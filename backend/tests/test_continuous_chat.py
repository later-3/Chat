from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.main import create_app
from backend.app.model_call_review import InMemoryModelCallReviewStore, PreparedProviderRequest
from backend.app.model_providers import ModelOption, ModelProviderCatalog, ModelProviderConfig


class SequencedTransport:
    def __init__(self, responses: list[str]) -> None:
        self.responses = responses
        self.prepared: list[PreparedProviderRequest] = []

    async def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[str]:
        self.prepared.append(prepared)
        yield self.responses[len(self.prepared) - 1]


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
        "forwardedProps": {
            "workflow": {"id": "continuous-collaboration", "version": "1.0.0"}
        },
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
        "resume": [{
            "interruptId": approval_id,
            "status": "resolved",
            "payload": {"decision": decision, **({"changes": changes} if changes else {})},
        }],
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
        str(value.get("delta") or "")
        for value in events
        if value["type"] == "TEXT_MESSAGE_CONTENT"
    )


def test_continuous_workflow_simple_question_uses_three_governed_model_calls(tmp_path) -> None:
    responses = [
        json.dumps({
            "scenario": "simple_question",
            "goal": "解释什么是幂等",
            "confidence": 0.97,
            "project_hint": None,
            "needs_plan": False,
            "needs_clarification": False,
            "clarification_question": None,
            "context_keywords": ["幂等"],
            "reason_summary": "独立知识问答",
        }, ensure_ascii=False),
        "幂等是指同一个操作执行一次或多次，最终产生相同的可观察结果。",
        json.dumps({
            "topic": "幂等概念",
            "confirmed_facts": [],
            "decisions": [],
            "open_questions": [],
            "project_hint": None,
            "work_state_candidates": [],
            "memory_candidates": [],
        }, ensure_ascii=False),
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
        assert [value["id"] for value in workflows if value["selectable"]] == [
            "continuous-collaboration"
        ]
        definition = next(value for value in workflows if value["id"] == "continuous-collaboration")
        assert len(definition["nodes"]) == 20

        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _card(_events(client.post(
            definition["endpoint"],
            json=_request(session_id, "continuous-start", "什么是幂等？"),
        )))
        assert first["execution_context"]["agent_id"] == "intent_router"
        assert first["execution_context"]["governance"]["final_action"] == "require_human"
        assert transport.prepared == []

        second = _card(_events(client.post(
            definition["endpoint"],
            json=_resume(session_id, "continuous-intent", first["approval_id"], "approve"),
        )))
        assert second["execution_context"]["agent_id"] == "response_agent"
        assert len(transport.prepared) == 1

        third = _card(_events(client.post(
            definition["endpoint"],
            json=_resume(session_id, "continuous-response", second["approval_id"], "approve"),
        )))
        assert third["execution_context"]["agent_id"] == "turn_summarizer"
        assert len(transport.prepared) == 2

        completed = _events(client.post(
            definition["endpoint"],
            json=_resume(session_id, "continuous-summary", third["approval_id"], "approve"),
        ))
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        trace = client.get(f"/api/sessions/{session_id}/runs/{run['id']}/trace").json()["trace"]
        governance = client.get(f"/api/runs/{run['id']}/governance")
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert len(transport.prepared) == 3
    assert _text(completed) == responses[1]
    assert messages[-1]["content"] == responses[1]
    assert governance.status_code == 200
    assert governance.json()["execution_draft"]["status"] == "accepted"
    assert governance.json()["run_spec"] is not None
    assert governance.json()["run_spec"]["status"] == "bound"
    assert governance.json()["turn_summary"]["topic"] == "幂等概念"
    assert len(governance.json()["model_calls"]) == 3
    contents = {
        value["payload"]["executor_id"]
        for value in trace
        if value["event_type"] == "workflow.node.content"
    }
    content_sequence = {
        value["payload"]["executor_id"]: value["sequence"]
        for value in trace
        if value["event_type"] == "workflow.node.content"
    }
    assert {
        "input_acceptance",
        "context_candidates",
        "intent_agent",
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
        first = _card(_events(client.post(
            "/api/workflows/continuous-collaboration/run",
            json=_request(session_id, "clarify-start", "继续昨天那个"),
        )))
        intent_decision = _card(_events(client.post(
            "/api/workflows/continuous-collaboration/run",
            json=_resume(session_id, "clarify-intent", first["approval_id"], "approve"),
        )))
        assert intent_decision["review_kind"] == "product_decision"
        assert intent_decision["decision_point_key"] == "intent_binding"
        completed = _events(client.post(
            "/api/workflows/continuous-collaboration/run",
            json=_resume(
                session_id,
                "clarify-intent-accepted",
                intent_decision["approval_id"],
                "accept",
            ),
        ))
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        governance = client.get(f"/api/runs/{run['id']}/governance").json()

    assert len(transport.prepared) == 1
    assert "补充目标或相关项目" in _text(completed)
    assert run["status"] == "succeeded"
    assert governance["turn_summary"]["summary"]["open_questions"]


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
        first = _card(_events(client.post(
            "/api/workflows/continuous-collaboration/run",
            json=_request(session_id, "abandon-start", "请帮我规划一个项目"),
        )))
        abandoned = _events(client.post(
            "/api/workflows/continuous-collaboration/run",
            json=_resume(session_id, "abandon-intent", first["approval_id"], "abandon"),
        ))
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert abandoned[-1]["type"] == "RUN_FINISHED"
    assert run["status"] == "abandoned"
    assert messages == []
    assert transport.prepared == []
    assert store.attempts() == []


def test_ambiguous_intent_can_be_edited_then_same_workflow_continues(tmp_path) -> None:
    responses = [
        json.dumps({
            "scenario": "clarify",
            "goal": "继续昨天那个",
            "confidence": 0.35,
            "project_hint": None,
            "needs_plan": False,
            "needs_clarification": True,
            "clarification_question": "你想继续哪个Project？",
            "context_keywords": [],
            "reason_summary": "缺少唯一Project",
        }, ensure_ascii=False),
        "幂等键应由业务操作身份构成，而不是随机请求ID。",
        json.dumps({
            "topic": "幂等键设计",
            "confirmed_facts": [],
            "decisions": [],
            "open_questions": [],
            "project_hint": None,
            "work_state_candidates": [],
            "memory_candidates": [],
        }, ensure_ascii=False),
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
        intent_call = _card(_events(client.post(
            "/api/workflows/continuous-collaboration/run",
            json=_request(session_id, "intent-revise-start", "继续昨天那个"),
        )))
        intent_decision = _card(_events(client.post(
            "/api/workflows/continuous-collaboration/run",
            json=_resume(session_id, "intent-revise-model", intent_call["approval_id"], "approve"),
        )))
        response_call = _card(_events(client.post(
            "/api/workflows/continuous-collaboration/run",
            json=_resume(
                session_id,
                "intent-revise-decision",
                intent_decision["approval_id"],
                "revise",
                changes={
                    "scenario": "simple_question",
                    "goal": "解释幂等键应该如何设计",
                    "project_hint": None,
                    "needs_plan": False,
                },
            ),
        )))

    assert intent_decision["decision_point_key"] == "intent_binding"
    assert response_call["execution_context"]["agent_id"] == "response_agent"
    assert len(transport.prepared) == 1


def test_principal_policy_can_auto_continue_all_model_calls_with_durable_records(tmp_path) -> None:
    responses = [
        json.dumps({
            "scenario": "simple_question",
            "goal": "解释幂等",
            "confidence": 0.98,
            "project_hint": None,
            "needs_plan": False,
            "needs_clarification": False,
            "clarification_question": None,
            "context_keywords": ["幂等"],
            "reason_summary": "简单问答",
        }, ensure_ascii=False),
        "幂等表示重复执行不会改变最终可观察结果。",
        json.dumps({
            "topic": "幂等",
            "confirmed_facts": [],
            "decisions": [],
            "open_questions": [],
            "project_hint": None,
            "work_state_candidates": [],
            "memory_candidates": [],
        }, ensure_ascii=False),
    ]
    catalog = _catalog()
    transport = SequencedTransport(responses)
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'auto-model.db'}"),
        model_call_store=InMemoryModelCallReviewStore(catalog),
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        configured = client.post("/api/hitl/policy-sets/activate", json={
            "scope_kind": "principal",
            "scope_ref_id": "local-user",
            "expected_active_revision_id": None,
            "change_summary": "测试当前用户自动继续模型调用",
            "rules": [{
                "decision_point_key": "model_call_authorization",
                "mode": "auto_continue",
            }],
        })
        assert configured.status_code == 200, configured.text
        session_id = client.post("/api/sessions", json={}).json()["id"]
        completed = _events(client.post(
            "/api/workflows/continuous-collaboration/run",
            json=_request(session_id, "auto-model-start", "什么是幂等？"),
        ))
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
        json.dumps({
            "scenario": "simple_question",
            "goal": "说明贪吃蛇项目当前进度",
            "confidence": 0.98,
            "project_hint": "贪吃蛇项目",
            "needs_plan": False,
            "needs_clarification": False,
            "clarification_question": None,
            "context_keywords": ["贪吃蛇", "进度"],
            "reason_summary": "项目状态问答",
        }, ensure_ascii=False),
        raw_first_answer,
        json.dumps({
            "topic": "贪吃蛇项目进度",
            "confirmed_facts": ["碰撞检测正在开发"],
            "decisions": [],
            "open_questions": ["移动端手势尚未验证"],
            "project_hint": "贪吃蛇项目",
            "work_state_candidates": [],
            "memory_candidates": [],
        }, ensure_ascii=False),
        json.dumps({
            "scenario": "continue_project",
            "goal": "继续贪吃蛇项目并安排下一步",
            "confidence": 0.96,
            "project_hint": "贪吃蛇项目",
            "needs_plan": True,
            "needs_clarification": False,
            "clarification_question": None,
            "context_keywords": ["贪吃蛇", "项目"],
            "reason_summary": "明确继续既有Project",
        }, ensure_ascii=False),
        "1. 核对碰撞检测；2. 实现移动端手势；3. 运行回归测试。",
        "下一步先核对碰撞检测，再实现移动端手势并运行回归测试。",
        json.dumps({
            "topic": "继续贪吃蛇项目",
            "confirmed_facts": [],
            "decisions": ["按碰撞检测、移动端手势、回归测试推进"],
            "open_questions": [],
            "project_hint": "贪吃蛇项目",
            "work_state_candidates": [{"kind": "next_step", "value": "核对碰撞检测"}],
            "memory_candidates": [],
        }, ensure_ascii=False),
    ]
    catalog = _catalog()
    transport = SequencedTransport(responses)
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'summary-context.db'}"),
        model_call_store=InMemoryModelCallReviewStore(catalog),
        model_call_transport=transport,
    )

    with TestClient(app) as client:
        configured = client.post("/api/hitl/policy-sets/activate", json={
            "scope_kind": "principal",
            "scope_ref_id": "local-user",
            "expected_active_revision_id": None,
            "change_summary": "场景测试自动执行低风险模型调用和候选处理",
            "rules": [
                {"decision_point_key": "model_call_authorization", "mode": "auto_continue"},
                {"decision_point_key": "memory_commit", "mode": "auto_continue"},
            ],
        })
        assert configured.status_code == 200, configured.text
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _events(client.post(
            "/api/workflows/continuous-collaboration/run",
            json=_request(session_id, "summary-context-first", "贪吃蛇项目现在做到哪里了？"),
        ))
        assert first[-1]["type"] == "RUN_FINISHED"
        restored = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        history = [
            {"id": value["agui_message_id"], "role": value["role"], "content": value["content"]}
            for value in restored
        ]
        second = _events(client.post(
            "/api/workflows/continuous-collaboration/run",
            json=_request(
                session_id,
                "summary-context-second",
                "继续贪吃蛇项目，安排下一步",
                history=history,
            ),
        ))
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
