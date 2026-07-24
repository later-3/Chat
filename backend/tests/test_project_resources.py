"""Application, transaction, concurrency and recovery tests for SD1-A."""

from __future__ import annotations

import asyncio
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select

from backend.app.config import WorkspaceRootSettings
from backend.app.governance.models import GovernanceOutboxRecord
from backend.app.harness.models import (
    HarnessCommandRecord,
    HarnessTraceRecord,
    ProductProjectRecord,
)
from backend.app.product_sessions.database import ProductDatabase, utc_now
from backend.app.project_resources.catalog import WorkspaceRootCatalog
from backend.app.project_resources.contracts import (
    ProjectResourceConflict,
    RepositoryInspectionError,
)
from backend.app.project_resources.git_inspector import ReadOnlyGitInspector
from backend.app.project_resources.models import (
    ProjectRepositoryBindingRecord,
    RepositorySnapshotRecord,
)
from backend.app.project_resources.service import ProjectResourceService


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


def _repository(path: Path, *, name: str = "README.md") -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q")
    _git(path, "config", "user.name", "Chat Test")
    _git(path, "config", "user.email", "chat-test@example.invalid")
    _git(path, "config", "commit.gpgsign", "false")
    (path / name).write_text("# Repository\n", encoding="utf-8")
    _git(path, "add", name)
    _git(path, "commit", "-qm", "initial")
    return path


async def _runtime(
    tmp_path: Path,
    *,
    catalog: WorkspaceRootCatalog | None = None,
    database_url: str = "sqlite+aiosqlite:///:memory:",
) -> tuple[ProductDatabase, ProjectResourceService, ProductProjectRecord]:
    database = ProductDatabase(database_url)
    await database.initialize()
    project = ProductProjectRecord(
        id="project-1",
        scope_id="local-user",
        kind="delivery",
        title="Self development",
        goal="让Chat能够开发自己",
        status="active",
        current_milestone_id=None,
        row_version=1,
        created_by="local-user",
        created_at=utc_now(),
        updated_at=utc_now(),
    )
    async with database.sessions.begin() as transaction:
        transaction.add(project)
    resolved_catalog = catalog or WorkspaceRootCatalog((WorkspaceRootSettings("code", "Code", tmp_path),))
    service = ProjectResourceService(
        database,
        catalog=resolved_catalog,
        inspector=ReadOnlyGitInspector(),
    )
    return database, service, project


async def _counts(database: ProductDatabase) -> dict[str, int]:
    tables = {
        "bindings": ProjectRepositoryBindingRecord,
        "snapshots": RepositorySnapshotRecord,
        "commands": HarnessCommandRecord,
        "traces": HarnessTraceRecord,
        "outbox": GovernanceOutboxRecord,
    }
    async with database.sessions() as transaction:
        return {
            key: int(await transaction.scalar(select(func.count()).select_from(model)) or 0)
            for key, model in tables.items()
        }


@pytest.mark.anyio
async def test_bind_is_atomic_idempotent_and_never_projects_private_paths(
    tmp_path: Path,
) -> None:
    _repository(tmp_path / "repo")
    database, service, _ = await _runtime(tmp_path)
    try:
        result = await service.bind_repository(
            command_id="bind-1",
            project_id="project-1",
            expected_project_row_version=1,
            alias="primary",
            display_name="Chat",
            role="primary",
            root_key="code",
            relative_path="repo",
        )
        replay = await service.bind_repository(
            command_id="bind-1",
            project_id="project-1",
            expected_project_row_version=1,
            alias="primary",
            display_name="Chat",
            role="primary",
            root_key="code",
            relative_path="repo",
        )

        assert result == replay
        assert result["binding"]["status"] == "active"
        assert result["binding"]["generation"] == 1
        assert result["snapshot"]["sequence"] == 1
        assert result["snapshot"]["capture_status"] == "available"
        assert result["project_row_version"] == 2
        assert str(tmp_path) not in repr(result)
        assert "root_identity_hash" not in repr(result)
        assert await _counts(database) == {
            "bindings": 1,
            "snapshots": 1,
            "commands": 1,
            "traces": 1,
            "outbox": 1,
        }

        with pytest.raises(ProjectResourceConflict):
            await service.bind_repository(
                command_id="bind-1",
                project_id="project-1",
                expected_project_row_version=1,
                alias="different",
                display_name="Different",
                role="primary",
                root_key="code",
                relative_path="repo",
            )
    finally:
        await database.close()


@pytest.mark.anyio
async def test_initial_inspection_failure_leaves_no_product_or_ledger_facts(
    tmp_path: Path,
) -> None:
    (tmp_path / "not-git").mkdir()
    database, service, _ = await _runtime(tmp_path)
    try:
        with pytest.raises(RepositoryInspectionError):
            await service.bind_repository(
                command_id="bind-invalid",
                project_id="project-1",
                expected_project_row_version=1,
                alias="primary",
                display_name="Invalid",
                role="primary",
                root_key="code",
                relative_path="not-git",
            )

        assert await _counts(database) == {
            "bindings": 0,
            "snapshots": 0,
            "commands": 0,
            "traces": 0,
            "outbox": 0,
        }
        async with database.sessions() as transaction:
            project = await transaction.get(ProductProjectRecord, "project-1")
            assert project and project.row_version == 1
    finally:
        await database.close()


@pytest.mark.anyio
async def test_refresh_persists_unavailable_observation_then_recovers(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "repo")
    database, service, _ = await _runtime(tmp_path)
    try:
        bound = await service.bind_repository(
            command_id="bind",
            project_id="project-1",
            expected_project_row_version=1,
            alias="primary",
            display_name="Chat",
            role="primary",
            root_key="code",
            relative_path="repo",
        )
        unavailable_path = tmp_path / "temporarily-unavailable"
        repository.rename(unavailable_path)
        unavailable = await service.refresh_repository(
            command_id="refresh-unavailable",
            binding_id=bound["binding"]["id"],
            expected_binding_row_version=1,
        )
        unavailable_path.rename(repository)
        recovered = await service.refresh_repository(
            command_id="refresh-recovered",
            binding_id=bound["binding"]["id"],
            expected_binding_row_version=2,
        )

        assert unavailable["binding"]["status"] == "unavailable"
        assert unavailable["snapshot"]["capture_status"] == "unavailable"
        assert unavailable["snapshot"]["semantic_hash"] is None
        assert unavailable["snapshot"]["error_code"] == "REPOSITORY_NOT_FOUND"
        assert unavailable["snapshot"]["sequence"] == 2
        assert recovered["binding"]["status"] == "active"
        assert recovered["snapshot"]["capture_status"] == "available"
        assert recovered["snapshot"]["sequence"] == 3
        assert recovered["snapshot"]["semantic_hash"] == bound["snapshot"]["semantic_hash"]
        assert await _counts(database) == {
            "bindings": 1,
            "snapshots": 3,
            "commands": 3,
            "traces": 3,
            "outbox": 3,
        }
    finally:
        await database.close()


@pytest.mark.anyio
async def test_rebind_and_detach_use_double_cas_and_keep_snapshot_history(
    tmp_path: Path,
) -> None:
    _repository(tmp_path / "repo-one")
    _repository(tmp_path / "repo-two")
    database, service, _ = await _runtime(tmp_path)
    try:
        bound = await service.bind_repository(
            command_id="bind",
            project_id="project-1",
            expected_project_row_version=1,
            alias="primary",
            display_name="One",
            role="primary",
            root_key="code",
            relative_path="repo-one",
        )
        rebound = await service.rebind_repository(
            command_id="rebind",
            project_id="project-1",
            binding_id=bound["binding"]["id"],
            expected_project_row_version=2,
            expected_binding_row_version=1,
            display_name="Two",
            role="primary",
            root_key="code",
            relative_path="repo-two",
        )
        detached = await service.detach_repository(
            command_id="detach",
            project_id="project-1",
            binding_id=bound["binding"]["id"],
            expected_project_row_version=3,
            expected_binding_row_version=2,
        )

        assert rebound["binding"]["id"] == bound["binding"]["id"]
        assert rebound["binding"]["generation"] == 2
        assert rebound["snapshot"]["binding_generation"] == 2
        assert rebound["snapshot"]["sequence"] == 2
        assert rebound["project_row_version"] == 3
        assert detached["binding"]["status"] == "detached"
        assert detached["binding"]["generation"] == 2
        assert detached["binding"]["latest_snapshot_sequence"] == 2
        assert detached["snapshot"] is None
        assert detached["project_row_version"] == 4
        assert [
            value["sequence"] for value in await service.list_snapshots(binding_id=bound["binding"]["id"])
        ] == [2, 1]
    finally:
        await database.close()


@pytest.mark.anyio
async def test_recorder_failure_rolls_back_project_binding_snapshot_and_ledgers(
    tmp_path: Path,
) -> None:
    _repository(tmp_path / "repo")
    database, service, _ = await _runtime(tmp_path)
    original_record = service._commands.record

    def explode(*args: Any, **kwargs: Any) -> None:
        original_record(*args, **kwargs)
        raise RuntimeError("injected recorder failure")

    service._commands.record = explode  # type: ignore[method-assign]
    try:
        with pytest.raises(RuntimeError, match="injected recorder failure"):
            await service.bind_repository(
                command_id="bind-rollback",
                project_id="project-1",
                expected_project_row_version=1,
                alias="primary",
                display_name="Chat",
                role="primary",
                root_key="code",
                relative_path="repo",
            )

        assert await _counts(database) == {
            "bindings": 0,
            "snapshots": 0,
            "commands": 0,
            "traces": 0,
            "outbox": 0,
        }
        async with database.sessions() as transaction:
            project = await transaction.get(ProductProjectRecord, "project-1")
            assert project and project.row_version == 1
    finally:
        await database.close()


@pytest.mark.anyio
async def test_eight_concurrent_primary_binds_commit_exactly_one_member(
    tmp_path: Path,
) -> None:
    for index in range(8):
        _repository(tmp_path / f"repo-{index}")
    database, service, _ = await _runtime(tmp_path)
    try:
        outcomes = await asyncio.gather(
            *(
                service.bind_repository(
                    command_id=f"bind-{index}",
                    project_id="project-1",
                    expected_project_row_version=1,
                    alias=f"repo-{index}",
                    display_name=f"Repo {index}",
                    role="primary",
                    root_key="code",
                    relative_path=f"repo-{index}",
                )
                for index in range(8)
            ),
            return_exceptions=True,
        )

        successes = [value for value in outcomes if isinstance(value, dict)]
        conflicts = [value for value in outcomes if isinstance(value, ProjectResourceConflict)]
        assert len(successes) == 1
        assert len(conflicts) == 7
        assert await _counts(database) == {
            "bindings": 1,
            "snapshots": 1,
            "commands": 1,
            "traces": 1,
            "outbox": 1,
        }
    finally:
        await database.close()


@pytest.mark.anyio
async def test_durable_sqlite_concurrent_primary_bind_preserves_same_cas_invariant(
    tmp_path: Path,
) -> None:
    for index in range(8):
        _repository(tmp_path / f"durable-repo-{index}")
    database, service, _ = await _runtime(
        tmp_path,
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'resources.db'}",
    )
    try:
        outcomes = await asyncio.gather(
            *(
                service.bind_repository(
                    command_id=f"durable-bind-{index}",
                    project_id="project-1",
                    expected_project_row_version=1,
                    alias=f"durable-{index}",
                    display_name=f"Durable {index}",
                    role="primary",
                    root_key="code",
                    relative_path=f"durable-repo-{index}",
                )
                for index in range(8)
            ),
            return_exceptions=True,
        )

        assert len([value for value in outcomes if isinstance(value, dict)]) == 1
        assert len([value for value in outcomes if isinstance(value, ProjectResourceConflict)]) == 7
        assert not [
            value
            for value in outcomes
            if isinstance(value, Exception) and not isinstance(value, ProjectResourceConflict)
        ]
    finally:
        await database.close()


@pytest.mark.anyio
async def test_concurrent_refresh_uses_binding_cas_and_same_command_replays(
    tmp_path: Path,
) -> None:
    _repository(tmp_path / "repo")
    database, service, _ = await _runtime(tmp_path)
    try:
        bound = await service.bind_repository(
            command_id="bind",
            project_id="project-1",
            expected_project_row_version=1,
            alias="primary",
            display_name="Chat",
            role="primary",
            root_key="code",
            relative_path="repo",
        )
        binding_id = bound["binding"]["id"]
        competing = await asyncio.gather(
            *(
                service.refresh_repository(
                    command_id=f"refresh-{index}",
                    binding_id=binding_id,
                    expected_binding_row_version=1,
                )
                for index in range(8)
            ),
            return_exceptions=True,
        )
        assert len([value for value in competing if isinstance(value, dict)]) == 1
        assert len([value for value in competing if isinstance(value, ProjectResourceConflict)]) == 7

        current = await service.get_binding(binding_id)
        same_command = await asyncio.gather(
            *(
                service.refresh_repository(
                    command_id="refresh-replay",
                    binding_id=binding_id,
                    expected_binding_row_version=current["binding"]["row_version"],
                )
                for _ in range(8)
            )
        )
        assert all(value == same_command[0] for value in same_command)
        assert len(await service.list_snapshots(binding_id=binding_id)) == 3
    finally:
        await database.close()


@pytest.mark.anyio
async def test_catalog_reconciliation_is_idempotent_and_does_not_scan_git(
    tmp_path: Path,
) -> None:
    _repository(tmp_path / "repo")
    database, service, _ = await _runtime(tmp_path)
    try:
        bound = await service.bind_repository(
            command_id="bind",
            project_id="project-1",
            expected_project_row_version=1,
            alias="primary",
            display_name="Chat",
            role="primary",
            root_key="code",
            relative_path="repo",
        )
        unavailable_catalog_service = ProjectResourceService(
            database,
            catalog=WorkspaceRootCatalog(()),
            inspector=ReadOnlyGitInspector(git_executable=str(tmp_path / "must-not-run")),
        )

        assert await unavailable_catalog_service.reconcile_catalog() == 1
        assert await unavailable_catalog_service.reconcile_catalog() == 0
        reconciled = await unavailable_catalog_service.get_binding(bound["binding"]["id"])
        assert reconciled["binding"]["status"] == "unavailable"
        assert reconciled["binding"]["status_reason_code"] == "REPOSITORY_ROOT_IDENTITY_CHANGED"
        assert reconciled["binding"]["latest_snapshot_sequence"] == 1
        assert len(await service.list_snapshots(binding_id=bound["binding"]["id"])) == 1
    finally:
        await database.close()
