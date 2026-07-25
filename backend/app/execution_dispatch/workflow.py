"""MAF Executors for immutable routing, pi dispatch and result assembly."""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import asdict, replace
from typing import Any

from agent_framework import Executor, WorkflowContext, handler, response_handler
from agent_framework._workflows._request_info_mixin import RequestInfoMixin

from ..model_call_review import (
    InMemoryModelCallReviewStore,
    ModelCallDraft,
    ModelCallDraftConflict,
)
from ..pi_runtime import (
    PiCompletedBoundary,
    PiGatewayCall,
    PiGatewayDecision,
    PiModelCallBoundary,
    PiRuntimeError,
    PiToolCallBoundary,
)
from ..product_sessions.service import ProductSessionService
from ..workflows.continuous_chat_contracts import CollaborationState, state_from_snapshot
from .service import (
    ExecutionDispatchError,
    ExecutionDispatchService,
    PiModelCallGovernance,
    PreparedPiExecution,
    PreparedWorkspaceExecution,
    ToolAuthorization,
)

WORKFLOW_ID = "continuous-collaboration"
WORKFLOW_VERSION = "1.7.0"
_PI_CHECKPOINT_VERSION = 1

logger = logging.getLogger(__name__)


async def _record_trace(
    *,
    sessions: ProductSessionService,
    thread_id: str,
    run_id: str,
    executor_id: str,
    content_type: str,
    public_input: Mapping[str, Any],
    public_output: Mapping[str, Any],
) -> None:
    await sessions.record_trace(
        thread_id,
        run_id,
        "workflow.node.content",
        {
            "workflow_id": WORKFLOW_ID,
            "executor_id": executor_id,
            "actor": "execution_dispatch",
            "content_type": content_type,
            "public_input": dict(public_input),
            "public_output": dict(public_output),
            "step_input_projection": None,
        },
    )


class ExecutionRouteExecutor(Executor):
    """Project the immutable RunSpec into one explicit branch."""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        dispatch: ExecutionDispatchService,
    ) -> None:
        super().__init__(id="execution_route")
        self._thread_id = thread_id
        self._run_id = run_id
        self._sessions = sessions
        self._dispatch = dispatch

    @handler(input=CollaborationState)
    async def route(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        if not state.run_spec_id:
            raise ExecutionDispatchError(
                "执行路由缺少RunSpec",
                code="RUN_SPEC_REQUIRED",
            )
        route = await self._dispatch.route(state.run_spec_id)
        route_view = route.public_view()
        route_decision = {
            "decision_kind": "run_spec_runtime_route",
            "selection_mode": "first_match",
            "selected_branch": route.kind,
            "selected_target": (
                "execution_workspace_prepare"
                if route.kind == "pi_workspace"
                else ("pi_readonly_dispatch" if route.kind == "pi_readonly" else "response_agent")
            ),
            "selection_reason": (
                "已批准RunSpec明确绑定pi隔离工作区和精确编辑能力。"
                if route.kind == "pi_workspace"
                else (
                    "已批准RunSpec明确绑定pi只读Runtime和Repository Snapshot。"
                    if route.kind == "pi_readonly"
                    else "已批准RunSpec选择MAF回答分支，不启动外部执行Runtime。"
                )
            ),
            "facts": {
                "run_spec_id": route.run_spec_id,
                "run_spec_hash": route.run_spec_hash,
                "route_kind": route.kind,
                "reason_code": route.reason_code,
            },
            "options": [
                {
                    "branch_id": "pi_workspace",
                    "label": "受治理pi隔离编辑",
                    "target": "execution_workspace_prepare",
                    "condition": "RunSpec.runtime_agent = pi / workspace_edit",
                    "actual": route.kind,
                    "matched": route.kind == "pi_workspace",
                    "selected": route.kind == "pi_workspace",
                    "reason": (
                        "RunSpec已选择pi隔离工作区Runtime。"
                        if route.kind == "pi_workspace"
                        else "RunSpec没有选择pi隔离工作区Runtime。"
                    ),
                },
                {
                    "branch_id": "pi_readonly",
                    "label": "受治理pi只读执行",
                    "target": "pi_readonly_dispatch",
                    "condition": "RunSpec.runtime_agent = pi / readonly",
                    "actual": route.kind,
                    "matched": route.kind == "pi_readonly",
                    "selected": route.kind == "pi_readonly",
                    "reason": (
                        "RunSpec已选择pi只读Runtime。"
                        if route.kind == "pi_readonly"
                        else "RunSpec没有选择pi只读Runtime。"
                    ),
                },
                {
                    "branch_id": "answer_only",
                    "label": "Chat回答Agent",
                    "target": "response_agent",
                    "condition": "Default（RunSpec.runtime_agent = maf-workflow / answer_only）",
                    "actual": route.kind,
                    "matched": route.kind == "answer_only",
                    "selected": route.kind == "answer_only",
                    "reason": (
                        "RunSpec已选择MAF回答分支。"
                        if route.kind == "answer_only"
                        else "RunSpec已绑定更具体的pi执行分支。"
                    ),
                },
            ],
        }
        next_state = replace(state, execution_route=route_view)
        await _record_trace(
            sessions=self._sessions,
            thread_id=self._thread_id,
            run_id=self._run_id(),
            executor_id=self.id,
            content_type="execution_route",
            public_input={"run_spec_id": state.run_spec_id},
            public_output={
                **route_view,
                "branch": route.kind,
                "route_decision": route_decision,
            },
        )
        await ctx.send_message(next_state)


class ExecutionWorkspacePrepareExecutor(Executor):
    """Create the exact managed worktree as a real, inspectable MAF node."""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        dispatch: ExecutionDispatchService,
    ) -> None:
        super().__init__(id="execution_workspace_prepare")
        self._thread_id = thread_id
        self._run_id = run_id
        self._sessions = sessions
        self._dispatch = dispatch

    @handler(input=CollaborationState)
    async def prepare(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        if not state.run_spec_id:
            raise ExecutionDispatchError(
                "Execution Workspace准备缺少RunSpec",
                code="RUN_SPEC_REQUIRED",
            )
        protocol = dict(state.protocol_selection or {})
        try:
            prepared = await self._dispatch.prepare_workspace(
                session_id=self._thread_id,
                run_id=self._run_id(),
                run_spec_id=state.run_spec_id,
                origin_prompt=state.origin_prompt,
                context_package_id=(state.detail_context_package_id or state.directory_context_package_id),
                protocol_definition_id=str(protocol.get("definition_id") or "") or None,
                protocol_binding_id=str(protocol.get("binding_id") or "") or None,
            )
        except Exception as error:
            await self._sessions.fail_active_run(
                self._thread_id,
                error_code=getattr(error, "code", type(error).__name__),
                message=str(error),
            )
            raise
        view = prepared.public_view()
        await _record_trace(
            sessions=self._sessions,
            thread_id=self._thread_id,
            run_id=self._run_id(),
            executor_id=self.id,
            content_type="execution_workspace",
            public_input={
                "run_spec_id": state.run_spec_id,
                "repository_snapshot_id": (
                    prepared.route.repository_fence.snapshot_id if prepared.route.repository_fence else None
                ),
            },
            public_output={
                "workspace_id": prepared.workspace_id,
                "tool_execution_id": prepared.execution_id,
                "status": "ready",
                "base_revision": (
                    prepared.route.repository_fence.head_oid if prepared.route.repository_fence else None
                ),
            },
        )
        await ctx.send_message(replace(state, execution_workspace=view))


class PiReadonlyDispatchExecutor(Executor, RequestInfoMixin):
    """Drive one pi subprocess while MAF owns every interrupt and continuation.

    The process-local boundary references below form one fail-closed state
    machine: a model/tool response may resume only the exact pending pi
    boundary.  Keeping its handlers together is deliberate even though the
    class crosses the normal size-review threshold; persistence, policy and
    filesystem work remain delegated to application services.
    """

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        dispatch: ExecutionDispatchService,
        store: InMemoryModelCallReviewStore,
        node_id: str = "pi_readonly_dispatch",
        mode: str = "readonly",
    ) -> None:
        super().__init__(id=node_id)
        self._thread_id = thread_id
        self._run_id = run_id
        self._sessions = sessions
        self._dispatch = dispatch
        self._store = store
        self._mode = mode
        self._execution_id: str | None = None
        self._prepared: PreparedPiExecution | None = None
        self._state: CollaborationState | None = None
        self._pending_model: PiModelCallBoundary | None = None
        self._pending_model_governance: PiModelCallGovernance | None = None
        self._active_model_attempt: tuple[PiGatewayCall, str] | None = None
        self._pending_tool: PiToolCallBoundary | None = None
        self._pending_tool_authorization: ToolAuthorization | None = None

    @handler(input=CollaborationState)
    async def start(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, dict[str, Any]],
    ) -> None:
        if not state.run_spec_id:
            raise ExecutionDispatchError(
                "pi执行缺少RunSpec",
                code="RUN_SPEC_REQUIRED",
            )
        protocol = dict(state.protocol_selection or {})
        self._state = state
        try:
            if self._mode == "workspace_edit":
                payload = state.execution_workspace
                if not isinstance(payload, Mapping):
                    raise ExecutionDispatchError(
                        "pi隔离执行缺少Execution Workspace节点输出",
                        code="PI_WORKSPACE_PREPARATION_MISSING",
                    )
                route = await self._dispatch.route(state.run_spec_id)
                self._prepared = await self._dispatch.start_workspace_pi(
                    PreparedWorkspaceExecution(
                        execution_id=str(payload.get("execution_id") or ""),
                        workspace_id=str(payload.get("workspace_id") or ""),
                        route=route,
                        step_input=dict(payload.get("step_input") or {}),
                        task=str(payload.get("task") or ""),
                    )
                )
            else:
                self._prepared = await self._dispatch.prepare_pi(
                    session_id=self._thread_id,
                    run_id=self._run_id(),
                    run_spec_id=state.run_spec_id,
                    origin_prompt=state.origin_prompt,
                    context_package_id=(
                        state.detail_context_package_id or state.directory_context_package_id
                    ),
                    protocol_definition_id=str(protocol.get("definition_id") or "") or None,
                    protocol_binding_id=str(protocol.get("binding_id") or "") or None,
                )
            self._execution_id = self._prepared.execution_id
            await self._emit(
                ctx,
                stage="process_started",
                status="running",
                summary=("pi隔离工作区进程已启动" if self._mode == "workspace_edit" else "pi只读进程已启动"),
                details={
                    "execution_id": self._prepared.execution_id,
                    "repository_snapshot_id": (
                        self._prepared.route.repository_fence.snapshot_id
                        if self._prepared.route.repository_fence
                        else None
                    ),
                    "workspace_id": self._prepared.workspace_id,
                },
            )
            await self._drive(ctx)
        except Exception as error:
            await self._terminate_failure(error)
            raise

    async def _drive(
        self,
        ctx: WorkflowContext[CollaborationState, dict[str, Any]],
    ) -> None:
        prepared = self._require_prepared()
        while True:
            boundary = await prepared.execution.next_boundary()
            await self._finish_active_model_attempt()
            if isinstance(boundary, PiModelCallBoundary):
                await self._request_model_approval(boundary, ctx)
                return
            if isinstance(boundary, PiToolCallBoundary):
                authorization = await self._authorize_tool(boundary)
                await self._emit(
                    ctx,
                    stage="tool_requested",
                    status=authorization.mode,
                    summary=f"pi请求{boundary.tool_name}",
                    details={
                        "tool_call_id": boundary.tool_call_id,
                        "tool_name": boundary.tool_name,
                        "arguments": boundary.arguments,
                        "authorization_mode": authorization.mode,
                    },
                )
                if authorization.mode == "auto_continue":
                    await prepared.execution.approve_tool_call(
                        boundary,
                        boundary.arguments,
                    )
                    continue
                self._pending_tool = boundary
                self._pending_tool_authorization = authorization
                await self._dispatch.mark_waiting(prepared.execution_id)
                await self._sessions.mark_waiting_approval(
                    self._thread_id,
                    approval_id=authorization.request.id if authorization.request else None,
                )
                fence = prepared.route.repository_fence
                await ctx.request_info(
                    authorization.review_card(
                        tool_name=boundary.tool_name,
                        arguments=boundary.arguments,
                        fence_label=(
                            f"{fence.root_key}/{fence.relative_path}" if fence else "Repository Snapshot"
                        ),
                        config_revision=prepared.execution.config.revision,
                    ),
                    dict,
                    request_id=authorization.request.id if authorization.request else None,
                )
                return
            if isinstance(boundary, PiCompletedBoundary):
                if boundary.status != "succeeded":
                    await self._dispatch.finish_failed(
                        prepared.execution_id,
                        failure_code=boundary.terminal_reason_code,
                        metrics=boundary.metrics,
                    )
                    raise PiRuntimeError(
                        boundary.text,
                        code=boundary.terminal_reason_code,
                    )
                await self._emit(
                    ctx,
                    stage="process_completed",
                    status="succeeded",
                    summary=(
                        "pi隔离工作区执行完成" if prepared.mode == "workspace_edit" else "pi只读执行完成"
                    ),
                    details={
                        "model_call_count": boundary.metrics.get("model_call_count"),
                        "tool_call_count": boundary.metrics.get("internal_tool_call_count"),
                        "terminal_reason_code": boundary.terminal_reason_code,
                    },
                )
                result = await self._dispatch.finish_success(
                    prepared.execution_id,
                    text=boundary.text,
                    metrics=boundary.metrics,
                    terminal_reason_code=boundary.terminal_reason_code,
                )
                await prepared.execution.close()
                state = self._require_state()
                await ctx.send_message(
                    replace(
                        state,
                        pi_result=result.public_view(),
                    )
                )
                return
            raise PiRuntimeError(
                "pi返回了未知运行边界",
                code="pi_boundary_unknown",
            )

    async def on_checkpoint_save(self) -> dict[str, Any]:
        """Persist reattachment references, never live process/Future objects."""

        if self._prepared is None or self._state is None:
            return {}
        pending: dict[str, Any] | None = None
        if self._pending_model is not None and self._pending_model_governance is not None:
            pending = {
                "kind": "model_call",
                "call_id": self._pending_model.call.id,
                "governance": self._pending_model_governance.checkpoint_view(),
            }
        elif self._pending_tool is not None and self._pending_tool_authorization is not None:
            request = self._pending_tool_authorization.request
            if request is None:
                raise ExecutionDispatchError(
                    "待人工确认的pi Tool没有持久请求",
                    code="PI_TOOL_REQUEST_MISSING",
                )
            pending = {
                "kind": "tool_call",
                "tool_call_id": self._pending_tool.tool_call_id,
                "authorization": {
                    "tool_call_request_id": (self._pending_tool_authorization.tool_call_request_id),
                    "decision_item_key": self._pending_tool_authorization.decision_item_key,
                    "request_id": request.id,
                    "request_hash": request.request_hash,
                    "request_row_version": request.row_version,
                    "operation_id": (
                        self._pending_tool_authorization.operation.operation_id
                        if self._pending_tool_authorization.operation
                        else None
                    ),
                },
            }
        if pending is None:
            # Once the pi node has crossed its last interrupt there is no live
            # boundary to reattach. Later Workflow checkpoints must not try to
            # resurrect the already-closed subprocess.
            return {}
        return {
            "schema_version": _PI_CHECKPOINT_VERSION,
            "execution_id": self._prepared.execution_id,
            "mode": self._prepared.mode,
            "step_input": self._prepared.step_input,
            "workflow_state": asdict(self._state),
            "pending": pending,
        }

    async def on_checkpoint_restore(self, state: dict[str, Any]) -> None:
        """Reattach a rebuilt Executor to the exact process-local boundary."""

        if not state:
            return
        try:
            if state.get("schema_version") != _PI_CHECKPOINT_VERSION:
                raise ExecutionDispatchError(
                    "pi Executor Checkpoint版本不受支持",
                    code="PI_CHECKPOINT_VERSION_UNSUPPORTED",
                )
            execution_id = str(state.get("execution_id") or "")
            self._execution_id = execution_id or None
            workflow_state = state.get("workflow_state")
            if not execution_id or not isinstance(workflow_state, Mapping):
                raise ExecutionDispatchError(
                    "pi Executor Checkpoint缺少重连引用",
                    code="PI_CHECKPOINT_INVALID",
                )
            restored_state = state_from_snapshot(workflow_state)
            self._prepared = await self._dispatch.reattach_live_pi(
                execution_id=execution_id,
                run_id=self._run_id(),
                expected_mode=str(state.get("mode") or self._mode),
                step_input=(state["step_input"] if isinstance(state.get("step_input"), Mapping) else {}),
            )
            self._state = restored_state
            pending = state.get("pending")
            if not isinstance(pending, Mapping):
                return
            kind = pending.get("kind")
            if kind == "model_call":
                call = self._prepared.execution.pending_provider_call(str(pending.get("call_id") or ""))
                governance = pending.get("governance")
                if not isinstance(governance, Mapping):
                    raise ExecutionDispatchError(
                        "pi模型Checkpoint缺少治理引用",
                        code="PI_MODEL_GOVERNANCE_MISSING",
                    )
                self._pending_model = PiModelCallBoundary(kind="model_call", call=call)
                self._pending_model_governance = PiModelCallGovernance.from_checkpoint(governance)
            elif kind == "tool_call":
                tool_call_id = str(pending.get("tool_call_id") or "")
                self._pending_tool = self._prepared.execution.pending_tool_boundary(tool_call_id)
                authorization = pending.get("authorization")
                if not isinstance(authorization, Mapping):
                    raise ExecutionDispatchError(
                        "pi Tool Checkpoint缺少授权引用",
                        code="PI_TOOL_REQUEST_MISSING",
                    )
                self._pending_tool_authorization = await self._dispatch.restore_tool_authorization(
                    authorization
                )
            else:
                raise ExecutionDispatchError(
                    "pi Executor Checkpoint包含未知待决边界",
                    code="PI_CHECKPOINT_INVALID",
                )
            logger.info(
                "pi_executor_checkpoint_restored execution_id=%s pending_kind=%s",
                execution_id,
                kind,
            )
        except Exception as error:
            logger.warning(
                "pi_executor_checkpoint_restore_failed execution_id=%s error_code=%s error_type=%s",
                self._execution_id,
                getattr(error, "code", "checkpoint_restore_failed"),
                type(error).__name__,
            )
            raise

    async def _request_model_approval(
        self,
        boundary: PiModelCallBoundary,
        ctx: WorkflowContext[CollaborationState, dict[str, Any]],
        *,
        draft: ModelCallDraft | None = None,
    ) -> None:
        prepared = self._require_prepared()
        if draft is None:
            try:
                request = json.loads(boundary.call.body)
            except json.JSONDecodeError as error:
                raise PiRuntimeError(
                    "pi产生了无效Provider JSON",
                    code="pi_provider_json_invalid",
                ) from error
            if not isinstance(request, dict):
                raise PiRuntimeError(
                    "pi Provider请求必须是JSON对象",
                    code="pi_provider_json_invalid",
                )
            draft = self._store.begin_provider_request(
                thread_id=self._thread_id,
                run_id=self._run_id(),
                provider_id=prepared.execution.provider.id,
                provider_request=request,
                origin_prompt=self._require_state().origin_prompt,
                allowed_tool_names=prepared.execution.config.allowed_tools,
                execution_context={
                    "workflow_id": WORKFLOW_ID,
                    "workflow_version": WORKFLOW_VERSION,
                    "executor_id": self.id,
                    "tool_id": "pi_agent",
                    "tool_name": (
                        "pi coding agent（隔离工作区）"
                        if prepared.mode == "workspace_edit"
                        else "pi coding agent（只读）"
                    ),
                    "config_revision": prepared.execution.config.revision,
                    "allowed_tool_names": list(prepared.execution.config.allowed_tools),
                    "call_position": prepared.execution.model_call_count,
                    "tool_execution_id": prepared.execution_id,
                    "run_spec_id": self._require_state().run_spec_id,
                    "step_input_projection_id": prepared.step_input["id"],
                    "workspace_id": prepared.workspace_id,
                },
            )
        card = draft.review_card()
        governance = await self._dispatch.register_pi_model_call(card)
        execution_context = card.setdefault("execution_context", {})
        if isinstance(execution_context, dict):
            execution_context["governance"] = governance.public_view()
        self._pending_model = boundary
        self._pending_model_governance = governance
        if governance.final_action == "deny":
            await self._dispatch.decide_pi_model_call(
                governance=governance,
                decision="deny",
                execution_id=prepared.execution_id,
            )
            boundary.call.approval_id = draft.approval_id
            boundary.call.decision.set_result(PiGatewayDecision(approved=False))
            raise ExecutionDispatchError(
                "HITL策略拒绝本次pi模型调用",
                code="PI_MODEL_DENIED",
            )
        if governance.final_action == "auto_continue":
            await self._approve_model_boundary(
                boundary=boundary,
                draft=draft,
                governance=governance,
            )
            await self._drive(ctx)
            return
        if governance.request_id is None:
            raise ExecutionDispatchError(
                "pi模型调用要求人工确认但没有持久请求",
                code="PI_MODEL_REQUEST_MISSING",
            )
        await self._dispatch.mark_waiting(prepared.execution_id)
        await self._sessions.mark_waiting_approval(
            self._thread_id,
            draft_id=draft.draft_id,
            approval_id=draft.approval_id,
        )
        await self._emit(
            ctx,
            stage="model_call_waiting",
            status="waiting_human",
            summary="pi模型请求等待逐次审批",
            details={
                "approval_id": draft.approval_id,
                "call_position": prepared.execution.model_call_count,
            },
        )
        await ctx.request_info(
            card,
            dict,
            request_id=draft.approval_id,
        )

    async def _authorize_tool(
        self,
        boundary: PiToolCallBoundary,
    ) -> ToolAuthorization:
        prepared = self._require_prepared()
        state = self._require_state()
        fence = prepared.route.repository_fence
        if state.run_spec_id is None or fence is None:
            raise ExecutionDispatchError(
                "pi只读Tool缺少RunSpec或RepositoryFence",
                code="PI_READONLY_CONTEXT_MISSING",
            )
        return await self._dispatch.authorize_tool(
            run_id=self._run_id(),
            run_spec_id=state.run_spec_id,
            execution_id=prepared.execution_id,
            tool_call_id=boundary.tool_call_id,
            tool_name=boundary.tool_name,
            arguments=boundary.arguments,
            fence=fence,
            workspace_id=prepared.workspace_id,
        )

    @response_handler(request=dict, response=dict, workflow_output=dict)
    async def resolve(
        self,
        original_request: dict[str, Any],
        decision: dict[str, Any],
        ctx,
    ) -> None:
        try:
            if original_request.get("review_kind") == "tool_execution":
                await self._resolve_tool(decision, ctx)
                return
            await self._resolve_model(original_request, decision, ctx)
        except Exception as error:
            await self._terminate_failure(error)
            raise

    async def _resolve_model(
        self,
        original_request: dict[str, Any],
        decision: dict[str, Any],
        ctx: WorkflowContext[CollaborationState, dict[str, Any]],
    ) -> None:
        boundary = self._pending_model
        governance = self._pending_model_governance
        prepared = self._require_prepared()
        if boundary is None or governance is None:
            raise ExecutionDispatchError(
                "pi模型审批已失去运行边界",
                code="PI_MODEL_BOUNDARY_MISSING",
            )
        action = decision.get("decision")
        if action == "revise":
            await self._dispatch.decide_pi_model_call(
                governance=governance,
                decision="revise",
                execution_id=prepared.execution_id,
            )
            revised = self._store.successor(
                str(original_request["draft_id"]),
                str(decision["revision_draft_id"]),
            )
            await self._request_model_approval(
                boundary,
                ctx,
                draft=revised,
            )
            return
        if action == "abandon":
            await self._dispatch.decide_pi_model_call(
                governance=governance,
                decision="abandon",
                execution_id=prepared.execution_id,
            )
            self._store.abandon(str(original_request["approval_id"]))
            boundary.call.approval_id = str(original_request["approval_id"])
            if not boundary.call.decision.done():
                boundary.call.decision.set_result(PiGatewayDecision(approved=False))
            await self._abandon(ctx)
            return
        if action != "approve":
            raise ExecutionDispatchError(
                "不支持的pi模型审批决定",
                code="PI_MODEL_DECISION_INVALID",
            )
        try:
            claimed = self._store.claim(
                approval_id=str(original_request["approval_id"]),
                expected_hash=str(original_request["binding_hash"]),
                owner=f"api-pid-{os.getpid()}:{self.id}",
            )
        except ModelCallDraftConflict:
            await self._emit(
                ctx,
                stage="model_call_stale",
                status="ignored",
                summary="该pi模型审批已失效，没有重复发送",
                details={},
            )
            return
        attempt_id = await self._dispatch.decide_pi_model_call(
            governance=governance,
            decision="approve",
            execution_id=prepared.execution_id,
        )
        if attempt_id is None:
            raise ExecutionDispatchError(
                "pi模型调用批准没有创建Attempt",
                code="PI_MODEL_ATTEMPT_MISSING",
            )
        boundary.call.approval_id = claimed.approval_id
        boundary.call.decision.set_result(
            PiGatewayDecision(
                approved=True,
                body=claimed.body,
                provider_id=claimed.provider_id,
            )
        )
        self._active_model_attempt = (boundary.call, attempt_id)
        self._pending_model = None
        self._pending_model_governance = None
        await self._dispatch.mark_running(prepared.execution_id)
        await self._sessions.mark_running(self._thread_id)
        await self._drive(ctx)

    async def _approve_model_boundary(
        self,
        *,
        boundary: PiModelCallBoundary,
        draft: ModelCallDraft,
        governance: PiModelCallGovernance,
    ) -> None:
        prepared = self._require_prepared()
        claimed = self._store.claim(
            approval_id=draft.approval_id,
            expected_hash=draft.binding_hash,
            owner=f"api-pid-{os.getpid()}:{self.id}",
        )
        attempt_id = await self._dispatch.decide_pi_model_call(
            governance=governance,
            decision="approve",
            execution_id=prepared.execution_id,
        )
        if attempt_id is None:
            raise ExecutionDispatchError(
                "pi模型调用自动批准没有创建Attempt",
                code="PI_MODEL_ATTEMPT_MISSING",
            )
        boundary.call.approval_id = claimed.approval_id
        boundary.call.decision.set_result(
            PiGatewayDecision(
                approved=True,
                body=claimed.body,
                provider_id=claimed.provider_id,
            )
        )
        self._active_model_attempt = (boundary.call, attempt_id)
        self._pending_model = None
        self._pending_model_governance = None

    async def _finish_active_model_attempt(self) -> None:
        active = self._active_model_attempt
        if active is None:
            return
        call, attempt_id = active
        status = call.outcome_status or "outcome_unknown"
        failure_code = call.error_code
        if call.outcome_status is None:
            failure_code = "pi_provider_outcome_missing"
        await self._dispatch.finish_pi_model_call_attempt(
            attempt_id=attempt_id,
            status=status,
            failure_code=failure_code,
        )
        self._active_model_attempt = None

    async def _resolve_tool(
        self,
        decision: dict[str, Any],
        ctx: WorkflowContext[CollaborationState, dict[str, Any]],
    ) -> None:
        boundary = self._pending_tool
        authorization = self._pending_tool_authorization
        prepared = self._require_prepared()
        if boundary is None or authorization is None:
            raise ExecutionDispatchError(
                "pi Tool审批已失去运行边界",
                code="PI_TOOL_BOUNDARY_MISSING",
            )
        action = str(decision.get("decision") or "")
        result = await self._dispatch.resolve_human_tool(
            authorization=authorization,
            decision=action,
            execution_id=prepared.execution_id,
        )
        self._pending_tool = None
        self._pending_tool_authorization = None
        await self._dispatch.mark_running(prepared.execution_id)
        await self._sessions.mark_running(self._thread_id)
        if result == "denied":
            await prepared.execution.reject_tool_call(boundary)
        else:
            arguments = decision.get("arguments", boundary.arguments)
            if not isinstance(arguments, Mapping):
                raise ExecutionDispatchError(
                    "pi Tool批准参数必须是对象",
                    code="PI_TOOL_ARGUMENTS_INVALID",
                )
            if dict(arguments) != boundary.arguments:
                raise ExecutionDispatchError(
                    "当前版本不允许在批准时静默替换Tool参数；请拒绝后让pi重新请求",
                    code="PI_TOOL_ARGUMENT_REVISION_REQUIRED",
                )
            await prepared.execution.approve_tool_call(boundary, arguments)
        await self._drive(ctx)

    async def _emit(
        self,
        ctx: WorkflowContext[CollaborationState, dict[str, Any]],
        *,
        stage: str,
        status: str,
        summary: str,
        details: Mapping[str, Any],
    ) -> None:
        prepared = self._prepared
        sequence = (
            await self._dispatch.record_activity(
                prepared.execution_id,
                activity={
                    "stage": stage,
                    "status": status,
                    "summary": summary,
                    "details": dict(details),
                },
            )
            if prepared is not None
            else 0
        )
        await ctx.yield_output(
            {
                "kind": "pi_activity",
                "execution_id": prepared.execution_id if prepared else None,
                "sequence": sequence,
                "stage": stage,
                "status": status,
                "summary": summary,
                "details": dict(details),
            }
        )

    async def _abandon(
        self,
        ctx: WorkflowContext[CollaborationState, dict[str, Any]],
    ) -> None:
        prepared = self._require_prepared()
        await self._emit(
            ctx,
            stage="abandoned",
            status="abandoned",
            summary=(
                "用户放弃本次pi隔离工作区执行"
                if prepared.mode == "workspace_edit"
                else "用户放弃本次pi只读执行"
            ),
            details={},
        )
        await self._dispatch.finish_abandoned(
            prepared.execution_id,
            metrics=prepared.execution.metrics(),
        )
        await prepared.execution.close()
        await self._sessions.abandon_active_run(self._thread_id)

    async def _fail(self, failure_code: str) -> None:
        await self._finish_active_model_attempt()
        prepared = self._prepared
        if prepared is None:
            if self._execution_id is not None:
                await self._dispatch.finish_failed(
                    self._execution_id,
                    failure_code=failure_code,
                    metrics={},
                )
            return
        await self._dispatch.finish_failed(
            prepared.execution_id,
            failure_code=failure_code,
            metrics=prepared.execution.metrics(),
        )
        await prepared.execution.close()

    async def _terminate_failure(self, error: Exception) -> None:
        """Persist one stable failure across every MAF Executor entry point."""

        failure_code = getattr(error, "code", type(error).__name__)
        await self._fail(failure_code)
        # MAF may project an Executor exception as a generic RunError. Close the
        # Product Run first so its domain failure survives protocol projection,
        # including failures before ToolExecution creation and after resume.
        await self._sessions.fail_active_run(
            self._thread_id,
            error_code=failure_code,
            message=str(error),
        )

    def _require_prepared(self) -> PreparedPiExecution:
        if self._prepared is None:
            raise ExecutionDispatchError(
                "pi执行尚未准备",
                code="PI_EXECUTION_NOT_PREPARED",
            )
        return self._prepared

    def _require_state(self) -> CollaborationState:
        if self._state is None:
            raise ExecutionDispatchError(
                "pi执行缺少Workflow状态",
                code="PI_WORKFLOW_STATE_MISSING",
            )
        return self._state


class PiReadonlyResultAssemblyExecutor(Executor):
    """Assemble the committed pi result without another model call."""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        dispatch: ExecutionDispatchService,
        node_id: str = "pi_readonly_result_assembly",
    ) -> None:
        super().__init__(id=node_id)
        self._thread_id = thread_id
        self._run_id = run_id
        self._sessions = sessions
        self._dispatch = dispatch

    @handler(input=CollaborationState)
    async def assemble(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        result = dict(state.pi_result or {})
        execution_id = str(result.get("execution_id") or "")
        if not execution_id or result.get("status") != "succeeded":
            raise ExecutionDispatchError(
                "pi结果不存在或不是成功终态",
                code="PI_RESULT_NOT_COMMITTED",
            )
        ledger = await self._dispatch.get(execution_id)
        if ledger["status"] != "succeeded" or ledger["result_hash"] != result.get("result_hash"):
            raise ExecutionDispatchError(
                "pi结果与ToolExecution Ledger不一致",
                code="PI_RESULT_BINDING_MISMATCH",
            )
        response = str(result.get("final_text") or "").strip()
        if not response:
            raise ExecutionDispatchError(
                "pi成功结果没有可显示文本",
                code="PI_RESULT_TEXT_EMPTY",
            )
        next_state = replace(state, response=response)
        await _record_trace(
            sessions=self._sessions,
            thread_id=self._thread_id,
            run_id=self._run_id(),
            executor_id=self.id,
            content_type=(
                "pi_workspace_result" if result.get("mode") == "workspace_edit" else "pi_readonly_result"
            ),
            public_input={
                "execution_id": execution_id,
                "result_hash": result["result_hash"],
            },
            public_output={
                "status": "assembled",
                "model_call_count": result.get("model_call_count"),
                "tool_call_count": result.get("tool_call_count"),
            },
        )
        await ctx.send_message(next_state)


class PiWorkspaceDispatchExecutor(PiReadonlyDispatchExecutor):
    """SD3 pi driver bound to a preceding managed-workspace node."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(
            **kwargs,
            node_id="pi_workspace_dispatch",
            mode="workspace_edit",
        )


class PiWorkspaceResultAssemblyExecutor(PiReadonlyResultAssemblyExecutor):
    """Deterministically assemble the retained workspace result."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs, node_id="pi_workspace_result_assembly")
