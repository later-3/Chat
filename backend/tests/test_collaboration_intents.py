from __future__ import annotations

import asyncio

import pytest

from backend.app.collaboration_intents import CollaborationIntentService
from backend.app.harness.contracts import HarnessConflict, HarnessValidationError
from backend.app.product_sessions.database import ProductDatabase
from backend.app.product_sessions.service import ProductSessionService


async def _runtime() -> tuple[
    ProductDatabase,
    ProductSessionService,
    CollaborationIntentService,
]:
    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    sessions = ProductSessionService(database)
    intents = CollaborationIntentService(database)
    await sessions.initialize()
    return database, sessions, intents


async def _accepted_run(
    sessions: ProductSessionService,
    *,
    session_id: str | None = None,
    suffix: str,
) -> tuple[str, str]:
    if session_id is None:
        session_id = (await sessions.create_session())["id"]
    history = await sessions.list_messages(session_id)
    accepted = await sessions.prepare_agui_run(
        {
            "threadId": session_id,
            "runId": f"intent-run-{suffix}",
            "state": {},
            "messages": [
                {
                    "id": value["agui_message_id"],
                    "role": value["role"],
                    "content": value["content"],
                }
                for value in history
            ]
            + [
                {
                    "id": f"intent-user-{suffix}",
                    "role": "user",
                    "content": f"用户输入 {suffix}",
                }
            ],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
    )
    return session_id, accepted.product_run_id


def test_multi_intent_set_is_immutable_ordered_and_idempotent() -> None:
    async def scenario() -> None:
        database, sessions, service = await _runtime()
        session_id, run_id = await _accepted_run(sessions, suffix="multi")
        candidates = [
            {
                "branch_key": "learn_outbox",
                "scenario": "learning",
                "goal": "学习Outbox",
                "expected_outcome": "能解释恢复语义",
                "confidence": 0.93,
                "needs_plan": True,
                "context_keywords": ["Outbox", "恢复"],
                "reason_summary": "用户明确提出学习目标",
            },
            {
                "branch_key": "apply_chat",
                "scenario": "continue_project",
                "goal": "把Outbox经验应用到Chat项目",
                "expected_outcome": "形成可验证的改造",
                "confidence": 0.88,
                "project_hint": "Chat",
                "needs_plan": True,
                "dependency_branch_keys": ["learn_outbox"],
                "constraints": ["不修改参考仓库"],
                "reason_summary": "第二个目标依赖先理解Outbox",
            },
        ]
        created = await service.record_candidate(
            run_id=run_id,
            origin_prompt="先学习Outbox，再用到Chat项目",
            intents=candidates,
            source_model_call_revision_id=None,
        )
        replay = await service.record_candidate(
            run_id=run_id,
            origin_prompt="先学习Outbox，再用到Chat项目",
            intents=candidates,
            source_model_call_revision_id=None,
        )

        assert replay == created
        assert created["session_id"] == session_id
        assert created["current_revision"]["revision"] == 1
        assert created["current_revision"]["combination_policy"] == "sequential"
        assert created["current_revision"]["execution_order"] == ["learn_outbox", "apply_chat"]
        assert [value["branch_key"] for value in created["intents"]] == [
            "learn_outbox",
            "apply_chat",
        ]
        assert created["intents"][1]["current_revision"]["dependency_branch_keys"] == ["learn_outbox"]
        assert await service.get_for_run(run_id) == created
        assert (await service.list_for_session(session_id))[0] == created
        await database.close()

    asyncio.run(scenario())


def test_human_intent_revision_uses_cas_and_accepts_exact_snapshot() -> None:
    async def scenario() -> None:
        database, sessions, service = await _runtime()
        _, run_id = await _accepted_run(sessions, suffix="revision")
        created = await service.record_candidate(
            run_id=run_id,
            origin_prompt="继续Chat项目",
            intents=[
                {
                    "scenario": "continue_project",
                    "goal": "继续Chat项目",
                    "confidence": 0.8,
                    "project_hint": "Chat",
                    "needs_plan": True,
                    "reason_summary": "识别到项目提示",
                }
            ],
            source_model_call_revision_id=None,
        )
        intent = created["intents"][0]
        revised = await service.revise_intent(
            intent_id=intent["id"],
            expected_set_revision_hash=created["current_revision"]["revision_hash"],
            changes={
                "goal": "只审查Chat项目的恢复语义",
                "expected_outcome": "给出问题清单，不改代码",
                "needs_plan": False,
                "constraints": ["只读审查"],
            },
            reason="用户收窄了本轮目标和权限",
        )

        assert revised["current_revision"]["revision"] == 2
        assert revised["status"] == "candidate"
        assert revised["accepted_revision_id"] is None
        assert revised["intents"][0]["current_revision"]["revision"] == 2
        assert revised["intents"][0]["current_revision"]["author_kind"] == "human"
        assert revised["intents"][0]["current_revision"]["goal"] == "只审查Chat项目的恢复语义"
        assert revised["intents"][0]["current_revision"]["constraints"] == ["只读审查"]

        with pytest.raises(HarnessConflict):
            await service.revise_intent(
                intent_id=intent["id"],
                expected_set_revision_hash=created["current_revision"]["revision_hash"],
                changes={"goal": "过期页面覆盖"},
                reason="过期提交",
            )

        accepted = await service.accept_current(
            intent_set_id=revised["id"],
            expected_revision_hash=revised["current_revision"]["revision_hash"],
        )
        replay = await service.accept_current(
            intent_set_id=revised["id"],
            expected_revision_hash=revised["current_revision"]["revision_hash"],
        )
        assert accepted == replay
        assert accepted["status"] == "accepted"
        assert accepted["accepted_revision_id"] == accepted["current_revision"]["id"]
        assert accepted["intents"][0]["status"] == "accepted"
        await database.close()

    asyncio.run(scenario())


def test_clarification_answer_crosses_product_runs_without_reusing_history_blob() -> None:
    async def scenario() -> None:
        database, sessions, service = await _runtime()
        session_id, first_run_id = await _accepted_run(sessions, suffix="clarify")
        created = await service.record_candidate(
            run_id=first_run_id,
            origin_prompt="继续那个项目",
            intents=[
                {
                    "scenario": "clarify",
                    "goal": "确认要继续的项目",
                    "confidence": 0.35,
                    "needs_clarification": True,
                    "clarification_question": "你要继续Chat还是贪吃蛇项目？",
                    "reason_summary": "存在多个可能项目",
                }
            ],
            source_model_call_revision_id=None,
        )
        clarification = created["intents"][0]["clarification"]
        assert clarification["status"] == "open"
        assert (await service.latest_open_clarification(session_id))["id"] == clarification["id"]

        await sessions.complete_active_run(
            session_id,
            assistant_text="你要继续Chat还是贪吃蛇项目？",
            agui_message_id="clarification-question",
        )
        _, second_run_id = await _accepted_run(
            sessions,
            session_id=session_id,
            suffix="clarification-answer",
        )
        answered = await service.answer_latest_open(
            session_id=session_id,
            answering_run_id=second_run_id,
            answer_text="继续Chat项目，只审查恢复流程。",
        )
        assert answered is not None
        assert answered["status"] == "answered"
        assert answered["answer"]["answering_run_id"] == second_run_id
        assert answered["answer"]["answer_text"] == "继续Chat项目，只审查恢复流程。"
        assert await service.latest_open_clarification(session_id) is None
        await database.close()

    asyncio.run(scenario())


def test_intent_contract_rejects_unsafe_branch_graphs_and_excessive_fanout() -> None:
    async def scenario() -> None:
        database, sessions, service = await _runtime()
        _, run_id = await _accepted_run(sessions, suffix="invalid")
        with pytest.raises(HarnessValidationError, match="更早"):
            await service.record_candidate(
                run_id=run_id,
                origin_prompt="错误依赖",
                intents=[
                    {
                        "branch_key": "first",
                        "scenario": "learning",
                        "goal": "第一步",
                        "confidence": 1,
                        "dependency_branch_keys": ["second"],
                        "reason_summary": "测试",
                    },
                    {
                        "branch_key": "second",
                        "scenario": "learning",
                        "goal": "第二步",
                        "confidence": 1,
                        "reason_summary": "测试",
                    },
                ],
                source_model_call_revision_id=None,
            )
        with pytest.raises(HarnessValidationError, match="最多支持4个"):
            await service.record_candidate(
                run_id=run_id,
                origin_prompt="过多意图",
                intents=[
                    {
                        "scenario": "simple_question",
                        "goal": f"目标 {index}",
                        "confidence": 1,
                        "reason_summary": "测试",
                    }
                    for index in range(5)
                ],
                source_model_call_revision_id=None,
            )
        await database.close()

    asyncio.run(scenario())
