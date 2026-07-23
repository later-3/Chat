from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from backend.app.governance.models import GovernanceOutboxRecord
from backend.app.harness.models import HarnessCommandRecord, HarnessTraceRecord
from backend.app.harness.service import (
    HarnessConflict,
    HarnessService,
    HarnessValidationError,
)
from backend.app.product_sessions.database import ProductDatabase
from backend.app.product_sessions.service import ProductSessionService


class VirtualClock:
    def __init__(self) -> None:
        self.value = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.value

    def advance(self, *, days: int = 0, hours: int = 0) -> None:
        self.value += timedelta(days=days, hours=hours)


async def _runtime() -> tuple[ProductDatabase, ProductSessionService, HarnessService, VirtualClock]:
    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    sessions = ProductSessionService(database)
    await sessions.initialize()
    clock = VirtualClock()
    return database, sessions, HarnessService(database, clock=clock), clock


async def _accepted_run(sessions: ProductSessionService, prompt: str = "测试Harness") -> tuple[str, str]:
    session = await sessions.create_session()
    accepted = await sessions.prepare_agui_run({
        "threadId": session["id"],
        "runId": f"agui-{session['id']}",
        "state": {},
        "messages": [{
            "id": f"message-{session['id']}",
            "role": "user",
            "content": prompt,
        }],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    })
    return session["id"], accepted.product_run_id


def test_project_work_commands_are_idempotent_cas_guarded_and_atomic() -> None:
    async def scenario() -> None:
        database, _, harness, clock = await _runtime()
        project = await harness.create_project(
            command_id="project-create",
            kind="delivery",
            title="贪吃蛇",
            goal="交付可验证的贪吃蛇游戏",
            status="active",
        )
        replay = await harness.create_project(
            command_id="project-create",
            kind="delivery",
            title="贪吃蛇",
            goal="交付可验证的贪吃蛇游戏",
            status="active",
        )
        assert replay == project
        with pytest.raises(HarnessConflict):
            await harness.create_project(
                command_id="project-create",
                kind="delivery",
                title="另一个项目",
                goal="不能复用command_id",
            )

        clock.advance(days=1)
        work = await harness.create_work_item(
            command_id="work-create",
            project_id=project["id"],
            kind="task",
            title="碰撞检测",
            objective="实现并验证边界与自身碰撞",
            status="ready",
        )
        in_progress = await harness.transition_work_item(
            work_item_id=work["id"],
            command_id="work-start",
            expected_row_version=1,
            target_status="in_progress",
            reason="开始实现",
        )
        with pytest.raises(HarnessConflict):
            await harness.transition_work_item(
                work_item_id=work["id"],
                command_id="work-stale",
                expected_row_version=1,
                target_status="blocked",
                reason="过期页面提交",
            )
        with pytest.raises(HarnessValidationError, match="Evidence"):
            await harness.transition_work_item(
                work_item_id=work["id"],
                command_id="work-false-complete",
                expected_row_version=in_progress["row_version"],
                target_status="completed",
                reason="Agent声称完成",
            )
        completed = await harness.transition_work_item(
            work_item_id=work["id"],
            command_id="work-complete",
            expected_row_version=in_progress["row_version"],
            target_status="completed",
            reason="测试已通过",
            evidence=[{"kind": "test", "id": "collision-suite", "status": "passed"}],
        )
        assert completed["status"] == "completed"

        async with database.sessions() as transaction:
            command_count = await transaction.scalar(select(func.count()).select_from(HarnessCommandRecord))
            trace_count = await transaction.scalar(select(func.count()).select_from(HarnessTraceRecord))
            outbox_count = await transaction.scalar(select(func.count()).select_from(GovernanceOutboxRecord))
        assert command_count == trace_count == outbox_count == 4
        await database.close()

    asyncio.run(scenario())


def test_plan_action_note_and_memory_keep_independent_lifecycles() -> None:
    async def scenario() -> None:
        database, _, harness, _ = await _runtime()
        project = await harness.create_project(
            command_id="learning-project",
            kind="learning",
            title="学习Python并发",
            goal="能解释并实践线程、进程与协程",
            status="active",
        )
        work = await harness.create_work_item(
            command_id="learning-work",
            project_id=project["id"],
            kind="learning_unit",
            title="掌握协程",
            objective="完成asyncio练习并解释事件循环",
        )
        with pytest.raises(HarnessValidationError, match="形成环"):
            await harness.create_plan_revision(
                command_id="cyclic-plan",
                work_item_id=work["id"],
                expected_work_row_version=1,
                summary="错误的循环依赖",
                nodes=[
                    {"key": "a", "title": "A", "objective": "A", "dependencies": ["b"]},
                    {"key": "b", "title": "B", "objective": "B", "dependencies": ["a"]},
                ],
            )
        plan = await harness.create_plan_revision(
            command_id="accepted-plan",
            work_item_id=work["id"],
            expected_work_row_version=1,
            summary="先概念、后练习",
            nodes=[
                {"key": "concept", "title": "理解概念", "objective": "解释事件循环"},
                {"key": "practice", "title": "完成练习", "objective": "实现并发下载", "dependencies": ["concept"]},
            ],
            accept=True,
        )
        detail = await harness.get_work_item(work["id"])
        nodes = detail["plan"]["revision"]["nodes"]
        concept = await harness.create_action_item(
            command_id="action-concept",
            project_id=project["id"],
            work_item_id=work["id"],
            plan_node_id=nodes[0]["id"],
            title="解释事件循环",
            assignee_kind="user",
            status="ready",
        )
        practice = await harness.create_action_item(
            command_id="action-practice",
            project_id=project["id"],
            work_item_id=work["id"],
            plan_node_id=nodes[1]["id"],
            title="完成并发下载练习",
            assignee_kind="user",
        )
        with pytest.raises(HarnessValidationError, match="依赖未完成"):
            await harness.transition_action_item(
                action_item_id=practice["id"],
                command_id="practice-too-early",
                expected_row_version=1,
                target_status="ready",
                reason="提前开始",
            )
        concept_running = await harness.transition_action_item(
            action_item_id=concept["id"],
            command_id="concept-start",
            expected_row_version=1,
            target_status="in_progress",
            reason="开始",
        )
        await harness.transition_action_item(
            action_item_id=concept["id"],
            command_id="concept-complete",
            expected_row_version=concept_running["row_version"],
            target_status="completed",
            reason="口述验证通过",
            evidence=[{"kind": "quiz", "score": 1.0}],
        )
        ready = await harness.transition_action_item(
            action_item_id=practice["id"],
            command_id="practice-ready",
            expected_row_version=1,
            target_status="ready",
            reason="依赖已完成",
        )
        assert ready["status"] == "ready"
        assert plan["revision"]["status"] == "accepted"

        note = await harness.capture_note(
            command_id="note-v1",
            kind="learning_note",
            title="事件循环",
            content="第一版理解",
            links=[{"resource_kind": "project", "resource_id": project["id"]}],
        )
        note = await harness.revise_note(
            note_id=note["id"], command_id="note-v2",
            expected_row_version=1, title="事件循环", content="第二版纠正",
        )
        note = await harness.revise_note(
            note_id=note["id"], command_id="note-v3",
            expected_row_version=2, title="事件循环", content="第三版最终理解",
        )
        assert note["current_revision"]["revision"] == 3

        rejected = await harness.propose_memory(
            command_id="memory-candidate-rejected",
            scope_kind="user",
            scope_ref_id=None,
            memory_kind="preference",
            content="我喜欢只看定义",
            source_refs=[{"kind": "note", "id": note["id"], "revision": 3}],
        )
        await harness.resolve_memory_candidate(
            candidate_id=rejected["id"], command_id="memory-reject",
            decision="reject", decision_record_id=None,
        )
        assert (await harness.list_memory())["accepted"] == []

        candidate = await harness.propose_memory(
            command_id="memory-candidate-accepted",
            scope_kind="project",
            scope_ref_id=project["id"],
            memory_kind="preference",
            content="先看例子，再解释概念",
            source_refs=[{"kind": "note", "id": note["id"], "revision": 3}],
        )
        resolved = await harness.resolve_memory_candidate(
            candidate_id=candidate["id"], command_id="memory-accept",
            decision="accept", decision_record_id=None,
        )
        memory = resolved["memory"]
        memory = await harness.revise_memory(
            memory_id=memory["id"], command_id="memory-revise",
            expected_row_version=1, content="先看可运行例子，再解释概念",
            source_refs=[{"kind": "note", "id": note["id"], "revision": 3}],
            reason="用户补充了可运行要求", decision_record_id=None,
        )
        assert memory["current_revision"]["revision"] == 2
        superseded = await harness.transition_memory(
            memory_id=memory["id"], command_id="memory-supersede",
            expected_row_version=2, target_status="superseded",
            reason="偏好已被新规则替代", decision_record_id=None,
        )
        assert superseded["status"] == "superseded"
        assert (await harness.project_context(project["id"]))["accepted_memory"] == []
        await database.close()

    asyncio.run(scenario())


def test_two_stage_context_records_adoption_exclusion_and_authoritative_sources() -> None:
    async def scenario() -> None:
        database, sessions, harness, _ = await _runtime()
        session_id, run_id = await _accepted_run(sessions, "继续贪吃蛇碰撞检测")
        project = await harness.create_project(
            command_id="context-project", kind="delivery", title="贪吃蛇",
            goal="交付贪吃蛇", status="active", session_id=session_id,
        )
        await harness.create_work_item(
            command_id="context-work", project_id=project["id"], kind="task",
            title="碰撞检测", objective="实现碰撞检测", status="ready",
        )
        directory_items, projects = await harness.directory_context_items(
            prompt="继续贪吃蛇碰撞检测",
            summaries=[{"id": "summary-1", "topic": "昨日进度", "summary": {"focus": "碰撞检测"}}],
        )
        assert projects[0]["id"] == project["id"]
        directory = await harness.create_context_package(
            session_id=session_id, run_id=run_id, stage="directory",
            items=directory_items, token_budget=1,
        )
        replay = await harness.create_context_package(
            session_id=session_id, run_id=run_id, stage="directory",
            items=directory_items, token_budget=1,
        )
        assert replay["id"] == directory["id"]
        assert directory["estimated_tokens"] <= 1
        assert any(not value["adopted"] for value in directory["items"])

        detail_items = await harness.detailed_context_items(project["id"])
        detail = await harness.create_context_package(
            session_id=session_id, run_id=run_id, stage="detail", items=detail_items,
            selected_project_id=project["id"], token_budget=6000, status="adopted",
        )
        latest = await harness.latest_context_package(session_id)
        assert latest is not None
        assert latest["id"] == detail["id"]
        assert latest["selected_project_id"] == project["id"]
        assert {value["source_kind"] for value in latest["items"]} >= {"project", "work_item"}
        assert all(value["reason"] for value in latest["items"])
        await database.close()

    asyncio.run(scenario())
