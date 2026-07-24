from __future__ import annotations

import asyncio
import json
import multiprocessing
import sqlite3
from collections.abc import AsyncIterator
from typing import Any

from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.execution_worker import run_execution_worker
from backend.app.main import create_app
from backend.app.model_call_review import (
    InMemoryModelCallReviewStore,
    PreparedProviderRequest,
)
from backend.app.model_providers import (
    ModelOption,
    ModelProviderCatalog,
    ModelProviderConfig,
)
from backend.app.outbox_worker import run_outbox_worker


class SequencedTransport:
    def __init__(self, responses: list[str]) -> None:
        self.responses = responses
        self.prepared: list[PreparedProviderRequest] = []

    async def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[str]:
        self.prepared.append(prepared)
        index = len(self.prepared)
        response = self.responses[index - 1]
        if prepared.stage_reporter is not None:
            await prepared.stage_reporter(
                "provider.dispatch",
                "in_progress",
                {"transport": "test", "protocol": "test"},
            )
            await prepared.stage_reporter(
                "provider.dispatch",
                "completed",
                {"http_status": 200, "provider_request_id": f"test-request-{index}"},
            )
            await prepared.stage_reporter(
                "provider.receive",
                "completed",
                {
                    "transport": "test",
                    "content_type": "application/json",
                    "response_bytes": len(response.encode("utf-8")),
                    "empty": not response,
                },
            )
            await prepared.stage_reporter(
                "provider.decode",
                "completed",
                {
                    "protocol": "test",
                    "provider_response_id": f"test-response-{index}",
                    "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
                    "empty": not response,
                },
            )
        yield response


def _catalog() -> ModelProviderCatalog:
    provider = ModelProviderConfig(
        id="provider-a",
        label="Provider A",
        models=(ModelOption(id="model-a", label="Model A"),),
        base_url="https://provider.invalid/v1",
        api_key="test-key",
    )
    return ModelProviderCatalog(
        providers=(provider,),
        default_provider_id=provider.id,
        default_model="model-a",
    )


def _settings(database_url: str) -> Settings:
    catalog = _catalog()
    return Settings(
        host="127.0.0.1",
        port=8030,
        frontend_origins=("http://testserver",),
        model="model-a",
        model_api_key="test-key",
        model_base_url="https://provider.invalid/v1",
        model_providers=catalog.providers,
        default_model_provider=catalog.default_provider_id,
        database_url=database_url,
    )


def _run_outbox_in_spawned_process(
    database_url: str,
    response: str,
    expected_count: int,
) -> None:
    """Spawn target: no process-local Workflow or review-store state is inherited."""

    app = create_app(
        _settings(database_url),
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=SequencedTransport([response]),
        start_outbox_worker=False,
        outbox_worker_id="spawned-outbox-test-worker",
        start_execution_worker=False,
    )
    processed = asyncio.run(run_outbox_worker(app, once=True))
    database_path = database_url.removeprefix("sqlite+aiosqlite:///")
    with sqlite3.connect(database_path) as connection:
        published_runtime_count = connection.execute(
            "SELECT COUNT(*) FROM governance_outbox "
            "WHERE event_type = 'runtime.resume_requested' AND status = 'published'"
        ).fetchone()[0]
        pending_runtime_count = connection.execute(
            "SELECT COUNT(*) FROM governance_outbox "
            "WHERE event_type = 'runtime.resume_requested' AND status != 'published'"
        ).fetchone()[0]
    if processed < expected_count:
        raise AssertionError(f"expected at least {expected_count} eligible outbox events, got {processed}")
    if published_runtime_count != expected_count or pending_runtime_count != 0:
        raise AssertionError(
            "runtime resume outbox contract violated: "
            f"published={published_runtime_count}, pending={pending_runtime_count}, "
            f"expected={expected_count}"
        )


def _spawn_outbox_worker(
    database_url: str,
    response: str,
    *,
    expected_count: int = 1,
) -> None:
    process = multiprocessing.get_context("spawn").Process(
        target=_run_outbox_in_spawned_process,
        args=(database_url, response, expected_count),
    )
    process.start()
    process.join(timeout=20)
    if process.is_alive():
        process.terminate()
        process.join(timeout=5)
        raise AssertionError("spawned Outbox Worker did not terminate")
    assert process.exitcode == 0


def _run_execution_in_spawned_process(database_url: str, response: str) -> None:
    app = create_app(
        _settings(database_url),
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=SequencedTransport([response]),
        start_outbox_worker=False,
        start_execution_worker=False,
        execution_worker_id="spawned-execution-test-worker",
    )
    processed = asyncio.run(run_execution_worker(app, once=True))
    if processed != 1:
        raise AssertionError(f"expected one resumed Runtime Job, got {processed}")


def _spawn_execution_worker(database_url: str, response: str) -> None:
    process = multiprocessing.get_context("spawn").Process(
        target=_run_execution_in_spawned_process,
        args=(database_url, response),
    )
    process.start()
    process.join(timeout=20)
    if process.is_alive():
        process.terminate()
        process.join(timeout=5)
        raise AssertionError("spawned Execution Worker did not terminate")
    assert process.exitcode == 0


def _request(
    session_id: str,
    run_id: str,
    prompt: str,
    *,
    history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "threadId": session_id,
        "runId": run_id,
        "state": {},
        "messages": [
            *(history or []),
            {"id": f"message-{run_id}", "role": "user", "content": prompt},
        ],
        "tools": [],
        "context": [],
        "forwardedProps": {"workflow": {"id": "continuous-collaboration", "version": "1.4.0"}},
    }


def _resume(
    session_id: str,
    run_id: str,
    approval_id: str,
    decision: str,
    *,
    changes: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "threadId": session_id,
        "runId": run_id,
        "state": {},
        "messages": [],
        "tools": [],
        "context": [],
        "forwardedProps": {},
        "resume": [
            {
                "interruptId": approval_id,
                "status": "resolved",
                "payload": {"decision": decision, **({"changes": changes} if changes else {})},
            }
        ],
    }


def _events(response) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def _card(events: list[dict[str, Any]]) -> dict[str, Any]:
    finished = [value for value in events if value["type"] == "RUN_FINISHED"]
    assert finished, events[-1]
    return finished[-1]["outcome"]["interrupts"][0]["metadata"]["agent_framework"]["data"]


def _text(events: list[dict[str, Any]]) -> str:
    return "".join(
        str(value.get("delta") or "") for value in events if value["type"] == "TEXT_MESSAGE_CONTENT"
    )


def test_continuous_workflow_simple_question_uses_three_governed_model_calls(tmp_path) -> None:
    responses = [
        json.dumps(
            {
                "scenario": "simple_question",
                "goal": "解释什么是幂等",
                "confidence": 0.97,
                "project_hint": None,
                "needs_plan": False,
                "needs_clarification": False,
                "clarification_question": None,
                "context_keywords": ["幂等"],
                "reason_summary": "独立知识问答",
            },
            ensure_ascii=False,
        ),
        "幂等是指同一个操作执行一次或多次，最终产生相同的可观察结果。",
        json.dumps(
            {
                "topic": "幂等概念",
                "confirmed_facts": [],
                "decisions": [],
                "open_questions": [],
                "project_hint": None,
                "work_state_candidates": [],
                "memory_candidates": [],
            },
            ensure_ascii=False,
        ),
    ]
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    transport = SequencedTransport(responses)
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'continuous.db'}"),
        model_call_store=store,
        model_call_transport=transport,
    )

    with TestClient(app) as client:
        workflows = client.get("/api/workflows").json()["workflows"]
        assert [value["id"] for value in workflows if value["selectable"]] == ["continuous-collaboration"]
        definition = next(value for value in workflows if value["id"] == "continuous-collaboration")
        assert len(definition["nodes"]) == 28

        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _card(
            _events(
                client.post(
                    definition["endpoint"],
                    json=_request(session_id, "continuous-start", "什么是幂等？"),
                )
            )
        )
        assert first["execution_context"]["agent_id"] == "intent_router"
        assert first["execution_context"]["governance"]["final_action"] == "require_human"
        assert transport.prepared == []

        second = _card(
            _events(
                client.post(
                    definition["endpoint"],
                    json=_resume(session_id, "continuous-intent", first["approval_id"], "approve"),
                )
            )
        )
        assert second["execution_context"]["agent_id"] == "response_agent"
        assert len(transport.prepared) == 1

        third = _card(
            _events(
                client.post(
                    definition["endpoint"],
                    json=_resume(session_id, "continuous-response", second["approval_id"], "approve"),
                )
            )
        )
        assert third["execution_context"]["agent_id"] == "turn_summarizer"
        assert len(transport.prepared) == 2

        completed = _events(
            client.post(
                definition["endpoint"],
                json=_resume(session_id, "continuous-summary", third["approval_id"], "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        trace = client.get(f"/api/sessions/{session_id}/runs/{run['id']}/trace").json()["trace"]
        governance = client.get(f"/api/runs/{run['id']}/governance")
        diagnostics = client.get(f"/api/diagnostics/runs/{run['id']}/timeline")
        step_inputs = client.get(f"/api/runs/{run['id']}/step-inputs")
        intent_set = client.get(f"/api/harness/intents?run_id={run['id']}")
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert len(transport.prepared) == 3
    assert _text(completed) == responses[1]
    assert messages[-1]["content"] == responses[1]
    assert governance.status_code == 200
    governance_payload = governance.json()
    assert governance_payload["execution_draft"]["status"] == "accepted"
    assert governance_payload["run_spec"] is not None
    assert governance_payload["run_spec"]["status"] == "bound"
    assert governance_payload["turn_summary"]["topic"] == "幂等概念"
    assert len(governance_payload["model_calls"]) == 3
    attempts = [
        attempt
        for call in governance_payload["model_calls"]
        for revision in call["revisions"]
        for attempt in revision["attempts"]
    ]
    assert [attempt["output_text"] for attempt in attempts] == responses
    assert [attempt["output_disposition"] for attempt in attempts] == [
        "accepted_as_intent",
        "accepted_as_response",
        "accepted_as_summary",
    ]
    assert all(attempt["http_status"] == 200 for attempt in attempts)
    assert all(attempt["provider_request_id"] for attempt in attempts)
    assert all(attempt["provider_response_id"] for attempt in attempts)
    assert all(attempt["usage"]["total_tokens"] == 15 for attempt in attempts)
    assert all(
        [(event["stage"], event["status"]) for event in attempt["transport_events"]]
        == [
            ("provider.dispatch", "in_progress"),
            ("provider.dispatch", "completed"),
            ("provider.receive", "completed"),
            ("provider.decode", "completed"),
        ]
        for attempt in attempts
    )
    assert diagnostics.status_code == 200
    assert step_inputs.status_code == 200
    assert intent_set.status_code == 200
    intent_payload = intent_set.json()
    assert intent_payload["status"] == "accepted"
    assert intent_payload["current_revision"]["combination_policy"] == "single"
    assert intent_payload["intents"][0]["current_revision"]["goal"] == "解释什么是幂等"
    assert intent_payload["intents"][0]["current_revision"]["source_model_call_revision_id"]
    step_input_values = step_inputs.json()["step_inputs"]
    step_input_nodes = {value["node_id"] for value in step_input_values}
    assert {
        "input_acceptance",
        "intent_agent",
        "collaboration_protocol_resolver",
        "execution_draft_compiler",
        "response_agent",
        "turn_summary_agent",
        "result_finalization",
    } <= step_input_nodes
    assert all(value["projection_hash"] for value in step_input_values)
    intent_projection = next(value for value in step_input_values if value["node_id"] == "intent_agent")
    assert intent_projection["agent_profile_key"] == "intent_router"
    assert intent_projection["context_package_id"]
    assert intent_projection["budget"]["model_calls"] == 1
    diagnostic_payload = diagnostics.json()
    assert len(diagnostic_payload["model_attempts"]) == 3
    assert diagnostic_payload["model_attempts"][0]["output_disposition"] == "accepted_as_intent"
    assert diagnostic_payload["model_attempts"][0]["output_text_sha256"]
    assert '"output_text":' not in diagnostics.text
    assert responses[0] not in diagnostics.text
    contents = {
        value["payload"]["executor_id"] for value in trace if value["event_type"] == "workflow.node.content"
    }
    protocol_event = next(
        value
        for value in trace
        if value["event_type"] == "workflow.node.content"
        and value["payload"]["executor_id"] == "collaboration_protocol_resolver"
    )
    assert protocol_event["payload"]["public_output"]["protocol_key"] == "simple-answer"
    assert protocol_event["payload"]["public_output"]["selection_source"] == "system"
    assert protocol_event["payload"]["public_output"]["applicable_rules"]
    content_sequence = {
        value["payload"]["executor_id"]: value["sequence"]
        for value in trace
        if value["event_type"] == "workflow.node.content"
    }
    assert {
        "input_acceptance",
        "context_candidates",
        "intent_agent",
        "collaboration_protocol_resolver",
        "scenario_router",
        "execution_draft_compiler",
        "run_spec_compiler",
        "response_agent",
        "turn_summary_agent",
        "turn_summary_persist",
        "result_finalization",
    }.issubset(contents)
    assert (
        content_sequence["execution_draft_compiler"]
        < content_sequence["execution_authorization"]
        < content_sequence["run_spec_compiler"]
        < content_sequence["response_agent"]
    )


def test_continuous_workflow_preserves_multi_intent_set_through_plan_and_execution_draft(
    tmp_path,
) -> None:
    responses = [
        json.dumps(
            {
                "intents": [
                    {
                        "branch_key": "learn_outbox",
                        "scenario": "learning",
                        "goal": "学习Outbox恢复语义",
                        "expected_outcome": "能解释领取、重试和幂等边界",
                        "confidence": 0.95,
                        "project_hint": None,
                        "needs_plan": True,
                        "needs_clarification": False,
                        "clarification_question": None,
                        "context_keywords": ["Outbox", "恢复"],
                        "dependency_branch_keys": [],
                        "constraints": ["先学习，不改代码"],
                        "reason_summary": "用户先提出学习目标",
                    },
                    {
                        "branch_key": "apply_chat",
                        "scenario": "continue_project",
                        "goal": "把恢复语义应用到Chat",
                        "expected_outcome": "形成Chat改造与验证清单",
                        "confidence": 0.91,
                        "project_hint": "Chat",
                        "needs_plan": True,
                        "needs_clarification": False,
                        "clarification_question": None,
                        "context_keywords": ["Chat", "Worker"],
                        "dependency_branch_keys": ["learn_outbox"],
                        "constraints": ["没有授权前不修改代码"],
                        "reason_summary": "第二个目标明确依赖学习结果",
                    },
                ],
                "combination_policy": "sequential",
            },
            ensure_ascii=False,
        ),
        "1. 学习Outbox领取与重试；2. 验证理解；3. 基于验证结果形成Chat改造清单。",
        "已完成概念梳理，并给出下一步Chat改造清单；尚未修改代码。",
        json.dumps(
            {
                "topic": "Outbox学习并应用到Chat",
                "confirmed_facts": [],
                "decisions": [],
                "open_questions": [],
                "project_hint": "Chat",
                "work_state_candidates": [],
                "memory_candidates": [],
            },
            ensure_ascii=False,
        ),
    ]
    store = InMemoryModelCallReviewStore(_catalog())
    transport = SequencedTransport(responses)
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'continuous-multi.db'}"),
        model_call_store=store,
        model_call_transport=transport,
    )

    with TestClient(app) as client:
        definition = next(
            value
            for value in client.get("/api/workflows").json()["workflows"]
            if value["id"] == "continuous-collaboration"
        )
        session_id = client.post("/api/sessions", json={}).json()["id"]
        approval = _card(
            _events(
                client.post(
                    definition["endpoint"],
                    json=_request(
                        session_id,
                        "continuous-multi-start",
                        "先学习Outbox，再把它应用到Chat项目，但先不要改代码。",
                    ),
                )
            )
        )
        expected_agents = ["task_planner", "response_agent", "turn_summarizer"]
        for index, expected_agent in enumerate(expected_agents):
            approval = _card(
                _events(
                    client.post(
                        definition["endpoint"],
                        json=_resume(
                            session_id,
                            f"continuous-multi-{index}",
                            approval["approval_id"],
                            "approve",
                        ),
                    )
                )
            )
            assert approval["execution_context"]["agent_id"] == expected_agent
        completed = _events(
            client.post(
                definition["endpoint"],
                json=_resume(
                    session_id,
                    "continuous-multi-summary",
                    approval["approval_id"],
                    "approve",
                ),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        intent_set = client.get(f"/api/harness/intents?run_id={run['id']}").json()
        governance = client.get(f"/api/runs/{run['id']}/governance").json()

    assert _text(completed) == responses[2]
    assert len(transport.prepared) == 4
    assert intent_set["status"] == "accepted"
    assert intent_set["current_revision"]["combination_policy"] == "sequential"
    assert intent_set["current_revision"]["execution_order"] == ["learn_outbox", "apply_chat"]
    assert intent_set["intents"][1]["current_revision"]["dependency_branch_keys"] == ["learn_outbox"]
    draft_payload = governance["execution_draft"]["payload"]
    assert len(draft_payload["intent_goal"]["intents"]) == 2
    assert draft_payload["plan"]["text"] == responses[1]
    protocol = draft_payload["collaboration_protocol_binding"]
    assert protocol["selection_hash"]
    assert protocol["effective_selection_hash"]
    assert protocol["base_execution_policy"]["planner"] == "enabled"
    assert protocol["execution_policy"]["planner"] == "required_for_intent_set"
    assert "planner" in protocol["execution_policy"]["allowed_roles"]
    assert protocol["composition_overlay"]["branch_keys"] == ["learn_outbox", "apply_chat"]
    assert draft_payload["authoritative_product_facts"]["project_catalog"] is None


def test_multi_intent_plan_and_response_receive_the_completed_project_catalog_fact(
    tmp_path,
) -> None:
    responses = [
        json.dumps(
            {
                "intents": [
                    {
                        "branch_key": "view_project_catalog",
                        "scenario": "simple_question",
                        "query_kind": "project_catalog",
                        "goal": "查看正式Project列表",
                        "expected_outcome": "返回权威Project目录",
                        "confidence": 0.99,
                        "project_hint": None,
                        "needs_plan": False,
                        "needs_clarification": False,
                        "context_keywords": ["Project", "列表"],
                        "dependency_branch_keys": [],
                        "constraints": ["只读"],
                        "reason_summary": "明确的权威产品查询",
                    },
                    {
                        "branch_key": "explain_fibonacci",
                        "scenario": "simple_question",
                        "query_kind": None,
                        "goal": "解释斐波那契数列",
                        "expected_outcome": "一句话解释",
                        "confidence": 0.99,
                        "project_hint": None,
                        "needs_plan": False,
                        "needs_clarification": False,
                        "context_keywords": ["斐波那契"],
                        "dependency_branch_keys": [],
                        "constraints": ["一句话"],
                        "reason_summary": "独立简单问答",
                    },
                ],
                "combination_policy": "sequential",
            },
            ensure_ascii=False,
        ),
        "先采用已完成的Product目录查询结果，再回答独立的斐波那契问题。",
        (
            "当前还没有已创建的正式 Project。"
            "最近对话中也没有识别到可供确认的 Project 候选。\n"
            "斐波那契数列是从0和1开始、此后每一项等于前两项之和的数列。"
        ),
        json.dumps(
            {
                "topic": "查询Project并解释斐波那契",
                "confirmed_facts": [],
                "decisions": [],
                "open_questions": [],
                "project_hint": None,
                "work_state_candidates": [],
                "memory_candidates": [],
            },
            ensure_ascii=False,
        ),
    ]
    transport = SequencedTransport(responses)
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'continuous-catalog-composition.db'}"),
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=transport,
    )

    with TestClient(app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        approval = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "catalog-composition-start",
                        "列出正式Project，并用一句话解释斐波那契数列。",
                    ),
                )
            )
        )
        for index in range(3):
            approval = _card(
                _events(
                    client.post(
                        "/api/workflows/continuous-collaboration/run",
                        json=_resume(
                            session_id,
                            f"catalog-composition-{index}",
                            approval["approval_id"],
                            "approve",
                        ),
                    )
                )
            )
        completed = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(
                    session_id,
                    "catalog-composition-summary",
                    approval["approval_id"],
                    "approve",
                ),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        governance = client.get(f"/api/runs/{run['id']}/governance").json()

    assert _text(completed) == responses[2]
    assert len(transport.prepared) == 4
    plan_payload = json.loads(transport.prepared[1].provider_request["input"][0]["content"][0]["text"])
    response_payload = json.loads(transport.prepared[2].provider_request["input"][0]["content"][0]["text"])
    for payload in (plan_payload, response_payload):
        catalog_fact = payload["authoritative_product_facts"]["project_catalog"]
        assert catalog_fact["source_id"] == "project_catalog"
        assert catalog_fact["query_status"] == "completed"
        assert catalog_fact["formal_project_count"] == 0
    catalog = governance["execution_draft"]["payload"]["authoritative_product_facts"]["project_catalog"]
    assert catalog["formal_project_count"] == 0
    assert catalog["query_status"] == "completed"


def test_second_turn_uses_a_product_run_scoped_workflow_checkpoint(tmp_path) -> None:
    """A new turn in one Product Session must not reuse the previous Run's storage."""

    database_path = tmp_path / "two-turn-checkpoints.db"
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{database_path}"),
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=SequencedTransport([]),
    )

    with TestClient(app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "turn-one", "第一轮只用于建立运行时实例。"),
                )
            )
        )
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "turn-one-abandon", first["approval_id"], "abandon"),
            )
        )

        second_events = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_request(session_id, "turn-two", "第二轮必须拥有独立Checkpoint。"),
            )
        )
        second = _card(second_events)
        runs = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]

    assert second["execution_context"]["agent_id"] == "intent_router"
    assert not [value for value in second_events if value["type"] == "RUN_ERROR"]
    second_run = next(value for value in runs if value["input_text"].startswith("第二轮"))
    assert second_run["status"] == "waiting_approval"
    with sqlite3.connect(database_path) as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM maf_workflow_checkpoints "
                "WHERE product_run_id = ? AND json_array_length(pending_request_ids_json) > 0",
                (second_run["id"],),
            ).fetchone()[0]
            == 1
        )


def test_continuous_workflow_restores_each_hitl_checkpoint_in_a_new_process(tmp_path) -> None:
    """Every approval may land on a fresh API/Worker process without replaying prior nodes."""

    database_url = f"sqlite+aiosqlite:///{tmp_path / 'cross-process.db'}"
    settings = _settings(database_url)
    session_id: str

    first_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=SequencedTransport([]),
    )
    with TestClient(first_app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "cross-process-start", "什么是幂等？"),
                )
            )
        )

    intent_transport = SequencedTransport(
        [
            json.dumps(
                {
                    "scenario": "simple_question",
                    "goal": "解释什么是幂等",
                    "confidence": 0.98,
                    "project_hint": None,
                    "needs_plan": False,
                    "needs_clarification": False,
                    "clarification_question": None,
                    "context_keywords": ["幂等"],
                    "reason_summary": "独立知识问答",
                },
                ensure_ascii=False,
            )
        ]
    )
    second_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=intent_transport,
    )
    with TestClient(second_app) as client:
        response_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "cross-process-intent", intent_card["approval_id"], "approve"),
                )
            )
        )
        assert response_card["execution_context"]["agent_id"] == "response_agent"
        assert len(intent_transport.prepared) == 1

    response_transport = SequencedTransport(["幂等表示同一操作重复执行不会改变最终可观察结果。"])
    third_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=response_transport,
    )
    with TestClient(third_app) as client:
        summary_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(
                        session_id, "cross-process-response", response_card["approval_id"], "approve"
                    ),
                )
            )
        )
        assert summary_card["execution_context"]["agent_id"] == "turn_summarizer"
        assert len(response_transport.prepared) == 1

    summary_transport = SequencedTransport(
        [
            json.dumps(
                {
                    "topic": "幂等概念",
                    "confirmed_facts": [],
                    "decisions": [],
                    "open_questions": [],
                    "project_hint": None,
                    "work_state_candidates": [],
                    "memory_candidates": [],
                },
                ensure_ascii=False,
            )
        ]
    )
    fourth_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=summary_transport,
    )
    with TestClient(fourth_app) as client:
        completed = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "cross-process-summary", summary_card["approval_id"], "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert _text(completed) == "幂等表示同一操作重复执行不会改变最终可观察结果。"
    assert run["status"] == "succeeded"
    assert messages[-1]["content"] == "幂等表示同一操作重复执行不会改变最终可观察结果。"
    assert len(summary_transport.prepared) == 1
    with sqlite3.connect(tmp_path / "cross-process.db") as connection:
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM maf_workflow_checkpoints WHERE product_run_id = ?",
                (run["id"],),
            ).fetchone()[0]
            >= 3
        )
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM runtime_interrupt_links WHERE product_run_id = ? AND status = 'resumed'",
                (run["id"],),
            ).fetchone()[0]
            == 3
        )


def test_checkpoint_corruption_fails_closed_without_provider_replay(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'checkpoint-corrupt.db'}"
    settings = _settings(database_url)
    first_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=SequencedTransport([]),
        start_outbox_worker=False,
    )
    with TestClient(first_app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "corrupt-start", "什么是幂等？"),
                )
            )
        )

    with sqlite3.connect(tmp_path / "checkpoint-corrupt.db") as connection:
        connection.execute(
            "UPDATE maf_workflow_checkpoints SET graph_signature_hash = ?",
            ("0" * 64,),
        )
        connection.commit()

    transport = SequencedTransport(["SHOULD_NOT_BE_SENT"])
    restored_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=transport,
        start_outbox_worker=False,
    )
    with TestClient(restored_app) as client:
        failed = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "corrupt-resume", card["approval_id"], "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        governance_view = client.get(f"/api/runs/{run['id']}/governance").json()

    assert failed[-1]["type"] == "RUN_ERROR"
    assert transport.prepared == []
    assert run["status"] == "interrupted"
    assert governance_view["runtime_interrupts"][0]["status"] == "recovery_required"
    assert governance_view["workflow_checkpoints"][-1]["status"] == "incompatible"


def test_outbox_worker_resumes_recorded_decision_after_api_process_restart(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'outbox-resume.db'}"
    settings = _settings(database_url)
    first_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=SequencedTransport([]),
        start_outbox_worker=False,
    )
    with TestClient(first_app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "outbox-start", "什么是幂等？"),
                )
            )
        )

    intent_response = json.dumps(
        {
            "scenario": "simple_question",
            "goal": "解释什么是幂等",
            "confidence": 0.98,
            "project_hint": None,
            "needs_plan": False,
            "needs_clarification": False,
            "clarification_question": None,
            "context_keywords": ["幂等"],
            "reason_summary": "独立知识问答",
        },
        ensure_ascii=False,
    )
    decision_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=SequencedTransport([]),
        start_outbox_worker=False,
    )
    governance_ref = card["execution_context"]["governance"]
    with TestClient(decision_app) as client:
        recorded = client.post(
            f"/api/hitl/decision-requests/{governance_ref['decision_request_id']}/resolve",
            json={
                "expected_request_hash": governance_ref["decision_request_hash"],
                "expected_row_version": governance_ref["decision_request_row_version"],
                "item_decisions": [
                    {
                        "item_key": governance_ref["decision_item_key"],
                        "decision": "approve",
                    }
                ],
            },
        )
        assert recorded.status_code == 200, recorded.text

    _spawn_outbox_worker(database_url, intent_response)
    _spawn_execution_worker(database_url, intent_response)

    inspection_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=SequencedTransport([]),
        start_outbox_worker=False,
    )
    with TestClient(inspection_app) as client:
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        governance_view = client.get(f"/api/runs/{run['id']}/governance").json()
    assert run["status"] == "waiting_approval"
    assert len(governance_view["runtime_interrupts"]) == 2
    assert governance_view["runtime_interrupts"][0]["status"] == "resumed"
    assert governance_view["runtime_interrupts"][1]["status"] == "pending"
    assert len(governance_view["workflow_checkpoints"]) >= 2
    assert governance_view["outbox_events"][0]["status"] == "published"
    with sqlite3.connect(tmp_path / "outbox-resume.db") as connection:
        assert connection.execute(
            "SELECT status FROM governance_outbox WHERE aggregate_id = ?",
            (governance_ref["decision_request_id"],),
        ).fetchone() == ("published",)
        assert connection.execute(
            "SELECT status FROM runtime_interrupt_links WHERE decision_request_id = ?",
            (governance_ref["decision_request_id"],),
        ).fetchone() == ("resumed",)


def test_execution_draft_full_edit_creates_new_revision_and_requires_reapproval(tmp_path) -> None:
    transport = SequencedTransport(
        [
            json.dumps(
                {
                    "scenario": "simple_question",
                    "goal": "解释幂等",
                    "confidence": 0.98,
                    "project_hint": None,
                    "needs_plan": False,
                    "needs_clarification": False,
                    "clarification_question": None,
                    "context_keywords": ["幂等"],
                    "reason_summary": "独立知识问答",
                },
                ensure_ascii=False,
            )
        ]
    )
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'draft-edit.db'}"),
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        policy = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "rules": [
                    {
                        "decision_point_key": "execution_authorization",
                        "mode": "require_human",
                        "reason": "测试完整ExecutionDraft工作台",
                    }
                ],
            },
        )
        assert policy.status_code == 200, policy.text
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "draft-start", "什么是幂等？"),
                )
            )
        )
        execution_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "draft-intent", intent_card["approval_id"], "approve"),
                )
            )
        )
        assert execution_card["decision_point_key"] == "execution_authorization"
        assert execution_card["editable_fields"][0]["type"] == "execution_draft"
        draft_id = execution_card["subject_resource_id"]
        draft = client.get(f"/api/execution-drafts/{draft_id}").json()
        payload = draft["payload"]
        payload["scope"]["included"] = ["answer current user request", "include one worked example"]
        revised_response = client.put(
            f"/api/execution-drafts/{draft_id}",
            json={
                "expected_revision_id": draft["revision_id"],
                "expected_draft_hash": draft["draft_hash"],
                "expected_row_version": draft["row_version"],
                "execution_brief": draft["execution_brief"] + "\n补充：必须给出一个例子。",
                "payload": payload,
            },
        )
        assert revised_response.status_code == 200, revised_response.text
        revised = revised_response.json()
        assert revised["revision"] == 2
        assert revised["draft_hash"] != draft["draft_hash"]

        stale = client.put(
            f"/api/execution-drafts/{draft_id}",
            json={
                "expected_revision_id": draft["revision_id"],
                "expected_draft_hash": draft["draft_hash"],
                "expected_row_version": draft["row_version"],
                "execution_brief": "过期页面修改",
                "payload": payload,
            },
        )
        assert stale.status_code == 409

        reapproval = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(
                        session_id,
                        "draft-reapproval",
                        execution_card["approval_id"],
                        "revise",
                        changes={"execution_draft_revision_id": revised["revision_id"]},
                    ),
                )
            )
        )

    assert reapproval["decision_point_key"] == "execution_authorization"
    assert reapproval["subject_hash"] == revised["draft_hash"]
    assert reapproval["subject_hash"] != execution_card["subject_hash"]


def test_execution_draft_revision_reapproval_survives_api_and_worker_process_loss(tmp_path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'draft-outbox.db'}"
    settings = _settings(database_url)
    intent_response = json.dumps(
        {
            "scenario": "simple_question",
            "goal": "解释幂等",
            "confidence": 0.98,
            "project_hint": None,
            "needs_plan": False,
            "needs_clarification": False,
            "clarification_question": None,
            "context_keywords": ["幂等"],
            "reason_summary": "独立知识问答",
        },
        ensure_ascii=False,
    )
    runtime_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=SequencedTransport([intent_response]),
        start_outbox_worker=False,
    )
    with TestClient(runtime_app) as client:
        policy = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "rules": [
                    {
                        "decision_point_key": "execution_authorization",
                        "mode": "require_human",
                    }
                ],
            },
        )
        assert policy.status_code == 200, policy.text
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "draft-outbox-start", "什么是幂等？"),
                )
            )
        )
        execution_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(
                        session_id,
                        "draft-outbox-intent",
                        intent_card["approval_id"],
                        "approve",
                    ),
                )
            )
        )
        draft_id = execution_card["subject_resource_id"]
        draft = client.get(f"/api/execution-drafts/{draft_id}").json()
        payload = draft["payload"]
        payload["scope"]["included"] = ["answer with a worked example"]
        revised = client.put(
            f"/api/execution-drafts/{draft_id}",
            json={
                "expected_revision_id": draft["revision_id"],
                "expected_draft_hash": draft["draft_hash"],
                "expected_row_version": draft["row_version"],
                "execution_brief": draft["execution_brief"] + "\n跨进程重新审批。",
                "payload": payload,
            },
        ).json()

    governance_ref = {
        "decision_request_id": execution_card["decision_request_id"],
        "decision_request_hash": execution_card["request_hash"],
        "decision_request_row_version": execution_card["row_version"],
        "decision_item_key": execution_card["decision_item_key"],
    }
    decision_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=SequencedTransport([]),
        start_outbox_worker=False,
    )
    with TestClient(decision_app) as client:
        recorded = client.post(
            f"/api/hitl/decision-requests/{governance_ref['decision_request_id']}/resolve",
            json={
                "expected_request_hash": governance_ref["decision_request_hash"],
                "expected_row_version": governance_ref["decision_request_row_version"],
                "item_decisions": [
                    {
                        "item_key": governance_ref["decision_item_key"],
                        "decision": "revise",
                    }
                ],
                "response_payload": {
                    "changes": {"execution_draft_revision_id": revised["revision_id"]},
                },
            },
        )
        assert recorded.status_code == 200, recorded.text

    _spawn_outbox_worker(database_url, "unused", expected_count=2)
    _spawn_execution_worker(database_url, "unused")

    inspection_app = create_app(
        settings,
        model_call_store=InMemoryModelCallReviewStore(_catalog()),
        model_call_transport=SequencedTransport([]),
        start_outbox_worker=False,
    )
    with TestClient(inspection_app) as client:
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        governance_view = client.get(f"/api/runs/{run['id']}/governance").json()
        current_draft = client.get(f"/api/execution-drafts/{draft_id}").json()

    execution_requests = [
        value
        for value in governance_view["decision_requests"]
        if value["decision_point_key"] == "execution_authorization"
    ]
    assert current_draft["revision"] == 2
    assert current_draft["draft_hash"] == revised["draft_hash"]
    assert [value["status"] for value in execution_requests] == ["resolved", "pending"]
    assert governance_view["runtime_interrupts"][-2]["status"] == "resumed"
    assert governance_view["runtime_interrupts"][-1]["status"] == "pending"


def test_continuous_workflow_invalid_intent_closes_failed_to_clarification(tmp_path) -> None:
    catalog = _catalog()
    transport = SequencedTransport(["不是JSON"])
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'clarify.db'}"),
        model_call_store=InMemoryModelCallReviewStore(catalog),
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "clarify-start", "继续昨天那个"),
                )
            )
        )
        completed = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "clarify-intent", first["approval_id"], "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        governance = client.get(f"/api/runs/{run['id']}/governance").json()

    assert len(transport.prepared) == 1
    assert "补充目标或相关项目" in _text(completed)
    assert "请直接在下方输入框回答" in _text(completed)
    assert run["status"] == "succeeded"
    assert governance["turn_summary"]["summary"]["open_questions"]
    assert governance["turn_summary"]["summary"]["awaiting_user_answer"] is True
    intent_evaluations = [
        value for value in governance["policy_evaluations"] if value["decision_point_key"] == "intent_binding"
    ]
    assert intent_evaluations[0]["applicability_status"] == "not_applicable"


def test_continuous_workflow_abandon_before_intent_dispatch_sends_nothing(tmp_path) -> None:
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    transport = SequencedTransport([])
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'abandon.db'}"),
        model_call_store=store,
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "abandon-start", "请帮我规划一个项目"),
                )
            )
        )
        abandoned = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "abandon-intent", first["approval_id"], "abandon"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert abandoned[-1]["type"] == "RUN_FINISHED"
    assert run["status"] == "abandoned"
    assert messages == []
    assert transport.prepared == []
    assert store.attempts() == []


def test_ambiguous_intent_can_be_edited_then_same_workflow_continues(tmp_path) -> None:
    responses = [
        json.dumps(
            {
                "scenario": "simple_question",
                "goal": "继续昨天那个",
                "confidence": 0.35,
                "project_hint": None,
                "needs_plan": False,
                "needs_clarification": False,
                "clarification_question": None,
                "context_keywords": [],
                "reason_summary": "缺少唯一Project",
            },
            ensure_ascii=False,
        ),
    ]
    catalog = _catalog()
    transport = SequencedTransport(responses)
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'intent-revision.db'}"),
        model_call_store=InMemoryModelCallReviewStore(catalog),
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_call = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "intent-revise-start", "继续昨天那个"),
                )
            )
        )
        intent_decision = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "intent-revise-model", intent_call["approval_id"], "approve"),
                )
            )
        )
        completed = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(
                    session_id,
                    "intent-revise-decision",
                    intent_decision["approval_id"],
                    "revise",
                    changes={
                        "scenario": "clarify",
                        "goal": "确认用户想继续哪个Project",
                        "project_hint": None,
                        "needs_plan": False,
                        "clarification_question": "你想继续哪个Project？",
                    },
                ),
            )
        )

    assert intent_decision["decision_point_key"] == "intent_binding"
    assert "你想继续哪个Project" in _text(completed)
    assert "请直接在下方输入框回答" in _text(completed)
    assert len(transport.prepared) == 1


def test_explicit_project_catalog_query_cannot_be_rewritten_as_create_or_clarify(tmp_path) -> None:
    catalog = _catalog()
    transport = SequencedTransport([])
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'project-catalog.db'}"),
        model_call_store=InMemoryModelCallReviewStore(catalog),
        model_call_transport=transport,
    )

    with TestClient(app) as client:
        results = []
        for index, prompt in enumerate(
            (
                "我有哪些项目？",
                "我想查看现有的项目列表",
                "我有哪些项目？只查看正式列表，不要创建任何事项。",
            ),
            start=1,
        ):
            session_id = client.post("/api/sessions", json={}).json()["id"]
            completed = _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, f"project-catalog-start-{index}", prompt),
                )
            )
            [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
            governance = client.get(f"/api/runs/{run['id']}/governance").json()
            trace = client.get(f"/api/sessions/{session_id}/runs/{run['id']}/trace").json()["trace"]
            results.append((run, completed, governance, trace))

    assert transport.prepared == []
    for run, completed, governance, trace in results:
        assert run["status"] == "succeeded"
        assert "当前还没有已创建的正式 Project" in _text(completed)
        assert "开始一个新的项目" not in _text(completed)
        assert governance["model_calls"] == []
        assert governance["turn_summary"]["summary"]["query_kind"] == "project_catalog"
        assert any(
            value["payload"].get("actor") == "deterministic_intent_guard"
            and value["payload"].get("public_output", {}).get("model_call_count") == 0
            for value in trace
            if value["event_type"] == "workflow.node.content"
        )
        assert any(
            value["payload"].get("executor_id") == "project_catalog_query"
            for value in trace
            if value["event_type"] == "workflow.node.content"
        )
        [route_event] = [
            value
            for value in trace
            if value["event_type"] == "workflow.node.content"
            and value["payload"].get("executor_id") == "scenario_router"
        ]
        route_decision = route_event["payload"]["public_output"]["route_decision"]
        assert route_decision["selected_branch"] == "project_catalog"
        assert route_decision["selected_target"] == "project_catalog_query"
        assert len(route_decision["options"]) == 4
        assert route_decision["options"][0]["selected"] is True


def test_clarification_answer_reuses_open_question_even_when_answer_has_no_keyword_overlap(tmp_path) -> None:
    responses = [
        json.dumps(
            {
                "scenario": "clarify",
                "goal": "确定用户要继续哪个Project",
                "confidence": 0.3,
                "project_hint": None,
                "needs_plan": False,
                "needs_clarification": True,
                "clarification_question": "你想继续贪吃蛇项目还是记账项目？",
                "context_keywords": [],
                "reason_summary": "存在两个候选Project",
            },
            ensure_ascii=False,
        ),
        json.dumps(
            {
                "scenario": "simple_question",
                "goal": "回答与第一个候选Project有关的问题",
                "confidence": 0.95,
                "project_hint": None,
                "needs_plan": False,
                "needs_clarification": False,
                "clarification_question": None,
                "context_keywords": [],
                "reason_summary": "结合上一轮开放问题理解第一个候选",
            },
            ensure_ascii=False,
        ),
        "已结合上一轮澄清，把“第一个”理解为贪吃蛇项目。",
        json.dumps(
            {
                "topic": "澄清后的项目选择",
                "confirmed_facts": [],
                "decisions": [],
                "open_questions": [],
                "project_hint": "贪吃蛇项目",
                "work_state_candidates": [],
                "memory_candidates": [],
            },
            ensure_ascii=False,
        ),
    ]
    catalog = _catalog()
    transport = SequencedTransport(responses)
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'clarification-follow-up.db'}"),
        model_call_store=InMemoryModelCallReviewStore(catalog),
        model_call_transport=transport,
    )

    with TestClient(app) as client:
        configured = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "expected_active_revision_id": None,
                "change_summary": "澄清连续性测试自动推进低风险模型调用",
                "rules": [{"decision_point_key": "model_call_authorization", "mode": "auto_continue"}],
            },
        )
        assert configured.status_code == 200, configured.text
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_request(session_id, "clarification-first", "继续之前那个"),
            )
        )
        assert "请直接在下方输入框回答" in _text(first)
        open_sets = client.get(f"/api/harness/intents?session_id={session_id}").json()
        clarification_id = open_sets[0]["intents"][0]["clarification"]["id"]
        responses[1] = json.dumps(
            {
                **json.loads(responses[1]),
                "answers_clarification_id": clarification_id,
            },
            ensure_ascii=False,
        )
        restored = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        history = [
            {"id": value["agui_message_id"], "role": value["role"], "content": value["content"]}
            for value in restored
        ]
        second = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_request(session_id, "clarification-second", "第一个", history=history),
            )
        )
        intent_sets = client.get(f"/api/harness/intents?session_id={session_id}").json()

    assert second[-1]["type"] == "RUN_FINISHED"
    second_intent_body = json.dumps(transport.prepared[1].provider_request, ensure_ascii=False)
    assert "awaiting_user_answer" in second_intent_body
    assert "你想继续贪吃蛇项目还是记账项目" in second_intent_body
    assert _text(second) == responses[2]
    original = next(value for value in intent_sets if value["run_id"] == open_sets[0]["run_id"])
    assert original["intents"][0]["clarification"]["status"] == "answered"
    assert original["intents"][0]["clarification"]["current_answer_id"]


def test_principal_policy_can_auto_continue_all_model_calls_with_durable_records(tmp_path) -> None:
    responses = [
        json.dumps(
            {
                "scenario": "simple_question",
                "goal": "解释幂等",
                "confidence": 0.98,
                "project_hint": None,
                "needs_plan": False,
                "needs_clarification": False,
                "clarification_question": None,
                "context_keywords": ["幂等"],
                "reason_summary": "简单问答",
            },
            ensure_ascii=False,
        ),
        "幂等表示重复执行不会改变最终可观察结果。",
        json.dumps(
            {
                "topic": "幂等",
                "confirmed_facts": [],
                "decisions": [],
                "open_questions": [],
                "project_hint": None,
                "work_state_candidates": [],
                "memory_candidates": [],
            },
            ensure_ascii=False,
        ),
    ]
    catalog = _catalog()
    transport = SequencedTransport(responses)
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'auto-model.db'}"),
        model_call_store=InMemoryModelCallReviewStore(catalog),
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        configured = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "expected_active_revision_id": None,
                "change_summary": "测试当前用户自动继续模型调用",
                "rules": [
                    {
                        "decision_point_key": "model_call_authorization",
                        "mode": "auto_continue",
                    }
                ],
            },
        )
        assert configured.status_code == 200, configured.text
        session_id = client.post("/api/sessions", json={}).json()["id"]
        completed = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_request(session_id, "auto-model-start", "什么是幂等？"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        governance = client.get(f"/api/runs/{run['id']}/governance").json()

    assert completed[-1]["type"] == "RUN_FINISHED"
    assert run["status"] == "succeeded"
    assert _text(completed) == responses[1]
    assert len(transport.prepared) == 3
    assert len(governance["model_calls"]) == 3
    assert governance["decision_requests"] == []
    assert all(
        revision["attempts"][0]["status"] == "completed"
        for model_call in governance["model_calls"]
        for revision in model_call["revisions"]
    )


def test_continuous_workflow_plans_and_reuses_only_prior_turn_summary(tmp_path) -> None:
    raw_first_answer = "RAW_FIRST_ANSWER：碰撞检测已写到第17行，这是原始回复而不是摘要。"
    responses = [
        json.dumps(
            {
                "scenario": "simple_question",
                "goal": "说明贪吃蛇项目当前进度",
                "confidence": 0.98,
                "project_hint": "贪吃蛇项目",
                "needs_plan": False,
                "needs_clarification": False,
                "clarification_question": None,
                "context_keywords": ["贪吃蛇", "进度"],
                "reason_summary": "项目状态问答",
            },
            ensure_ascii=False,
        ),
        raw_first_answer,
        json.dumps(
            {
                "topic": "贪吃蛇项目进度",
                "confirmed_facts": ["碰撞检测正在开发"],
                "decisions": [],
                "open_questions": ["移动端手势尚未验证"],
                "project_hint": "贪吃蛇项目",
                "work_state_candidates": [],
                "memory_candidates": [],
            },
            ensure_ascii=False,
        ),
        json.dumps(
            {
                "scenario": "continue_project",
                "goal": "继续贪吃蛇项目并安排下一步",
                "confidence": 0.96,
                "project_hint": "贪吃蛇项目",
                "needs_plan": True,
                "needs_clarification": False,
                "clarification_question": None,
                "context_keywords": ["贪吃蛇", "项目"],
                "reason_summary": "明确继续既有Project",
            },
            ensure_ascii=False,
        ),
        "1. 核对碰撞检测；2. 实现移动端手势；3. 运行回归测试。",
        "下一步先核对碰撞检测，再实现移动端手势并运行回归测试。",
        json.dumps(
            {
                "topic": "继续贪吃蛇项目",
                "confirmed_facts": [],
                "decisions": ["按碰撞检测、移动端手势、回归测试推进"],
                "open_questions": [],
                "project_hint": "贪吃蛇项目",
                "work_state_candidates": [{"kind": "next_step", "value": "核对碰撞检测"}],
                "memory_candidates": [],
            },
            ensure_ascii=False,
        ),
    ]
    catalog = _catalog()
    transport = SequencedTransport(responses)
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'summary-context.db'}"),
        model_call_store=InMemoryModelCallReviewStore(catalog),
        model_call_transport=transport,
    )

    with TestClient(app) as client:
        configured = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "expected_active_revision_id": None,
                "change_summary": "场景测试自动执行低风险模型调用和候选处理",
                "rules": [
                    {"decision_point_key": "model_call_authorization", "mode": "auto_continue"},
                    {"decision_point_key": "memory_commit", "mode": "auto_continue"},
                ],
            },
        )
        assert configured.status_code == 200, configured.text
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_request(session_id, "summary-context-first", "贪吃蛇项目现在做到哪里了？"),
            )
        )
        assert first[-1]["type"] == "RUN_FINISHED"
        restored = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        history = [
            {"id": value["agui_message_id"], "role": value["role"], "content": value["content"]}
            for value in restored
        ]
        second = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_request(
                    session_id,
                    "summary-context-second",
                    "继续贪吃蛇项目，安排下一步",
                    history=history,
                ),
            )
        )
        runs = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        second_governance = client.get(f"/api/runs/{runs[0]['id']}/governance").json()

    assert second[-1]["type"] == "RUN_FINISHED", second[-1]
    assert len(transport.prepared) == 7
    assert len(second_governance["model_calls"]) == 4
    second_intent_body = json.dumps(transport.prepared[3].provider_request, ensure_ascii=False)
    assert "贪吃蛇项目进度" in second_intent_body
    assert "碰撞检测正在开发" in second_intent_body
    assert raw_first_answer not in second_intent_body
    assert second_governance["turn_summary"]["topic"] == "继续贪吃蛇项目"
