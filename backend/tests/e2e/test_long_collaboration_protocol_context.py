"""Cross-day acceptance scenario for collaboration methods and context isolation.

The test uses the same durable Product Store and application services as the
runtime.  Time is simulated: there are no sleeps and no assertions against
model prose.  The scenario proves that a user can move from a learning track
to a delivery project and back while protocol selection, editable Context,
public step inputs and TurnDigest evidence remain bound to the intended work.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from backend.app.collaboration_contexts import CollaborationContextService
from backend.app.collaboration_protocols import CollaborationProtocolService
from backend.app.governance.service import ExecutionGovernanceService
from backend.app.harness.service import HarnessService
from backend.app.product_sessions.database import ProductDatabase
from backend.app.product_sessions.service import ProductSessionService
from backend.app.step_inputs import StepInputProjectionService


class ScenarioClock:
    """Move product time across days without slowing the suite."""

    def __init__(self) -> None:
        self.origin = datetime(2026, 2, 2, 9, 0, tzinfo=timezone.utc)
        self.value = self.origin

    def __call__(self) -> datetime:
        return self.value

    def at_day(self, day: int) -> None:
        self.value = self.origin + timedelta(days=day - 1)


async def _run(
    sessions: ProductSessionService,
    *,
    session_id: str,
    ordinal: int,
    prompt: str,
) -> str:
    """Persist one complete user/assistant turn and return its Product Run ID."""

    history = await sessions.list_messages(session_id)
    accepted = await sessions.prepare_agui_run(
        {
            "threadId": session_id,
            "runId": f"protocol-context-{ordinal}",
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
                    "id": f"protocol-context-user-{ordinal}",
                    "role": "user",
                    "content": prompt,
                },
            ],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
    )
    await sessions.complete_active_run(
        session_id,
        assistant_text=f"protocol-context-result-{ordinal}",
        agui_message_id=f"protocol-context-assistant-{ordinal}",
    )
    return accepted.product_run_id


def _adopted_source_ids(package: dict[str, Any]) -> set[str]:
    return {str(item["source_id"]) for item in package["items"] if item["adopted"]}


@pytest.mark.anyio
async def test_e2e_cross_day_method_context_step_input_and_digest_remain_aligned(
    tmp_path,
) -> None:
    """One user can switch focus without leaking methods, context or durable facts."""

    database_url = f"sqlite+aiosqlite:///{tmp_path / 'long-protocol-context.db'}"
    clock = ScenarioClock()
    database = ProductDatabase(database_url)
    sessions = ProductSessionService(database)
    harness = HarnessService(database, clock=clock)
    contexts = CollaborationContextService(database, clock=clock)
    protocols = CollaborationProtocolService(database, clock=clock)
    governance = ExecutionGovernanceService(database)
    step_inputs = StepInputProjectionService(database, clock=clock)
    await sessions.initialize()
    await governance.initialize()
    await protocols.initialize()

    # Day 1: an authoritative directory question must use the direct-answer
    # method, remain a zero-work query and not promote model prose to Product fact.
    clock.at_day(1)
    overview_session = (await sessions.create_session(title="项目总览"))["id"]
    overview_run = await _run(
        sessions,
        session_id=overview_session,
        ordinal=1,
        prompt="我有哪些项目？只查看正式列表。",
    )
    overview_protocol = await protocols.resolve_for_turn(
        scenario="simple_question",
        project_id=None,
        query_kind="project_catalog",
    )
    assert overview_protocol["protocol_key"] == "simple-answer"
    assert overview_protocol["selection_source"] == "system"
    overview_items, overview_projects = await harness.directory_context_items(
        prompt="我有哪些项目？只查看正式列表。",
        summaries=[],
    )
    assert overview_projects == []
    overview_context = await harness.create_context_package(
        session_id=overview_session,
        run_id=overview_run,
        stage="directory",
        items=overview_items,
        token_budget=800,
        status="adopted",
    )
    overview_digest = await governance.save_turn_summary(
        session_id=overview_session,
        run_id=overview_run,
        summary={
            "topic": "查看正式Project目录",
            "confirmed_facts": ["用户已经有一个项目"],
            "decisions": [],
            "open_questions": [],
            "work_state_candidates": [],
            "memory_candidates": [],
        },
        source_model_call_revision_id=None,
    )
    assert overview_context["selected_project_id"] is None
    assert overview_digest["summary"]["confirmed_facts"] == []
    assert overview_digest["summary"]["unverified_fact_candidates"][0]["text"] == ("用户已经有一个项目")

    # Still day 1: establish a learning track. The user removes a merely related
    # Note from this turn and locks the Project goal before any execution draft.
    learning_session = (await sessions.create_session(title="FastAPI学习"))["id"]
    learning_run = await _run(
        sessions,
        session_id=learning_session,
        ordinal=2,
        prompt="开始学习FastAPI依赖注入，先跑通最小例子。",
    )
    learning = await harness.create_project(
        command_id="long-method-learning-project",
        kind="learning",
        title="FastAPI依赖注入学习",
        goal="运行、测试并解释FastAPI依赖注入",
        status="active",
        session_id=learning_session,
    )
    learning_work = await harness.create_work_item(
        command_id="long-method-learning-work",
        project_id=learning["id"],
        kind="learning_unit",
        title="Depends最小例子",
        objective="运行最小API并写dependency_overrides测试",
        status="ready",
    )
    learning_note = await harness.capture_note(
        command_id="long-method-learning-note",
        kind="learning_note",
        title="后续阅读候选",
        content="依赖缓存机制值得后续阅读，但本轮先不展开。",
        links=[{"resource_kind": "project", "resource_id": learning["id"]}],
    )
    learning_protocol = await protocols.resolve_for_turn(
        scenario="continue_project",
        project_id=learning["id"],
        work_item_id=learning_work["id"],
    )
    assert learning_protocol["protocol_key"] == "learning-loop"
    learning_context_v1 = await harness.create_context_package(
        session_id=learning_session,
        run_id=learning_run,
        stage="detail",
        items=await harness.detailed_context_items(learning["id"]),
        selected_project_id=learning["id"],
        selected_work_item_id=learning_work["id"],
        token_budget=1600,
        status="adopted",
    )
    note_ordinal = next(
        index
        for index, item in enumerate(learning_context_v1["items"])
        if item["source_id"] == learning_note["id"]
    )
    project_ordinal = next(
        index
        for index, item in enumerate(learning_context_v1["items"])
        if item["source_id"] == learning["id"]
    )
    learning_context_v2 = await contexts.revise_package(
        package_id=learning_context_v1["id"],
        command_id="long-method-learning-context-review",
        expected_package_hash=learning_context_v1["package_hash"],
        reason="本轮只学习Depends最小例子，暂不采用后续阅读候选",
        item_changes=[
            {"ordinal": project_ordinal, "locked": True},
            {
                "ordinal": note_ordinal,
                "adopted": False,
                "reason": "与当前练习不直接相关",
            },
        ],
    )
    assert learning_context_v2["revision"] == 2
    assert learning_note["id"] not in _adopted_source_ids(learning_context_v2)
    assert (
        next(item for item in learning_context_v2["items"] if item["source_id"] == learning["id"])["locked"]
        is True
    )

    role_inputs = {
        "intent_agent": {
            "goal": "识别学习续接意图",
            "context": ["当前输入", "轻量Project目录"],
        },
        "planning_agent": {
            "goal": learning_work["objective"],
            "context": sorted(_adopted_source_ids(learning_context_v2)),
        },
        "execution_agent": {
            "goal": "运行Depends最小例子",
            "allowed_actions": ["read", "test"],
        },
        "review_agent": {
            "goal": "核对最小例子与测试Evidence",
            "required_evidence": ["test_result"],
        },
        "turn_digest_agent": {
            "goal": "提取本轮重点，不直接提交Memory",
            "writeback": "candidate_only",
        },
    }
    for ordinal, (node_id, input_value) in enumerate(role_inputs.items(), start=1):
        await step_inputs.record(
            run_id=learning_run,
            workflow_definition_id="continuous-collaboration",
            workflow_version="1.3.0",
            node_id=node_id,
            agent_profile_key=node_id,
            context_package_id=learning_context_v2["id"],
            protocol_definition_id=learning_protocol["definition_id"],
            protocol_binding_id=learning_protocol["binding_id"],
            input_value=input_value,
            capability_allowlist=(
                [{"kind": "tool", "name": "read"}, {"kind": "tool", "name": "test"}]
                if node_id == "execution_agent"
                else []
            ),
            budget={"token_budget": 900 + ordinal * 100, "model_calls": 1},
            output_contract={"kind": node_id.removesuffix("_agent")},
            stop_conditions=["缺少必要输入时停止并请求用户决定"],
        )
    projections = await step_inputs.list_for_run(learning_run)
    assert {value["node_id"] for value in projections} == set(role_inputs)
    assert next(value for value in projections if value["node_id"] == "execution_agent")[
        "capability_allowlist"
    ] == [
        {"kind": "tool", "name": "read"},
        {"kind": "tool", "name": "test"},
    ]
    assert (
        next(value for value in projections if value["node_id"] == "intent_agent")["capability_allowlist"]
        == []
    )

    learning_digest = await governance.save_turn_summary(
        session_id=learning_session,
        run_id=learning_run,
        summary={
            "topic": "FastAPI Depends最小例子",
            "confirmed_facts": [
                {
                    "text": "本轮关联FastAPI依赖注入学习",
                    "source_refs": [
                        {
                            "kind": "project",
                            "id": learning["id"],
                            "revision": learning["row_version"],
                        }
                    ],
                }
            ],
            "decisions": [],
            "open_questions": ["dependency_overrides测试尚未执行"],
            "work_state_candidates": [{"work_item_id": learning_work["id"], "target_status": "in_progress"}],
            "memory_candidates": [],
        },
        source_model_call_revision_id=None,
        product_fact_refs=[
            {
                "kind": "project",
                "id": learning["id"],
                "revision": learning["row_version"],
            }
        ],
    )
    assert learning_digest["summary"]["product_fact_refs"] == [
        {
            "kind": "project",
            "id": learning["id"],
            "revision": str(learning["row_version"]),
        }
    ]

    # Day 2: a software-delivery Project chooses a different method and only its
    # own working set. The prior learning goal and note must not reach its input.
    clock.at_day(2)
    delivery_session = (await sessions.create_session(title="书签API"))["id"]
    delivery_run = await _run(
        sessions,
        session_id=delivery_session,
        ordinal=3,
        prompt="暂停学习，开始书签API项目，先完成列表接口。",
    )
    delivery = await harness.create_project(
        command_id="long-method-delivery-project",
        kind="delivery",
        title="书签API",
        goal="交付可查询与新增书签的HTTP API",
        status="active",
        session_id=delivery_session,
    )
    delivery_work = await harness.create_work_item(
        command_id="long-method-delivery-work",
        project_id=delivery["id"],
        kind="task",
        title="书签列表接口",
        objective="实现GET /bookmarks并通过接口测试",
        status="ready",
    )
    delivery_protocol = await protocols.resolve_for_turn(
        scenario="continue_project",
        project_id=delivery["id"],
        work_item_id=delivery_work["id"],
    )
    assert delivery_protocol["protocol_key"] == "software-delivery"
    delivery_context = await harness.create_context_package(
        session_id=delivery_session,
        run_id=delivery_run,
        stage="detail",
        items=await harness.detailed_context_items(delivery["id"]),
        selected_project_id=delivery["id"],
        selected_work_item_id=delivery_work["id"],
        token_budget=1800,
        status="adopted",
    )
    assert _adopted_source_ids(delivery_context) >= {
        delivery["id"],
        delivery_work["id"],
    }
    assert learning["id"] not in _adopted_source_ids(delivery_context)
    assert learning_work["id"] not in _adopted_source_ids(delivery_context)
    await step_inputs.record(
        run_id=delivery_run,
        workflow_definition_id="continuous-collaboration",
        workflow_version="1.3.0",
        node_id="planning_agent",
        agent_profile_key="task_planner",
        context_package_id=delivery_context["id"],
        protocol_definition_id=delivery_protocol["definition_id"],
        protocol_binding_id=delivery_protocol["binding_id"],
        input_value={
            "goal": delivery_work["objective"],
            "context": sorted(_adopted_source_ids(delivery_context)),
        },
        budget={"token_budget": 1600, "model_calls": 1},
        output_contract={"kind": "plan"},
        stop_conditions=["接口范围不明确时请求用户决定"],
    )
    delivery_projection = (await step_inputs.list_for_run(delivery_run))[0]
    assert learning["id"] not in delivery_projection["input"]["context"]

    # Day 3: after reconstructing every application service, returning to the
    # learning track recovers its method and accepted working set, not the most
    # recently touched delivery Project.
    await database.close()
    clock.at_day(3)
    database = ProductDatabase(database_url)
    sessions = ProductSessionService(database)
    harness = HarnessService(database, clock=clock)
    protocols = CollaborationProtocolService(database, clock=clock)
    governance = ExecutionGovernanceService(database)
    step_inputs = StepInputProjectionService(database, clock=clock)
    await sessions.initialize()
    await governance.initialize()
    await protocols.initialize()

    resumed_session = (await sessions.create_session(title="继续FastAPI学习"))["id"]
    resumed_run = await _run(
        sessions,
        session_id=resumed_session,
        ordinal=4,
        prompt="继续FastAPI依赖注入学习，下一步做dependency_overrides测试。",
    )
    resumed_protocol = await protocols.resolve_for_turn(
        scenario="continue_project",
        project_id=learning["id"],
        work_item_id=learning_work["id"],
    )
    resumed_context = await harness.create_context_package(
        session_id=resumed_session,
        run_id=resumed_run,
        stage="detail",
        items=await harness.detailed_context_items(learning["id"]),
        selected_project_id=learning["id"],
        selected_work_item_id=learning_work["id"],
        token_budget=1600,
        status="adopted",
    )
    assert resumed_protocol["protocol_key"] == "learning-loop"
    assert _adopted_source_ids(resumed_context) >= {
        learning["id"],
        learning_work["id"],
        learning_note["id"],
    }
    assert delivery["id"] not in _adopted_source_ids(resumed_context)
    assert delivery_work["id"] not in _adopted_source_ids(resumed_context)
    assert resumed_context["estimated_tokens"] <= resumed_context["token_budget"]

    all_projects = await harness.list_projects(statuses=("active",))
    assert {(value["id"], value["kind"]) for value in all_projects} == {
        (learning["id"], "learning"),
        (delivery["id"], "delivery"),
    }
    await database.close()
