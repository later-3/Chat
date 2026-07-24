"""Governed MAF Workflow exposing pi as a real FunctionTool runtime."""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping
from typing import Any, cast
from uuid import uuid4

from agent_framework import (
    SKIP_PARSING,
    Executor,
    FunctionTool,
    WorkflowBuilder,
    WorkflowContext,
    handler,
    response_handler,
)
from agent_framework._workflows._request_info_mixin import RequestInfoMixin

from ..model_call_review import InMemoryModelCallReviewStore, ModelCallDraftConflict
from ..model_call_workflow import normalize_agui_messages_for_provider
from ..pi_gateway import PiRuntimeManager
from ..pi_runtime import (
    PiCompletedBoundary,
    PiExecution,
    PiGatewayDecision,
    PiModelCallBoundary,
    PiRuntimeError,
    PiToolCallBoundary,
)
from ..product_sessions.service import ProductSessionService
from ..tool_configs import PiToolConfigSnapshot, ToolConfigurationService


def _latest_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            return "\n".join(
                str(part.get("text") or "")
                for part in content
                if isinstance(part, Mapping) and isinstance(part.get("text"), str)
            ).strip()
    return ""


def _tool_review_card(
    boundary: PiToolCallBoundary,
    *,
    approval_id: str,
    config: PiToolConfigSnapshot,
) -> dict[str, Any]:
    risk = "只读" if boundary.tool_name in {"read", "grep", "find", "ls"} else "可能修改工作区"
    return {
        "review_kind": "tool_execution",
        "message": "请审核pi内部Tool调用",
        "approval_id": approval_id,
        "tool_call_id": boundary.tool_call_id,
        "tool_id": "pi_agent",
        "tool_name": boundary.tool_name,
        "arguments": boundary.arguments,
        "working_directory": config.working_directory,
        "risk": risk,
        "config_revision": config.revision,
        "execution_context": {
            "workflow_id": "governed-pi-agent",
            "executor_id": "pi_agent.tool_gate",
            "tool_id": "pi_agent",
            "wait_reason": "pi_internal_tool_approval",
        },
    }


class GovernedPiToolExecutor(Executor, RequestInfoMixin):
    """Run one pi RPC process and pause at every external boundary."""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        config: PiToolConfigSnapshot,
        manager: PiRuntimeManager,
        store: InMemoryModelCallReviewStore,
        sessions: ProductSessionService,
        tools: ToolConfigurationService,
    ) -> None:
        super().__init__(id="pi_agent")
        self._thread_id = thread_id
        self._run_id = run_id
        self._config = config
        self._manager = manager
        self._store = store
        self._sessions = sessions
        self._tools = tools
        self._execution: PiExecution | None = None
        self._execution_id: str | None = None
        self._origin_prompt = ""
        self._pending_model: PiModelCallBoundary | None = None
        self._pending_tool: PiToolCallBoundary | None = None
        self._pi_tool = FunctionTool(
            name="pi_agent",
            description=(
                "在配置的本地工作目录中运行pi coding agent；每次模型请求与pi内部Tool请求都由Chat暂停审批。"
            ),
            approval_mode="always_require",
            func=self._start_pi,
            input_model={
                "type": "object",
                "properties": {"task": {"type": "string", "description": "要交给pi的编码任务"}},
                "required": ["task"],
                "additionalProperties": False,
            },
            result_parser=SKIP_PARSING,
        )

    @property
    def function_tool(self) -> FunctionTool:
        return self._pi_tool

    async def _start_pi(self, task: str) -> PiExecution:
        return await self._manager.start(task, self._config)

    @handler(input=list)
    async def start(self, messages: list[Any], ctx: WorkflowContext[Any, str]) -> None:
        normalized = normalize_agui_messages_for_provider(messages)
        self._origin_prompt = _latest_user_text(normalized)
        if not self._origin_prompt:
            raise ValueError("pi Agent Workflow没有可执行的用户任务")
        active_run = await self._sessions.active_run(self._thread_id)
        if active_run is None:
            raise RuntimeError("pi Agent Workflow缺少活动Product Run")
        self._execution_id = await self._tools.start_execution(
            session_id=self._thread_id,
            run_id=str(active_run["id"]),
            config_revision=self._config.revision,
        )
        try:
            self._execution = cast(
                PiExecution,
                await self._pi_tool.invoke(
                    arguments={"task": self._origin_prompt},
                    skip_parsing=True,
                ),
            )
            await self._drive(ctx)
        except Exception as error:
            await self._fail(type(error).__name__)
            raise

    async def _drive(self, ctx: WorkflowContext[Any, str]) -> None:
        if self._execution is None:
            raise RuntimeError("pi Agent运行实例未创建")
        try:
            boundary = await self._execution.next_boundary()
            if isinstance(boundary, PiModelCallBoundary):
                try:
                    request = json.loads(boundary.call.body)
                except json.JSONDecodeError as error:
                    raise PiRuntimeError(
                        "pi产生了无效Provider JSON", code="pi_provider_json_invalid"
                    ) from error
                if not isinstance(request, dict):
                    raise PiRuntimeError("pi Provider请求必须是JSON对象", code="pi_provider_json_invalid")
                draft = self._store.begin_provider_request(
                    thread_id=self._thread_id,
                    run_id=self._run_id(),
                    provider_id=self._execution.provider.id,
                    provider_request=request,
                    origin_prompt=self._origin_prompt,
                    allowed_tool_names=self._config.allowed_tools,
                    execution_context={
                        "workflow_id": "governed-pi-agent",
                        "executor_id": "pi_agent.model_gate",
                        "tool_id": "pi_agent",
                        "tool_name": "pi coding agent",
                        "config_revision": self._config.revision,
                        "allowed_tool_names": list(self._config.allowed_tools),
                        "call_position": self._execution.model_call_count,
                    },
                )
                self._pending_model = boundary
                await self._sessions.mark_waiting_approval(
                    self._thread_id,
                    draft_id=draft.draft_id,
                    approval_id=draft.approval_id,
                )
                await ctx.request_info(draft.review_card(), dict, request_id=draft.approval_id)
                return
            if isinstance(boundary, PiToolCallBoundary):
                approval_id = f"pi_tool_approval_{uuid4().hex}"
                self._pending_tool = boundary
                await self._sessions.mark_waiting_approval(
                    self._thread_id,
                    approval_id=approval_id,
                )
                await ctx.request_info(
                    _tool_review_card(boundary, approval_id=approval_id, config=self._config),
                    dict,
                    request_id=approval_id,
                )
                return
            if isinstance(boundary, PiCompletedBoundary):
                failure_code = boundary.metrics.get("failure_code")
                if failure_code:
                    await self._finish("failed", boundary.metrics, str(failure_code))
                    raise PiRuntimeError(boundary.text, code=str(failure_code))
                await self._finish("succeeded", boundary.metrics)
                await ctx.yield_output(boundary.text)
                return
            raise PiRuntimeError("pi返回了未知运行边界", code="pi_boundary_unknown")
        except Exception as error:
            await self._fail(getattr(error, "code", type(error).__name__))
            raise

    @response_handler(request=dict, response=dict, workflow_output=str)
    async def resolve(self, original_request: dict[str, Any], decision: dict[str, Any], ctx) -> None:
        if original_request.get("review_kind") == "tool_execution":
            await self._resolve_tool(decision, ctx)
            return
        await self._resolve_model(original_request, decision, ctx)

    async def _resolve_model(
        self,
        original_request: dict[str, Any],
        decision: dict[str, Any],
        ctx: WorkflowContext[Any, str],
    ) -> None:
        boundary = self._pending_model
        if boundary is None or self._execution is None:
            raise RuntimeError("pi模型审批已失去对应运行边界")
        action = decision.get("decision")
        if action == "revise":
            revised = self._store.successor(
                str(original_request["draft_id"]),
                str(decision["revision_draft_id"]),
            )
            await self._sessions.mark_waiting_approval(
                self._thread_id,
                draft_id=revised.draft_id,
                approval_id=revised.approval_id,
            )
            await ctx.request_info(revised.review_card(), dict, request_id=revised.approval_id)
            return
        if action == "abandon":
            self._store.abandon(str(original_request["approval_id"]))
            boundary.call.approval_id = str(original_request["approval_id"])
            if not boundary.call.decision.done():
                boundary.call.decision.set_result(PiGatewayDecision(approved=False))
            await self._abandon(ctx)
            return
        if action != "approve":
            raise ValueError(f"不支持的pi模型审批决定: {action}")
        try:
            draft = self._store.claim(
                approval_id=str(original_request["approval_id"]),
                expected_hash=str(original_request["binding_hash"]),
                owner=f"api-pid-{os.getpid()}:pi-agent",
            )
        except ModelCallDraftConflict:
            await ctx.yield_output("该pi模型审批已失效，没有重复发送。")
            return
        boundary.call.approval_id = draft.approval_id
        boundary.call.decision.set_result(
            PiGatewayDecision(
                approved=True,
                body=draft.body,
                provider_id=draft.provider_id,
            )
        )
        self._pending_model = None
        await self._sessions.mark_running(self._thread_id)
        await self._drive(ctx)

    async def _resolve_tool(
        self,
        decision: dict[str, Any],
        ctx: WorkflowContext[Any, str],
    ) -> None:
        boundary = self._pending_tool
        if boundary is None or self._execution is None:
            raise RuntimeError("pi Tool审批已失去对应运行边界")
        action = decision.get("decision")
        if action == "abandon":
            await self._execution.reject_tool_call(boundary)
            await self._abandon(ctx)
            return
        if action != "approve":
            raise ValueError(f"不支持的pi Tool审批决定: {action}")
        arguments = decision.get("arguments")
        if not isinstance(arguments, Mapping):
            raise ValueError("pi Tool审批必须提供arguments对象")
        await self._execution.approve_tool_call(boundary, arguments)
        self._pending_tool = None
        await self._sessions.mark_running(self._thread_id)
        await self._drive(ctx)

    async def _abandon(self, ctx: WorkflowContext[Any, str]) -> None:
        execution = self._execution
        metrics = execution.metrics() if execution is not None else {}
        await self._finish("abandoned", metrics, "user_abandoned")
        await self._sessions.abandon_active_run(self._thread_id)
        await ctx.yield_output("本次pi Agent已放弃，没有继续模型或Tool调用。")

    async def _finish(
        self,
        status: str,
        metrics: dict[str, Any],
        failure_code: str | None = None,
    ) -> None:
        if self._execution_id is not None:
            await self._tools.finish_execution(
                self._execution_id,
                status=status,
                metrics=metrics,
                failure_code=failure_code,
            )
            self._execution_id = None
        if self._execution is not None:
            await self._execution.close()
            self._execution = None

    async def _fail(self, failure_code: str) -> None:
        execution = self._execution
        metrics = execution.metrics() if execution is not None else {}
        await self._finish("failed", metrics, failure_code)


def create_governed_pi_agent_workflow(
    *,
    thread_id: str,
    run_id: Callable[[], str],
    config: PiToolConfigSnapshot,
    manager: PiRuntimeManager,
    store: InMemoryModelCallReviewStore,
    sessions: ProductSessionService,
    tools: ToolConfigurationService,
):
    pi_executor = GovernedPiToolExecutor(
        thread_id=thread_id,
        run_id=run_id,
        config=config,
        manager=manager,
        store=store,
        sessions=sessions,
        tools=tools,
    )
    return WorkflowBuilder(
        name="governed-pi-agent",
        start_executor=pi_executor,
        output_from=[pi_executor],
    ).build()
