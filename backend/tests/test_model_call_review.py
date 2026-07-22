from __future__ import annotations

import asyncio
import copy
import hashlib
import json
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.main import create_app
from backend.app.model_call_review import (
    InMemoryModelCallReviewStore,
    ModelCallDraftConflict,
    ModelCallDraftValidationError,
    PreparedProviderRequest,
    ProviderDispatchError,
    _safe_provider_status_error,
    canonical_json_bytes,
    compile_provider_request,
    provider_endpoint,
)
from backend.app.model_providers import ModelOption, ModelProviderCatalog, ModelProviderConfig
from backend.app.model_providers import (
    DEFAULT_MODEL_CAPABILITIES,
    CHAT_COMPLETIONS_MODEL_CAPABILITIES,
    ModelCapabilities,
    ParameterCapability,
)
from backend.app.model_call_workflow import ModelCallApprovalExecutor, normalize_agui_messages_for_provider
from backend.app.product_sessions import ProductDatabase, ProductSessionService


class CapturingProviderTransport:
    def __init__(self, chunks: list[str] | None = None) -> None:
        self.prepared: list[PreparedProviderRequest] = []
        self.chunks = chunks or ["修改后的", "模型回答"]

    async def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[str]:
        self.prepared.append(prepared)
        for chunk in self.chunks:
            yield chunk


def _provider_catalog() -> ModelProviderCatalog:
    capabilities = ModelCapabilities(
        roles=DEFAULT_MODEL_CAPABILITIES.roles,
        content_types_by_role=DEFAULT_MODEL_CAPABILITIES.content_types_by_role,
        parameters=(
            *DEFAULT_MODEL_CAPABILITIES.parameters,
            ParameterCapability(
                key="tool_choice",
                label="工具选择方式",
                value_type="enum",
                default="none",
                choices=("none", "auto", "required"),
            ),
            ParameterCapability(
                key="reasoning",
                label="推理配置",
                value_type="object_enum",
                default={"effort": "medium"},
                choices=("low", "medium", "high"),
                child_key="effort",
            ),
            ParameterCapability(
                key="text",
                label="输出配置",
                value_type="object_enum",
                default={"verbosity": "medium"},
                choices=("low", "medium", "high"),
                child_key="verbosity",
            ),
            ParameterCapability(
                key="max_output_tokens",
                label="最大输出Token",
                value_type="integer",
                default=1024,
                minimum=1,
                maximum=65536,
            ),
            ParameterCapability(
                key="temperature",
                label="随机性",
                value_type="number",
                default=1,
                minimum=0,
                maximum=2,
            ),
        ),
        allow_unknown_parameters=True,
    )
    return ModelProviderCatalog(
        providers=(
            ModelProviderConfig(
                id="provider-a",
                label="Provider A",
                models=tuple(
                    ModelOption(id=model, label=model, capabilities=capabilities)
                    for model in ("initial-model", "model-a", "model-b", "edited-model", "shared-model")
                ),
                base_url="https://provider-a.invalid/v1",
                api_key="test-a",
            ),
            ModelProviderConfig(
                id="provider-b",
                label="Provider B",
                models=(
                    ModelOption(id="shared-model", label="Shared Model", capabilities=capabilities),
                    ModelOption(id="provider-b-model", label="Provider B Model", capabilities=capabilities),
                ),
                base_url="https://provider-b.invalid/v1",
                api_key="test-b",
            ),
        ),
        default_provider_id="provider-a",
        default_model="initial-model",
    )


class FailingProviderTransport:
    async def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[str]:
        del prepared
        if False:
            yield ""
        raise ProviderDispatchError("Provider请求失败: HTTP 400: invalid_request | 参数不兼容")


class UnknownOutcomeProviderTransport:
    async def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[str]:
        del prepared
        if False:
            yield ""
        raise ProviderDispatchError(
            "Provider请求超时",
            error_code="provider_timeout",
            outcome_status="outcome_unknown",
        )


class CancelledProviderTransport:
    async def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[str]:
        del prepared
        if False:
            yield ""
        raise asyncio.CancelledError


class YieldingContext:
    def __init__(self) -> None:
        self.outputs: list[str] = []

    async def yield_output(self, value: str) -> None:
        self.outputs.append(value)


class RefusingCommitSessionService(ProductSessionService):
    async def complete_active_run(
        self,
        session_id: str,
        *,
        assistant_text: str,
        agui_message_id: str | None,
    ) -> dict[str, Any] | None:
        del session_id, assistant_text, agui_message_id
        return None


def _model_settings() -> Settings:
    return Settings(
        host="127.0.0.1",
        port=8030,
        frontend_origins=("http://testserver",),
        model="initial-model",
        model_api_key="test-only-key",
        model_base_url="https://provider.invalid/v1",
        model_providers=_provider_catalog().providers,
        default_model_provider="provider-a",
        database_url="sqlite+aiosqlite:///:memory:",
    )


def _request(thread_id: str, run_id: str, prompt: str) -> dict[str, Any]:
    return {
        "threadId": thread_id,
        "runId": run_id,
        "state": {},
        "messages": [
            {"id": "current-user", "role": "user", "content": prompt},
        ],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def _resume(thread_id: str, run_id: str, approval_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "threadId": thread_id,
        "runId": run_id,
        "state": {},
        "messages": [],
        "tools": [],
        "context": [],
        "forwardedProps": {},
        "resume": [{"interruptId": approval_id, "status": "resolved", "payload": payload}],
    }


def _events(response) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def _interrupt(events: list[dict[str, Any]]) -> dict[str, Any]:
    finished = [event for event in events if event.get("type") == "RUN_FINISHED"][-1]
    return finished["outcome"]["interrupts"][0]


def _review_card(interrupt: dict[str, Any]) -> dict[str, Any]:
    return interrupt["metadata"]["agent_framework"]["data"]


def _create_product_session(client: TestClient) -> str:
    response = client.post("/api/sessions", json={"title": "审批测试会话"})
    assert response.status_code == 201
    return str(response.json()["id"])


def _text(events: list[dict[str, Any]]) -> str:
    return "".join(
        str(event.get("delta", ""))
        for event in events
        if event.get("type") == "TEXT_MESSAGE_CONTENT"
    )


def test_full_provider_payload_revision_changes_version_hash_and_invalidates_old_approval() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    first = store.begin(
        thread_id="thread-domain",
        run_id="run-domain",
        messages=[{"role": "user", "content": "原问题"}],
        model="model-a",
        provider_id="provider-a",
    )
    edited = {
        "model": "model-b",
        "instructions": "修改后的完整指令",
        "input": [
            {"role": "developer", "content": [{"type": "input_text", "text": "开发约束"}]},
            {"role": "user", "content": [{"type": "input_text", "text": "修改后的问题"}]},
        ],
        "tools": [],
        "tool_choice": "none",
        "reasoning": {"effort": "high"},
        "text": {
            "verbosity": "high",
            "format": {
                "type": "json_schema",
                "name": "answer",
                "schema": {"type": "object", "properties": {"answer": {"type": "string"}}},
            },
        },
        "max_output_tokens": 900,
        "temperature": 0.2,
        "store": False,
        "stream": True,
        "provider_extension": {"editable": True},
    }

    revised = store.revise(
        draft_id=first.draft_id,
        expected_hash=first.binding_hash,
        provider_id="provider-a",
        provider_request=edited,
    )

    assert revised.version == 2
    assert revised.previous_draft_id == first.draft_id
    assert revised.provider_request == edited
    assert revised.body == canonical_json_bytes(edited)
    assert revised.body_sha256 == hashlib.sha256(revised.body).hexdigest()
    assert revised.body_sha256 != first.body_sha256
    assert store.get(first.draft_id).status == "superseded"
    try:
        store.claim(approval_id=first.approval_id, expected_hash=first.binding_hash, owner="stale")
    except ModelCallDraftConflict:
        pass
    else:
        raise AssertionError("旧审批不能发送已被修改的请求")

    card = revised.review_card()
    assert card["effective_context"]["instructions"] == card["provider_request"]["instructions"]
    assert card["effective_context"]["messages"] == card["provider_request"]["input"]
    assert card["effective_context"]["tools"] == card["provider_request"]["tools"]
    assert card["effective_context"]["model_parameters"]["model"] == card["provider_request"]["model"]


def test_store_and_continuation_are_editable_but_blocked_by_the_approved_policy() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    first = store.begin(
        thread_id="thread-policy",
        run_id="run-policy",
        messages=[{"role": "user", "content": "策略验证"}],
        model="model-a",
        provider_id="provider-a",
    )
    invalid = copy.deepcopy(first.provider_request)
    invalid["store"] = True
    invalid["previous_response_id"] = "resp_hidden_context"

    try:
        store.revise(
            draft_id=first.draft_id,
            expected_hash=first.binding_hash,
            provider_id="provider-a",
            provider_request=invalid,
        )
    except ModelCallDraftValidationError as error:
        assert "store=false" in str(error)
        assert "previous_response_id" in str(error)
    else:
        raise AssertionError("违反已批准完整上下文策略的请求不能发送")


def test_unregistered_tool_definition_is_rejected() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    first = store.begin(
        thread_id="thread-tool-policy",
        run_id="run-tool-policy",
        messages=[{"role": "user", "content": "工具策略验证"}],
        model="model-a",
        provider_id="provider-a",
    )
    invalid = copy.deepcopy(first.provider_request)
    invalid["tools"] = [
        {
            "type": "function",
            "name": "new_tool",
            "description": "没有真实执行器",
            "parameters": {"type": "object", "properties": {}},
        }
    ]

    try:
        store.revise(
            draft_id=first.draft_id,
            expected_hash=first.binding_hash,
            provider_id="provider-a",
            provider_request=invalid,
        )
    except ModelCallDraftValidationError as error:
        assert "没有已注册且可执行的Tool" in str(error)
    else:
        raise AssertionError("未绑定真实执行器的Tool定义必须被拒绝")


def test_message_roles_content_types_and_parameter_ranges_are_deeply_validated() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    first = store.begin(
        thread_id="thread-deep-validation",
        run_id="run-deep-validation",
        messages=[{"role": "user", "content": "深层校验"}],
        model="model-a",
        provider_id="provider-a",
    )

    invalid = copy.deepcopy(first.provider_request)
    invalid["input"] = [
        {"role": "tool", "content": [{"type": "input_text", "text": "伪造Tool结果"}]},
        {"role": "assistant", "content": [{"type": "input_text", "text": "类型不兼容"}]},
        {"role": "user", "content": [{"type": "input_text", "text": "  "}]},
    ]
    invalid["temperature"] = 9

    with pytest.raises(ModelCallDraftValidationError) as captured:
        store.revise(
            draft_id=first.draft_id,
            expected_hash=first.binding_hash,
            provider_id="provider-a",
            provider_request=invalid,
        )

    issues = "；".join(captured.value.issues)
    assert "role必须是以下角色之一" in issues
    assert "与角色assistant不兼容" in issues
    assert "text不能为空" in issues
    assert "temperature不能大于2" in issues


def test_context_sources_and_section_token_estimates_follow_the_revised_request() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    first = store.begin(
        thread_id="thread-context-source",
        run_id="run-context-source",
        messages=[
            {"role": "user", "content": "历史问题"},
            {"role": "assistant", "content": "历史回答"},
            {"role": "user", "content": "本轮问题"},
        ],
        model="model-a",
        provider_id="provider-a",
    )
    first_context = first.review_card()["effective_context"]
    assert [item["source_type"] for item in first_context["history_and_knowledge"]] == [
        "conversation_history",
        "conversation_history",
        "current_input",
    ]
    assert first_context["token_breakdown"]["total"] == first_context["token_estimate"]
    assert first_context["token_breakdown"]["exact"] is False

    edited = copy.deepcopy(first.provider_request)
    edited["input"][0]["content"][0]["text"] = "用户修改过的历史问题"
    edited["input"].append(
        {"role": "developer", "content": [{"type": "input_text", "text": "手动补充约束"}]}
    )
    revised = store.revise(
        draft_id=first.draft_id,
        expected_hash=first.binding_hash,
        provider_id="provider-a",
        provider_request=edited,
    )
    revised_sources = revised.review_card()["effective_context"]["history_and_knowledge"]
    assert revised_sources[0]["modified_in_review"] is True
    assert "重新审批" in revised_sources[0]["adoption_reason"]
    assert revised_sources[-1]["source_type"] == "manual_context"
    assert revised_sources[-1]["content"] == edited["input"][-1]


def test_provider_selection_is_catalog_validated_and_bound_to_a_new_hash() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    first = store.begin(
        thread_id="thread-provider-selection",
        run_id="run-provider-selection",
        messages=[{"role": "user", "content": "Provider切换"}],
        model="shared-model",
        provider_id="provider-a",
    )
    revised = store.revise(
        draft_id=first.draft_id,
        expected_hash=first.binding_hash,
        provider_id="provider-b",
        provider_request=first.provider_request,
    )

    assert revised.body == first.body
    assert revised.body_sha256 == first.body_sha256
    assert revised.binding_hash != first.binding_hash
    public_catalog = revised.review_card()["provider_catalog"]
    assert [provider["id"] for provider in public_catalog] == ["provider-a", "provider-b"]
    assert [model["id"] for model in public_catalog[1]["models"]] == [
        "shared-model",
        "provider-b-model",
    ]
    assert public_catalog[1]["models"][1]["capabilities"]["roles"] == [
        "user",
        "assistant",
        "developer",
        "system",
    ]

    invalid = copy.deepcopy(revised.provider_request)
    invalid["model"] = "model-a"
    try:
        store.revise(
            draft_id=revised.draft_id,
            expected_hash=revised.binding_hash,
            provider_id="provider-b",
            provider_request=invalid,
        )
    except ModelCallDraftValidationError as error:
        assert "不属于Provider provider-b" in str(error)
    else:
        raise AssertionError("Provider与模型不匹配时不能保存")


def test_model_call_review_protocol_messages_do_not_enter_the_next_provider_context() -> None:
    def content(**payload: Any) -> SimpleNamespace:
        return SimpleNamespace(to_dict=lambda: dict(payload))

    normalized = normalize_agui_messages_for_provider(
        [
            SimpleNamespace(
                role="assistant",
                contents=[
                    content(
                        type="function_call",
                        call_id="model_call_approval_internal",
                        name="request_info",
                        arguments="{review-card-json}",
                    )
                ],
            ),
            SimpleNamespace(
                role="tool",
                contents=[
                    content(
                        type="function_result",
                        call_id="model_call_approval_internal",
                        result={"decision": "abandon"},
                    )
                ],
            ),
            SimpleNamespace(
                role="assistant",
                contents=[
                    content(
                        type="function_call",
                        call_id="business_tool_call",
                        name="read_only_lookup",
                        arguments="{}",
                    )
                ],
            ),
            SimpleNamespace(
                role="user",
                contents=[content(type="text", text="再次发送的用户输入")],
            ),
        ]
    )

    assert normalized == [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "function_call",
                    "call_id": "business_tool_call",
                    "name": "read_only_lookup",
                    "arguments": "{}",
                }
            ],
        },
        {"role": "user", "content": [{"type": "text", "text": "再次发送的用户输入"}]},
    ]


def test_model_provider_endpoint_is_safe_and_grouped_by_provider() -> None:
    app = create_app(_model_settings())
    with TestClient(app) as client:
        response = client.get("/api/model-providers")

    assert response.status_code == 200
    payload = response.json()
    assert payload["default_provider_id"] == "provider-a"
    assert payload["default_model"] == "initial-model"
    assert [provider["id"] for provider in payload["providers"]] == ["provider-a", "provider-b"]
    assert "api_key" not in json.dumps(payload)
    assert "base_url" not in json.dumps(payload)


def test_chat_completions_provider_compiles_and_validates_its_own_exact_body() -> None:
    provider = ModelProviderConfig(
        id="chat-provider",
        label="Chat Provider",
        models=(
            ModelOption(
                id="chat-model",
                label="Chat Model",
                capabilities=CHAT_COMPLETIONS_MODEL_CAPABILITIES,
            ),
        ),
        base_url="https://chat.invalid/v1",
        api_key="test-key",
        protocol="openai_chat_completions",
    )
    catalog = ModelProviderCatalog(
        providers=(provider,),
        default_provider_id=provider.id,
        default_model="chat-model",
    )
    store = InMemoryModelCallReviewStore(catalog)

    draft = store.begin(
        thread_id="thread-chat-protocol",
        run_id="run-chat-protocol",
        messages=[{"role": "user", "content": "Chat协议验证"}],
        model="chat-model",
        provider_id=provider.id,
    )

    assert draft.provider_protocol == "openai_chat_completions"
    assert draft.provider_request["messages"] == [
        {"role": "system", "content": draft.review_card()["effective_context"]["instructions"]},
        {"role": "user", "content": "Chat协议验证"},
    ]
    assert "input" not in draft.provider_request
    assert draft.body == canonical_json_bytes(draft.provider_request)
    assert provider_endpoint(provider.base_url, provider.protocol) == (
        "https://chat.invalid/v1/chat/completions"
    )

    invalid = compile_provider_request(
        model="chat-model",
        messages=[{"role": "user", "content": "错误协议"}],
    )
    with pytest.raises(ModelCallDraftValidationError, match="不应包含input字段"):
        store.revise(
            draft_id=draft.draft_id,
            expected_hash=draft.binding_hash,
            provider_id=provider.id,
            provider_request=invalid,
        )


def test_cross_protocol_revision_keeps_instruction_and_user_source_meaning_aligned() -> None:
    response_provider = ModelProviderConfig(
        id="responses-provider",
        label="Responses Provider",
        models=(ModelOption(id="responses-model", label="Responses Model"),),
        base_url="https://responses.invalid/v1",
        api_key="test-key",
    )
    chat_provider = ModelProviderConfig(
        id="chat-provider",
        label="Chat Provider",
        models=(
            ModelOption(
                id="chat-model",
                label="Chat Model",
                capabilities=CHAT_COMPLETIONS_MODEL_CAPABILITIES,
            ),
        ),
        base_url="https://chat.invalid/v1",
        api_key="test-key",
        protocol="openai_chat_completions",
    )
    store = InMemoryModelCallReviewStore(
        ModelProviderCatalog(
            providers=(response_provider, chat_provider),
            default_provider_id=response_provider.id,
            default_model="responses-model",
        )
    )
    first = store.begin(
        thread_id="thread-source-alignment",
        run_id="run-source-alignment",
        messages=[{"role": "user", "content": "保留来源的当前输入"}],
        model="responses-model",
        provider_id=response_provider.id,
    )
    revised_request = {
        "model": "chat-model",
        "messages": [
            {"role": "system", "content": first.provider_request["instructions"]},
            {"role": "user", "content": "保留来源的当前输入"},
        ],
        "tools": [],
        "store": False,
        "stream": True,
    }

    revised = store.revise(
        draft_id=first.draft_id,
        expected_hash=first.binding_hash,
        provider_id=chat_provider.id,
        provider_request=revised_request,
    )
    sources = revised.review_card()["effective_context"]["history_and_knowledge"]

    assert [source["source_type"] for source in sources] == [
        "agent_instructions",
        "current_input",
    ]
    assert sources[1]["modified_in_review"] is False


def test_provider_validation_error_exposes_only_bounded_structured_detail() -> None:
    body = json.dumps(
        {
            "error": {
                "code": "invalid_request",
                "type": "validation_error",
                "message": "tools must be omitted when empty",
            }
        }
    ).encode()
    message = _safe_provider_status_error(400, body)
    assert message == (
        "Provider请求失败: HTTP 400: "
        "invalid_request | validation_error | tools must be omitted when empty"
    )


def test_agui_revision_requires_second_approval_and_sends_exact_edited_bytes() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    transport = CapturingProviderTransport()
    app = create_app(
        _model_settings(),
        model_call_store=store,
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        thread_id = _create_product_session(client)
        first_events = _events(client.post("/api/agent", json=_request(thread_id, "run-1", "原问题")))
        first_card = _review_card(_interrupt(first_events))
        assert transport.prepared == []

        edited = copy.deepcopy(first_card["provider_request"])
        edited.update(
            {
                "model": "provider-b-model",
                "instructions": "所有内容均由用户审核修改",
                "input": [
                    {"role": "user", "content": [{"type": "input_text", "text": "最终发送内容"}]}
                ],
                "tools": [],
                "tool_choice": "none",
                "reasoning": {"effort": "low"},
                "text": {"verbosity": "high"},
                "max_output_tokens": 321,
                "provider_extension": {"reviewed": "yes"},
            }
        )
        revised_response = client.put(
            f"/api/model-call-drafts/{first_card['draft_id']}",
            json={
                "expected_hash": first_card["binding_hash"],
                "provider_id": "provider-b",
                "provider_request": edited,
            },
        )
        assert revised_response.status_code == 200
        revised_card = revised_response.json()
        assert revised_card["version"] == 2
        assert revised_card["binding_hash"] != first_card["binding_hash"]

        second_events = _events(
            client.post(
                "/api/agent",
                json=_resume(
                    thread_id,
                    "run-revise",
                    first_card["approval_id"],
                    {"decision": "revise", "revision_draft_id": revised_card["draft_id"]},
                ),
            )
        )
        second_card = _review_card(_interrupt(second_events))
        assert second_card["approval_id"] == revised_card["approval_id"]
        assert transport.prepared == []

        sent_events = _events(
            client.post(
                "/api/agent",
                json=_resume(
                    thread_id,
                    "run-approve",
                    second_card["approval_id"],
                    {"decision": "approve"},
                ),
            )
        )
        completed_run = client.get(f"/api/sessions/{thread_id}/runs").json()["runs"][0]
        completed_trace = client.get(
            f"/api/sessions/{thread_id}/runs/{completed_run['id']}/trace"
        ).json()["trace"]

    assert _text(sent_events) == "修改后的模型回答"
    assert len(transport.prepared) == 1
    prepared = transport.prepared[0]
    assert prepared.body == canonical_json_bytes(edited)
    assert json.loads(prepared.body) == edited
    assert hashlib.sha256(prepared.body).hexdigest() == second_card["body_sha256"]
    assert prepared.provider_id == "provider-b"
    assert len(store.attempts()) == 1
    assert store.attempts()[0].status == "completed"
    completed_stages = {
        event["payload"].get("stage_id"): event["payload"].get("status")
        for event in completed_trace
        if event["event_type"] == "workflow.stage"
    }
    assert completed_stages["agui.ingress"] == "completed"
    assert completed_stages["request.compile"] == "completed"
    assert completed_stages["approval.wait"] == "completed"
    assert completed_stages["provider.dispatch"] == "completed"
    assert completed_stages["provider.receive"] == "completed"
    assert completed_stages["provider.decode"] == "completed"
    assert completed_stages["agui.project"] == "completed"
    assert completed_stages["product.commit"] == "completed"
    assert completed_stages["agui.terminal"] == "completed"


def test_abandon_creates_zero_provider_attempts_and_preserves_origin_prompt() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    transport = CapturingProviderTransport()
    app = create_app(
        _model_settings(),
        model_call_store=store,
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        thread_id = _create_product_session(client)
        paused = _events(client.post("/api/agent", json=_request(thread_id, "run-abandon", "请保留这段输入")))
        card = _review_card(_interrupt(paused))
        assert card["origin_prompt"] == "请保留这段输入"
        abandoned = _events(
            client.post(
                "/api/agent",
                json=_resume(
                    thread_id,
                    "run-abandon-resume",
                    card["approval_id"],
                    {"decision": "abandon"},
                ),
            )
        )
        product_messages = client.get(f"/api/sessions/{thread_id}/messages").json()["messages"]
        product_runs = client.get(f"/api/sessions/{thread_id}/runs").json()["runs"]
        product_session = client.get(f"/api/sessions/{thread_id}").json()
        abandoned_trace = client.get(
            f"/api/sessions/{thread_id}/runs/{product_runs[0]['id']}/trace"
        ).json()["trace"]

        workflow_events = _events(
            client.post(
                "/api/workflows/nested-quality-demo/run",
                json={
                    "threadId": thread_id,
                    "runId": "workflow-after-abandon",
                    "state": {},
                    "messages": [
                        {
                            "id": "workflow-user-after-abandon",
                            "role": "user",
                            "content": "放弃模型审批后运行Workflow",
                        }
                    ],
                    "tools": [],
                    "context": [],
                    "forwardedProps": {},
                },
            )
        )
        messages_after_workflow = client.get(
            f"/api/sessions/{thread_id}/messages"
        ).json()["messages"]

    assert "未向模型发送" in _text(abandoned)
    event_types = [event.get("type") for event in abandoned]
    assert event_types.index("TEXT_MESSAGE_END") < event_types.index("RUN_FINISHED")
    assert transport.prepared == []
    assert store.attempts() == []
    assert store.get(card["draft_id"]).status == "abandoned"
    assert product_messages == []
    assert product_runs[0]["status"] == "abandoned"
    assert product_session["active_run_id"] is None
    abandoned_stages = {
        event["payload"].get("stage_id"): event["payload"].get("status")
        for event in abandoned_trace
        if event["event_type"] == "workflow.stage"
    }
    assert abandoned_stages["approval.wait"] == "abandoned"
    assert abandoned_stages["provider.dispatch"] == "skipped"
    assert abandoned_stages["provider.receive"] == "skipped"
    assert abandoned_stages["provider.decode"] == "skipped"
    assert abandoned_stages["agui.project"] == "skipped"
    assert abandoned_stages["product.commit"] == "skipped"
    assert abandoned_stages["agui.terminal"] == "completed"
    assert workflow_events[-1]["type"] == "RUN_FINISHED"
    assert [value["role"] for value in messages_after_workflow] == ["user", "assistant"]
    assert [value["ordinal"] for value in messages_after_workflow] == [2, 3]


def test_second_model_approval_uses_product_history_exactly_once() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    transport = CapturingProviderTransport()
    app = create_app(
        _model_settings(),
        model_call_store=store,
        model_call_transport=transport,
    )

    with TestClient(app) as client:
        thread_id = _create_product_session(client)
        first_events = _events(
            client.post("/api/agent", json=_request(thread_id, "run-first", "第一轮问题"))
        )
        first_card = _review_card(_interrupt(first_events))
        completed = _events(
            client.post(
                "/api/agent",
                json=_resume(
                    thread_id,
                    "run-first-approve",
                    first_card["approval_id"],
                    {"decision": "approve"},
                ),
            )
        )
        assert completed[-1]["type"] == "RUN_FINISHED"
        persisted = client.get(f"/api/sessions/{thread_id}/messages").json()["messages"]
        incoming = [
            {
                "id": value["agui_message_id"],
                "role": value["role"],
                "content": value["content"],
            }
            for value in persisted
        ]
        incoming.append({"id": "current-user-2", "role": "user", "content": "第二轮问题"})
        second_events = _events(
            client.post(
                "/api/agent",
                json={**_request(thread_id, "run-second", "ignored"), "messages": incoming},
            )
        )
        second_card = _review_card(_interrupt(second_events))
        second_input = second_card["provider_request"]["input"]

    assert [value["role"] for value in second_input] == ["user", "assistant", "user"]
    assert [value["content"][0]["text"] for value in second_input] == [
        "第一轮问题",
        "修改后的模型回答",
        "第二轮问题",
    ]
    assert len(second_input) == 3


def test_provider_failure_is_the_last_agui_event() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    app = create_app(
        _model_settings(),
        model_call_store=store,
        model_call_transport=FailingProviderTransport(),
    )
    with TestClient(app) as client:
        thread_id = _create_product_session(client)
        paused = _events(client.post("/api/agent", json=_request(thread_id, "run-error", "错误顺序验证")))
        card = _review_card(_interrupt(paused))
        failed = _events(
            client.post(
                "/api/agent",
                json=_resume(
                    thread_id,
                    "run-error-resume",
                    card["approval_id"],
                    {"decision": "approve"},
                ),
            )
        )
        product_messages = client.get(f"/api/sessions/{thread_id}/messages").json()["messages"]
        product_runs = client.get(f"/api/sessions/{thread_id}/runs").json()["runs"]
        product_session = client.get(f"/api/sessions/{thread_id}").json()

    assert failed[-1]["type"] == "RUN_ERROR"
    assert "HTTP 400" in failed[-1]["message"]
    assert not any(event["type"] == "RUN_FINISHED" for event in failed)
    assert store.attempts()[0].status == "failed"
    assert [value["role"] for value in product_messages] == ["user"]
    assert product_runs[0]["status"] == "failed"
    assert [value["status"] for value in product_runs[0]["attempts"]] == ["failed"]
    assert product_session["active_run_id"] is None


def test_product_commit_gate_replaces_provider_success_with_run_error() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    sessions = RefusingCommitSessionService(
        ProductDatabase("sqlite+aiosqlite:///:memory:")
    )
    app = create_app(
        _model_settings(),
        model_call_store=store,
        model_call_transport=CapturingProviderTransport(["未提交回答"]),
        product_session_service=sessions,
    )
    with TestClient(app) as client:
        thread_id = _create_product_session(client)
        paused = _events(
            client.post("/api/agent", json=_request(thread_id, "run-commit-gate", "提交门验证"))
        )
        card = _review_card(_interrupt(paused))
        failed = _events(
            client.post(
                "/api/agent",
                json=_resume(
                    thread_id,
                    "run-commit-gate-resume",
                    card["approval_id"],
                    {"decision": "approve"},
                ),
            )
        )
        product_messages = client.get(f"/api/sessions/{thread_id}/messages").json()["messages"]
        product_runs = client.get(f"/api/sessions/{thread_id}/runs").json()["runs"]

    assert failed[-1] == {
        "type": "RUN_ERROR",
        "message": "模型输出已产生，但Product Store终态提交失败。",
        "code": "PRODUCT_COMMIT_FAILED",
    }
    assert not any(event["type"] == "RUN_FINISHED" for event in failed)
    assert [value["role"] for value in product_messages] == ["user"]
    assert product_runs[0]["status"] == "failed"
    assert product_runs[0]["failure_code"] == "product_commit_failed"


def test_timeout_like_failure_is_not_retried_and_is_exposed_as_outcome_unknown() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    app = create_app(
        _model_settings(),
        model_call_store=store,
        model_call_transport=UnknownOutcomeProviderTransport(),
    )
    with TestClient(app) as client:
        thread_id = _create_product_session(client)
        paused = _events(client.post("/api/agent", json=_request(thread_id, "run-timeout", "超时验证")))
        card = _review_card(_interrupt(paused))
        failed = _events(
            client.post(
                "/api/agent",
                json=_resume(
                    thread_id,
                    "run-timeout-resume",
                    card["approval_id"],
                    {"decision": "approve"},
                ),
            )
        )
        persisted = client.get(f"/api/model-call-drafts/{card['draft_id']}")
        product_messages = client.get(f"/api/sessions/{thread_id}/messages").json()["messages"]
        product_runs = client.get(f"/api/sessions/{thread_id}/runs").json()["runs"]
        product_session = client.get(f"/api/sessions/{thread_id}").json()

    assert failed[-1]["type"] == "RUN_ERROR"
    assert len(store.attempts()) == 1
    assert store.attempts()[0].status == "outcome_unknown"
    assert persisted.status_code == 200
    assert persisted.json()["attempt"] == {
        "attempt_id": store.attempts()[0].attempt_id,
        "status": "outcome_unknown",
        "error_code": "provider_timeout",
    }
    assert [value["role"] for value in product_messages] == ["user"]
    assert product_runs[0]["status"] == "outcome_unknown"
    assert [value["status"] for value in product_runs[0]["attempts"]] == [
        "outcome_unknown"
    ]
    assert product_session["active_run_id"] is None


def test_cancelling_after_dispatch_claim_marks_attempt_unknown_without_retry() -> None:
    store = InMemoryModelCallReviewStore(_provider_catalog())
    draft = store.begin(
        thread_id="thread-cancelled-dispatch",
        run_id="run-cancelled-dispatch",
        messages=[{"role": "user", "content": "取消验证"}],
        model="model-a",
        provider_id="provider-a",
    )
    executor = ModelCallApprovalExecutor(
        thread_id=draft.thread_id,
        provider_id=draft.provider_id,
        model="model-a",
        store=store,
        transport=CancelledProviderTransport(),
        run_id=lambda: draft.run_id,
    )

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            executor.resolve(
                draft.review_card(),
                {"decision": "approve"},
                YieldingContext(),
            )
        )

    assert len(store.attempts()) == 1
    assert store.attempts()[0].status == "outcome_unknown"
    assert store.attempts()[0].error_code == "provider_dispatch_cancelled"
