from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.main import create_app


def _client() -> TestClient:
    return TestClient(create_app(Settings.for_test()))


def test_health_exposes_approved_architecture_without_secrets() -> None:
    with _client() as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "chat",
        "version": "0.1.0",
        "agent_framework": "microsoft-agent-framework",
        "protocol": "ag-ui",
        "runtime_mode": "bootstrap",
        "model": None,
    }


def test_settings_accept_ark_provider_aliases(monkeypatch) -> None:
    monkeypatch.delenv("CHAT_MODEL", raising=False)
    monkeypatch.delenv("CHAT_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("CHAT_MODEL_BASE_URL", raising=False)
    monkeypatch.setenv("ARK_MODEL", "ark-test-model")
    monkeypatch.setenv("ARK_API_KEY", "ark-test-key")
    monkeypatch.setenv("ARK_BASE_URL", "https://example.invalid/v1")

    settings = Settings.from_env()

    assert settings.runtime_mode == "model"
    assert settings.model == "ark-test-model"
    assert settings.model_api_key == "ark-test-key"
    assert settings.model_base_url == "https://example.invalid/v1"


def test_ag_ui_endpoint_streams_a_complete_bootstrap_run() -> None:
    payload = {
        "threadId": "thread-test",
        "runId": "run-test",
        "state": {},
        "messages": [
            {
                "id": "message-user-test",
                "role": "user",
                "content": "验证AG-UI连接",
            }
        ],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }

    with _client() as client:
        response = client.post("/api/agent", json=payload)

    assert response.status_code == 200
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    event_types = [event["type"] for event in events]
    assert event_types[0] == "RUN_STARTED"
    assert "TEXT_MESSAGE_CONTENT" in event_types
    assert event_types[-1] == "RUN_FINISHED"
    text = "".join(
        str(event.get("delta", ""))
        for event in events
        if event["type"] == "TEXT_MESSAGE_CONTENT"
    )
    assert "Microsoft Agent Framework" in text
