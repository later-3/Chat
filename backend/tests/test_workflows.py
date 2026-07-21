from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.main import create_app


def _events(response) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def _request(session_id: str, run_id: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "threadId": session_id,
        "runId": run_id,
        "state": {},
        "messages": messages,
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def _activity(events: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [
        (str(event["content"]["executor_id"]), str(event["content"]["status"]))
        for event in events
        if event["type"] == "ACTIVITY_SNAPSHOT"
    ]


def test_workflow_catalog_describes_nested_heterogeneous_graph() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        response = client.get("/api/workflows")

    assert response.status_code == 200
    [workflow] = response.json()["workflows"]
    assert workflow["id"] == "nested-quality-demo"
    assert workflow["endpoint"] == "/api/workflows/nested-quality-demo/run"
    assert {node["runtime_type"] for node in workflow["nodes"]} == {"executor", "workflow"}
    assert {node["kind"] for node in workflow["nodes"]} >= {
        "input",
        "workflow",
        "transform",
        "policy",
        "decision",
        "output",
    }
    assert max(node["depth"] for node in workflow["nodes"]) == 2
    assert next(
        node for node in workflow["nodes"] if node["id"] == "quality_gate.policy_bundle.score"
    )["parent_id"] == "quality_gate.policy_bundle"


def test_nested_workflow_emits_standard_agui_progress_and_persists_trace() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        events = _events(
            client.post(
                "/api/workflows/nested-quality-demo/run",
                json=_request(
                    session_id,
                    "workflow-success",
                    [{"id": "workflow-user", "role": "user", "content": "检查交付质量"}],
                ),
            )
        )

        assert events[-1]["type"] == "RUN_FINISHED"
        activity = _activity(events)
        assert ("quality_gate", "in_progress") in activity
        assert ("quality_gate.policy_bundle", "in_progress") in activity
        assert ("quality_gate.policy_bundle.score", "completed") in activity
        assert ("finalize", "completed") in activity
        assert all("traceback" not in json.dumps(event) for event in events)

        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        assert run["status"] == "succeeded"
        trace = client.get(f"/api/sessions/{session_id}/runs/{run['id']}/trace").json()["trace"]
        assert [value["sequence"] for value in trace] == list(range(1, len(trace) + 1))
        assert trace[-1]["event_type"] == "run.succeeded"
        node_trace = [value for value in trace if value["event_type"] == "workflow.node"]
        assert any(
            value["payload"]["executor_id"] == "quality_gate.policy_bundle.score"
            and value["payload"]["status"] == "completed"
            for value in node_trace
        )
        assert all("data" not in value["payload"] for value in node_trace)
        latest = client.get(
            f"/api/sessions/{session_id}/workflows/nested-quality-demo/latest-trace"
        ).json()["trace"]
        assert latest == trace


def test_nested_workflow_failure_has_no_fake_success_and_keeps_user_fact() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        events = _events(
            client.post(
                "/api/workflows/nested-quality-demo/run",
                json=_request(
                    session_id,
                    "workflow-failure",
                    [{"id": "workflow-fail-user", "role": "user", "content": "检查 [fail]"}],
                ),
            )
        )

        assert events[-1]["type"] == "RUN_ERROR"
        assert events[-1]["code"] == "RuntimeError"
        activity = _activity(events)
        assert ("quality_gate.policy_bundle.score", "failed") in activity
        assert ("quality_gate.policy_bundle", "failed") in activity
        assert ("quality_gate", "failed") in activity
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        assert run["status"] == "failed"
        assert run["assistant_message_id"] is None
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        assert [(message["role"], message["content"]) for message in messages] == [
            ("user", "检查 [fail]")
        ]
        trace = client.get(f"/api/sessions/{session_id}/runs/{run['id']}/trace").json()["trace"]
        assert trace[-1]["event_type"] == "run.failed"
        assert not any(value["event_type"] == "run.succeeded" for value in trace)
        assert "traceback" not in json.dumps(trace)


def test_workflow_result_is_authoritative_history_for_next_chat_turn() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _request(
            session_id,
            "workflow-cross-feature",
            [{"id": "workflow-cross-user", "role": "user", "content": "跨功能检查"}],
        )
        assert _events(client.post("/api/workflows/nested-quality-demo/run", json=first))[-1][
            "type"
        ] == "RUN_FINISHED"

        restored = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        next_messages = [
            {
                "id": value["agui_message_id"],
                "role": value["role"],
                "content": value["content"],
            }
            for value in restored
        ]
        next_messages.append({"id": "chat-after-workflow", "role": "user", "content": "继续"})
        second = _events(
            client.post(
                "/api/agent",
                json=_request(session_id, "chat-after-workflow-run", next_messages),
            )
        )

        assert second[-1]["type"] == "RUN_FINISHED"
        final_messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        assert [value["role"] for value in final_messages] == [
            "user",
            "assistant",
            "user",
            "assistant",
        ]
