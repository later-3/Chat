from __future__ import annotations

import asyncio

import pytest

from backend.app.collaboration_contexts import CollaborationContextService
from backend.app.governance.catalog import EXECUTION_DRAFT_KEYS
from backend.app.governance.models import (
    ExecutionDraftRecord,
    ExecutionDraftRevisionRecord,
)
from backend.app.governance.service import ExecutionGovernanceService
from backend.app.harness.contracts import HarnessConflict, HarnessValidationError
from backend.app.harness.models import ContextPackageRecord
from backend.app.harness.service import HarnessService
from backend.app.product_sessions.database import ProductDatabase
from backend.app.product_sessions.service import ProductSessionService


async def _runtime() -> tuple[
    ProductDatabase,
    ProductSessionService,
    HarnessService,
    CollaborationContextService,
    ExecutionGovernanceService,
]:
    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    sessions = ProductSessionService(database)
    harness = HarnessService(database)
    contexts = CollaborationContextService(database)
    governance = ExecutionGovernanceService(database)
    await sessions.initialize()
    await governance.initialize()
    return database, sessions, harness, contexts, governance


async def _accepted_run(
    sessions: ProductSessionService,
) -> tuple[str, str]:
    session = await sessions.create_session()
    accepted = await sessions.prepare_agui_run(
        {
            "threadId": session["id"],
            "runId": "context-revision-run",
            "state": {},
            "messages": [
                {
                    "id": "context-revision-user",
                    "role": "user",
                    "content": "继续推进项目",
                }
            ],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
    )
    return session["id"], accepted.product_run_id


def test_context_revision_is_immutable_editable_and_cas_guarded() -> None:
    async def scenario() -> None:
        database, sessions, harness, contexts, _ = await _runtime()
        session_id, run_id = await _accepted_run(sessions)
        project = await harness.create_project(
            command_id="context-project",
            kind="delivery",
            title="Chat",
            goal="构建可恢复的协作系统",
            status="active",
        )
        package = await harness.create_context_package(
            session_id=session_id,
            run_id=run_id,
            stage="detail",
            items=[
                {
                    "source_kind": "project",
                    "source_id": project["id"],
                    "source_revision": project["row_version"],
                    "title": project["title"],
                    "content": project["goal"],
                    "adopted": True,
                    "reason": "当前项目",
                },
                {
                    "source_kind": "turn_summary",
                    "source_id": "digest-old",
                    "title": "旧回合重点",
                    "content": "与本轮不直接相关",
                    "adopted": True,
                    "reason": "关键词候选",
                },
            ],
        )

        revised = await contexts.revise_package(
            package_id=package["id"],
            command_id="context-revise-1",
            expected_package_hash=package["package_hash"],
            reason="用户只保留当前项目，并修正目标表述",
            item_changes=[
                {
                    "ordinal": 0,
                    "content": "构建可恢复、可审核、可维护的协作系统",
                    "locked": True,
                },
                {"ordinal": 1, "adopted": False, "reason": "与本轮目标无关"},
            ],
        )
        replay = await contexts.revise_package(
            package_id=package["id"],
            command_id="context-revise-1",
            expected_package_hash=package["package_hash"],
            reason="用户只保留当前项目，并修正目标表述",
            item_changes=[
                {
                    "ordinal": 0,
                    "content": "构建可恢复、可审核、可维护的协作系统",
                    "locked": True,
                },
                {"ordinal": 1, "adopted": False, "reason": "与本轮目标无关"},
            ],
        )

        assert replay == revised
        assert revised["revision"] == 2
        assert revised["previous_package_id"] == package["id"]
        assert revised["items"][0]["source_kind"] == "user_override"
        assert revised["items"][0]["locked"] is True
        assert revised["items"][0]["selection_origin"] == "human"
        assert revised["items"][1]["adopted"] is False
        assert revised["package_hash"] != package["package_hash"]
        async with database.sessions() as transaction:
            old = await transaction.get(ContextPackageRecord, package["id"])
            assert old is not None and old.status == "superseded"

        with pytest.raises(HarnessConflict):
            await contexts.revise_package(
                package_id=revised["id"],
                command_id="context-revise-stale",
                expected_package_hash=package["package_hash"],
                reason="过期页面提交",
            )
        with pytest.raises(HarnessValidationError, match="超过预算"):
            await contexts.revise_package(
                package_id=revised["id"],
                command_id="context-revise-over-budget",
                expected_package_hash=revised["package_hash"],
                reason="预算过小",
                item_changes=[
                    {"ordinal": 0, "content": "很长的上下文" * 100},
                    {"ordinal": 1, "adopted": True},
                ],
                token_budget=128,
            )
        with pytest.raises(HarnessValidationError, match="没有发生变化"):
            await contexts.revise_package(
                package_id=revised["id"],
                command_id="context-revise-no-op",
                expected_package_hash=revised["package_hash"],
                reason="没有改变任何采用内容",
            )
        budget_revision = await contexts.revise_package(
            package_id=revised["id"],
            command_id="context-revise-budget",
            expected_package_hash=revised["package_hash"],
            reason="为本轮收紧Context预算",
            token_budget=4096,
        )
        assert budget_revision["revision"] == 3
        assert budget_revision["token_budget"] == 4096
        assert budget_revision["package_hash"] != revised["package_hash"]
        await database.close()

    asyncio.run(scenario())


def test_context_revision_invalidates_unstarted_execution_draft() -> None:
    async def scenario() -> None:
        database, sessions, harness, contexts, governance = await _runtime()
        session_id, run_id = await _accepted_run(sessions)
        package = await harness.create_context_package(
            session_id=session_id,
            run_id=run_id,
            stage="directory",
            items=[
                {
                    "source_kind": "project",
                    "source_id": "project-candidate",
                    "title": "候选项目",
                    "content": "旧上下文",
                    "adopted": True,
                }
            ],
        )
        payload = {key: {} for key in EXECUTION_DRAFT_KEYS}
        payload["context_binding"] = {
            "context_package_id": package["id"],
            "context_hash": package["package_hash"],
            "manifest": [],
        }
        draft, revision = await governance.create_execution_draft(
            session_id=session_id,
            run_id=run_id,
            workflow_definition_id="continuous-collaboration",
            workflow_version="1.3.0",
            payload=payload,
            execution_brief="使用当前Context回答",
        )

        revised = await contexts.revise_package(
            package_id=package["id"],
            command_id="context-invalidates-draft",
            expected_package_hash=package["package_hash"],
            reason="用户修改了真正要发送的上下文",
            item_changes=[{"ordinal": 0, "content": "用户修正后的上下文"}],
        )
        assert revised["execution_invalidation"] == {
            "invalidated": True,
            "draft_ids": [draft.id],
            "decision_request_ids": [],
            "requires_recompile": True,
        }
        async with database.sessions() as transaction:
            stored_draft = await transaction.get(ExecutionDraftRecord, draft.id)
            stored_revision = await transaction.get(
                ExecutionDraftRevisionRecord,
                revision.id,
            )
            assert stored_draft is not None and stored_draft.status == "invalidated"
            assert stored_revision is not None and stored_revision.status == "superseded"
        await database.close()

    asyncio.run(scenario())


def test_context_can_add_only_authoritative_panel_sources() -> None:
    async def scenario() -> None:
        database, sessions, harness, contexts, _ = await _runtime()
        session_id, run_id = await _accepted_run(sessions)
        project = await harness.create_project(
            command_id="panel-project",
            kind="research",
            title="Agent研究",
            goal="比较可恢复Agent架构",
            status="active",
        )
        package = await harness.create_context_package(
            session_id=session_id,
            run_id=run_id,
            stage="directory",
            items=[],
        )
        revised = await contexts.revise_package(
            package_id=package["id"],
            command_id="context-add-panel-source",
            expected_package_hash=package["package_hash"],
            reason="用户从信息面板选择项目",
            added_source_refs=[
                {
                    "source_kind": "project",
                    "source_id": project["id"],
                    "locked": True,
                }
            ],
        )
        assert revised["items"][0]["title"] == "Agent研究"
        assert revised["items"][0]["source_revision"] == "1"
        assert revised["items"][0]["selection_origin"] == "human"

        with pytest.raises(HarnessValidationError, match="暂不支持"):
            await contexts.revise_package(
                package_id=revised["id"],
                command_id="context-add-untrusted-source",
                expected_package_hash=revised["package_hash"],
                reason="不能伪造任意来源",
                added_source_refs=[
                    {
                        "source_kind": "arbitrary_json",
                        "source_id": "fake",
                    }
                ],
            )
        await database.close()

    asyncio.run(scenario())
