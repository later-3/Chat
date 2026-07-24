"""REST contracts for safe repository discovery and Binding management."""

from __future__ import annotations

import os
import subprocess
from dataclasses import replace
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.config import Settings, WorkspaceRootSettings
from backend.app.main import create_app


def _git(cwd: Path, *arguments: str) -> None:
    subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        check=True,
        text=True,
        capture_output=True,
        env={
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
        },
    )


def _repository(path: Path) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q")
    _git(path, "config", "user.name", "Chat Test")
    _git(path, "config", "user.email", "chat-test@example.invalid")
    _git(path, "config", "commit.gpgsign", "false")
    (path / "README.md").write_text("# Repository\n", encoding="utf-8")
    _git(path, "add", "README.md")
    _git(path, "commit", "-qm", "initial")
    return path


def _settings(root: Path) -> Settings:
    return replace(
        Settings.for_test(),
        workspace_roots=(
            WorkspaceRootSettings(
                key="local-code",
                label="本地代码",
                path=root,
            ),
            WorkspaceRootSettings(
                key="missing",
                label="离线磁盘",
                path=root / "missing",
            ),
        ),
    )


def _project(client: TestClient) -> dict:
    response = client.post(
        "/api/harness/projects",
        json={
            "command_id": "create-project",
            "kind": "delivery",
            "title": "Chat",
            "goal": "开发Chat系统",
            "status": "active",
        },
    )
    assert response.status_code == 201
    return response.json()


def test_root_and_directory_discovery_never_exposes_server_paths(
    tmp_path: Path,
) -> None:
    _repository(tmp_path / "alpha")
    (tmp_path / "bravo").mkdir()
    (tmp_path / "charlie").mkdir()
    (tmp_path / ".hidden").mkdir()
    external = tmp_path.parent / f"{tmp_path.name}-external"
    external.mkdir()
    (tmp_path / "linked").symlink_to(external, target_is_directory=True)
    app = create_app(_settings(tmp_path))

    with TestClient(app) as client:
        roots = client.get("/api/harness/repository-roots")
        first_page = client.get(
            "/api/harness/repository-roots/local-code/directories",
            params={"limit": 2},
        )
        second_page = client.get(
            "/api/harness/repository-roots/local-code/directories",
            params={
                "limit": 2,
                "cursor": first_page.json()["next_cursor"],
            },
        )

    assert roots.status_code == 200
    assert {value["root_key"] for value in roots.json()["roots"]} == {
        "local-code",
        "missing",
    }
    assert (
        next(value for value in roots.json()["roots"] if value["root_key"] == "missing")["available"] is False
    )
    assert [value["name"] for value in first_page.json()["directories"]] == [
        "alpha",
        "bravo",
    ]
    assert [value["name"] for value in second_page.json()["directories"]] == ["charlie"]
    assert first_page.json()["directories"][0]["has_git_marker"] is True
    bodies = f"{roots.text}{first_page.text}{second_page.text}"
    assert str(tmp_path) not in bodies
    assert ".hidden" not in bodies
    assert "linked" not in bodies


def test_repository_binding_refresh_rebind_detach_and_snapshot_cursor(
    tmp_path: Path,
) -> None:
    first_repository = _repository(tmp_path / "first")
    _repository(tmp_path / "second")
    app = create_app(_settings(tmp_path))

    with TestClient(app) as client:
        project = _project(client)
        bound_response = client.post(
            f"/api/harness/projects/{project['id']}/repositories",
            json={
                "command_id": "bind",
                "expected_project_row_version": project["row_version"],
                "alias": "main",
                "display_name": "Chat代码",
                "role": "primary",
                "root_key": "local-code",
                "relative_path": "first",
            },
        )
        assert bound_response.status_code == 201
        bound = bound_response.json()
        binding_id = bound["binding"]["id"]
        (first_repository / "dirty.txt").write_text("dirty", encoding="utf-8")
        refreshed = client.post(
            f"/api/harness/repositories/{binding_id}/refresh",
            json={
                "command_id": "refresh-1",
                "expected_binding_row_version": 1,
            },
        ).json()
        refreshed_again = client.post(
            f"/api/harness/repositories/{binding_id}/refresh",
            json={
                "command_id": "refresh-2",
                "expected_binding_row_version": 2,
            },
        ).json()
        first_page = client.get(
            f"/api/harness/repositories/{binding_id}/snapshots",
            params={"limit": 2},
        ).json()
        second_page = client.get(
            f"/api/harness/repositories/{binding_id}/snapshots",
            params={"limit": 2, "cursor": first_page["next_cursor"]},
        ).json()
        rebound_response = client.post(
            f"/api/harness/repositories/{binding_id}/rebind",
            json={
                "command_id": "rebind",
                "expected_project_row_version": bound["project_row_version"],
                "expected_binding_row_version": refreshed_again["binding"]["row_version"],
                "display_name": "Chat新代码",
                "role": "primary",
                "root_key": "local-code",
                "relative_path": "second",
            },
        )
        assert rebound_response.status_code == 200
        rebound = rebound_response.json()
        detached_response = client.post(
            f"/api/harness/repositories/{binding_id}/detach",
            json={
                "command_id": "detach",
                "expected_project_row_version": rebound["project_row_version"],
                "expected_binding_row_version": rebound["binding"]["row_version"],
            },
        )
        listed = client.get(f"/api/harness/projects/{project['id']}/repositories").json()
        fetched = client.get(f"/api/harness/repositories/{binding_id}").json()

    assert bound["binding"]["root_label"] == "本地代码"
    assert str(tmp_path) not in repr(bound)
    assert refreshed["snapshot"]["dirty"] is True
    assert refreshed["binding"]["row_version"] == 2
    assert [value["sequence"] for value in first_page["snapshots"]] == [3, 2]
    assert [value["sequence"] for value in second_page["snapshots"]] == [1]
    assert rebound["binding"]["generation"] == 2
    assert rebound["snapshot"]["sequence"] == 4
    assert detached_response.status_code == 200
    assert detached_response.json()["binding"]["status"] == "detached"
    assert listed["repositories"][0]["binding"]["status"] == "detached"
    assert listed["repositories"][0]["latest_snapshot"]["sequence"] == 4
    assert listed["repositories"][0]["last_available_snapshot"]["sequence"] == 4
    assert fetched["latest_snapshot"]["sequence"] == 4


def test_repository_list_keeps_last_available_baseline_when_latest_observation_fails(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "repository")
    unavailable_path = tmp_path / "repository-offline"
    app = create_app(_settings(tmp_path))

    with TestClient(app) as client:
        project = _project(client)
        bound = client.post(
            f"/api/harness/projects/{project['id']}/repositories",
            json={
                "command_id": "bind-for-unavailable",
                "expected_project_row_version": project["row_version"],
                "alias": "main",
                "display_name": "Chat代码",
                "role": "primary",
                "root_key": "local-code",
                "relative_path": "repository",
            },
        ).json()
        repository.rename(unavailable_path)
        unavailable = client.post(
            f"/api/harness/repositories/{bound['binding']['id']}/refresh",
            json={
                "command_id": "observe-unavailable",
                "expected_binding_row_version": bound["binding"]["row_version"],
            },
        )
        listed = client.get(
            f"/api/harness/projects/{project['id']}/repositories",
        )

    assert unavailable.status_code == 200
    assert unavailable.json()["snapshot"]["capture_status"] == "unavailable"
    summary = listed.json()["repositories"][0]
    assert summary["latest_snapshot"]["sequence"] == 2
    assert summary["latest_snapshot"]["capture_status"] == "unavailable"
    assert summary["last_available_snapshot"]["sequence"] == 1
    assert summary["last_available_snapshot"]["capture_status"] == "available"


def test_repository_api_maps_stable_errors_and_rejects_unknown_fields(
    tmp_path: Path,
) -> None:
    (tmp_path / "not-git").mkdir()
    app = create_app(_settings(tmp_path))

    with TestClient(app) as client:
        project = _project(client)
        missing_root = client.post(
            f"/api/harness/projects/{project['id']}/repositories",
            json={
                "command_id": "missing-root",
                "expected_project_row_version": 1,
                "alias": "main",
                "display_name": "Missing",
                "role": "primary",
                "root_key": "unknown",
                "relative_path": ".",
            },
        )
        absolute_path = client.post(
            f"/api/harness/projects/{project['id']}/repositories",
            json={
                "command_id": "absolute",
                "expected_project_row_version": 1,
                "alias": "main",
                "display_name": "Absolute",
                "role": "primary",
                "root_key": "local-code",
                "relative_path": str(tmp_path),
            },
        )
        non_git = client.post(
            f"/api/harness/projects/{project['id']}/repositories",
            json={
                "command_id": "not-git",
                "expected_project_row_version": 1,
                "alias": "main",
                "display_name": "Not Git",
                "role": "primary",
                "root_key": "local-code",
                "relative_path": "not-git",
            },
        )
        extra = client.post(
            f"/api/harness/projects/{project['id']}/repositories",
            json={
                "command_id": "extra",
                "expected_project_row_version": 1,
                "alias": "main",
                "display_name": "Extra",
                "role": "primary",
                "root_key": "local-code",
                "relative_path": "not-git",
                "absolute_path": str(tmp_path),
            },
        )
        missing_project = client.get(
            "/api/harness/projects/not-a-project/repositories",
        )
        parent_traversal = client.get(
            "/api/harness/repository-roots/local-code/directories",
            params={"relative_path": "../outside"},
        )

    assert missing_root.status_code == 404
    assert missing_root.json()["code"] == "REPOSITORY_ROOT_NOT_FOUND"
    assert absolute_path.status_code == 422
    assert absolute_path.json()["code"] == "REPOSITORY_PATH_INVALID"
    assert non_git.status_code == 422
    assert non_git.json()["code"] == "REPOSITORY_NOT_GIT"
    assert extra.status_code == 422
    assert extra.json()["code"] == "REQUEST_VALIDATION_FAILED"
    assert missing_project.status_code == 404
    assert missing_project.json()["code"] == "PROJECT_NOT_FOUND"
    assert parent_traversal.status_code == 422
    assert parent_traversal.json()["code"] == "REPOSITORY_PATH_INVALID"
    assert str(tmp_path) not in (
        missing_root.text
        + absolute_path.text
        + non_git.text
        + extra.text
        + missing_project.text
        + parent_traversal.text
    )
