"""Governed pi JSONL-RPC subprocess and exact-byte Provider gateway."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import secrets
import tempfile
import time
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

import httpx
from fastapi import HTTPException
from starlette.responses import Response, StreamingResponse

from .config import PiRuntimeSettings
from .model_call_review import InMemoryModelCallReviewStore, ProviderDispatchError
from .model_providers import ModelProviderCatalog, ModelProviderConfig
from .tool_configs import PiToolConfigSnapshot

PI_EXTENSION_SOURCE = """export default function(pi) {
  pi.on("tool_call", async (event, ctx) => {
    const edited = await ctx.ui.editor(
      "CHAT_PI_TOOL_APPROVAL",
      JSON.stringify({
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        arguments: event.input
      })
    );
    if (edited === undefined) {
      return { block: true, reason: "Chat user rejected the pi tool call" };
    }
    let decision;
    try {
      decision = JSON.parse(edited);
    } catch {
      return { block: true, reason: "Chat returned invalid tool arguments" };
    }
    if (!decision || typeof decision.arguments !== "object" || Array.isArray(decision.arguments)) {
      return { block: true, reason: "Chat returned invalid tool arguments" };
    }
    for (const key of Object.keys(event.input)) delete event.input[key];
    Object.assign(event.input, decision.arguments);
    return undefined;
  });
}
"""


class PiRuntimeError(RuntimeError):
    def __init__(self, message: str, *, code: str = "pi_runtime_error") -> None:
        self.code = code
        super().__init__(message)


@dataclass(slots=True)
class PiGatewayDecision:
    approved: bool
    body: bytes | None = None
    provider_id: str | None = None


@dataclass(slots=True)
class PiGatewayCall:
    id: str
    protocol: str
    body: bytes
    received_at: float
    decision: asyncio.Future[PiGatewayDecision]
    approval_id: str | None = None


@dataclass(frozen=True, slots=True)
class PiModelCallBoundary:
    kind: Literal["model_call"]
    call: PiGatewayCall


@dataclass(frozen=True, slots=True)
class PiToolCallBoundary:
    kind: Literal["tool_call"]
    rpc_request_id: str
    tool_call_id: str
    tool_name: str
    arguments: dict[str, Any]


@dataclass(frozen=True, slots=True)
class PiCompletedBoundary:
    kind: Literal["completed"]
    text: str
    metrics: dict[str, Any]


PiBoundary = PiModelCallBoundary | PiToolCallBoundary | PiCompletedBoundary


def _assistant_text(message: Mapping[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        str(item.get("text") or "")
        for item in content
        if isinstance(item, Mapping) and item.get("type") == "text"
    )


def _pi_api(protocol: str) -> str:
    return "openai-completions" if protocol == "openai_chat_completions" else "openai-responses"


class PiExecution:
    """One live pi process; lifecycle is intentionally process-local until Runtime Jobs exist."""

    def __init__(
        self,
        *,
        token: str,
        task: str,
        config: PiToolConfigSnapshot,
        runtime: PiRuntimeSettings,
        provider: ModelProviderConfig,
        manager: PiRuntimeManager,
    ) -> None:
        self.token = token
        self.task = task
        self.config = config
        self.runtime = runtime
        self.provider = provider
        self.manager = manager
        self.started_at = time.monotonic()
        self.process: asyncio.subprocess.Process | None = None
        self._temp_directory: tempfile.TemporaryDirectory[str] | None = None
        self._boundaries: asyncio.Queue[PiBoundary] = asyncio.Queue()
        self._response_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._stderr: list[str] = []
        self._final_text = ""
        self._closed = False
        self._model_call_count = 0
        self._internal_tool_call_count = 0
        self._tool_events: list[dict[str, Any]] = []
        self._usage = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "cost": 0.0,
        }

    @property
    def model_call_count(self) -> int:
        return self._model_call_count

    async def start(self) -> None:
        if not self.runtime.available or self.runtime.node_path is None or self.runtime.cli_path is None:
            raise PiRuntimeError("pi RPC运行时不可用", code="pi_runtime_unavailable")
        self._temp_directory = tempfile.TemporaryDirectory(prefix="chat-pi-")
        agent_directory = Path(self._temp_directory.name)
        gateway_base = f"{self.runtime.gateway_origin}/api/pi-provider/v1"
        models = {
            "providers": {
                "chat-governed": {
                    "name": "Chat逐次审批网关",
                    "baseUrl": gateway_base,
                    "apiKey": self.token,
                    "authHeader": True,
                    "api": _pi_api(self.provider.protocol),
                    "compat": (
                        {"supportsStore": True} if self.provider.protocol == "openai_chat_completions" else {}
                    ),
                    "models": [
                        {
                            "id": self.config.model,
                            "name": self.config.model,
                            "reasoning": self.config.thinking_level != "off",
                            "contextWindow": 128000,
                            "maxTokens": 16384,
                        }
                    ],
                }
            }
        }
        (agent_directory / "models.json").write_text(json.dumps(models, ensure_ascii=False), encoding="utf-8")
        extension_path = agent_directory / "chat-tool-approval.mjs"
        extension_path.write_text(PI_EXTENSION_SOURCE, encoding="utf-8")
        environment = os.environ.copy()
        environment.update(
            {
                "PI_CODING_AGENT_DIR": str(agent_directory),
                "PI_OFFLINE": "1",
                "PI_TELEMETRY": "0",
            }
        )
        arguments = [
            str(self.runtime.node_path),
            str(self.runtime.cli_path),
            "--mode",
            "rpc",
            "--provider",
            "chat-governed",
            "--model",
            self.config.model,
            "--api-key",
            self.token,
            "--thinking",
            self.config.thinking_level,
            "--tools",
            ",".join(self.config.allowed_tools),
            "--system-prompt",
            self.config.system_prompt,
            "--extension",
            str(extension_path),
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-session",
            "--approve",
            "--offline",
        ]
        self.process = await asyncio.create_subprocess_exec(
            *arguments,
            cwd=self.config.working_directory,
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())
        await self._command("set_auto_retry", {"enabled": False})
        await self._command("prompt", {"message": self.task})

    async def accept_provider_call(self, protocol: str, body: bytes) -> PiGatewayCall:
        if self._closed:
            raise PiRuntimeError("pi执行已经结束", code="pi_execution_closed")
        if protocol != self.provider.protocol:
            raise PiRuntimeError("pi网关协议与目标Provider不一致", code="pi_protocol_mismatch")
        self._model_call_count += 1
        if self._model_call_count > self.config.max_model_calls:
            raise PiRuntimeError("pi模型调用次数超过配置上限", code="pi_model_call_limit")
        call = PiGatewayCall(
            id=str(uuid4()),
            protocol=protocol,
            body=body,
            received_at=time.monotonic(),
            decision=asyncio.get_running_loop().create_future(),
        )
        await self._boundaries.put(PiModelCallBoundary(kind="model_call", call=call))
        return call

    async def next_boundary(self) -> PiBoundary:
        remaining = self.config.timeout_seconds - (time.monotonic() - self.started_at)
        if remaining <= 0:
            await self.close()
            raise PiRuntimeError("pi执行超过配置的总时限", code="pi_timeout")
        try:
            return await asyncio.wait_for(self._boundaries.get(), timeout=remaining)
        except TimeoutError as error:
            await self.close()
            raise PiRuntimeError("pi执行超过配置的总时限", code="pi_timeout") from error

    async def approve_tool_call(self, boundary: PiToolCallBoundary, arguments: Mapping[str, Any]) -> None:
        self._validate_tool_arguments(boundary.tool_name, arguments)
        await self._write(
            {
                "type": "extension_ui_response",
                "id": boundary.rpc_request_id,
                "value": json.dumps(
                    {
                        "tool_call_id": boundary.tool_call_id,
                        "tool_name": boundary.tool_name,
                        "arguments": copy.deepcopy(dict(arguments)),
                    },
                    ensure_ascii=False,
                ),
            }
        )

    async def reject_tool_call(self, boundary: PiToolCallBoundary) -> None:
        await self._write({"type": "extension_ui_response", "id": boundary.rpc_request_id, "cancelled": True})

    def metrics(self) -> dict[str, Any]:
        return {
            "model_call_count": self._model_call_count,
            "internal_tool_call_count": self._internal_tool_call_count,
            **self._usage,
            "duration_ms": int((time.monotonic() - self.started_at) * 1000),
            "tool_calls": copy.deepcopy(self._tool_events),
            "pi_version": "0.81.1",
            "integration_mode": "jsonl_rpc_subprocess",
        }

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        process = self.process
        if process is not None and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except TimeoutError:
                process.kill()
                await process.wait()
        for task in (self._reader_task, self._stderr_task):
            if task is not None and not task.done():
                task.cancel()
        self.manager.unregister(self.token)
        if self._temp_directory is not None:
            self._temp_directory.cleanup()
            self._temp_directory = None

    async def _command(self, command_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        command_id = str(uuid4())
        waiter: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._response_waiters[command_id] = waiter
        await self._write({"id": command_id, "type": command_type, **payload})
        try:
            result = await asyncio.wait_for(waiter, timeout=30)
        except TimeoutError as error:
            raise PiRuntimeError(f"pi RPC命令超时: {command_type}", code="pi_rpc_timeout") from error
        if result.get("success") is not True:
            raise PiRuntimeError(
                str(result.get("error") or f"pi RPC命令失败: {command_type}"),
                code="pi_rpc_rejected",
            )
        return result

    async def _write(self, value: Mapping[str, Any]) -> None:
        if self.process is None or self.process.stdin is None or self.process.returncode is not None:
            raise PiRuntimeError("pi RPC进程不可写", code="pi_process_closed")
        self.process.stdin.write(
            (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        )
        await self.process.stdin.drain()

    async def _read_stdout(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        try:
            while line := await self.process.stdout.readline():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                if event.get("type") == "response" and isinstance(event.get("id"), str):
                    waiter = self._response_waiters.pop(event["id"], None)
                    if waiter is not None and not waiter.done():
                        waiter.set_result(event)
                    continue
                await self._handle_event(event)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self._boundaries.put(
                PiCompletedBoundary(
                    kind="completed",
                    text=f"pi RPC输出读取失败: {type(error).__name__}",
                    metrics={**self.metrics(), "failure_code": "pi_rpc_output_failed"},
                )
            )
        finally:
            if not self._closed and self.process is not None:
                return_code = await self.process.wait()
                if return_code != 0:
                    detail = self._stderr[-1] if self._stderr else f"exit {return_code}"
                    await self._boundaries.put(
                        PiCompletedBoundary(
                            kind="completed",
                            text=f"pi进程异常结束: {detail[:300]}",
                            metrics={**self.metrics(), "failure_code": "pi_process_failed"},
                        )
                    )

    async def _read_stderr(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        while line := await self.process.stderr.readline():
            text = line.decode("utf-8", errors="replace").strip()
            if text:
                self._stderr.append(text[:1000])
                self._stderr = self._stderr[-20:]

    async def _handle_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        if event_type == "extension_ui_request" and event.get("method") == "editor":
            if event.get("title") != "CHAT_PI_TOOL_APPROVAL":
                await self._write({"type": "extension_ui_response", "id": event.get("id"), "cancelled": True})
                return
            try:
                payload = json.loads(str(event.get("prefill") or "{}"))
            except json.JSONDecodeError:
                payload = {}
            arguments = payload.get("arguments") if isinstance(payload, dict) else {}
            boundary = PiToolCallBoundary(
                kind="tool_call",
                rpc_request_id=str(event.get("id") or ""),
                tool_call_id=str(payload.get("tool_call_id") or ""),
                tool_name=str(payload.get("tool_name") or ""),
                arguments=copy.deepcopy(arguments) if isinstance(arguments, dict) else {},
            )
            self._validate_tool_arguments(boundary.tool_name, boundary.arguments)
            self._internal_tool_call_count += 1
            await self._boundaries.put(boundary)
            return
        if event_type == "tool_execution_start":
            self._tool_events.append(
                {
                    "tool_call_id": str(event.get("toolCallId") or ""),
                    "tool_name": str(event.get("toolName") or ""),
                    "status": "running",
                    "started_offset_ms": int((time.monotonic() - self.started_at) * 1000),
                }
            )
            return
        if event_type == "tool_execution_end":
            tool_call_id = str(event.get("toolCallId") or "")
            item = next(
                (value for value in reversed(self._tool_events) if value["tool_call_id"] == tool_call_id),
                None,
            )
            if item is not None:
                item["status"] = "failed" if event.get("isError") else "completed"
                item["finished_offset_ms"] = int((time.monotonic() - self.started_at) * 1000)
            return
        if event_type == "message_end" and isinstance(event.get("message"), dict):
            message = event["message"]
            if message.get("role") == "assistant":
                text = _assistant_text(message)
                if text:
                    self._final_text = text
                usage = message.get("usage")
                if isinstance(usage, dict):
                    self._usage["input_tokens"] += int(usage.get("input") or 0)
                    self._usage["output_tokens"] += int(usage.get("output") or 0)
                    self._usage["cache_read_tokens"] += int(usage.get("cacheRead") or 0)
                    self._usage["cache_write_tokens"] += int(usage.get("cacheWrite") or 0)
                    self._usage["cost"] += float(
                        usage.get("cost", {}).get("total", 0) if isinstance(usage.get("cost"), dict) else 0
                    )
            return
        if event_type == "agent_end" and not event.get("willRetry"):
            await self._boundaries.put(
                PiCompletedBoundary(
                    kind="completed",
                    text=self._final_text or "pi执行完成，但没有返回可显示文本。",
                    metrics=self.metrics(),
                )
            )

    def _validate_tool_arguments(self, tool_name: str, arguments: Mapping[str, Any]) -> None:
        if tool_name not in self.config.allowed_tools:
            raise PiRuntimeError(f"pi请求了未授权Tool: {tool_name}", code="pi_tool_not_allowed")
        path_value = arguments.get("path")
        if isinstance(path_value, str) and path_value.strip():
            base = Path(self.config.working_directory)
            resolved = (
                (base / path_value).resolve()
                if not Path(path_value).is_absolute()
                else Path(path_value).resolve()
            )
            if resolved != base and not resolved.is_relative_to(base):
                raise PiRuntimeError("pi Tool路径超出本次工作目录", code="pi_tool_path_escape")


class PiRuntimeManager:
    """Own live pi processes and route their model requests through approval."""

    def __init__(
        self,
        *,
        runtime: PiRuntimeSettings,
        catalog: ModelProviderCatalog,
        review_store: InMemoryModelCallReviewStore,
        http_client_factory: Callable[..., httpx.AsyncClient] | None = None,
    ) -> None:
        self.runtime = runtime
        self.catalog = catalog
        self.review_store = review_store
        self._http_client_factory = http_client_factory or httpx.AsyncClient
        self._executions: dict[str, PiExecution] = {}

    async def start(self, task: str, config: PiToolConfigSnapshot) -> PiExecution:
        clean_task = task.strip()
        if not clean_task:
            raise PiRuntimeError("pi任务不能为空", code="pi_task_empty")
        provider = self.catalog.require_selection(config.provider_id, config.model)
        token = secrets.token_urlsafe(32)
        execution = PiExecution(
            token=token,
            task=clean_task,
            config=config,
            runtime=self.runtime,
            provider=provider,
            manager=self,
        )
        self._executions[token] = execution
        try:
            await execution.start()
        except Exception:
            self.unregister(token)
            await execution.close()
            raise
        return execution

    def unregister(self, token: str) -> None:
        self._executions.pop(token, None)

    async def close_all(self) -> None:
        for execution in list(self._executions.values()):
            await execution.close()

    def authenticate(self, authorization: str | None) -> PiExecution:
        prefix = "Bearer "
        token = authorization[len(prefix) :] if authorization and authorization.startswith(prefix) else ""
        execution = self._executions.get(token)
        if execution is None:
            raise HTTPException(status_code=401, detail="pi Provider网关凭据无效")
        return execution

    async def gateway_response(
        self,
        *,
        authorization: str | None,
        protocol: str,
        body: bytes,
    ) -> Response:
        execution = self.authenticate(authorization)
        try:
            call = await execution.accept_provider_call(protocol, body)
            decision = await call.decision
        except PiRuntimeError as error:
            return Response(
                content=json.dumps({"error": {"message": str(error), "code": error.code}}),
                status_code=429 if error.code == "pi_model_call_limit" else 409,
                media_type="application/json",
            )
        if not decision.approved or decision.body is None:
            return Response(
                content=json.dumps({"error": {"message": "用户未批准本次pi模型调用"}}),
                status_code=403,
                media_type="application/json",
            )
        try:
            approved_request = json.loads(decision.body)
            provider = self.catalog.require_selection(
                decision.provider_id or execution.provider.id,
                str(approved_request.get("model") or ""),
            )
        except (ValueError, json.JSONDecodeError, AttributeError):
            self._mark_gateway_attempt(call, "failed", "pi_provider_route_invalid")
            return Response(
                content=json.dumps(
                    {
                        "error": {
                            "message": "已审批的pi Provider路由无效",
                            "code": "pi_provider_route_invalid",
                        }
                    }
                ),
                status_code=409,
                media_type="application/json",
            )
        if provider.protocol != call.protocol:
            self._mark_gateway_attempt(call, "failed", "pi_protocol_switch_rejected")
            return Response(
                content=json.dumps(
                    {
                        "error": {
                            "message": "pi运行中不能切换Provider协议",
                            "code": "pi_protocol_switch_rejected",
                        }
                    }
                ),
                status_code=409,
                media_type="application/json",
            )
        endpoint = self._provider_endpoint(provider)
        headers = {"content-type": "application/json"}
        if provider.api_key:
            headers["authorization"] = f"Bearer {provider.api_key}"
        client = self._http_client_factory(
            timeout=execution.config.timeout_seconds,
            follow_redirects=False,
        )
        try:
            request = client.build_request("POST", endpoint, content=decision.body, headers=headers)
            upstream = await client.send(request, stream=True)
        except httpx.TimeoutException as error:
            await client.aclose()
            self._mark_gateway_attempt(call, "outcome_unknown", "provider_timeout")
            raise ProviderDispatchError(
                "pi上游Provider请求超时",
                error_code="provider_timeout",
                outcome_status="outcome_unknown",
            ) from error
        except httpx.HTTPError as error:
            await client.aclose()
            self._mark_gateway_attempt(call, "outcome_unknown", "provider_connection_failed")
            raise ProviderDispatchError(
                "pi上游Provider连接失败",
                error_code="provider_connection_failed",
                outcome_status="outcome_unknown",
            ) from error

        async def relay() -> AsyncIterator[bytes]:
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
                status = "completed" if not upstream.is_error else "failed"
                code = None if not upstream.is_error else f"provider_http_{upstream.status_code}"
                self._mark_gateway_attempt(call, status, code)
            except asyncio.CancelledError:
                self._mark_gateway_attempt(call, "outcome_unknown", "provider_dispatch_cancelled")
                raise
            finally:
                await upstream.aclose()
                await client.aclose()

        response_headers = {
            key: value
            for key, value in upstream.headers.items()
            if key.lower() in {"content-type", "cache-control", "x-request-id"}
        }
        return StreamingResponse(
            relay(),
            status_code=upstream.status_code,
            headers=response_headers,
            media_type=upstream.headers.get("content-type"),
        )

    def _mark_gateway_attempt(
        self,
        call: PiGatewayCall,
        status: str,
        error_code: str | None,
    ) -> None:
        if call.approval_id is None:
            return
        try:
            self.review_store.mark_attempt(call.approval_id, status, error_code=error_code)
        except Exception:
            return

    @staticmethod
    def _provider_endpoint(provider: ModelProviderConfig) -> str:
        root = (provider.base_url or "").rstrip("/")
        suffix = "/chat/completions" if provider.protocol == "openai_chat_completions" else "/responses"
        return root if root.endswith(suffix) else f"{root}{suffix}"
