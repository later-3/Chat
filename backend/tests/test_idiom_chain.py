from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi.testclient import TestClient

from backend.app.config import Settings
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


def _request(session_id: str, run_id: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "threadId": session_id,
        "runId": run_id,
        "state": {},
        "messages": messages,
        "tools": [],
        "context": [],
        "forwardedProps": {"workflow": {"id": "governed-idiom-chain", "version": "1.0.0"}},
    }


def _resume(session_id: str, run_id: str, approval_id: str, decision: str) -> dict[str, Any]:
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
                "payload": {"decision": decision},
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
    finished = [value for value in events if value["type"] == "RUN_FINISHED"][-1]
    return finished["outcome"]["interrupts"][0]["metadata"]["agent_framework"]["data"]


def _text(events: list[dict[str, Any]]) -> str:
    return "".join(
        str(value.get("delta") or "") for value in events if value["type"] == "TEXT_MESSAGE_CONTENT"
    )


def test_idiom_chain_requires_two_approvals_and_records_public_node_content(tmp_path) -> None:
    store = InMemoryModelCallReviewStore(_catalog())
    transport = SequencedTransport(["意气风发", "发扬光大"])
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'idiom.db'}"),
        model_call_store=store,
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        workflows = client.get("/api/workflows").json()["workflows"]
        selectable = [value for value in workflows if value["selectable"]]
        assert [value["id"] for value in selectable] == [
            "continuous-collaboration",
        ]
        idiom = next(value for value in workflows if value["id"] == "governed-idiom-chain")
        assert [value["runtime_type"] for value in idiom["nodes"]] == [
            "executor",
            "agent",
            "executor",
            "agent",
            "executor",
        ]

        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _events(
            client.post(
                idiom["endpoint"],
                json=_request(
                    session_id, "idiom-start", [{"id": "user-1", "role": "user", "content": "一心一意"}]
                ),
            )
        )
        agent_a = _card(first)
        assert agent_a["execution_context"]["agent_id"] == "idiom_agent_a"
        assert agent_a["execution_context"]["call_position"] == 1
        assert transport.prepared == []

        second = _events(
            client.post(
                idiom["endpoint"],
                json=_resume(session_id, "idiom-a-approved", agent_a["approval_id"], "approve"),
            )
        )
        agent_b = _card(second)
        assert agent_b["execution_context"]["agent_id"] == "idiom_agent_b"
        assert agent_b["execution_context"]["call_position"] == 2
        assert len(transport.prepared) == 1
        prepared_b = json.loads(transport.prepared[0].body.decode("utf-8"))
        assert "一心一意" in json.dumps(prepared_b, ensure_ascii=False)

        completed = _events(
            client.post(
                idiom["endpoint"],
                json=_resume(session_id, "idiom-b-approved", agent_b["approval_id"], "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        trace = client.get(f"/api/sessions/{session_id}/runs/{run['id']}/trace").json()["trace"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert len(transport.prepared) == 2
    assert _text(completed) == (
        "本轮成语接龙\n"
        "你：一心一意\n"
        "接龙 Agent 甲：意气风发\n"
        "接龙 Agent 乙：发扬光大\n\n"
        "轮到你了：请用“大”字开头继续。"
    )
    assert messages[-1]["content"].endswith("请用“大”字开头继续。")
    content_events = [value["payload"] for value in trace if value["event_type"] == "workflow.node.content"]
    assert {value["executor_id"] for value in content_events} == {
        "idiom_input",
        "idiom_agent_a",
        "idiom_handoff",
        "idiom_agent_b",
        "idiom_result",
    }
    assert all("public_input" in value and "public_output" in value for value in content_events)
    assert "hidden" not in json.dumps(content_events).lower()


def test_idiom_chain_rejects_broken_continuation_before_provider_call(tmp_path) -> None:
    store = InMemoryModelCallReviewStore(_catalog())
    transport = SequencedTransport(["意气风发", "发扬光大"])
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'invalid.db'}"),
        model_call_store=store,
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _card(
            _events(
                client.post(
                    "/api/workflows/governed-idiom-chain/run",
                    json=_request(
                        session_id,
                        "valid-start",
                        [
                            {"id": "initial-user", "role": "user", "content": "一心一意"},
                        ],
                    ),
                )
            )
        )
        second = _card(
            _events(
                client.post(
                    "/api/workflows/governed-idiom-chain/run",
                    json=_resume(session_id, "valid-a", first["approval_id"], "approve"),
                )
            )
        )
        _events(
            client.post(
                "/api/workflows/governed-idiom-chain/run",
                json=_resume(session_id, "valid-b", second["approval_id"], "approve"),
            )
        )
        history = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        agui_history = [
            {"id": value["agui_message_id"], "role": value["role"], "content": value["content"]}
            for value in history
        ]
        agui_history.append({"id": "user-invalid", "role": "user", "content": "一心一意"})
        events = _events(
            client.post(
                "/api/workflows/governed-idiom-chain/run",
                json=_request(session_id, "invalid", agui_history),
            )
        )
        runs = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]

    assert events[-1]["type"] == "RUN_ERROR"
    assert "需要用“大”字开头" in events[-1]["message"]
    assert runs[0]["status"] == "failed"
    assert len(transport.prepared) == 2
    assert len(store.attempts()) == 2


def test_abandon_second_idiom_agent_keeps_one_dispatch_and_no_fake_answer(tmp_path) -> None:
    store = InMemoryModelCallReviewStore(_catalog())
    transport = SequencedTransport(["意气风发"])
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
                    "/api/workflows/governed-idiom-chain/run",
                    json=_request(
                        session_id, "start", [{"id": "user", "role": "user", "content": "一心一意"}]
                    ),
                )
            )
        )
        second = _card(
            _events(
                client.post(
                    "/api/workflows/governed-idiom-chain/run",
                    json=_resume(session_id, "first-ok", first["approval_id"], "approve"),
                )
            )
        )
        abandoned = _events(
            client.post(
                "/api/workflows/governed-idiom-chain/run",
                json=_resume(session_id, "second-abandon", second["approval_id"], "abandon"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert abandoned[-1]["type"] == "RUN_FINISHED"
    assert run["status"] == "abandoned"
    assert messages == []
    assert len(transport.prepared) == 1
    assert len(store.attempts()) == 1


def test_abandon_first_idiom_agent_sends_nothing_and_withdraws_user_turn(tmp_path) -> None:
    store = InMemoryModelCallReviewStore(_catalog())
    transport = SequencedTransport([])
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'first-abandon.db'}"),
        model_call_store=store,
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _card(
            _events(
                client.post(
                    "/api/workflows/governed-idiom-chain/run",
                    json=_request(
                        session_id, "start", [{"id": "user", "role": "user", "content": "一心一意"}]
                    ),
                )
            )
        )
        abandoned = _events(
            client.post(
                "/api/workflows/governed-idiom-chain/run",
                json=_resume(session_id, "first-abandon", first["approval_id"], "abandon"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert abandoned[-1]["type"] == "RUN_FINISHED"
    assert run["status"] == "abandoned"
    assert messages == []
    assert transport.prepared == []
    assert store.attempts() == []


def test_invalid_first_agent_output_fails_before_second_agent(tmp_path) -> None:
    store = InMemoryModelCallReviewStore(_catalog())
    transport = SequencedTransport(["我不知道该接什么"])
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'invalid-agent.db'}"),
        model_call_store=store,
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _card(
            _events(
                client.post(
                    "/api/workflows/governed-idiom-chain/run",
                    json=_request(
                        session_id, "start", [{"id": "user", "role": "user", "content": "一心一意"}]
                    ),
                )
            )
        )
        failed = _events(
            client.post(
                "/api/workflows/governed-idiom-chain/run",
                json=_resume(session_id, "invalid-output", first["approval_id"], "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]

    assert failed[-1]["type"] == "RUN_ERROR"
    assert run["status"] == "failed"
    assert len(transport.prepared) == 1
    assert len(store.attempts()) == 1


def test_second_idiom_round_uses_previous_tail_and_completes(tmp_path) -> None:
    store = InMemoryModelCallReviewStore(_catalog())
    transport = SequencedTransport(["意气风发", "发扬光大", "成千上万", "万事如意"])
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'two-rounds.db'}"),
        model_call_store=store,
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]

        def play_round(run_prefix: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
            first = _card(
                _events(
                    client.post(
                        "/api/workflows/governed-idiom-chain/run",
                        json=_request(session_id, f"{run_prefix}-start", messages),
                    )
                )
            )
            second = _card(
                _events(
                    client.post(
                        "/api/workflows/governed-idiom-chain/run",
                        json=_resume(session_id, f"{run_prefix}-a", first["approval_id"], "approve"),
                    )
                )
            )
            return _events(
                client.post(
                    "/api/workflows/governed-idiom-chain/run",
                    json=_resume(session_id, f"{run_prefix}-b", second["approval_id"], "approve"),
                )
            )

        play_round("one", [{"id": "user-one", "role": "user", "content": "一心一意"}])
        history = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        next_messages = [
            {"id": value["agui_message_id"], "role": value["role"], "content": value["content"]}
            for value in history
        ]
        next_messages.append({"id": "user-two", "role": "user", "content": "大功告成"})
        completed = play_round("two", next_messages)
        runs = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]

    assert _text(completed).endswith("轮到你了：请用“意”字开头继续。")
    assert [value["status"] for value in runs] == ["succeeded", "succeeded"]
    assert len(transport.prepared) == 4
