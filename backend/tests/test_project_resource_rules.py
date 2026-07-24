"""Pure configuration, catalog, path and repository hash contracts."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.config import Settings, SettingsError, WorkspaceRootSettings
from backend.app.project_resources.catalog import WorkspaceRootCatalog
from backend.app.project_resources.contracts import (
    ProjectResourceNotFound,
    ProjectResourceValidationError,
    locator_hash,
    repository_semantic_hash,
)
from backend.app.project_resources.paths import (
    normalize_relative_path,
    resolve_repository_path,
)


def _config_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "version": 1,
        "server": {"host": "127.0.0.1", "port": 8030},
        "product_store": {"url": "sqlite+aiosqlite:///:memory:"},
        "providers": [],
        "pi_agent": {"enabled": False, "allowed_working_roots": []},
    }
    payload.update(overrides)
    return payload


def _write_config(path: Path, payload: dict[str, object]) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_settings_load_explicit_workspace_roots_without_public_path_projection(
    tmp_path: Path,
) -> None:
    root = tmp_path / "projects"
    root.mkdir()
    config = tmp_path / "config.json"
    _write_config(
        config,
        _config_payload(
            workspace_roots=[
                {
                    "key": "local-projects",
                    "label": "本地项目",
                    "path": str(root),
                }
            ]
        ),
    )

    settings = Settings.from_file(config)
    assert settings.workspace_roots == (
        WorkspaceRootSettings(
            key="local-projects",
            label="本地项目",
            path=root,
            source="configured",
        ),
    )
    public = WorkspaceRootCatalog(settings.workspace_roots).list_public()
    assert public == [
        {
            "root_key": "local-projects",
            "label": "本地项目",
            "available": True,
            "source": "configured",
            "error_code": None,
        }
    ]
    assert str(root) not in json.dumps(public, ensure_ascii=False)


def test_settings_compatibility_lifts_pi_roots_with_stable_opaque_keys(
    tmp_path: Path,
) -> None:
    root = tmp_path / "legacy"
    root.mkdir()
    config = tmp_path / "config.json"
    payload = _config_payload(
        pi_agent={
            "enabled": False,
            "allowed_working_roots": [str(root)],
            "default_working_directory": str(root),
        }
    )
    _write_config(config, payload)

    with pytest.warns(DeprecationWarning):
        first = Settings.from_file(config)
    with pytest.warns(DeprecationWarning):
        second = Settings.from_file(config)

    assert first.workspace_roots[0].key == second.workspace_roots[0].key
    assert first.workspace_roots[0].key.startswith("legacy-")
    assert str(root) not in first.workspace_roots[0].key
    assert first.workspace_roots[0].source == "pi_compatibility"


@pytest.mark.parametrize(
    "workspace_roots",
    [
        [{"key": "UPPER", "label": "Root", "path": "/tmp"}],
        [{"key": "valid", "label": "", "path": "/tmp"}],
        [{"key": "valid", "label": "Root", "path": "relative"}],
        [
            {"key": "same", "label": "One", "path": "/tmp"},
            {"key": "same", "label": "Two", "path": "/tmp"},
        ],
    ],
)
def test_settings_reject_invalid_workspace_root_contract(
    tmp_path: Path,
    workspace_roots: list[dict[str, str]],
) -> None:
    config = tmp_path / "config.json"
    _write_config(config, _config_payload(workspace_roots=workspace_roots))
    with pytest.raises(SettingsError):
        Settings.from_file(config)


def test_catalog_marks_missing_and_symlink_roots_unavailable(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    catalog = WorkspaceRootCatalog(
        (
            WorkspaceRootSettings("missing", "Missing", tmp_path / "missing"),
            WorkspaceRootSettings("linked", "Linked", link),
        )
    )

    public = {value["root_key"]: value for value in catalog.list_public()}
    assert public["missing"]["error_code"] == "REPOSITORY_ROOT_UNAVAILABLE"
    assert public["linked"]["error_code"] == "REPOSITORY_SYMLINK_REJECTED"
    with pytest.raises(ProjectResourceValidationError) as linked:
        catalog.require_available("linked")
    assert linked.value.code == "REPOSITORY_SYMLINK_REJECTED"
    with pytest.raises(ProjectResourceNotFound) as absent:
        catalog.require_available("absent")
    assert absent.value.code == "REPOSITORY_ROOT_NOT_FOUND"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", "."),
        (".", "."),
        ("repo", "repo"),
        ("group\\repo", "group/repo"),
        ("含 空格/仓库", "含 空格/仓库"),
    ],
)
def test_relative_path_normalization(raw: str, expected: str) -> None:
    assert normalize_relative_path(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "/absolute",
        "C:/absolute",
        "../escape",
        "one/../escape",
        "one/./two",
        "one//two",
        "one/",
        "bad\x00path",
    ],
)
def test_relative_path_rejects_ambiguous_or_escaping_values(raw: str) -> None:
    with pytest.raises(ProjectResourceValidationError):
        normalize_relative_path(raw)


def test_path_guard_rejects_every_symlink_segment_and_accepts_root_itself(
    tmp_path: Path,
) -> None:
    allowed = tmp_path / "allowed"
    repository = allowed / "repository"
    nested = repository / "nested"
    nested.mkdir(parents=True)
    external = tmp_path / "external"
    external.mkdir()
    (allowed / "link").symlink_to(external, target_is_directory=True)
    catalog = WorkspaceRootCatalog((WorkspaceRootSettings("code", "Code", allowed),))
    root = catalog.require_available("code")

    root_path = resolve_repository_path(root, ".")
    nested_path = resolve_repository_path(root, "repository/nested")
    assert root_path.absolute_path == allowed.resolve()
    assert root_path.relative_path == "."
    assert nested_path.absolute_path == nested.resolve()
    assert nested_path.locator_hash == locator_hash(
        root_identity_hash=nested_path.root_identity_hash,
        relative_path="repository/nested",
    )
    with pytest.raises(ProjectResourceValidationError) as rejected:
        resolve_repository_path(root, "link")
    assert rejected.value.code == "REPOSITORY_SYMLINK_REJECTED"


def test_semantic_hash_excludes_observation_metadata_but_fences_generation() -> None:
    common = {
        "locator_hash_value": "a" * 64,
        "head_oid": "b" * 40,
        "head_ref": "refs/heads/main",
        "detached_head": False,
        "worktree_fingerprint": "c" * 64,
        "fingerprint_complete": True,
        "governance_manifest_hash": "d" * 64,
    }
    first = repository_semantic_hash(binding_generation=1, **common)
    repeated_observation = repository_semantic_hash(binding_generation=1, **common)
    rebound = repository_semantic_hash(binding_generation=2, **common)

    assert first == repeated_observation
    assert first != rebound
