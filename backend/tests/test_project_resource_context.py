"""Repository Context contribution and source-freshness contract tests."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from backend.app.collaboration_contexts.service import CollaborationContextService
from backend.app.config import WorkspaceRootSettings
from backend.app.harness.service import HarnessService
from backend.app.product_sessions.database import ProductDatabase
from backend.app.product_sessions.service import ProductSessionService
from backend.app.project_resources.catalog import WorkspaceRootCatalog
from backend.app.project_resources.context import (
    ContextSourceStale,
    RepositoryContextContributor,
    RepositoryContextSourceResolver,
    RepositorySourceFreshnessGuard,
)
from backend.app.project_resources.git_inspector import ReadOnlyGitInspector
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


def _repository(path: Path) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q")
    _git(path, "config", "user.name", "Chat Test")
    _git(path, "config", "user.email", "chat-test@example.invalid")
    _git(path, "config", "commit.gpgsign", "false")
    (path / "README.md").write_text("# Chat\n\nRepository overview.\n", encoding="utf-8")
    (path / "PROJECT_PLAN.md").write_text("# Plan\n\nShip SD1-C.\n", encoding="utf-8")
    (path / "AGENTS.md").write_text("# Rules\n\nKeep provider approval.\n", encoding="utf-8")
    (path / ".env").write_text("SECRET=never-adopt\n", encoding="utf-8")
    (path / "backend").mkdir()
    (path / "backend" / "config.json").write_text('{"api_key":"never-adopt"}\n', encoding="utf-8")
    _git(path, "add", "README.md", "PROJECT_PLAN.md", "AGENTS.md")
    _git(path, "commit", "-qm", "initial")
    return path


async def _runtime(
    tmp_path: Path,
) -> tuple[
    ProductDatabase,
    HarnessService,
    ProjectResourceService,
    RepositoryContextContributor,
    RepositoryContextSourceResolver,
    RepositorySourceFreshnessGuard,
]:
    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    await database.initialize()
    harness = HarnessService(database)
    project = await harness.create_project(
        command_id="create-project",
        kind="delivery",
        title="Chat",
        goal="让Chat能够开发自己",
        status="active",
    )
    catalog = WorkspaceRootCatalog((WorkspaceRootSettings("code", "Code", tmp_path),))
    resources = ProjectResourceService(
        database,
        catalog=catalog,
        inspector=ReadOnlyGitInspector(),
    )
    await resources.bind_repository(
        command_id="bind-chat",
        project_id=project["id"],
        expected_project_row_version=project["row_version"],
        alias="primary",
        display_name="Chat",
        role="primary",
        root_key="code",
        relative_path="repo",
    )
    contributor = RepositoryContextContributor(
        database,
        catalog=catalog,
    )
    resolver = RepositoryContextSourceResolver(
        database,
        catalog=catalog,
    )
    guard = RepositorySourceFreshnessGuard(database)
    return database, harness, resources, contributor, resolver, guard


@pytest.mark.anyio
async def test_stage_a_is_lightweight_and_stage_b_selects_only_allowlisted_governance(
    tmp_path: Path,
) -> None:
    _repository(tmp_path / "repo")
    database, harness, _, contributor, _, _ = await _runtime(tmp_path)
    try:
        [project] = await harness.list_projects()
        directory = await contributor.directory_context_items(
            prompt="继续开发Chat",
            projects=[project],
        )
        assert {value["source_kind"] for value in directory} == {"repository_directory"}
        assert all("Repository overview." not in value["content"] for value in directory)

        detail = await contributor.detailed_context_items(
            project_id=project["id"],
            prompt="继续开发并审查代码",
            scenario="continue_project",
        )
        assert any(value["source_kind"] == "repository_snapshot" and value["adopted"] for value in detail)
        governance = [
            value
            for value in detail
            if value["source_kind"] in {"repository_governance", "repository_governance_manifest"}
        ]
        assert governance
        assert all(".env" not in value["source_id"] for value in governance)
        assert all("backend/config.json" not in value["source_id"] for value in governance)
        assert any(
            value["source_kind"] == "repository_governance" and "Keep provider approval." in value["content"]
            for value in governance
        )
    finally:
        await database.close()


@pytest.mark.anyio
async def test_governance_budget_adopts_each_fitting_document_in_preference_order(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "repo")
    (repository / "PROJECT_STATE.md").write_text("S" * 120, encoding="utf-8")
    (repository / "PROJECT_PLAN.md").write_text("next plan\n", encoding="utf-8")
    _git(repository, "add", "PROJECT_STATE.md", "PROJECT_PLAN.md")
    _git(repository, "commit", "-qm", "add status and plan")
    database, harness, _, _, _, _ = await _runtime(tmp_path)
    contributor = RepositoryContextContributor(
        database,
        catalog=WorkspaceRootCatalog((WorkspaceRootSettings("code", "Code", tmp_path),)),
        max_governance_context_bytes=64,
    )
    try:
        [project] = await harness.list_projects()
        detail = await contributor.detailed_context_items(
            project_id=project["id"],
            prompt="当前状态和下一步计划是什么？",
            scenario="continue_project",
        )
        state = next(value for value in detail if value["source_id"].endswith(":PROJECT_STATE.md"))
        plan = next(value for value in detail if value["source_id"].endswith(":PROJECT_PLAN.md"))

        assert state["source_kind"] == "repository_governance_manifest"
        assert state["adopted"] is False
        assert "剩余预算" in state["reason"]
        assert plan["source_kind"] == "repository_governance"
        assert plan["adopted"] is True
        assert plan["content"] == "next plan\n"
    finally:
        await database.close()


@pytest.mark.anyio
async def test_repository_context_keeps_one_binding_revision_across_sessions_and_isolates_projects(
    tmp_path: Path,
) -> None:
    _repository(tmp_path / "repo")
    database, harness, _, contributor, _, _ = await _runtime(tmp_path)
    sessions = ProductSessionService(database)
    try:
        [chat_project] = await harness.list_projects()
        other_project = await harness.create_project(
            command_id="create-other-project",
            kind="delivery",
            title="Other",
            goal="验证Project来源隔离",
            status="active",
        )
        chat_items = await contributor.detailed_context_items(
            project_id=chat_project["id"],
            prompt="开发Chat需要遵守哪些规则？",
            scenario="continue_project",
        )
        adopted_repository_sources = [
            (value["source_kind"], value["source_id"], value["source_revision"])
            for value in chat_items
            if value["adopted"]
        ]
        assert adopted_repository_sources

        package_sources: list[list[tuple[str, str, str | None]]] = []
        for ordinal in (1, 2):
            session = await sessions.create_session(title=f"Chat dogfood {ordinal}")
            accepted = await sessions.prepare_agui_run(
                {
                    "threadId": session["id"],
                    "runId": f"cross-session-{ordinal}",
                    "state": {},
                    "messages": [
                        {
                            "id": f"message-{ordinal}",
                            "role": "user",
                            "content": "开发Chat需要遵守哪些规则？",
                        }
                    ],
                    "tools": [],
                    "context": [],
                    "forwardedProps": {},
                }
            )
            package = await harness.create_context_package(
                session_id=session["id"],
                run_id=accepted.product_run_id,
                stage="detail",
                items=chat_items,
                selected_project_id=chat_project["id"],
                status="adopted",
            )
            package_sources.append(
                [
                    (value["source_kind"], value["source_id"], value["source_revision"])
                    for value in package["items"]
                    if value["adopted"]
                ]
            )

        other_items = await contributor.detailed_context_items(
            project_id=other_project["id"],
            prompt="继续Other项目",
            scenario="continue_project",
        )

        assert package_sources == [
            adopted_repository_sources,
            adopted_repository_sources,
        ]
        assert other_items == []
    finally:
        await database.close()


@pytest.mark.anyio
async def test_governance_body_hash_mismatch_fails_closed_until_snapshot_refresh(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "repo")
    database, harness, resources, contributor, resolver, _ = await _runtime(tmp_path)
    try:
        [project] = await harness.list_projects()
        detail = await contributor.detailed_context_items(
            project_id=project["id"],
            prompt="查看下一步计划",
            scenario="plan_request",
        )
        source = next(
            value
            for value in detail
            if value["source_kind"] == "repository_governance"
            and value["source_id"].endswith(":PROJECT_PLAN.md")
        )
        (repository / "PROJECT_PLAN.md").write_text("# Plan\n\nChanged after snapshot.\n", encoding="utf-8")
        with pytest.raises(ContextSourceStale) as caught:
            await resolver.materialize(
                source_kind=source["source_kind"],
                source_id=source["source_id"],
                source_revision=source["source_revision"],
            )
        assert caught.value.code == "CONTEXT_SOURCE_STALE"

        [binding] = await resources.list_bindings(project_id=project["id"])
        await resources.refresh_repository(
            command_id="refresh-plan",
            binding_id=binding["id"],
            expected_binding_row_version=binding["row_version"],
        )
        refreshed = await contributor.detailed_context_items(
            project_id=project["id"],
            prompt="查看下一步计划",
            scenario="plan_request",
        )
        assert any(
            value["source_kind"] == "repository_governance" and "Changed after snapshot." in value["content"]
            for value in refreshed
        )
    finally:
        await database.close()


@pytest.mark.anyio
async def test_governance_materialization_rejects_link_and_unavailable_repository(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "repo")
    database, harness, _, contributor, resolver, _ = await _runtime(tmp_path)
    try:
        [project] = await harness.list_projects()
        detail = await contributor.detailed_context_items(
            project_id=project["id"],
            prompt="继续开发并审查代码",
            scenario="continue_project",
        )
        source = next(
            value
            for value in detail
            if value["source_kind"] == "repository_governance" and value["source_id"].endswith(":AGENTS.md")
        )

        (repository / "AGENTS.md").unlink()
        (repository / "AGENTS.md").symlink_to("README.md")
        with pytest.raises(ContextSourceStale) as linked:
            await resolver.materialize(
                source_kind=source["source_kind"],
                source_id=source["source_id"],
                source_revision=source["source_revision"],
            )
        assert linked.value.reason_code == "governance_symlink_rejected"

        (repository / "AGENTS.md").unlink()
        (repository / "AGENTS.md").write_text(
            "# Rules\n\nKeep provider approval.\n",
            encoding="utf-8",
        )
        repository.rename(tmp_path / "repo-offline")
        with pytest.raises(ContextSourceStale) as unavailable:
            await resolver.materialize(
                source_kind=source["source_kind"],
                source_id=source["source_id"],
                source_revision=source["source_revision"],
            )
        assert unavailable.value.reason_code == "repository_not_found"
    finally:
        await database.close()


@pytest.mark.anyio
async def test_freshness_guard_accepts_same_semantics_and_rejects_changed_or_unavailable_latest(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "repo")
    database, harness, resources, contributor, _, guard = await _runtime(tmp_path)
    try:
        [project] = await harness.list_projects()
        items = await contributor.detailed_context_items(
            project_id=project["id"],
            prompt="查看项目概览",
            scenario="continue_project",
        )
        adopted = [value for value in items if value["adopted"]]
        assert (await guard.assert_items_fresh(adopted))["fresh"] is True

        [binding] = await resources.list_bindings(project_id=project["id"])
        repeated = await resources.refresh_repository(
            command_id="refresh-same",
            binding_id=binding["id"],
            expected_binding_row_version=binding["row_version"],
        )
        assert repeated["snapshot"]["semantic_hash"] == adopted[0]["source_revision"]
        assert (await guard.assert_items_fresh(adopted))["fresh"] is True

        (repository / "README.md").write_text("# Chat\n\nChanged semantics.\n", encoding="utf-8")
        current = (await resources.get_binding(binding["id"]))["binding"]
        await resources.refresh_repository(
            command_id="refresh-changed",
            binding_id=binding["id"],
            expected_binding_row_version=current["row_version"],
        )
        with pytest.raises(ContextSourceStale):
            await guard.assert_items_fresh(adopted)

        repository.rename(tmp_path / "repo-offline")
        current = (await resources.get_binding(binding["id"]))["binding"]
        await resources.refresh_repository(
            command_id="refresh-unavailable",
            binding_id=binding["id"],
            expected_binding_row_version=current["row_version"],
        )
        with pytest.raises(ContextSourceStale) as caught:
            await guard.assert_items_fresh(adopted)
        assert caught.value.reason_code == "latest_snapshot_unavailable"
    finally:
        await database.close()


@pytest.mark.anyio
async def test_manifest_selection_materializes_body_outside_context_transaction(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "repo")
    database, harness, _, _, resolver, _ = await _runtime(tmp_path)
    catalog = WorkspaceRootCatalog((WorkspaceRootSettings("code", "Code", tmp_path),))
    contributor = RepositoryContextContributor(
        database,
        catalog=catalog,
        max_governance_context_bytes=1,
    )
    sessions = ProductSessionService(database)
    collaboration_contexts = CollaborationContextService(
        database,
        external_source_resolver=resolver,
    )
    try:
        [project] = await harness.list_projects()
        detail = await contributor.detailed_context_items(
            project_id=project["id"],
            prompt="查看下一步计划",
            scenario="plan_request",
        )
        manifest_index = next(
            index
            for index, value in enumerate(detail)
            if value["source_kind"] == "repository_governance_manifest"
            and value["source_id"].endswith(":PROJECT_PLAN.md")
        )
        session = await sessions.create_session()
        accepted = await sessions.prepare_agui_run(
            {
                "threadId": session["id"],
                "runId": "agui-materialize",
                "state": {},
                "messages": [
                    {
                        "id": "message-materialize",
                        "role": "user",
                        "content": "查看下一步计划",
                    }
                ],
                "tools": [],
                "context": [],
                "forwardedProps": {},
            }
        )
        package = await harness.create_context_package(
            session_id=session["id"],
            run_id=accepted.product_run_id,
            stage="detail",
            items=detail,
            selected_project_id=project["id"],
            status="adopted",
        )
        revised = await collaboration_contexts.revise_package(
            package_id=package["id"],
            command_id="materialize-plan",
            expected_package_hash=package["package_hash"],
            reason="用户明确选择计划规则",
            item_changes=[
                {
                    "ordinal": manifest_index,
                    "adopted": True,
                    "materialize": True,
                }
            ],
        )
        materialized = revised["items"][manifest_index]
        assert materialized["source_kind"] == "repository_governance"
        assert materialized["adopted"] is True
        assert "Ship SD1-C." in materialized["content"]
        assert materialized["source_revision"] == package["items"][0]["source_revision"]

        # Exact command replay is a ledger read, not a second external-file
        # operation. It therefore remains deterministic even if the file has
        # changed after the first transaction committed.
        (repository / "PROJECT_PLAN.md").write_text(
            "# Plan\n\nChanged after the accepted revision.\n",
            encoding="utf-8",
        )
        replay = await collaboration_contexts.revise_package(
            package_id=package["id"],
            command_id="materialize-plan",
            expected_package_hash=package["package_hash"],
            reason="用户明确选择计划规则",
            item_changes=[
                {
                    "ordinal": manifest_index,
                    "adopted": True,
                    "materialize": True,
                }
            ],
        )
        assert replay["id"] == revised["id"]
        assert replay["package_hash"] == revised["package_hash"]
    finally:
        await database.close()
