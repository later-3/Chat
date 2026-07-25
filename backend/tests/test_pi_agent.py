from __future__ import annotations

import asyncio
import copy
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.responses import StreamingResponse

from backend.app.config import PiRuntimeSettings, Settings
from backend.app.main import create_app
from backend.app.model_call_review import (
    InMemoryModelCallReviewStore,
    ModelCallDraftValidationError,
)
from backend.app.model_providers import (
    ModelOption,
    ModelProviderCatalog,
    ModelProviderConfig,
)
from backend.app.pi_gateway import PiRuntimeManager
from backend.app.pi_runtime import (
    _PI_RPC_STREAM_LIMIT,
    MAX_PI_READ_TOOL_CALLS,
    PI_GATEWAY_TOKEN_HEADER,
    PiCompletedBoundary,
    PiExecution,
    PiGatewayCall,
    PiGatewayDecision,
    PiModelCallBoundary,
    PiRuntimeError,
    PiToolCallBoundary,
    _pi_max_tokens,
    _pi_provider_compat,
)
from backend.app.product_sessions import ProductDatabase, ProductSessionService
from backend.app.product_sessions.database import ToolExecutionRecord
from backend.app.readonly_tools.service import MAX_READ_BYTES
from backend.app.tool_configs import (
    PiToolConfigSnapshot,
    ToolConfigurationConflict,
    ToolConfigurationError,
    ToolConfigurationService,
)


def _catalog(protocol: str = "openai_responses") -> ModelProviderCatalog:
    provider = ModelProviderConfig(
        id="provider-a",
        label="Provider A",
        models=(
            ModelOption(id="model-a", label="Model A"),
            ModelOption(id="model-b", label="Model B"),
        ),
        base_url="https://provider.invalid/v1",
        api_key="test-provider-key",
        protocol=protocol,
    )
    return ModelProviderCatalog(
        providers=(provider,),
        default_provider_id=provider.id,
        default_model="model-a",
    )


def _runtime(tmp_path: Path) -> PiRuntimeSettings:
    node = tmp_path / "node"
    cli = tmp_path / "pi.js"
    node.touch()
    cli.touch()
    return PiRuntimeSettings(
        enabled=True,
        node_path=node,
        cli_path=cli,
        allowed_working_roots=(tmp_path,),
        default_working_directory=tmp_path,
        gateway_origin="http://127.0.0.1:8030",
    )


def _config(tmp_path: Path) -> PiToolConfigSnapshot:
    return PiToolConfigSnapshot(
        enabled=True,
        provider_id="provider-a",
        model="model-a",
        working_directory=str(tmp_path),
        allowed_tools=("read", "grep"),
        thinking_level="off",
        max_model_calls=6,
        timeout_seconds=120,
        system_prompt="只执行已审批的编码任务。",
        revision=1,
    )


def test_pi_runtime_exposes_the_operator_pinned_contract_version(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)

    assert runtime.public_view()["contract_version"] == "0.81.1"
    assert runtime.health_view()["contract_version"] == "0.81.1"


def test_pi_rpc_stream_limit_can_carry_the_largest_bounded_read_result() -> None:
    # JSONL adds line metadata and escaping around the raw text result, so the
    # subprocess reader must leave substantial headroom above the tool bound.
    assert _PI_RPC_STREAM_LIMIT >= MAX_READ_BYTES * 4
    assert MAX_PI_READ_TOOL_CALLS == 24


def test_pi_gateway_projects_real_dashscope_compatibility_before_review() -> None:
    provider = ModelProviderConfig(
        id="dashscope",
        label="DashScope",
        models=(ModelOption(id="qwen3.7-plus", label="Qwen"),),
        base_url="https://coding.dashscope.aliyuncs.com/v1",
        api_key="test-key",
        protocol="openai_chat_completions",
    )

    assert _pi_provider_compat(provider, "qwen3.7-plus") == {
        "supportsStore": True,
        "supportsDeveloperRole": False,
        "supportsReasoningEffort": True,
        "maxTokensField": "max_completion_tokens",
        "supportsStrictMode": False,
    }
    assert _pi_max_tokens(provider, "qwen3.7-plus", "off") == 16_384
    assert _pi_max_tokens(provider, "qwen3.7-plus", "medium") == 65_536


def test_pi_gateway_accepts_dedicated_header_and_normalized_bearer(tmp_path: Path) -> None:
    catalog = _catalog()
    manager = PiRuntimeManager(
        runtime=_runtime(tmp_path),
        catalog=catalog,
        review_store=InMemoryModelCallReviewStore(catalog),
    )
    provider = catalog.get("provider-a")
    assert provider is not None
    execution = PiExecution(
        token="runtime-token",
        task="检查项目",
        config=_config(tmp_path),
        runtime=_runtime(tmp_path),
        provider=provider,
        manager=manager,
    )
    manager._executions[execution.token] = execution

    assert (
        manager.authenticate(
            "Bearer wrong-sdk-token",
            gateway_token="runtime-token",
        )
        is execution
    )
    assert manager.authenticate("bearer   runtime-token") is execution
    with pytest.raises(HTTPException, match="pi Provider网关凭据无效"):
        manager.authenticate(
            "Bearer runtime-token",
            gateway_token="wrong-dedicated-token",
        )
    assert PI_GATEWAY_TOKEN_HEADER == "X-Chat-Pi-Token"


def test_pi_error_boundary_preserves_sanitized_provider_failure(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = InMemoryModelCallReviewStore(_catalog("openai_chat_completions"))
        manager = PiRuntimeManager(
            runtime=_runtime(tmp_path),
            catalog=_catalog("openai_chat_completions"),
            review_store=store,
        )
        provider = _catalog("openai_chat_completions").get("provider-a")
        assert provider is not None
        execution = PiExecution(
            token="runtime-token",
            task="检查项目",
            config=_config(tmp_path),
            runtime=_runtime(tmp_path),
            provider=provider,
            manager=manager,
        )
        execution.record_provider_outcome("failed", "provider_http_400")
        await execution._handle_event(
            {
                "type": "message_end",
                "message": {
                    "role": "assistant",
                    "content": [],
                    "stopReason": "error",
                    "errorMessage": "token=secret-value invalid provider request",
                },
            }
        )
        await execution._handle_event({"type": "agent_end", "willRetry": False})

        boundary = await execution.next_boundary()
        assert isinstance(boundary, PiCompletedBoundary)
        assert boundary.status == "failed"
        assert boundary.terminal_reason_code == "provider_http_400"
        assert boundary.text == "token=[redacted] invalid provider request"

    asyncio.run(scenario())


def test_pi_workspace_normalizes_sdk_absolute_tool_paths_before_governance(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        provider = _catalog().get("provider-a")
        assert provider is not None
        catalog = _catalog()
        execution = PiExecution(
            token="runtime-token",
            task="精确编辑README",
            config=replace(
                _config(tmp_path),
                allowed_tools=("read", "grep", "find", "ls", "edit"),
            ),
            runtime=_runtime(tmp_path),
            provider=provider,
            manager=PiRuntimeManager(
                runtime=_runtime(tmp_path),
                catalog=catalog,
                review_store=InMemoryModelCallReviewStore(catalog),
            ),
            workspace_id="workspace-1",
        )

        await execution._handle_event(
            {
                "type": "extension_ui_request",
                "method": "editor",
                "title": "CHAT_PI_TOOL_APPROVAL",
                "id": "rpc-1",
                "prefill": json.dumps(
                    {
                        "tool_call_id": "call-1",
                        "tool_name": "read",
                        "arguments": {"path": str(tmp_path / "README.md")},
                    }
                ),
            }
        )

        boundary = await execution.next_boundary()
        assert isinstance(boundary, PiToolCallBoundary)
        assert boundary.arguments == {"path": "README.md"}

    asyncio.run(scenario())


def test_pi_workspace_rejects_sdk_absolute_tool_path_escape(tmp_path: Path) -> None:
    provider = _catalog().get("provider-a")
    assert provider is not None
    catalog = _catalog()
    execution = PiExecution(
        token="runtime-token",
        task="精确编辑README",
        config=_config(tmp_path),
        runtime=_runtime(tmp_path),
        provider=provider,
        manager=PiRuntimeManager(
            runtime=_runtime(tmp_path),
            catalog=catalog,
            review_store=InMemoryModelCallReviewStore(catalog),
        ),
        workspace_id="workspace-1",
    )

    with pytest.raises(PiRuntimeError, match="超出本次工作目录"):
        execution._normalize_tool_arguments(
            "read",
            {"path": str(tmp_path.parent / "outside.md")},
        )


def test_chat_completions_pi_tool_loop_is_reviewable_as_complete_provider_request() -> None:
    store = InMemoryModelCallReviewStore(_catalog("openai_chat_completions"))
    request = {
        "model": "model-a",
        "messages": [
            {"role": "system", "content": "只读检查。"},
            {"role": "user", "content": "检查README。"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call-read-1",
                        "type": "function",
                        "function": {
                            "name": "read",
                            "arguments": '{"path":"README.md"}',
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call-read-1",
                "content": '{"lines":[{"line":1,"text":"# Chat"}]}',
            },
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "read",
                    "description": "读取文件",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"],
                    },
                },
            }
        ],
        "store": False,
        "stream": True,
    }

    draft = store.begin_provider_request(
        thread_id="pi-tool-loop-thread",
        run_id="pi-tool-loop-run",
        provider_id="provider-a",
        provider_request=request,
        origin_prompt="检查README",
        allowed_tool_names=("read",),
    )

    assert draft.provider_request == request
    assert "tool" in draft.model_capabilities.roles
    assert (
        draft.review_card()["effective_context"]["messages"][2]["tool_calls"][0]["function"]["name"] == "read"
    )


def _provider_request(*, second: bool = False) -> dict[str, Any]:
    values: list[dict[str, Any]] = [{"role": "user", "content": [{"type": "input_text", "text": "检查项目"}]}]
    if second:
        values.extend(
            [
                {
                    "type": "function_call",
                    "call_id": "call-read-1",
                    "name": "read",
                    "arguments": '{"path":"README.md"}',
                },
                {
                    "type": "function_call_output",
                    "call_id": "call-read-1",
                    "output": "README content",
                },
            ]
        )
    return {
        "model": "model-a",
        "input": values,
        "tools": [
            {
                "type": "function",
                "name": "read",
                "description": "读取文件",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
                "strict": False,
            }
        ],
        "store": False,
        "stream": True,
        "max_output_tokens": 1000,
    }


def _request(session_id: str, run_id: str, prompt: str) -> dict[str, Any]:
    return {
        "threadId": session_id,
        "runId": run_id,
        "state": {},
        "messages": [{"id": f"message-{run_id}", "role": "user", "content": prompt}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def _resume(
    session_id: str,
    run_id: str,
    approval_id: str,
    decision: str,
    **payload: Any,
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
                "payload": {"decision": decision, **payload},
            }
        ],
    }


def _events(response) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events[0]["type"] == "RUN_STARTED"
    return events


def _card(events: list[dict[str, Any]]) -> dict[str, Any]:
    finished = [value for value in events if value["type"] == "RUN_FINISHED"][-1]
    interrupt = finished["outcome"]["interrupts"][0]
    return interrupt["metadata"]["agent_framework"]["data"]


def test_provider_shaped_pi_draft_only_accepts_registered_tools_and_exact_runtime_contract() -> None:
    store = InMemoryModelCallReviewStore(_catalog())
    draft = store.begin_provider_request(
        thread_id="pi-thread",
        run_id="pi-run",
        provider_id="provider-a",
        provider_request=_provider_request(),
        origin_prompt="检查项目",
        allowed_tool_names=("read", "grep"),
        execution_context={"tool_id": "pi_agent"},
    )

    assert draft.provider_request["tools"][0]["name"] == "read"
    assert draft.model_capabilities.allow_unknown_parameters is True
    assert draft.review_card()["effective_context"]["tools"][0]["name"] == "read"

    edited = copy.deepcopy(draft.provider_request)
    edited["tools"][0]["description"] = "只读README"
    edited["input"][0]["content"][0]["text"] = "只检查README"
    revised = store.revise(
        draft_id=draft.draft_id,
        expected_hash=draft.binding_hash,
        provider_id="provider-a",
        provider_request=edited,
    )
    assert revised.version == 2
    assert revised.binding_hash != draft.binding_hash
    assert revised.provider_request == edited

    fake_tool = copy.deepcopy(edited)
    fake_tool["tools"][0]["name"] = "new_tool"
    with pytest.raises(ModelCallDraftValidationError, match="未注册或未授权Tool"):
        store.revise(
            draft_id=revised.draft_id,
            expected_hash=revised.binding_hash,
            provider_id="provider-a",
            provider_request=fake_tool,
        )

    non_streaming = copy.deepcopy(edited)
    non_streaming["stream"] = False
    with pytest.raises(ModelCallDraftValidationError, match="stream必须保持为True"):
        store.revise(
            draft_id=revised.draft_id,
            expected_hash=revised.binding_hash,
            provider_id="provider-a",
            provider_request=non_streaming,
        )


def test_tool_configuration_has_cas_path_policy_and_persisted_metrics(tmp_path: Path) -> None:
    async def scenario() -> None:
        database = ProductDatabase(f"sqlite+aiosqlite:///{tmp_path / 'tools.db'}")
        sessions = ProductSessionService(database)
        await sessions.initialize()
        service = ToolConfigurationService(database, _catalog(), _runtime(tmp_path))
        await service.initialize()
        [initial] = await service.list()
        assert initial["available_tools"] == ["read", "grep", "find", "ls", "bash", "edit", "write"]

        updated = await service.update(
            expected_revision=initial["revision"],
            enabled=True,
            provider_id="provider-a",
            model="model-b",
            working_directory=str(tmp_path),
            allowed_tools=["read", "grep"],
            thinking_level="low",
            max_model_calls=8,
            timeout_seconds=180,
            system_prompt="新的pi约束",
        )
        assert updated["revision"] == 2
        assert updated["model"] == "model-b"
        with pytest.raises(ToolConfigurationConflict):
            await service.update(
                expected_revision=1,
                enabled=True,
                provider_id="provider-a",
                model="model-a",
                working_directory=str(tmp_path),
                allowed_tools=["read"],
                thinking_level="off",
                max_model_calls=2,
                timeout_seconds=60,
                system_prompt="stale",
            )
        outside = tmp_path.parent / "outside"
        outside.mkdir(exist_ok=True)
        with pytest.raises(ToolConfigurationError, match="不在后端允许范围"):
            await service.update(
                expected_revision=2,
                enabled=True,
                provider_id="provider-a",
                model="model-a",
                working_directory=str(outside),
                allowed_tools=["read"],
                thinking_level="off",
                max_model_calls=2,
                timeout_seconds=60,
                system_prompt="outside",
            )

        session = await sessions.create_session()
        accepted = await sessions.prepare_agui_run(_request(session["id"], "tool-ledger-run", "执行pi"))
        execution_id = await service.start_execution(
            session_id=session["id"],
            run_id=accepted.product_run_id,
            config_revision=2,
        )
        await service.finish_execution(
            execution_id,
            status="succeeded",
            metrics={
                "model_call_count": 2,
                "internal_tool_call_count": 1,
                "input_tokens": 120,
                "output_tokens": 40,
                "cache_read_tokens": 5,
                "cache_write_tokens": 3,
                "cost": 0.012,
                "duration_ms": 3210,
                "tool_calls": [{"tool_name": "read", "status": "completed"}],
            },
        )
        [execution] = await service.executions()
        assert execution["status"] == "succeeded"
        assert execution["model_call_count"] == 2
        assert execution["tokens"] == {
            "input": 120,
            "output": 40,
            "cache_read": 5,
            "cache_write": 3,
        }
        assert execution["metrics"]["tool_calls"][0]["tool_name"] == "read"

        waiting_orphan_id = await service.start_execution(
            session_id=session["id"],
            run_id=accepted.product_run_id,
            config_revision=2,
        )
        starting_orphan_id = await service.start_execution(
            session_id=session["id"],
            run_id=accepted.product_run_id,
            config_revision=2,
        )
        async with database.sessions.begin() as transaction:
            waiting_orphan = await transaction.get(ToolExecutionRecord, waiting_orphan_id)
            starting_orphan = await transaction.get(ToolExecutionRecord, starting_orphan_id)
            assert waiting_orphan is not None
            assert starting_orphan is not None
            waiting_orphan.status = "waiting_human"
            starting_orphan.status = "starting"
        restarted = ToolConfigurationService(database, _catalog(), _runtime(tmp_path))
        await restarted.initialize()
        executions = await restarted.executions()
        for orphan_id in (waiting_orphan_id, starting_orphan_id):
            orphan = next(value for value in executions if value["id"] == orphan_id)
            assert orphan["status"] == "interrupted"
            assert orphan["failure_code"] == "process_restarted"
            assert orphan["finished_at"] is not None
            assert orphan["metrics"]["recovery"]["reason"] == "process_restarted"
        assert next(value for value in executions if value["id"] == execution_id)["status"] == "succeeded"
        await database.close()

    asyncio.run(scenario())


def test_pi_gateway_forwards_the_exact_approved_bytes_and_marks_attempt(tmp_path: Path) -> None:
    async def scenario() -> None:
        captured: list[bytes] = []

        class OneChunkStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'data: {"type":"response.completed"}\n\n'

        async def upstream(request: httpx.Request) -> httpx.Response:
            captured.append(await request.aread())
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                stream=OneChunkStream(),
            )

        store = InMemoryModelCallReviewStore(_catalog())
        manager = PiRuntimeManager(
            runtime=_runtime(tmp_path),
            catalog=_catalog(),
            review_store=store,
            http_client_factory=lambda **kwargs: httpx.AsyncClient(
                transport=httpx.MockTransport(upstream),
                **kwargs,
            ),
        )
        execution = PiExecution(
            token="runtime-token",
            task="检查项目",
            config=_config(tmp_path),
            runtime=_runtime(tmp_path),
            provider=_catalog().get("provider-a"),
            manager=manager,
            tool_execution_id="tool-execution-1",
        )
        manager._executions[execution.token] = execution
        assert manager.live_for_tool_execution("tool-execution-1") is execution
        incoming = json.dumps(_provider_request(), separators=(",", ":")).encode()
        dispatch = asyncio.create_task(
            manager.gateway_response(
                authorization="Bearer runtime-token",
                protocol="openai_responses",
                body=incoming,
            )
        )
        boundary = await execution.next_boundary()
        assert isinstance(boundary, PiModelCallBoundary)
        assert execution.pending_provider_call(boundary.call.id) is boundary.call
        draft = store.begin_provider_request(
            thread_id="gateway-thread",
            run_id="gateway-run",
            provider_id="provider-a",
            provider_request=json.loads(incoming),
            origin_prompt="检查项目",
            allowed_tool_names=("read", "grep"),
        )
        claimed = store.claim(
            approval_id=draft.approval_id,
            expected_hash=draft.binding_hash,
            owner="test-worker",
        )
        boundary.call.approval_id = claimed.approval_id
        boundary.call.decision.set_result(
            PiGatewayDecision(
                approved=True,
                body=claimed.body,
                provider_id=claimed.provider_id,
            )
        )
        response = await dispatch
        assert isinstance(response, StreamingResponse)
        relayed = b"".join([chunk async for chunk in response.body_iterator])
        assert b"response.completed" in relayed
        assert captured == [claimed.body]
        [attempt] = store.attempts()
        assert attempt.status == "completed"
        with pytest.raises(PiRuntimeError, match="已经结束或不存在"):
            execution.pending_provider_call(boundary.call.id)
        await execution.close()
        assert manager.live_for_tool_execution("tool-execution-1") is None

    asyncio.run(scenario())


class FakePiExecution:
    def __init__(self, *, provider: ModelProviderConfig, store: InMemoryModelCallReviewStore) -> None:
        self.provider = provider
        self.store = store
        self.model_call_count = 0
        self.step = 0
        self.approved_arguments: list[dict[str, Any]] = []
        self.calls: list[PiGatewayCall] = []
        self.closed = False

    def _model_boundary(self, request: dict[str, Any]) -> PiModelCallBoundary:
        self.model_call_count += 1
        call = PiGatewayCall(
            id=f"gateway-{self.model_call_count}",
            protocol="openai_responses",
            body=json.dumps(request, separators=(",", ":")).encode(),
            received_at=0,
            decision=asyncio.get_running_loop().create_future(),
        )

        def completed(decision) -> None:
            result = decision.result()
            if result.approved and call.approval_id:
                self.store.mark_attempt(call.approval_id, "completed")

        call.decision.add_done_callback(completed)
        self.calls.append(call)
        return PiModelCallBoundary(kind="model_call", call=call)

    async def next_boundary(self):
        self.step += 1
        if self.step == 1:
            return self._model_boundary(_provider_request())
        if self.step == 2:
            return PiToolCallBoundary(
                kind="tool_call",
                rpc_request_id="rpc-tool-1",
                tool_call_id="tool-call-1",
                tool_name="read",
                arguments={"path": "PROJECT_STATE.md"},
            )
        if self.step == 3:
            return self._model_boundary(_provider_request(second=True))
        return PiCompletedBoundary(
            kind="completed",
            text="pi已检查完成，README与项目状态一致。",
            metrics=self.metrics(),
        )

    async def approve_tool_call(self, boundary, arguments) -> None:
        del boundary
        self.approved_arguments.append(dict(arguments))

    async def reject_tool_call(self, boundary) -> None:
        del boundary

    def metrics(self) -> dict[str, Any]:
        return {
            "model_call_count": self.model_call_count,
            "internal_tool_call_count": 1 if self.step >= 2 else 0,
            "input_tokens": 90,
            "output_tokens": 30,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "cost": 0.01,
            "duration_ms": 1400,
            "tool_calls": [{"tool_call_id": "tool-call-1", "tool_name": "read", "status": "completed"}],
        }

    async def close(self) -> None:
        self.closed = True


class FakePiManager:
    def __init__(self, provider: ModelProviderConfig, store: InMemoryModelCallReviewStore) -> None:
        self.provider = provider
        self.store = store
        self.executions: list[FakePiExecution] = []

    async def start(self, task: str, config: PiToolConfigSnapshot) -> FakePiExecution:
        assert task
        assert config.enabled
        execution = FakePiExecution(provider=self.provider, store=self.store)
        self.executions.append(execution)
        return execution

    async def close_all(self) -> None:
        for execution in self.executions:
            await execution.close()


def _model_settings(tmp_path: Path, runtime: PiRuntimeSettings) -> Settings:
    catalog = _catalog()
    return Settings(
        host="127.0.0.1",
        port=8030,
        frontend_origins=("http://testserver",),
        model="model-a",
        model_api_key="test-provider-key",
        model_base_url="https://provider.invalid/v1",
        model_providers=catalog.providers,
        default_model_provider=catalog.default_provider_id,
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'workflow.db'}",
        pi_runtime=runtime,
    )


def test_pi_workflow_reapproves_two_model_calls_edits_tool_args_and_persists_metrics(
    tmp_path: Path,
) -> None:
    runtime = _runtime(tmp_path)
    store = InMemoryModelCallReviewStore(_catalog())
    manager = FakePiManager(_catalog().get("provider-a"), store)
    app = create_app(
        _model_settings(tmp_path, runtime),
        model_call_store=store,
        pi_runtime_manager=manager,  # type: ignore[arg-type]
    )
    with TestClient(app) as client:
        workflows = client.get("/api/workflows").json()["workflows"]
        pi_definition = next(value for value in workflows if value["id"] == "governed-pi-agent")
        assert [value["runtime_type"] for value in pi_definition["nodes"]] == [
            "tool",
            "approval",
            "approval",
        ]
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _card(
            _events(
                client.post(
                    "/api/workflows/governed-pi-agent/run",
                    json=_request(session_id, "pi-start", "检查项目"),
                )
            )
        )
        assert first["review_kind"] == "model_call"
        assert first["execution_context"]["executor_id"] == "pi_agent.model_gate"
        assert first["effective_context"]["tools"][0]["name"] == "read"
        assert store.attempts() == []

        edited = copy.deepcopy(first["provider_request"])
        edited["input"][0]["content"][0]["text"] = "只检查README"
        revised = client.put(
            f"/api/model-call-drafts/{first['draft_id']}",
            json={
                "expected_hash": first["binding_hash"],
                "provider_id": first["provider_id"],
                "provider_request": edited,
            },
        ).json()
        revised_card = _card(
            _events(
                client.post(
                    "/api/workflows/governed-pi-agent/run",
                    json=_resume(
                        session_id,
                        "pi-first-revised",
                        first["approval_id"],
                        "revise",
                        revision_draft_id=revised["draft_id"],
                    ),
                )
            )
        )
        assert revised_card["version"] == 2
        assert store.attempts() == []

        tool_card = _card(
            _events(
                client.post(
                    "/api/workflows/governed-pi-agent/run",
                    json=_resume(
                        session_id,
                        "pi-first-approved",
                        revised_card["approval_id"],
                        "approve",
                    ),
                )
            )
        )
        assert tool_card["review_kind"] == "tool_execution"
        assert tool_card["tool_name"] == "read"
        assert tool_card["arguments"] == {"path": "PROJECT_STATE.md"}

        second = _card(
            _events(
                client.post(
                    "/api/workflows/governed-pi-agent/run",
                    json=_resume(
                        session_id,
                        "pi-tool-approved",
                        tool_card["approval_id"],
                        "approve",
                        arguments={"path": "README.md"},
                    ),
                )
            )
        )
        assert second["review_kind"] == "model_call"
        assert second["execution_context"]["call_position"] == 2
        assert second["provider_request"]["input"][-1]["type"] == "function_call_output"
        completed = _events(
            client.post(
                "/api/workflows/governed-pi-agent/run",
                json=_resume(
                    session_id,
                    "pi-second-approved",
                    second["approval_id"],
                    "approve",
                ),
            )
        )
        executions = client.get("/api/tools/pi_agent/executions").json()["executions"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert completed[-1]["type"] == "RUN_FINISHED"
    assert manager.executions[0].approved_arguments == [{"path": "README.md"}]
    assert len(store.attempts()) == 2
    assert [value.status for value in store.attempts()] == ["completed", "completed"]
    assert executions[0]["status"] == "succeeded"
    assert executions[0]["model_call_count"] == 2
    assert executions[0]["internal_tool_call_count"] == 1
    assert [(value["role"], value["content"]) for value in messages] == [
        ("user", "检查项目"),
        ("assistant", "pi已检查完成，README与项目状态一致。"),
    ]


def test_abandon_pi_internal_tool_stops_later_calls_without_fake_success(tmp_path: Path) -> None:
    runtime = _runtime(tmp_path)
    store = InMemoryModelCallReviewStore(_catalog())
    manager = FakePiManager(_catalog().get("provider-a"), store)
    with TestClient(
        create_app(
            _model_settings(tmp_path, runtime),
            model_call_store=store,
            pi_runtime_manager=manager,  # type: ignore[arg-type]
        )
    ) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _card(
            _events(
                client.post(
                    "/api/workflows/governed-pi-agent/run",
                    json=_request(session_id, "pi-abandon-start", "不要执行Tool"),
                )
            )
        )
        tool_card = _card(
            _events(
                client.post(
                    "/api/workflows/governed-pi-agent/run",
                    json=_resume(
                        session_id,
                        "pi-abandon-model-approved",
                        first["approval_id"],
                        "approve",
                    ),
                )
            )
        )
        abandoned = _events(
            client.post(
                "/api/workflows/governed-pi-agent/run",
                json=_resume(
                    session_id,
                    "pi-tool-abandoned",
                    tool_card["approval_id"],
                    "abandon",
                ),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        [execution] = client.get("/api/tools/pi_agent/executions").json()["executions"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert abandoned[-1]["type"] == "RUN_FINISHED"
    assert run["status"] == "abandoned"
    assert execution["status"] == "abandoned"
    assert execution["model_call_count"] == 1
    assert len(manager.executions[0].calls) == 1
    assert messages == []
