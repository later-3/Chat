"""Long-running Product Harness scenarios with real persistence objects.

Weeks are simulated with an injected clock; no assertion depends on sleeping.
Every scripted turn is still accepted and completed through ProductSessionService,
so the tests exercise the same Product Session, Interaction, Message and Run
tables used by the HTTP/AG-UI composition root.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from sqlalchemy import func, select

from backend.app.governance.models import GovernanceOutboxRecord
from backend.app.harness.models import (
    ContextPackageRecord,
    HarnessCommandRecord,
    HarnessTraceRecord,
    MemoryRevisionRecord,
    NoteRevisionRecord,
)
from backend.app.harness.participant import HarnessTransitionParticipant
from backend.app.harness.service import (
    HarnessConflict,
    HarnessService,
    HarnessValidationError,
)
from backend.app.product_sessions.database import (
    InteractionRecord,
    MessageRecord,
    ProductDatabase,
    RunRecord,
)
from backend.app.product_sessions.service import ProductSessionService


class ScenarioClock:
    def __init__(self) -> None:
        self.origin = datetime(2026, 1, 1, 9, 0, tzinfo=timezone.utc)
        self.value = self.origin

    def __call__(self) -> datetime:
        return self.value

    def at_day(self, day: int, *, hour: int = 9) -> None:
        self.value = self.origin + timedelta(days=day - 1, hours=hour - 9)


async def _accept_prevalidated_result_reference(*args: Any, **kwargs: Any) -> None:
    """Stand in for ResultCommitCoordinator in Harness-only longevity tests.

    Exact chain validation and atomic subject migration are covered by
    ``test_result_commit.py``.  These long scenarios start at the participant
    boundary after that validation has succeeded.
    """


def _gate_projection(key: str) -> list[dict[str, str]]:
    return [{"result_commit_id": f"result-{key}", "claim_id": f"claim-{key}"}]


@dataclass(frozen=True, slots=True)
class ScenarioTurn:
    number: int
    day: int
    session: str
    channel: str
    process: str
    prompt: str
    product_run_id: str


class LongScenarioRunner:
    def __init__(
        self,
        sessions: ProductSessionService,
        clock: ScenarioClock,
    ) -> None:
        self.sessions = sessions
        self.clock = clock
        self.session_ids: dict[str, str] = {}
        self.turns: list[ScenarioTurn] = []

    async def ensure_session(self, alias: str) -> str:
        if alias not in self.session_ids:
            self.session_ids[alias] = (await self.sessions.create_session())["id"]
        return self.session_ids[alias]

    async def turn(
        self,
        *,
        day: int,
        session: str,
        prompt: str,
        channel: str = "web",
        process: str = "api-a",
    ) -> tuple[str, str]:
        self.clock.at_day(day)
        session_id = await self.ensure_session(session)
        number = len(self.turns) + 1
        history = await self.sessions.list_messages(session_id)
        accepted = await self.sessions.prepare_agui_run(
            {
                "threadId": session_id,
                "runId": f"long-{number}",
                "state": {},
                "messages": [
                    *[
                        {
                            "id": value["agui_message_id"],
                            "role": value["role"],
                            "content": value["content"],
                        }
                        for value in history
                    ],
                    {
                        "id": f"user-long-{number}",
                        "role": "user",
                        "content": prompt,
                    },
                ],
                "tools": [],
                "context": [],
                "forwardedProps": {"channel": channel, "process": process},
            }
        )
        await self.sessions.complete_active_run(
            session_id,
            assistant_text=f"TURN_{number}_RESULT",
            agui_message_id=f"assistant-long-{number}",
        )
        self.turns.append(
            ScenarioTurn(
                number=number,
                day=day,
                session=session,
                channel=channel,
                process=process,
                prompt=prompt,
                product_run_id=accepted.product_run_id,
            )
        )
        return session_id, accepted.product_run_id


async def open_runtime(
    database_url: str, clock: ScenarioClock
) -> tuple[
    ProductDatabase,
    ProductSessionService,
    HarnessService,
]:
    database = ProductDatabase(database_url)
    sessions = ProductSessionService(database)
    await sessions.initialize()
    harness = HarnessService(database, clock=clock)
    harness.transition_participant = HarnessTransitionParticipant(
        scope_id=harness.scope_id,
        principal_id=harness.principal_id,
        clock=clock,
        command_recorder=harness.command_recorder,
        completion_reference_validator=_accept_prevalidated_result_reference,
    )
    return database, sessions, harness


DEV_PROMPTS = [
    "做一个可在手机上玩的贪吃蛇，先建立项目。",
    "目标补充：必须有边界碰撞、自身碰撞和移动端手势验证。",
    "把第一版计划拆成碰撞检测、手势和回归测试。",
    "确认新版计划，开始推进。",
    "Python 的 GIL 是什么？这只是一个独立问题。",
    "继续昨天的贪吃蛇碰撞检测。",
    "先实现边界碰撞。",
    "再实现自身碰撞。",
    "Agent 说碰撞检测完成了，先看测试证据。",
    "测试失败，不要标记完成。",
    "把碰撞检测标记为受阻。",
    "我准备修改技术方案。",
    "碰撞检测改用网格坐标，不再用像素边界。",
    "保存一份方案说明。",
    "服务重启后继续。",
    "重复提交刚才同一条Note，不能生成两份。",
    "查询当前计划revision。",
    "查看所有开放行动。",
    "我偏好每次先跑测试，再声明完成。",
    "接受这个Project范围内的偏好。",
    "现在做到哪里了？",
    "从另一个入口查看同一个Project。",
    "开始移动端手势。",
    "移动端手势验证通过。",
    "开始全量回归测试。",
    "回归测试通过。",
    "之前的方案Note失效了。",
    "确认依赖旧Note的Memory不再进入Context。",
    "修复碰撞测试并再次运行。",
    "碰撞检测测试通过。",
    "所有开放Work都完成了吗？",
    "有Evidence后完成Project。",
]


@pytest.mark.anyio
async def test_e2e_long_dev_21d_preserves_work_truth_across_32_turns_and_restart(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'long-dev.db'}"
    clock = ScenarioClock()
    database, sessions, harness = await open_runtime(database_url, clock)
    runner = LongScenarioRunner(sessions, clock)

    project: dict[str, Any] | None = None
    collision: dict[str, Any] | None = None
    gesture: dict[str, Any] | None = None
    regression: dict[str, Any] | None = None
    note: dict[str, Any] | None = None
    accepted_memory: dict[str, Any] | None = None

    day_by_turn = [
        1,
        1,
        1,
        1,
        2,
        3,
        3,
        4,
        5,
        5,
        5,
        8,
        8,
        8,
        8,
        12,
        12,
        12,
        12,
        12,
        14,
        14,
        15,
        15,
        16,
        16,
        18,
        18,
        20,
        20,
        21,
        21,
    ]
    for index, (day, prompt) in enumerate(zip(day_by_turn, DEV_PROMPTS, strict=True), start=1):
        session_alias = "dev-main" if index not in {5, 22} else ("qa" if index == 5 else "dev-mobile")
        channel = "web" if index != 22 else "telegram"
        process = "api-a" if index < 15 else "api-b"
        session_id, run_id = await runner.turn(
            day=day,
            session=session_alias,
            prompt=prompt,
            channel=channel,
            process=process,
        )

        if index == 1:
            project = await harness.create_project(
                command_id="dev-project-propose",
                kind="delivery",
                title="贪吃蛇",
                goal="交付可在手机上玩的贪吃蛇",
                status="proposed",
                session_id=session_id,
            )
        elif index == 2:
            assert project is not None
            project = await harness.transition_project(
                project_id=project["id"],
                command_id="dev-project-activate",
                expected_row_version=project["row_version"],
                target_status="active",
                reason="用户确认补充后的交付目标",
            )
        elif index == 3:
            assert project is not None
            collision = await harness.create_work_item(
                command_id="dev-work-collision",
                project_id=project["id"],
                kind="task",
                title="碰撞检测",
                objective="实现边界与自身碰撞",
                status="draft",
            )
            gesture = await harness.create_work_item(
                command_id="dev-work-gesture",
                project_id=project["id"],
                kind="task",
                title="移动端手势",
                objective="实现并验证滑动控制",
                status="ready",
            )
            regression = await harness.create_work_item(
                command_id="dev-work-regression",
                project_id=project["id"],
                kind="task",
                title="回归测试",
                objective="运行完整游戏回归",
                status="ready",
            )
            await harness.create_plan_revision(
                command_id="dev-plan-v1",
                work_item_id=collision["id"],
                expected_work_row_version=1,
                summary="第一版像素坐标方案",
                nodes=[
                    {"key": "boundary", "title": "边界碰撞", "objective": "验证边界"},
                    {
                        "key": "self",
                        "title": "自身碰撞",
                        "objective": "验证蛇身",
                        "dependencies": ["boundary"],
                    },
                ],
            )
        elif index == 4:
            assert collision is not None
            await harness.create_plan_revision(
                command_id="dev-plan-v2",
                work_item_id=collision["id"],
                expected_work_row_version=1,
                summary="加入移动端和回归验证的已接受计划",
                nodes=[
                    {"key": "collision", "title": "碰撞检测", "objective": "通过碰撞测试"},
                    {
                        "key": "gesture",
                        "title": "移动端手势",
                        "objective": "通过触控测试",
                        "dependencies": ["collision"],
                    },
                    {
                        "key": "regression",
                        "title": "回归",
                        "objective": "通过回归",
                        "dependencies": ["gesture"],
                    },
                ],
                accept=True,
            )
            collision = (await harness.get_work_item(collision["id"]))["work_item"]
        elif index == 5:
            assert project is not None
            snapshot = await harness.project_context(project["id"])
            assert len(snapshot["work_items"]) == 3
            assert snapshot["accepted_memory"] == []
            package = await harness.create_context_package(
                session_id=session_id,
                run_id=run_id,
                stage="directory",
                items=[
                    {
                        "source_kind": "turn_summary",
                        "source_id": "qa-gil",
                        "source_revision": 1,
                        "title": "Python GIL",
                        "content": "独立知识问答，不关联贪吃蛇",
                        "adopted": True,
                        "reason": "本轮独立问题",
                    }
                ],
                token_budget=200,
            )
            assert package["selected_project_id"] is None
        elif index == 6:
            assert project is not None
            detail_items = await harness.detailed_context_items(project["id"])
            package = await harness.create_context_package(
                session_id=session_id,
                run_id=run_id,
                stage="detail",
                items=detail_items,
                selected_project_id=project["id"],
                token_budget=2500,
                status="adopted",
            )
            context_text = "\n".join(item["content"] for item in package["items"])
            assert "独立知识问答" not in context_text
            assert {item["source_kind"] for item in package["items"] if item["adopted"]} >= {
                "project",
                "work_item",
                "task_plan",
            }
        elif index == 7:
            assert collision is not None
            collision = await harness.transition_work_item(
                work_item_id=collision["id"],
                command_id="collision-ready",
                expected_row_version=collision["row_version"],
                target_status="ready",
                reason="计划已确认",
            )
        elif index == 8:
            assert collision is not None
            collision = await harness.transition_work_item(
                work_item_id=collision["id"],
                command_id="collision-start",
                expected_row_version=collision["row_version"],
                target_status="in_progress",
                reason="开始实现碰撞检测",
            )
        elif index == 9:
            assert collision is not None
            with pytest.raises(HarnessValidationError, match="Result Commit Gate"):
                await harness.transition_work_item(
                    work_item_id=collision["id"],
                    command_id="collision-false-complete",
                    expected_row_version=collision["row_version"],
                    target_status="completed",
                    reason="Agent自然语言声称完成",
                )
        elif index == 11:
            assert collision is not None
            collision = await harness.transition_work_item(
                work_item_id=collision["id"],
                command_id="collision-blocked",
                expected_row_version=collision["row_version"],
                target_status="blocked",
                reason="碰撞测试失败",
                evidence=[{"kind": "test", "id": "collision-v1", "status": "failed"}],
            )
        elif index == 13:
            assert collision is not None
            with pytest.raises(HarnessConflict):
                await harness.create_plan_revision(
                    command_id="dev-plan-stale",
                    work_item_id=collision["id"],
                    expected_work_row_version=collision["row_version"] - 1,
                    summary="过期页面方案",
                    nodes=[{"key": "stale", "title": "过期", "objective": "不能覆盖"}],
                    accept=True,
                )
            await harness.create_plan_revision(
                command_id="dev-plan-v3",
                work_item_id=collision["id"],
                expected_work_row_version=collision["row_version"],
                summary="采用网格坐标并重新运行碰撞测试",
                nodes=[
                    {"key": "grid", "title": "网格坐标", "objective": "统一位置表示"},
                    {
                        "key": "collision",
                        "title": "碰撞回归",
                        "objective": "重新测试",
                        "dependencies": ["grid"],
                    },
                ],
                accept=True,
            )
            collision = (await harness.get_work_item(collision["id"]))["work_item"]
        elif index == 14:
            assert project is not None
            note = await harness.capture_note(
                command_id="dev-note-grid",
                kind="project_note",
                title="网格坐标方案",
                content="位置统一为整数网格坐标。",
                links=[{"resource_kind": "project", "resource_id": project["id"]}],
            )
        elif index == 15:
            # Simulate losing the API process and reopening the same Product DB.
            await database.close()
            database, sessions, harness = await open_runtime(database_url, clock)
            runner.sessions = sessions
            assert project is not None
            assert (await harness.get_project(project["id"]))["status"] == "active"
        elif index == 16:
            assert note is not None
            replay = await harness.capture_note(
                command_id="dev-note-grid",
                kind="project_note",
                title="网格坐标方案",
                content="位置统一为整数网格坐标。",
                links=[{"resource_kind": "project", "resource_id": project["id"]}],
            )
            assert replay["id"] == note["id"]
        elif index == 19:
            assert project is not None and note is not None
            candidate = await harness.propose_memory(
                command_id="dev-memory-propose",
                scope_kind="project",
                scope_ref_id=project["id"],
                memory_kind="experience_rule",
                content="先运行测试，再声明完成。",
                source_refs=[{"kind": "note", "id": note["id"], "revision": 1}],
            )
        elif index == 20:
            resolved = await harness.resolve_memory_candidate(
                candidate_id=candidate["id"],
                command_id="dev-memory-accept",
                decision="accept",
                decision_record_id=None,
            )
            accepted_memory = resolved["memory"]
        elif index in {21, 22}:
            assert project is not None
            status = await harness.project_context(project["id"])
            assert len(status["work_items"]) == 3
            assert any(item["status"] == "blocked" for item in status["work_items"])
        elif index == 23:
            assert gesture is not None
            gesture = await harness.transition_work_item(
                work_item_id=gesture["id"],
                command_id="gesture-start",
                expected_row_version=gesture["row_version"],
                target_status="in_progress",
                reason="开始移动端手势",
            )
        elif index == 24:
            assert gesture is not None
            gesture = await harness.transition_work_item(
                work_item_id=gesture["id"],
                command_id="gesture-complete",
                expected_row_version=gesture["row_version"],
                target_status="completed",
                reason="触控测试通过",
                evidence=_gate_projection("gesture-suite"),
            )
        elif index == 25:
            assert regression is not None
            regression = await harness.transition_work_item(
                work_item_id=regression["id"],
                command_id="regression-start",
                expected_row_version=regression["row_version"],
                target_status="in_progress",
                reason="开始全量回归",
            )
        elif index == 26:
            assert regression is not None
            regression = await harness.transition_work_item(
                work_item_id=regression["id"],
                command_id="regression-complete",
                expected_row_version=regression["row_version"],
                target_status="completed",
                reason="回归测试通过",
                evidence=_gate_projection("game-regression"),
            )
        elif index == 27:
            assert note is not None
            note = await harness.transition_note(
                note_id=note["id"],
                command_id="dev-note-archive",
                expected_row_version=note["row_version"],
                target_status="archived",
                reason="该方案来源已被撤回",
            )
        elif index == 28:
            assert project is not None and accepted_memory is not None
            context = await harness.project_context(project["id"])
            assert context["accepted_memory"] == []
            memory_rows = await harness.list_memory(
                scope_kind="project",
                scope_ref_id=project["id"],
                include_candidates=False,
            )
            assert (
                next(item for item in memory_rows["accepted"] if item["id"] == accepted_memory["id"])[
                    "status"
                ]
                == "invalid"
            )
        elif index == 29:
            assert collision is not None
            collision = await harness.transition_work_item(
                work_item_id=collision["id"],
                command_id="collision-resume",
                expected_row_version=collision["row_version"],
                target_status="in_progress",
                reason="网格坐标修复完成，重新测试",
            )
        elif index == 30:
            assert collision is not None
            collision = await harness.transition_work_item(
                work_item_id=collision["id"],
                command_id="collision-complete",
                expected_row_version=collision["row_version"],
                target_status="completed",
                reason="碰撞测试通过",
                evidence=_gate_projection("collision-v2"),
            )
        elif index == 31:
            assert project is not None
            status = await harness.project_context(project["id"])
            assert all(item["status"] == "completed" for item in status["work_items"])
        elif index == 32:
            assert project is not None
            project = await harness.transition_project(
                project_id=project["id"],
                command_id="dev-project-complete",
                expected_row_version=project["row_version"],
                target_status="completed",
                reason="3个WorkItem均有通过Evidence",
            )

    assert len(runner.turns) == 32
    assert runner.turns[-1].day == 21
    assert {turn.channel for turn in runner.turns} == {"web", "telegram"}
    assert {turn.process for turn in runner.turns} == {"api-a", "api-b"}
    assert project is not None and project["status"] == "completed"
    async with database.sessions() as transaction:
        interaction_count = await transaction.scalar(select(func.count()).select_from(InteractionRecord))
        run_count = await transaction.scalar(select(func.count()).select_from(RunRecord))
        message_count = await transaction.scalar(select(func.count()).select_from(MessageRecord))
        command_count = await transaction.scalar(select(func.count()).select_from(HarnessCommandRecord))
        trace_count = await transaction.scalar(select(func.count()).select_from(HarnessTraceRecord))
        outbox_count = await transaction.scalar(select(func.count()).select_from(GovernanceOutboxRecord))
    assert interaction_count == run_count == 32
    assert message_count == 64
    assert command_count == trace_count == outbox_count
    await database.close()


LEARNING_PROMPTS = [
    "建立一个四周Python并发学习项目。",
    "拆成线程、进程、协程和综合练习。",
    "制定先概念后练习的路径。",
    "开始线程单元。",
    "记录GIL第一版理解。",
    "我喜欢只看定义，记住这个偏好。",
    "拒绝刚才的长期偏好。",
    "做一次线程安全测验。",
    "测验失败，标记薄弱点。",
    "切换到另一个Session问一道无关数学题。",
    "回到学习项目继续。",
    "查看当前Context，拒绝的Memory不能出现。",
    "纠正GIL笔记第二版。",
    "做一次协程事件循环练习。",
    "记录事件循环错题。",
    "我哪里薄弱？",
    "根据失败Evidence给出下一步。",
    "再次说明偏好：先看可运行例子。",
    "这次接受该偏好。",
    "用新偏好讲解协程。",
    "把GIL笔记纠正为第三版。",
    "开始进程单元。",
    "比较线程池与进程池。",
    "完成一个CPU密集练习。",
    "从第二个Session继续同一学习项目。",
    "查询四个学习单元状态。",
    "复习失败的线程安全题。",
    "生成一个新的练习Action。",
    "完成事件循环练习并附证据。",
    "开始综合练习。",
    "综合练习第一次失败。",
    "记录失败Evidence。",
    "修复后再测。",
    "综合练习通过。",
    "总结本周决策，不复制全部聊天。",
    "查看LearningTrack进度。",
    "检查Accepted Memory来源。",
    "检查Note三版仍可追溯。",
    "按Token预算组装最终复习Context。",
    "给出第28天复习重点。",
]


@pytest.mark.anyio
async def test_e2e_long_learning_28d_keeps_40_turns_but_assembles_bounded_context(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'long-learning.db'}"
    clock = ScenarioClock()
    database, sessions, harness = await open_runtime(database_url, clock)
    runner = LongScenarioRunner(sessions, clock)
    project: dict[str, Any] | None = None
    units: list[dict[str, Any]] = []
    note: dict[str, Any] | None = None
    final_context: dict[str, Any] | None = None

    for index, prompt in enumerate(LEARNING_PROMPTS, start=1):
        day = min(28, 1 + (index - 1) * 27 // 39)
        alias = "learn-main" if index not in {10, 25} else "learn-secondary"
        session_id, run_id = await runner.turn(day=day, session=alias, prompt=prompt)
        if index == 1:
            project = await harness.create_project(
                command_id="learn-project",
                kind="learning",
                title="Python并发四周学习",
                goal="能解释并实践线程、进程、协程和并发选择",
                status="active",
                session_id=session_id,
            )
        elif index == 2:
            assert project is not None
            for key, title in (
                ("thread", "线程与GIL"),
                ("process", "进程池"),
                ("asyncio", "协程与事件循环"),
                ("capstone", "综合练习"),
            ):
                units.append(
                    await harness.create_work_item(
                        command_id=f"learn-unit-{key}",
                        project_id=project["id"],
                        kind="learning_unit",
                        title=title,
                        objective=f"掌握{title}",
                        status="ready",
                    )
                )
        elif index == 3:
            await harness.create_plan_revision(
                command_id="learn-plan-v1",
                work_item_id=units[0]["id"],
                expected_work_row_version=1,
                summary="概念、示例、练习、复盘",
                nodes=[
                    {"key": "concept", "title": "概念", "objective": "准确解释"},
                    {"key": "example", "title": "示例", "objective": "运行示例", "dependencies": ["concept"]},
                    {
                        "key": "practice",
                        "title": "练习",
                        "objective": "独立完成",
                        "dependencies": ["example"],
                    },
                ],
                accept=True,
            )
            units[0] = (await harness.get_work_item(units[0]["id"]))["work_item"]
        elif index == 4:
            units[0] = await harness.transition_work_item(
                work_item_id=units[0]["id"],
                command_id="thread-start",
                expected_row_version=units[0]["row_version"],
                target_status="in_progress",
                reason="开始线程单元",
            )
        elif index == 5:
            assert project is not None
            note = await harness.capture_note(
                command_id="gil-note-v1",
                kind="learning_note",
                title="GIL理解",
                content="第一版：GIL让所有Python代码只能串行。",
                links=[{"resource_kind": "project", "resource_id": project["id"]}],
            )
        elif index == 6:
            rejected = await harness.propose_memory(
                command_id="learn-pref-rejected",
                scope_kind="user",
                scope_ref_id=None,
                memory_kind="preference",
                content="只看定义。",
                source_refs=[],
            )
        elif index == 7:
            await harness.resolve_memory_candidate(
                candidate_id=rejected["id"],
                command_id="learn-pref-reject",
                decision="reject",
                decision_record_id=None,
            )
        elif index == 9:
            units[0] = await harness.transition_work_item(
                work_item_id=units[0]["id"],
                command_id="thread-blocked",
                expected_row_version=units[0]["row_version"],
                target_status="blocked",
                reason="线程安全测验失败",
                evidence=[{"kind": "quiz", "id": "thread-safety", "status": "failed", "score": 0.4}],
            )
        elif index == 12:
            assert project is not None
            package = await harness.create_context_package(
                session_id=session_id,
                run_id=run_id,
                stage="detail",
                items=await harness.detailed_context_items(project["id"]),
                selected_project_id=project["id"],
                token_budget=800,
                status="adopted",
            )
            assert all(item["source_kind"] != "accepted_memory" for item in package["items"])
        elif index == 13:
            assert note is not None
            note = await harness.revise_note(
                note_id=note["id"],
                command_id="gil-note-v2",
                expected_row_version=note["row_version"],
                title="GIL理解",
                content="第二版：GIL限制同一进程内CPython字节码的并行执行。",
            )
        elif index == 16:
            assert project is not None
            weak = await harness.project_context(project["id"])
            thread = next(item for item in weak["work_items"] if item["id"] == units[0]["id"])
            assert thread["status"] == "blocked"
            assert thread["completion_evidence"][0]["status"] == "failed"
        elif index == 18:
            assert project is not None and note is not None
            accepted_candidate = await harness.propose_memory(
                command_id="learn-pref-accepted",
                scope_kind="project",
                scope_ref_id=project["id"],
                memory_kind="preference",
                content="先看可运行例子，再解释概念。",
                source_refs=[{"kind": "note", "id": note["id"], "revision": 2}],
            )
        elif index == 19:
            await harness.resolve_memory_candidate(
                candidate_id=accepted_candidate["id"],
                command_id="learn-pref-accept",
                decision="accept",
                decision_record_id=None,
            )
        elif index == 21:
            assert note is not None
            note = await harness.revise_note(
                note_id=note["id"],
                command_id="gil-note-v3",
                expected_row_version=note["row_version"],
                title="GIL理解",
                content="第三版：GIL是CPython实现约束；I/O并发与多进程仍有不同适用场景。",
            )
        elif index == 29:
            units[2] = await harness.transition_work_item(
                work_item_id=units[2]["id"],
                command_id="asyncio-start",
                expected_row_version=units[2]["row_version"],
                target_status="in_progress",
                reason="开始事件循环练习",
            )
            units[2] = await harness.transition_work_item(
                work_item_id=units[2]["id"],
                command_id="asyncio-complete",
                expected_row_version=units[2]["row_version"],
                target_status="completed",
                reason="事件循环练习通过",
                evidence=_gate_projection("asyncio-loop"),
            )
        elif index == 31:
            units[3] = await harness.transition_work_item(
                work_item_id=units[3]["id"],
                command_id="capstone-start",
                expected_row_version=units[3]["row_version"],
                target_status="in_progress",
                reason="开始综合练习",
            )
        elif index == 32:
            units[3] = await harness.transition_work_item(
                work_item_id=units[3]["id"],
                command_id="capstone-blocked",
                expected_row_version=units[3]["row_version"],
                target_status="blocked",
                reason="首次运行失败",
                evidence=[{"kind": "test", "id": "capstone-v1", "status": "failed"}],
            )
        elif index == 34:
            units[3] = await harness.transition_work_item(
                work_item_id=units[3]["id"],
                command_id="capstone-resume",
                expected_row_version=units[3]["row_version"],
                target_status="in_progress",
                reason="修复后重测",
            )
            units[3] = await harness.transition_work_item(
                work_item_id=units[3]["id"],
                command_id="capstone-complete",
                expected_row_version=units[3]["row_version"],
                target_status="completed",
                reason="综合练习通过",
                evidence=_gate_projection("capstone-v2"),
            )
        elif index == 36:
            tracks = await harness.learning_tracks()
            assert tracks[0]["progress"] == {"completed": 2, "total": 4}
        elif index == 37:
            assert project is not None
            memory = await harness.list_memory(
                scope_kind="project",
                scope_ref_id=project["id"],
                include_candidates=False,
                statuses=("accepted",),
            )
            assert len(memory["accepted"]) == 1
            assert memory["accepted"][0]["current_revision"]["source_refs"][0]["revision"] == 2
        elif index == 38:
            assert note is not None
            async with database.sessions() as transaction:
                revision_count = await transaction.scalar(
                    select(func.count())
                    .select_from(NoteRevisionRecord)
                    .where(NoteRevisionRecord.note_id == note["id"])
                )
            assert revision_count == 3
        elif index == 39:
            assert project is not None
            final_context = await harness.create_context_package(
                session_id=session_id,
                run_id=run_id,
                stage="detail",
                items=await harness.detailed_context_items(project["id"]),
                selected_project_id=project["id"],
                token_budget=500,
                status="adopted",
            )
            assert final_context["estimated_tokens"] <= 500
            all_content = "\n".join(item["content"] for item in final_context["items"])
            assert "TURN_1_RESULT" not in all_content
            assert "TURN_40_RESULT" not in all_content
            assert any(
                item["source_kind"] == "accepted_memory" and item["adopted"]
                for item in final_context["items"]
            )

    assert len(runner.turns) == 40
    assert runner.turns[-1].day == 28
    assert set(runner.session_ids) == {"learn-main", "learn-secondary"}
    assert final_context is not None
    async with database.sessions() as transaction:
        interaction_count = await transaction.scalar(select(func.count()).select_from(InteractionRecord))
        message_count = await transaction.scalar(select(func.count()).select_from(MessageRecord))
        memory_revision_count = await transaction.scalar(
            select(func.count()).select_from(MemoryRevisionRecord)
        )
    assert interaction_count == 40
    assert message_count == 80
    assert memory_revision_count == 1
    await database.close()


@pytest.mark.anyio
async def test_e2e_three_day_learning_project_switches_preserve_focus_and_work_truth(tmp_path) -> None:
    """A user can change focus without merging unrelated durable context.

    The scenario deliberately crosses Product Sessions and reconstructs the backend
    services from the same durable database to simulate an API-process restart:
    learn -> delivery project -> learn -> next-day learn -> new delivery project ->
    project overview -> learn.  Project/Work/Note/Memory remain durable, while each
    detail ContextPackage contains only the explicitly selected Project working set.
    """

    database_url = f"sqlite+aiosqlite:///{tmp_path / 'mixed-focus.db'}"
    clock = ScenarioClock()
    database, sessions, harness = await open_runtime(database_url, clock)
    runner = LongScenarioRunner(sessions, clock)

    # Day 1: establish a learning track and its accepted working method.
    learn_session, learn_run = await runner.turn(
        day=1,
        session="learn-day-1",
        prompt="开始学习FastAPI依赖注入，先做一个可运行例子。",
    )
    learning = await harness.create_project(
        command_id="mixed-learning-project",
        kind="learning",
        title="FastAPI依赖注入学习",
        goal="能独立编写、测试并解释FastAPI依赖注入",
        status="active",
        session_id=learn_session,
    )
    dependency_unit = await harness.create_work_item(
        command_id="mixed-learning-unit",
        project_id=learning["id"],
        kind="learning_unit",
        title="依赖注入基础与可运行例子",
        objective="运行一个带Depends的最小API并解释依赖解析过程",
        status="ready",
    )
    await harness.create_plan_revision(
        command_id="mixed-learning-plan",
        work_item_id=dependency_unit["id"],
        expected_work_row_version=dependency_unit["row_version"],
        summary="先运行例子，再解释解析链，最后写测试",
        nodes=[
            {"key": "run", "title": "运行例子", "objective": "验证最小API"},
            {
                "key": "explain",
                "title": "解释依赖链",
                "objective": "说清Depends解析顺序",
                "dependencies": ["run"],
            },
            {
                "key": "test",
                "title": "依赖覆盖测试",
                "objective": "使用dependency_overrides写测试",
                "dependencies": ["explain"],
            },
        ],
        accept=True,
    )
    dependency_unit = (await harness.get_work_item(dependency_unit["id"]))["work_item"]
    dependency_unit = await harness.transition_work_item(
        work_item_id=dependency_unit["id"],
        command_id="mixed-learning-start",
        expected_row_version=dependency_unit["row_version"],
        target_status="in_progress",
        reason="用户开始运行第一个Depends示例",
    )
    practice = await harness.create_action_item(
        command_id="mixed-learning-action",
        project_id=learning["id"],
        work_item_id=dependency_unit["id"],
        title="运行并保存Depends最小例子",
        assignee_kind="user",
        status="ready",
    )
    learning_note = await harness.capture_note(
        command_id="mixed-learning-note",
        kind="learning_note",
        title="Depends解析要点",
        content="FastAPI先解析依赖图，再把依赖结果注入路径函数；下一步验证dependency_overrides。",
        links=[{"resource_kind": "project", "resource_id": learning["id"]}],
    )
    memory_candidate = await harness.propose_memory(
        command_id="mixed-learning-memory-candidate",
        scope_kind="project",
        scope_ref_id=learning["id"],
        memory_kind="preference",
        content="学习技术概念时先运行最小例子，再总结原理。",
        source_refs=[{"kind": "note", "id": learning_note["id"], "revision": 1}],
    )
    accepted_learning_memory = (
        await harness.resolve_memory_candidate(
            candidate_id=memory_candidate["id"],
            command_id="mixed-learning-memory-accept",
            decision="accept",
            decision_record_id=None,
        )
    )["memory"]
    initial_learning_context = await harness.create_context_package(
        session_id=learn_session,
        run_id=learn_run,
        stage="detail",
        items=await harness.detailed_context_items(learning["id"]),
        selected_project_id=learning["id"],
        token_budget=1200,
        status="adopted",
    )
    assert initial_learning_context["estimated_tokens"] <= 1200

    # Still day 1: switch to a delivery Project. Its detail context must not inherit
    # the learning Note or learning-scoped Memory merely because it is recent.
    api_session, api_run = await runner.turn(
        day=1,
        session="bookmark-api",
        prompt="暂停学习，推进书签API项目，先实现列表接口。",
    )
    bookmark = await harness.create_project(
        command_id="mixed-bookmark-project",
        kind="delivery",
        title="书签API",
        goal="交付支持查询和新增书签的HTTP API",
        status="active",
        session_id=api_session,
    )
    bookmark_list = await harness.create_work_item(
        command_id="mixed-bookmark-list",
        project_id=bookmark["id"],
        kind="task",
        title="书签列表接口",
        objective="实现GET /bookmarks并通过接口测试",
        status="ready",
    )
    bookmark_list = await harness.transition_work_item(
        work_item_id=bookmark_list["id"],
        command_id="mixed-bookmark-start",
        expected_row_version=bookmark_list["row_version"],
        target_status="in_progress",
        reason="已确认接口范围，开始实现",
    )
    bookmark_note = await harness.capture_note(
        command_id="mixed-bookmark-note",
        kind="project_note",
        title="书签API接口约定",
        content="GET /bookmarks返回按created_at倒序的书签列表。",
        links=[{"resource_kind": "project", "resource_id": bookmark["id"]}],
    )
    bookmark_context = await harness.create_context_package(
        session_id=api_session,
        run_id=api_run,
        stage="detail",
        items=await harness.detailed_context_items(bookmark["id"]),
        selected_project_id=bookmark["id"],
        token_budget=1200,
        status="adopted",
    )
    bookmark_sources = {item["source_id"] for item in bookmark_context["items"] if item["adopted"]}
    assert bookmark_sources >= {bookmark["id"], bookmark_list["id"], bookmark_note["id"]}
    assert learning_note["id"] not in bookmark_sources
    assert accepted_learning_memory["id"] not in bookmark_sources

    # Return to learning on day 1. Stage A can see both lightweight directory
    # entries; Stage B binds one Project and excludes the delivery working set.
    return_session, return_run = await runner.turn(
        day=1,
        session="learn-day-1",
        prompt="回到FastAPI依赖注入学习，继续刚才的最小例子。",
    )
    directory_items, directory_projects = await harness.directory_context_items(
        prompt="回到FastAPI依赖注入学习，继续刚才的最小例子。",
        summaries=[
            {
                "id": "day-1-learning-summary",
                "topic": "依赖注入学习进度",
                "summary": {"focus": "已开始Depends最小例子，下一步验证依赖覆盖测试"},
            }
        ],
    )
    assert directory_projects[0]["id"] == learning["id"]
    assert {value["id"] for value in directory_projects} == {learning["id"], bookmark["id"]}
    await harness.create_context_package(
        session_id=return_session,
        run_id=return_run,
        stage="directory",
        items=directory_items,
        token_budget=900,
        status="candidate",
    )
    return_learning_context = await harness.create_context_package(
        session_id=return_session,
        run_id=return_run,
        stage="detail",
        items=await harness.detailed_context_items(learning["id"]),
        selected_project_id=learning["id"],
        token_budget=1200,
        status="adopted",
    )
    return_sources = {item["source_id"] for item in return_learning_context["items"] if item["adopted"]}
    assert return_sources >= {
        learning["id"],
        dependency_unit["id"],
        practice["id"],
        learning_note["id"],
        accepted_learning_memory["id"],
    }
    assert bookmark["id"] not in return_sources
    assert bookmark_list["id"] not in return_sources
    assert bookmark_note["id"] not in return_sources

    # Day 2: restart the API process and continue from a new Product Session.
    await database.close()
    database, sessions, harness = await open_runtime(database_url, clock)
    runner.sessions = sessions
    next_day_session, next_day_run = await runner.turn(
        day=2,
        session="learn-day-2",
        prompt="继续昨天的FastAPI依赖注入学习，完成最小例子后做依赖覆盖测试。",
        process="api-b",
    )
    next_day_directory, next_day_projects = await harness.directory_context_items(
        prompt="继续昨天的FastAPI依赖注入学习，完成最小例子后做依赖覆盖测试。",
        summaries=[
            {
                "id": "day-1-learning-summary",
                "topic": "依赖注入学习进度",
                "summary": {"focus": "Depends最小例子进行中", "next": "dependency_overrides测试"},
            }
        ],
    )
    assert next_day_projects[0]["id"] == learning["id"]
    await harness.create_context_package(
        session_id=next_day_session,
        run_id=next_day_run,
        stage="directory",
        items=next_day_directory,
        token_budget=900,
        status="candidate",
    )
    next_day_context = await harness.create_context_package(
        session_id=next_day_session,
        run_id=next_day_run,
        stage="detail",
        items=await harness.detailed_context_items(learning["id"]),
        selected_project_id=learning["id"],
        token_budget=1200,
        status="adopted",
    )
    next_day_text = "\n".join(item["content"] for item in next_day_context["items"] if item["adopted"])
    assert "dependency_overrides" in next_day_text
    assert "GET /bookmarks" not in next_day_text
    assert "TURN_" not in next_day_text
    practice = await harness.transition_action_item(
        action_item_id=practice["id"],
        command_id="mixed-learning-example-complete",
        expected_row_version=practice["row_version"],
        target_status="in_progress",
        reason="开始运行Depends例子",
    )
    practice = await harness.transition_action_item(
        action_item_id=practice["id"],
        command_id="mixed-learning-example-evidence",
        expected_row_version=practice["row_version"],
        target_status="completed",
        reason="最小例子已运行通过",
        evidence=_gate_projection("fastapi-depends-example"),
    )
    coverage_unit = await harness.create_work_item(
        command_id="mixed-learning-coverage-unit",
        project_id=learning["id"],
        kind="learning_unit",
        title="dependency_overrides测试",
        objective="能用依赖覆盖隔离外部服务并验证API",
        status="ready",
    )
    coverage_unit = await harness.transition_work_item(
        work_item_id=coverage_unit["id"],
        command_id="mixed-learning-coverage-start",
        expected_row_version=coverage_unit["row_version"],
        target_status="in_progress",
        reason="最小例子完成，进入测试练习",
    )

    # Day 3: a genuinely new Project must coexist without overwriting either prior focus.
    cli_session, cli_run = await runner.turn(
        day=3,
        session="vocabulary-cli",
        prompt="新开一个背单词CLI项目，先做导入词表功能。",
        process="api-b",
    )
    vocabulary = await harness.create_project(
        command_id="mixed-vocabulary-project",
        kind="delivery",
        title="背单词CLI",
        goal="交付支持词表导入和每日复习的命令行工具",
        status="active",
        session_id=cli_session,
    )
    import_words = await harness.create_work_item(
        command_id="mixed-vocabulary-import",
        project_id=vocabulary["id"],
        kind="task",
        title="导入词表",
        objective="从CSV导入单词并报告错误行",
        status="ready",
    )
    import_words = await harness.transition_work_item(
        work_item_id=import_words["id"],
        command_id="mixed-vocabulary-start",
        expected_row_version=import_words["row_version"],
        target_status="in_progress",
        reason="新Project范围已确认",
    )
    cli_context = await harness.create_context_package(
        session_id=cli_session,
        run_id=cli_run,
        stage="detail",
        items=await harness.detailed_context_items(vocabulary["id"]),
        selected_project_id=vocabulary["id"],
        token_budget=1000,
        status="adopted",
    )
    cli_sources = {item["source_id"] for item in cli_context["items"] if item["adopted"]}
    assert cli_sources >= {vocabulary["id"], import_words["id"]}
    assert learning["id"] not in cli_sources
    assert bookmark["id"] not in cli_sources

    # "What projects do I have?" is a directory query, not a request to create
    # another Project. It returns the three authoritative aggregates.
    overview_session, overview_run = await runner.turn(
        day=3,
        session="project-overview",
        prompt="我现在有哪些项目？只查看列表。",
        process="api-b",
    )
    overview_items, overview_projects = await harness.directory_context_items(
        prompt="我现在有哪些项目？只查看列表。",
        summaries=[],
    )
    assert {value["id"] for value in overview_projects} == {
        learning["id"],
        bookmark["id"],
        vocabulary["id"],
    }
    overview = await harness.create_context_package(
        session_id=overview_session,
        run_id=overview_run,
        stage="directory",
        items=overview_items,
        token_budget=1000,
        status="adopted",
    )
    assert overview["selected_project_id"] is None
    assert {item["source_id"] for item in overview["items"] if item["adopted"]} == {
        learning["id"],
        bookmark["id"],
        vocabulary["id"],
    }

    # The learning track remains resumable after both delivery Projects were touched.
    final_session, final_run = await runner.turn(
        day=3,
        session="learn-day-2",
        prompt="回到FastAPI学习，继续dependency_overrides测试。",
        process="api-b",
    )
    final_context = await harness.create_context_package(
        session_id=final_session,
        run_id=final_run,
        stage="detail",
        items=await harness.detailed_context_items(learning["id"]),
        selected_project_id=learning["id"],
        token_budget=1400,
        status="adopted",
    )
    final_sources = {item["source_id"] for item in final_context["items"] if item["adopted"]}
    assert final_sources >= {
        learning["id"],
        dependency_unit["id"],
        coverage_unit["id"],
        learning_note["id"],
        accepted_learning_memory["id"],
    }
    assert bookmark["id"] not in final_sources
    assert vocabulary["id"] not in final_sources

    projects = await harness.list_projects(statuses=("active",))
    assert {(value["id"], value["kind"]) for value in projects} == {
        (learning["id"], "learning"),
        (bookmark["id"], "delivery"),
        (vocabulary["id"], "delivery"),
    }
    learning_track = next(
        value for value in await harness.learning_tracks() if value["project"]["id"] == learning["id"]
    )
    assert learning_track["progress"] == {"completed": 0, "total": 2}
    assert (
        next(value for value in learning_track["units"] if value["id"] == coverage_unit["id"])["status"]
        == "in_progress"
    )
    assert (await harness.get_work_item(bookmark_list["id"]))["work_item"]["status"] == "in_progress"
    assert (await harness.get_work_item(import_words["id"]))["work_item"]["status"] == "in_progress"
    persisted_practice = next(
        value
        for value in await harness.list_action_items(work_item_id=dependency_unit["id"])
        if value["id"] == practice["id"]
    )
    assert persisted_practice["status"] == "completed"

    async with database.sessions() as transaction:
        context_count = await transaction.scalar(select(func.count()).select_from(ContextPackageRecord))
        interaction_count = await transaction.scalar(select(func.count()).select_from(InteractionRecord))
        message_count = await transaction.scalar(select(func.count()).select_from(MessageRecord))
    assert context_count == 9
    assert interaction_count == len(runner.turns) == 7
    assert message_count == 14
    await database.close()
