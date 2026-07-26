from __future__ import annotations

import json
import sys
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

    sandbox_requirement = (
        "seatbelt"
        if sys.platform == "darwin"
        else "bwrap"
        if sys.platform.startswith("linux")
        else "unavailable"
    )
    sandbox_path = {
        "seatbelt": Path("/usr/bin/sandbox-exec"),
        "bwrap": Path("/usr/bin/bwrap"),
    }.get(sandbox_requirement)
    sandbox_available = sandbox_path is not None and sandbox_path.is_file()

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
        "pi_agent": {
            "enabled": False,
            "available": False,
            "contract_version": "0.82.0",
            "integration_mode": "jsonl_rpc_subprocess",
            "provider_gate": "every_pi_model_call",
            "tool_gate": "every_pi_internal_tool_call",
            "allowed_working_root_count": 0,
            "default_working_directory_configured": True,
        },
        "artifact_store": {
            "available": False,
            "storage": "content_addressed_filesystem",
            "scope_isolation": "not_configured",
            "orphan_grace_seconds": 86400,
        },
        "validation": {
            "available": sandbox_available,
            "python_source": "project_virtual_environment",
            "system_python_fallback": False,
            "network_policy": "deny",
            "sandbox_requirement": sandbox_requirement,
            "sandbox_available": sandbox_available,
        },
    }


def test_product_harness_rest_contract_is_versioned_and_server_authoritative() -> None:
    """Exercise the public REST surface, not only the application service."""

    with _client() as client:
        project_response = client.post(
            "/api/harness/projects",
            json={
                "command_id": "api-project-create",
                "kind": "learning",
                "title": "学习异步编程",
                "goal": "能够实现并验证异步任务",
                "status": "active",
            },
        )
        assert project_response.status_code == 201
        project = project_response.json()
        assert project["row_version"] == 1

        replay = client.post(
            "/api/harness/projects",
            json={
                "command_id": "api-project-create",
                "kind": "learning",
                "title": "学习异步编程",
                "goal": "能够实现并验证异步任务",
                "status": "active",
            },
        )
        assert replay.status_code == 201
        assert replay.json()["id"] == project["id"]

        work_response = client.post(
            "/api/harness/work-items",
            json={
                "command_id": "api-work-create",
                "project_id": project["id"],
                "kind": "learning_unit",
                "title": "理解事件循环",
                "objective": "完成一个可验证的 asyncio 练习",
                "status": "ready",
            },
        )
        assert work_response.status_code == 201
        assert work_response.json()["project_id"] == project["id"]

        note_response = client.post(
            "/api/harness/notes",
            json={
                "command_id": "api-note-create",
                "kind": "learning_note",
                "title": "事件循环笔记",
                "content": "事件循环负责调度可运行协程。",
                "links": [{"resource_kind": "project", "resource_id": project["id"]}],
            },
        )
        assert note_response.status_code == 201
        assert note_response.json()["current_revision"]["revision"] == 1

        candidate_response = client.post(
            "/api/harness/memory-candidates",
            json={
                "command_id": "api-memory-propose",
                "scope_kind": "project",
                "scope_ref_id": project["id"],
                "memory_kind": "preference",
                "content": "学习时先看可运行示例。",
                "source_refs": [{"kind": "note", "id": note_response.json()["id"], "revision": 1}],
            },
        )
        assert candidate_response.status_code == 201
        candidate = candidate_response.json()
        accepted_response = client.post(
            f"/api/harness/memory-candidates/{candidate['id']}/resolve",
            json={"command_id": "api-memory-accept", "decision": "accept"},
        )
        assert accepted_response.status_code == 200

        detail = client.get(f"/api/harness/projects/{project['id']}")
        assert detail.status_code == 200
        assert [item["title"] for item in detail.json()["work_items"]] == ["理解事件循环"]
        assert [item["title"] for item in detail.json()["notes"]] == ["事件循环笔记"]
        assert [item["memory_kind"] for item in detail.json()["accepted_memory"]] == ["preference"]

        conflict = client.post(
            f"/api/harness/projects/{project['id']}/transition",
            json={
                "command_id": "api-project-stale-transition",
                "expected_row_version": 0,
                "target_status": "paused",
                "reason": "模拟过期页面",
            },
        )
        assert conflict.status_code == 409
        problem = conflict.json()
        assert problem["code"] == "HARNESS_CONFLICT"
        assert "版本冲突" in problem["message"]
        assert problem["retryable"] is False
        assert problem["request_id"] == conflict.headers["x-request-id"]

        search = client.get("/api/harness/search", params={"q": "事件循环"})
        assert search.status_code == 200
        assert {item["kind"] for item in search.json()["resources"]} == {"work_item", "note"}


def _write_config(path: Path, payload: dict[str, object]) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_rest_errors_use_one_redacted_correlated_problem_contract() -> None:
    app = create_app(Settings.for_test())

    @app.get("/api/test/unhandled")
    async def unhandled() -> None:
        raise RuntimeError(
            "SELECT secret FROM records; /Users/example/private/config.json sk-not-a-real-key-but-shaped"
        )

    with TestClient(app, raise_server_exceptions=False) as client:
        missing = client.get(
            "/api/sessions/does-not-exist",
            headers={"X-Request-ID": "client-request-42"},
        )
        invalid = client.post("/api/sessions", json={"title": 17, "unexpected": True})
        failed = client.get("/api/test/unhandled")

    assert missing.status_code == 404
    assert missing.headers["x-request-id"] == "client-request-42"
    assert missing.json() == {
        "code": "SESSION_NOT_FOUND",
        "message": "Product Session不存在",
        "request_id": "client-request-42",
        "retryable": False,
        "details": None,
    }

    invalid_problem = invalid.json()
    assert invalid.status_code == 422
    assert invalid_problem["code"] == "REQUEST_VALIDATION_FAILED"
    assert invalid_problem["request_id"] == invalid.headers["x-request-id"]
    assert invalid_problem["retryable"] is False
    assert invalid_problem["details"]["issues"]
    assert "input" not in invalid_problem["details"]["issues"][0]

    failed_text = failed.text
    assert failed.status_code == 500
    assert failed.json()["code"] == "INTERNAL_SERVER_ERROR"
    assert failed.json()["message"] == "服务处理请求时发生内部错误。"
    assert failed.json()["request_id"] == failed.headers["x-request-id"]
    assert "/Users/" not in failed_text
    assert "SELECT secret" not in failed_text
    assert "sk-not" not in failed_text


def test_openapi_declares_problem_detail_for_rest_failures() -> None:
    with _client() as client:
        schema = client.get("/openapi.json").json()

    session_route = schema["paths"]["/api/sessions/{session_id}"]["get"]
    problem_schema = session_route["responses"]["409"]["content"]["application/json"]["schema"]
    assert problem_schema["$ref"] == "#/components/schemas/ProblemDetail"
    required = set(schema["components"]["schemas"]["ProblemDetail"]["required"])
    assert required == {"code", "message", "request_id", "retryable"}


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
            "product_store": {
                "url": f"sqlite+aiosqlite:///{tmp_path / 'bootstrap.db'}",
            },
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


def test_settings_loads_artifact_and_validation_runtime_without_exposing_secret(
    tmp_path: Path,
) -> None:
    project_python = Path(__file__).resolve().parents[2] / ".venv" / "bin" / "python"
    secret = "ab" * 32
    path = _write_config(
        tmp_path / "config.json",
        {
            "version": 1,
            "artifact_store": {
                "root": str(tmp_path / "artifacts"),
                "scope_key_secret_hex": secret,
                "orphan_grace_seconds": 3600,
            },
            "validation": {"project_python": str(project_python)},
            "providers": [],
        },
    )

    settings = Settings.from_file(path)

    assert settings.artifact_store.available is True
    assert settings.artifact_store.root == (tmp_path / "artifacts").resolve()
    assert settings.artifact_store.orphan_grace_seconds == 3600
    assert settings.artifact_store.health_view() == {
        "available": True,
        "storage": "content_addressed_filesystem",
        "scope_isolation": "hmac_sha256_128bit",
        "orphan_grace_seconds": 3600,
    }
    assert secret not in json.dumps(settings.artifact_store.health_view())
    assert settings.validation_runtime.available is True
    assert settings.validation_runtime.project_python == project_python


@pytest.mark.parametrize(
    ("artifact_store", "message"),
    [
        ({"scope_key_secret_hex": "abcd"}, "至少64位"),
        ({"scope_key_secret_hex": "z" * 64}, "十六进制"),
        ({"orphan_grace_seconds": 1}, "60秒到90天"),
    ],
)
def test_settings_rejects_unsafe_artifact_store_configuration(
    tmp_path: Path,
    artifact_store: dict[str, object],
    message: str,
) -> None:
    path = _write_config(
        tmp_path / "config.json",
        {"version": 1, "artifact_store": artifact_store, "providers": []},
    )
    with pytest.raises(SettingsError, match=message):
        Settings.from_file(path)


def test_application_composes_configured_artifact_and_validation_runtime(tmp_path: Path) -> None:
    project_python = Path(__file__).resolve().parents[2] / ".venv" / "bin" / "python"
    path = _write_config(
        tmp_path / "config.json",
        {
            "version": 1,
            "product_store": {
                "url": f"sqlite+aiosqlite:///{tmp_path / 'chat.db'}",
            },
            "artifact_store": {
                "root": str(tmp_path / "artifacts"),
                "scope_key_secret_hex": "cd" * 32,
            },
            "validation": {"project_python": str(project_python)},
            "providers": [],
        },
    )
    app = create_app(Settings.from_file(path))

    with TestClient(app) as client:
        health = client.get("/api/health").json()
        assert health["artifact_store"]["available"] is True
        assert app.state.artifact_coordinator is not None
        assert app.state.artifact_reconciler is not None
        assert app.state.validation_capabilities is not None
        assert app.state.validation_compiler is not None
        assert app.state.validation_runner is not None


def test_settings_loads_kimi_runtime_model_metadata_without_exposing_secret(
    tmp_path: Path,
) -> None:
    path = _write_config(
        tmp_path / "config.json",
        {
            "version": 1,
            "default_provider_id": "kimi-code",
            "providers": [
                {
                    "id": "kimi-code",
                    "label": "Kimi Code",
                    "protocol": "openai_chat_completions",
                    "base_url": "https://api.kimi.com/coding/v1",
                    "api_key": "private-test-key",
                    "default_model": "k3",
                    "models": [
                        {
                            "id": "k3",
                            "label": "Kimi K3",
                            "context_window": 1_048_576,
                            "reasoning": True,
                            "thinking_level_map": {
                                "off": "none",
                                "minimal": "low",
                                "medium": "high",
                                "xhigh": "max",
                            },
                        }
                    ],
                    "capabilities": {
                        "image_input": False,
                        "roles": ["user", "assistant", "system"],
                        "content_types_by_role": {
                            "user": ["text"],
                            "assistant": ["text"],
                            "system": ["text"],
                        },
                    },
                }
            ],
        },
    )

    settings = Settings.from_file(path)
    catalog = settings.model_catalog()
    assert catalog is not None
    provider = catalog.get("kimi-code")
    assert provider is not None
    [model] = provider.models
    assert model.context_window == 1_048_576
    assert model.reasoning is True
    assert dict(model.thinking_level_map) == {
        "off": "none",
        "minimal": "low",
        "medium": "high",
        "xhigh": "max",
    }
    assert model.capabilities.content_types("user") == ("text",)
    assert "private-test-key" not in json.dumps(catalog.public_view())


@pytest.mark.parametrize(
    "model_changes",
    [
        {"context_window": 0},
        {"context_window": True},
        {"thinking_level_map": {"turbo": "max"}},
        {"thinking_level_map": {"low": 1}},
    ],
)
def test_settings_rejects_invalid_runtime_model_metadata(
    tmp_path: Path,
    model_changes: dict[str, object],
) -> None:
    model: dict[str, object] = {"id": "k3", "label": "Kimi K3"}
    model.update(model_changes)
    path = _write_config(
        tmp_path / "config.json",
        {
            "version": 1,
            "default_provider_id": "kimi-code",
            "providers": [
                {
                    "id": "kimi-code",
                    "protocol": "openai_chat_completions",
                    "api_key": "configured",
                    "default_model": "k3",
                    "models": [model],
                }
            ],
        },
    )

    with pytest.raises((SettingsError, ModelProviderCatalogError)):
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
    text = "".join(str(event.get("delta", "")) for event in events if event["type"] == "TEXT_MESSAGE_CONTENT")
    assert "Microsoft Agent Framework" in text
