from __future__ import annotations

import pytest

from backend.app.workflows.continuous_chat_contracts import (
    CollaborationState,
    apply_intent_set_protocol_overlay,
    evaluate_scenario_route,
    is_project_catalog_query,
    normalize_intent_candidates,
    render_project_catalog_result,
)


@pytest.mark.parametrize(
    ("scenario", "intent", "selected_branch", "selected_target", "selected_index"),
    [
        (
            "simple_question",
            {"query_kind": "project_catalog", "needs_plan": False},
            "project_catalog",
            "project_catalog_query",
            0,
        ),
        (
            "clarify",
            {"needs_plan": False},
            "clarification",
            "clarification",
            1,
        ),
        (
            "continue_project",
            {"needs_plan": False},
            "planning",
            "planning_agent",
            2,
        ),
        (
            "simple_question",
            {"needs_plan": False},
            "direct_response",
            "execution_draft_compiler",
            3,
        ),
    ],
)
def test_scenario_route_explains_all_four_public_branches(
    scenario: str,
    intent: dict[str, object],
    selected_branch: str,
    selected_target: str,
    selected_index: int,
) -> None:
    decision = evaluate_scenario_route(
        CollaborationState(origin_prompt="测试", scenario=scenario, intent=intent)
    )

    assert decision["decision_kind"] == "maf_switch_case"
    assert decision["selection_mode"] == "first_match"
    assert decision["selected_branch"] == selected_branch
    assert decision["selected_target"] == selected_target
    assert decision["selection_reason"]
    assert len(decision["options"]) == 4
    assert [option["selected"] for option in decision["options"]] == [
        index == selected_index for index in range(4)
    ]
    assert all(option["condition"] and option["reason"] for option in decision["options"])


def test_scenario_route_records_first_match_when_later_conditions_are_also_true() -> None:
    decision = evaluate_scenario_route(
        CollaborationState(
            origin_prompt="测试优先级",
            scenario="clarify",
            intent={"query_kind": "project_catalog", "needs_plan": True},
        )
    )
    project_catalog, clarification, planning, default = decision["options"]

    assert decision["selected_branch"] == "project_catalog"
    assert project_catalog["matched"] is True
    assert project_catalog["selected"] is True
    assert clarification["matched"] is True
    assert clarification["selected"] is False
    assert planning["matched"] is True
    assert planning["selected"] is False
    assert "已经先命中" in clarification["reason"]
    assert default["matched"] is False


def test_project_catalog_is_not_a_terminal_branch_for_a_multi_intent_set() -> None:
    intents = (
        {
            "branch_key": "catalog",
            "query_kind": "project_catalog",
            "scenario": "simple_question",
            "needs_plan": False,
        },
        {
            "branch_key": "explain",
            "query_kind": None,
            "scenario": "simple_question",
            "needs_plan": False,
        },
    )
    decision = evaluate_scenario_route(
        CollaborationState(
            origin_prompt="列出项目并解释斐波那契",
            scenario="simple_question",
            intent=intents[0],
            intents=intents,
        )
    )

    assert decision["selected_branch"] == "planning"
    assert decision["facts"]["intent_count"] == 2
    assert decision["options"][0]["matched"] is False
    assert "Intent Set包含2项目标" in decision["options"][0]["actual"]


def test_single_intent_keeps_the_immutable_protocol_selection_unchanged() -> None:
    selection = {
        "protocol_key": "simple-answer",
        "definition_id": "definition-1",
        "definition_hash": "definition-hash",
        "selection_hash": "selection-hash",
        "execution_policy": {
            "planner": "disabled",
            "allowed_roles": ["intent", "response"],
            "tool_mode": "read_only_when_needed",
        },
    }

    effective = apply_intent_set_protocol_overlay(
        selection,
        ({"branch_key": "answer", "scenario": "simple_question"},),
    )

    assert effective == selection
    assert effective is not selection


def test_multi_intent_adds_a_hashed_planning_overlay_without_mutating_source_provenance() -> None:
    selection = {
        "protocol_key": "simple-answer",
        "definition_id": "definition-1",
        "definition_hash": "definition-hash",
        "selection_hash": "selection-hash",
        "execution_policy": {
            "planner": "disabled",
            "allowed_roles": ["intent", "response"],
            "tool_mode": "read_only_when_needed",
        },
    }
    intents = (
        {"branch_key": "catalog", "scenario": "simple_question"},
        {"branch_key": "explain", "scenario": "simple_question"},
    )

    first = apply_intent_set_protocol_overlay(selection, intents)
    second = apply_intent_set_protocol_overlay(selection, intents)

    assert first["definition_hash"] == "definition-hash"
    assert first["selection_hash"] == "selection-hash"
    assert first["base_execution_policy"]["planner"] == "disabled"
    assert first["execution_policy"] == {
        "planner": "required_for_intent_set",
        "allowed_roles": ["intent", "response", "planner"],
        "tool_mode": "read_only_when_needed",
    }
    assert first["composition_overlay"] == {
        "kind": "intent_set",
        "reason": "Intent Set含多个目标，必须先形成组合计划",
        "intent_count": 2,
        "branch_keys": ["catalog", "explain"],
        "scenario_kinds": ["simple_question", "simple_question"],
        "source_protocol_key": "simple-answer",
        "source_definition_id": "definition-1",
        "source_definition_hash": "definition-hash",
    }
    assert first["effective_selection_hash"] == second["effective_selection_hash"]
    assert selection["execution_policy"]["planner"] == "disabled"


def test_empty_project_catalog_result_is_an_explicit_authoritative_fact() -> None:
    result = render_project_catalog_result([], [])

    assert result == {
        "source_kind": "product_query",
        "source_id": "project_catalog",
        "query_status": "completed",
        "formal_project_count": 0,
        "formal_projects": [],
        "conversation_project_candidates": [],
        "assistant_response": (
            "当前还没有已创建的正式 Project。最近对话中也没有识别到可供确认的 Project 候选。"
        ),
    }


@pytest.mark.parametrize(
    ("prompt", "expected"),
    [
        ("我有哪些项目？只查看正式列表，不要创建任何事项。", True),
        ("列出我的项目，不用新建项目。", True),
        ("显示项目列表，禁止自动创建任务", True),
        ("我有哪些项目？没有的话创建一个新项目。", False),
        ("开始一个新项目。", False),
    ],
)
def test_project_catalog_guard_distinguishes_read_only_constraints_from_creation(
    prompt: str,
    expected: bool,
) -> None:
    assert is_project_catalog_query(prompt) is expected


def test_multi_intent_output_preserves_order_dependencies_and_clarification_link() -> None:
    values = normalize_intent_candidates(
        {
            "intents": [
                {
                    "branch_key": "learn",
                    "scenario": "learning",
                    "goal": "学习Outbox",
                    "expected_outcome": "能解释恢复语义",
                    "confidence": 0.9,
                    "needs_plan": True,
                    "reason_summary": "明确学习目标",
                },
                {
                    "branch_key": "apply",
                    "scenario": "continue_project",
                    "goal": "应用到Chat",
                    "confidence": 0.85,
                    "needs_plan": True,
                    "dependency_branch_keys": ["learn"],
                    "answers_clarification_id": "clarification-1",
                    "reason_summary": "明确应用目标",
                },
            ]
        },
        origin_prompt="先学再用",
    )

    assert [value["branch_key"] for value in values] == ["learn", "apply"]
    assert values[1]["dependency_branch_keys"] == ["learn"]
    assert values[1]["answers_clarification_id"] == "clarification-1"
    assert values[1]["expected_outcome"] == "应用到Chat"


@pytest.mark.parametrize(
    "payload",
    [
        {"intents": []},
        {
            "intents": [
                {
                    "branch_key": "first",
                    "scenario": "learning",
                    "goal": "第一步",
                    "confidence": 1,
                    "dependency_branch_keys": ["missing"],
                }
            ]
        },
        {
            "intents": [
                {
                    "scenario": "unsupported",
                    "goal": "非法场景",
                    "confidence": 1,
                }
            ]
        },
    ],
)
def test_invalid_multi_intent_output_fails_closed_to_clarification(
    payload: dict[str, object],
) -> None:
    [value] = normalize_intent_candidates(payload, origin_prompt="原始输入")

    assert value["scenario"] == "clarify"
    assert value["confidence"] == 0
    assert value["needs_clarification"] is True
    assert value["goal"] == "原始输入"
