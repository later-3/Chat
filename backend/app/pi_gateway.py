"""Authenticated Provider and read-Tool gateway for live pi executions.

The gateway owns transport authentication and upstream relay only.  Process
state, JSONL-RPC parsing and tool-result consumption remain in ``pi_runtime``;
Product governance and durable state remain in ``execution_dispatch``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx
from fastapi import HTTPException
from starlette.responses import Response, StreamingResponse

from .config import PiRuntimeSettings
from .execution_dispatch.contracts import RepositoryFence
from .execution_workspaces import ExecutionWorkspaceService
from .model_call_review import InMemoryModelCallReviewStore, ProviderDispatchError
from .model_providers import ModelProviderCatalog, ModelProviderConfig, is_kimi_code_provider
from .pi_runtime import PiExecution, PiGatewayCall, PiRuntimeError
from .readonly_tools import ReadonlyToolService
from .tool_configs import PiToolConfigSnapshot
from .tool_execution import ToolOperationService

logger = logging.getLogger(__name__)


def _provider_request_headers(
    provider: ModelProviderConfig,
    *,
    pi_contract_version: str,
) -> dict[str, str]:
    """Build secret-bearing upstream headers without altering approved bytes."""

    headers = {"content-type": "application/json"}
    if provider.api_key:
        headers["authorization"] = f"Bearer {provider.api_key}"
    if is_kimi_code_provider(provider):
        # Kimi Code asks compatible clients to preserve their true identity.
        # This gateway is Chat operating pi, not the Kimi CLI itself.
        headers["user-agent"] = f"Chat-Pi-Gateway/1 pi-coding-agent/{pi_contract_version}"
    return headers


class PiRuntimeManager:
    """Own live pi processes and route their governed external requests."""

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

    async def start(
        self,
        task: str,
        config: PiToolConfigSnapshot,
        *,
        repository_fence: RepositoryFence | None = None,
        readonly_tools: ReadonlyToolService | None = None,
        workspace_id: str | None = None,
        tool_execution_id: str | None = None,
        product_session_id: str | None = None,
        product_run_id: str | None = None,
        execution_workspaces: ExecutionWorkspaceService | None = None,
        tool_operations: ToolOperationService | None = None,
    ) -> PiExecution:
        # DEBUG-BREAKPOINT-NOTE: BP-24
        # DEBUG-BREAKPOINT-NOTE: 触发: pi运行时管理器启动时触发。
        # DEBUG-BREAKPOINT-NOTE: 触发: 仅在config.json中启用了pi_agent时才命中。
        # DEBUG-BREAKPOINT-NOTE: 触发: 启动pi子进程并建立JSONL RPC通道。
        # DEBUG-BREAKPOINT-NOTE: 触发: 通常在应用启动时调用一次。
        # DEBUG-BREAKPOINT-NOTE: 频率: 应用启动时触发1次（仅pi启用时）
        breakpoint()  # DEBUG-BREAKPOINT: BP-24
        clean_task = task.strip()
        if not clean_task:
            raise PiRuntimeError("pi任务不能为空", code="pi_task_empty")
        if self.runtime.node_debug_port is not None and self._executions:
            raise PiRuntimeError(
                "pi源码调试端口已被另一个活动执行占用",
                code="pi_debugger_busy",
            )
        provider = self.catalog.require_selection(config.provider_id, config.model)
        token = secrets.token_urlsafe(32)
        execution = PiExecution(
            token=token,
            task=clean_task,
            config=config,
            runtime=self.runtime,
            provider=provider,
            manager=self,
            repository_fence=repository_fence,
            readonly_tools=readonly_tools,
            workspace_id=workspace_id,
            tool_execution_id=tool_execution_id,
            product_session_id=product_session_id,
            product_run_id=product_run_id,
            execution_workspaces=execution_workspaces,
            tool_operations=tool_operations,
        )
        self._executions[token] = execution
        logger.info(
            "pi_runtime_registered execution_id=%s process_id=%d credential_fingerprint=%s "
            "active_executions=%d",
            tool_execution_id,
            os.getpid(),
            hashlib.sha256(token.encode("utf-8")).hexdigest()[:12],
            len(self._executions),
        )
        try:
            await execution.start()
        except Exception as error:
            self.unregister(token)
            await execution.close()
            metrics = execution.metrics()
            if isinstance(error, PiRuntimeError):
                error.metrics = metrics
                raise
            raise PiRuntimeError(
                "pi进程启动失败",
                code=getattr(error, "code", type(error).__name__),
                metrics=metrics,
            ) from error
        logger.info(
            "pi_runtime_started execution_id=%s process_id=%d active_executions=%d",
            tool_execution_id,
            os.getpid(),
            len(self._executions),
        )
        return execution

    def unregister(self, token: str) -> None:
        execution = self._executions.pop(token, None)
        logger.info(
            "pi_runtime_unregistered execution_id=%s process_id=%d credential_fingerprint=%s "
            "was_active=%s active_executions=%d",
            execution.tool_execution_id if execution is not None else None,
            os.getpid(),
            hashlib.sha256(token.encode("utf-8")).hexdigest()[:12],
            execution is not None,
            len(self._executions),
        )

    async def close_all(self) -> None:
        for execution in list(self._executions.values()):
            await execution.close()

    async def close_for_tool_execution(self, tool_execution_id: str) -> dict[str, Any] | None:
        """关闭唯一活动进程，并返回冻结Session后的最终安全指标。"""

        execution = self.live_for_tool_execution(tool_execution_id)
        if execution is None:
            return None
        await execution.close()
        return execution.metrics()

    def live_for_tool_execution(self, tool_execution_id: str) -> PiExecution | None:
        """Resolve one process-local pi owner from its durable ledger ID."""

        matches = [
            execution
            for execution in self._executions.values()
            if execution.tool_execution_id == tool_execution_id
        ]
        if len(matches) > 1:
            raise PiRuntimeError(
                "同一ToolExecution绑定了多个pi进程",
                code="pi_execution_owner_conflict",
            )
        return matches[0] if matches else None

    def authenticate(
        self,
        authorization: str | None,
        *,
        gateway_token: str | None = None,
    ) -> PiExecution:
        """Resolve one process-local credential without logging the secret."""

        candidate = (gateway_token or "").strip()
        source = "dedicated_header" if candidate else "authorization"
        if not candidate and authorization:
            scheme, separator, value = authorization.partition(" ")
            if separator and scheme.lower() == "bearer":
                candidate = value.strip()
        for token, execution in self._executions.items():
            if candidate and secrets.compare_digest(token, candidate):
                logger.info(
                    "pi_gateway_authenticated source=%s execution_id=%s process_id=%d "
                    "credential_fingerprint=%s",
                    source,
                    execution.tool_execution_id,
                    os.getpid(),
                    hashlib.sha256(candidate.encode("utf-8")).hexdigest()[:12],
                )
                return execution
        fingerprint = hashlib.sha256(candidate.encode("utf-8")).hexdigest()[:12] if candidate else "missing"
        logger.warning(
            "pi_gateway_authentication_failed source=%s process_id=%d "
            "credential_fingerprint=%s active_executions=%d",
            source,
            os.getpid(),
            fingerprint,
            len(self._executions),
        )
        raise HTTPException(status_code=401, detail="pi Provider网关凭据无效")

    async def read_tool_response(
        self,
        *,
        authorization: str | None,
        tool_name: str,
        body: bytes,
    ) -> dict[str, Any]:
        execution = self.authenticate(authorization)
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as error:
            raise PiRuntimeError(
                "pi只读Tool请求不是有效JSON",
                code="pi_read_tool_request_invalid",
            ) from error
        if not isinstance(payload, dict) or not isinstance(payload.get("arguments"), dict):
            raise PiRuntimeError(
                "pi只读Tool请求缺少参数",
                code="pi_read_tool_request_invalid",
            )
        return await execution.execute_read_tool(
            tool_call_id=str(payload.get("tool_call_id") or ""),
            tool_name=tool_name,
            arguments=payload["arguments"],
        )

    async def workspace_tool_response(
        self,
        *,
        authorization: str | None,
        tool_name: str,
        body: bytes,
    ) -> dict[str, Any]:
        execution = self.authenticate(authorization)
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as error:
            raise PiRuntimeError(
                "pi Workspace Tool请求不是有效JSON",
                code="pi_workspace_tool_request_invalid",
            ) from error
        if not isinstance(payload, dict) or not isinstance(payload.get("arguments"), dict):
            raise PiRuntimeError(
                "pi Workspace Tool请求缺少参数",
                code="pi_workspace_tool_request_invalid",
            )
        return await execution.execute_workspace_tool(
            tool_call_id=str(payload.get("tool_call_id") or ""),
            tool_name=tool_name,
            arguments=payload["arguments"],
        )

    async def gateway_response(
        self,
        *,
        authorization: str | None,
        gateway_token: str | None = None,
        protocol: str,
        body: bytes,
    ) -> Response:
        execution = self.authenticate(
            authorization,
            gateway_token=gateway_token,
        )
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
            execution.retire_provider_call(call.id)
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
            self._mark_gateway_attempt(
                execution,
                call,
                "failed",
                "pi_provider_route_invalid",
            )
            execution.retire_provider_call(call.id)
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
            self._mark_gateway_attempt(
                execution,
                call,
                "failed",
                "pi_protocol_switch_rejected",
            )
            execution.retire_provider_call(call.id)
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
        headers = _provider_request_headers(
            provider,
            pi_contract_version=self.runtime.contract_version,
        )
        client = self._http_client_factory(
            timeout=execution.config.timeout_seconds,
            follow_redirects=False,
        )
        try:
            request = client.build_request(
                "POST",
                endpoint,
                content=decision.body,
                headers=headers,
            )
            upstream = await client.send(request, stream=True)
        except httpx.TimeoutException as error:
            await client.aclose()
            self._mark_gateway_attempt(
                execution,
                call,
                "outcome_unknown",
                "provider_timeout",
            )
            execution.retire_provider_call(call.id)
            raise ProviderDispatchError(
                "pi上游Provider请求超时",
                error_code="provider_timeout",
                outcome_status="outcome_unknown",
            ) from error
        except httpx.HTTPError as error:
            await client.aclose()
            self._mark_gateway_attempt(
                execution,
                call,
                "outcome_unknown",
                "provider_connection_failed",
            )
            execution.retire_provider_call(call.id)
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
                self._mark_gateway_attempt(execution, call, status, code)
            except asyncio.CancelledError:
                self._mark_gateway_attempt(
                    execution,
                    call,
                    "outcome_unknown",
                    "provider_dispatch_cancelled",
                )
                raise
            finally:
                await upstream.aclose()
                await client.aclose()
                execution.retire_provider_call(call.id)

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
        execution: PiExecution,
        call: PiGatewayCall,
        status: str,
        error_code: str | None,
    ) -> None:
        call.outcome_status = status
        call.error_code = error_code
        execution.record_provider_outcome(status, error_code)
        if call.approval_id is None:
            return
        try:
            self.review_store.mark_attempt(
                call.approval_id,
                status,
                error_code=error_code,
            )
        except Exception as error:
            logger.warning(
                "pi_attempt_projection_failed call_id=%s approval_id=%s status=%s error_type=%s",
                call.id,
                call.approval_id,
                status,
                type(error).__name__,
            )

    @staticmethod
    def _provider_endpoint(provider: ModelProviderConfig) -> str:
        root = (provider.base_url or "").rstrip("/")
        suffix = "/chat/completions" if provider.protocol == "openai_chat_completions" else "/responses"
        return root if root.endswith(suffix) else f"{root}{suffix}"
