from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.config import Settings, SettingsError
from backend.app.main import create_app
from backend.app.model_providers import ModelProviderCatalogError


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
        "model_call_approval": "not_applicable",
        "product_sessions": "sqlite",
    }


def _write_config(path: Path, payload: dict[str, object]) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_settings_loads_one_provider_from_json(tmp_path: Path) -> None:
    path = _write_config(
        tmp_path / "config.json",
        {
            "server": {
                "host": "127.0.0.2",
                "port": 8040,
                "frontend_origins": ["http://frontend.invalid"],
            },
            "default_provider_id": "ark",
            "providers": [
                {
                    "id": "ark",
                    "label": "火山方舟",
                    "base_url": "https://example.invalid/v1",
                    "api_key": "ark-test-key",
                    "default_model": "ark-test-model",
                    "models": ["ark-test-model", "ark-second-model"],
                }
            ],
        },
    )

    settings = Settings.from_file(path)

    assert settings.runtime_mode == "model"
    assert settings.model == "ark-test-model"
    assert settings.model_api_key == "ark-test-key"
    assert settings.model_base_url == "https://example.invalid/v1"
    assert settings.host == "127.0.0.2"
    assert settings.port == 8040
    assert settings.frontend_origins == ("http://frontend.invalid",)
    assert settings.model_catalog() is not None
    assert settings.model_catalog().default_provider_id == "ark"
    assert [model.id for model in settings.model_catalog().get("ark").models] == [
        "ark-test-model",
        "ark-second-model",
    ]


def test_settings_builds_multiple_provider_model_catalog_without_exposing_secrets(tmp_path: Path) -> None:
    path = _write_config(
        tmp_path / "config.json",
        {
            "default_provider_id": "beta",
            "providers": [
                {
                    "id": "alpha",
                    "label": "Alpha Provider",
                    "base_url": "https://alpha.invalid/v1",
                    "api_key": "alpha-secret",
                    "default_model": "alpha-1",
                    "models": ["alpha-1", "alpha-2"],
                },
                {
                    "id": "beta",
                    "label": "Beta Provider",
                    "base_url": "https://beta.invalid/v1",
                    "api_key": "beta-secret",
                    "default_model": "beta-1",
                    "models": [{"id": "beta-1", "label": "Beta One"}],
                    "capabilities": {
                        "image_input": True,
                        "parameters": [
                            {
                                "key": "temperature",
                                "label": "随机性",
                                "value_type": "number",
                                "default": 1,
                                "minimum": 0,
                                "maximum": 2,
                            }
                        ],
                    },
                },
            ],
        },
    )

    settings = Settings.from_file(path)
    catalog = settings.model_catalog()

    assert catalog is not None
    assert catalog.default_provider_id == "beta"
    assert catalog.default_model == "beta-1"
    assert settings.model == "beta-1"
    assert [model.id for model in catalog.get("beta").models] == ["beta-1"]
    assert catalog.get("beta").api_key == "beta-secret"
    public = catalog.public_view()
    public_model = public[1]["models"][0]
    assert public_model["id"] == "beta-1"
    assert public_model["label"] == "Beta One"
    assert public_model["capabilities"]["content_types_by_role"]["user"] == [
        "input_text",
        "input_image",
    ]
    assert [item["key"] for item in public_model["capabilities"]["parameters"]] == [
        "store",
        "stream",
        "temperature",
    ]
    assert "secret" not in json.dumps(public)


def test_settings_uses_bootstrap_when_json_has_no_configured_provider(tmp_path: Path) -> None:
    path = _write_config(
        tmp_path / "config.json",
        {
            "version": 1,
            "default_provider_id": "ark",
            "providers": [
                {
                    "id": "ark",
                    "label": "火山方舟",
                    "enabled": True,
                    "api_key": "",
                    "default_model": "ark-model",
                    "models": ["ark-model"],
                },
                {
                    "id": "dashscope",
                    "label": "阿里云百炼",
                    "enabled": False,
                    "api_key": "dashscope-secret",
                    "default_model": "dashscope-model",
                    "models": ["dashscope-model"],
                },
            ],
        },
    )

    settings = Settings.from_file(path)

    assert settings.runtime_mode == "bootstrap"
    assert settings.model_catalog() is None
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/model-providers").json() == {
            "default_provider_id": None,
            "default_model": None,
            "providers": [],
        }


def test_settings_rejects_unconfigured_default_when_another_provider_is_available(
    tmp_path: Path,
) -> None:
    path = _write_config(
        tmp_path / "config.json",
        {
            "version": 1,
            "default_provider_id": "ark",
            "providers": [
                {
                    "id": "ark",
                    "api_key": "",
                    "default_model": "ark-model",
                    "models": ["ark-model"],
                },
                {
                    "id": "dashscope",
                    "api_key": "configured",
                    "default_model": "dashscope-model",
                    "models": ["dashscope-model"],
                },
            ],
        },
    )

    with pytest.raises(ModelProviderCatalogError, match="默认Provider未完成运行配置"):
        Settings.from_file(path)


def test_settings_rejects_unknown_json_version(tmp_path: Path) -> None:
    path = _write_config(tmp_path / "config.json", {"version": 2, "providers": []})

    with pytest.raises(SettingsError, match="不支持的配置版本"):
        Settings.from_file(path)


@pytest.mark.parametrize(
    ("provider_changes", "error_type", "message"),
    [
        (
            {"default_model": "not-in-models"},
            ModelProviderCatalogError,
            "不属于Provider",
        ),
        (
            {"protocol": "private_vendor_protocol"},
            ModelProviderCatalogError,
            "尚未支持的协议",
        ),
        (
            {"enabled": "yes"},
            SettingsError,
            "必须是JSON布尔值",
        ),
    ],
)
def test_settings_rejects_invalid_provider_schema(
    tmp_path: Path,
    provider_changes: dict[str, object],
    error_type: type[Exception],
    message: str,
) -> None:
    provider: dict[str, object] = {
        "id": "ark",
        "api_key": "configured",
        "protocol": "openai_responses",
        "default_model": "ark-model",
        "models": ["ark-model"],
    }
    provider.update(provider_changes)
    path = _write_config(
        tmp_path / "config.json",
        {
            "version": 1,
            "default_provider_id": "ark",
            "providers": [provider],
        },
    )

    with pytest.raises(error_type, match=message):
        Settings.from_file(path)


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
        created = client.post("/api/sessions", json={"title": "传输验证"})
        assert created.status_code == 201
        payload["threadId"] = created.json()["id"]
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
