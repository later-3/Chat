"""持续协作节点24-31背后的pi只读/隔离编辑应用协调器。

本服务拥有Product事务和外部dispatch边界：从RunSpec编译路由，准备StepInput与
ToolExecution，创建/恢复Workspace，登记pi内部每次模型调用与Tool授权，记录活动、
成功/失败/取消。MAF Executor只编排，不直接查表、解析文件路径或发明权限。
"""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass, replace
from typing import Any, Mapping
from uuid import uuid4

from sqlalchemy import func, select

from ..execution_workspaces import ExecutionWorkspaceService, WorkspaceOwnership
from ..governance.models import (
    DecisionSubjectRecord,
    HumanDecisionRequestRecord,
    ModelCallDraftRevisionRecord,
    PolicyEvaluationRecord,
    RunSpecRecord,
)
from ..governance.service import ExecutionGovernanceService
from ..harness.contracts import content_hash
from ..observability.context import bind_context
from ..pi_gateway import PiRuntimeManager
from ..pi_runtime import PiExecution
from ..pi_sessions import pending_pi_session_view
from ..product_sessions.database import (
    ProductDatabase,
    RunAttemptRecord,
    RunRecord,
    ToolExecutionRecord,
    utc_now,
)
from ..project_resources.contracts import ProjectResourceConflict
from ..readonly_tools import ReadonlyToolService
from ..runtime_execution.models import RuntimeJobRecord
from ..step_inputs import StepInputProjectionService
from ..tool_configs import PI_TOOL_ID, PiToolConfigSnapshot, ToolConfigurationService
from ..tool_execution import PreparedToolOperation, ToolOperationService
from .contracts import ExecutionRoute, PiReadonlyResult, route_from_run_spec
from .repository_context import RepositoryExecutionContextService

logger = logging.getLogger(__name__)

PI_WORKFLOW_ID = "continuous-collaboration"
PI_WORKFLOW_VERSION = "1.8.0"
PI_NODE_ID = "pi_readonly_dispatch"
PI_TOOLS = ("read", "grep", "find", "ls")
PI_WORKSPACE_PREPARE_NODE_ID = "execution_workspace_prepare"
PI_WORKSPACE_NODE_ID = "pi_workspace_dispatch"
PI_WORKSPACE_TOOLS = (*PI_TOOLS, "edit")
_TERMINAL_EXECUTION_STATUSES = frozenset({"succeeded", "failed", "cancelled", "abandoned", "interrupted"})


class ExecutionDispatchError(RuntimeError):
    """Safe execution-dispatch failure carrying a stable code."""

    def __init__(self, message: str, *, code: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class PreparedPiExecution:
    execution_id: str
    execution: PiExecution
    route: ExecutionRoute
    step_input: dict[str, Any]
    task: str
    mode: str = "readonly"
    workspace_id: str | None = None


@dataclass(frozen=True, slots=True)
class PreparedWorkspaceExecution:
    """Serializable hand-off from the workspace node to the pi node."""

    execution_id: str
    workspace_id: str
    route: ExecutionRoute
    step_input: dict[str, Any]
    task: str

    def public_view(self) -> dict[str, Any]:
        return {
            "execution_id": self.execution_id,
            "workspace_id": self.workspace_id,
            "route": self.route.public_view(),
            "step_input": copy.deepcopy(self.step_input),
            "task": self.task,
        }


@dataclass(frozen=True, slots=True)
class ToolAuthorization:
    mode: str
    tool_call_request_id: str
    decision_item_key: str
    request: HumanDecisionRequestRecord | None
    consumption_id: str | None
    operation: PreparedToolOperation | None = None

    def review_card(
        self,
        *,
        tool_name: str,
        arguments: Mapping[str, Any],
        fence_label: str,
        config_revision: int,
    ) -> dict[str, Any]:
        request = self.request
        if request is None:
            raise ExecutionDispatchError(
                "自动Tool授权没有人工审核卡",
                code="TOOL_AUTHORIZATION_STATE_INVALID",
            )
        operation = self.operation.public_view() if self.operation is not None else None
        writable = operation is not None
        return {
            "review_kind": "tool_execution",
            "message": "请审核pi工作区精确编辑" if writable else "请审核pi只读Tool调用",
            "approval_id": request.id,
            "request_id": request.id,
            "request_hash": request.request_hash,
            "row_version": request.row_version,
            "item_key": self.decision_item_key,
            "tool_call_request_id": self.tool_call_request_id,
            "tool_id": PI_TOOL_ID,
            "tool_name": tool_name,
            "arguments": dict(arguments),
            "target": fence_label,
            "config_revision": config_revision,
            "risk": (
                "只写入隔离Execution Workspace；不修改活动仓库，不提交或推送Git。"
                if writable
                else "只读、无副作用；仍受Repository Snapshot或Workspace围栏约束"
            ),
            "tool_operation": operation,
            "allowed_actions": ["approve", "deny"],
            "execution_context": {
                "workflow_id": PI_WORKFLOW_ID,
                "executor_id": PI_WORKSPACE_NODE_ID if writable else PI_NODE_ID,
                "tool_id": PI_TOOL_ID,
                "wait_reason": "pi_internal_tool_approval",
            },
        }


@dataclass(frozen=True, slots=True)
class PiModelCallGovernance:
    """Durable governance references for one process-local pi model boundary."""

    revision_id: str
    subject_id: str
    evaluation_id: str
    final_action: str
    binding_hash: str
    request_id: str | None
    request_hash: str | None
    request_row_version: int | None

    def public_view(self) -> dict[str, Any]:
        return {
            "model_call_revision_id": self.revision_id,
            "policy_evaluation_id": self.evaluation_id,
            "final_action": self.final_action,
            "decision_request_id": self.request_id,
            "decision_request_hash": self.request_hash,
            "decision_request_row_version": self.request_row_version,
            "decision_item_key": self.subject_id if self.request_id else None,
        }

    def checkpoint_view(self) -> dict[str, Any]:
        """Return the durable references required to resume one decision."""

        return {
            "revision_id": self.revision_id,
            "subject_id": self.subject_id,
            "evaluation_id": self.evaluation_id,
            "final_action": self.final_action,
            "binding_hash": self.binding_hash,
            "request_id": self.request_id,
            "request_hash": self.request_hash,
            "request_row_version": self.request_row_version,
        }

    @classmethod
    def from_checkpoint(cls, value: Mapping[str, Any]) -> PiModelCallGovernance:
        return cls(
            revision_id=str(value.get("revision_id") or ""),
            subject_id=str(value.get("subject_id") or ""),
            evaluation_id=str(value.get("evaluation_id") or ""),
            final_action=str(value.get("final_action") or ""),
            binding_hash=str(value.get("binding_hash") or ""),
            request_id=str(value["request_id"]) if value.get("request_id") else None,
            request_hash=str(value["request_hash"]) if value.get("request_hash") else None,
            request_row_version=(
                int(value["request_row_version"]) if value.get("request_row_version") is not None else None
            ),
        )


class ExecutionDispatchService:
    """拥有受治理pi dispatch用例，但不拥有MAF图。

    路由准备、授权与ToolExecution转换必须在同一应用边界内，否则Executor可能绕过
    Repository围栏、Grant或账本启动进程。纯编译、仓库解析、只读Tool、Workspace和
    副作用账本仍是独立协作者。
    """

    def __init__(
        self,
        database: ProductDatabase,
        *,
        governance: ExecutionGovernanceService,
        repository_context: RepositoryExecutionContextService,
        step_inputs: StepInputProjectionService,
        tool_configurations: ToolConfigurationService,
        manager: PiRuntimeManager | None,
        readonly_tools: ReadonlyToolService,
        execution_workspaces: ExecutionWorkspaceService,
        tool_operations: ToolOperationService,
    ) -> None:
        self.database = database
        self._governance = governance
        self._repository_context = repository_context
        self._step_inputs = step_inputs
        self._tool_configurations = tool_configurations
        self._manager = manager
        self._readonly_tools = readonly_tools
        self._execution_workspaces = execution_workspaces
        self._tool_operations = tool_operations

    async def route(self, run_spec_id: str) -> ExecutionRoute:
        """节点24使用：只从已绑定RunSpec编译执行路由，不重新读取Prompt。"""
        async with self.database.sessions() as transaction:
            spec = await transaction.get(RunSpecRecord, run_spec_id)
            if spec is None or spec.status != "bound" or spec.bound_run_id is None:
                raise ExecutionDispatchError(
                    "RunSpec不存在或未绑定Product Run",
                    code="RUN_SPEC_NOT_BOUND",
                )
            payload = copy.deepcopy(dict(spec.spec_json or {}))
            return route_from_run_spec(
                run_spec_id=spec.id,
                run_spec_hash=spec.run_spec_hash,
                spec=payload,
            )

    async def prepare_pi(
        self,
        *,
        session_id: str,
        run_id: str,
        run_spec_id: str,
        origin_prompt: str,
        context_package_id: str | None,
        protocol_definition_id: str | None,
        protocol_binding_id: str | None,
    ) -> PreparedPiExecution:
        """节点30使用：校验pi只读路由与Repository围栏，创建账本并启动临时子进程。"""
        route = await self.route(run_spec_id)
        if route.kind != "pi_readonly" or route.repository_fence is None:
            raise ExecutionDispatchError(
                "RunSpec没有选择pi只读执行",
                code="PI_READONLY_ROUTE_REQUIRED",
            )
        fence = route.repository_fence
        try:
            await self._repository_context.assert_fresh(fence)
            private_path = await self._repository_context.resolve_private_path(fence)
        except ProjectResourceConflict as error:
            # Repository inspection owns a broader Harness error vocabulary.
            # The dispatch boundary narrows it to the stable failure consumed by
            # Product Run recovery, Trace and the Workbench.
            raise ExecutionDispatchError(
                str(error),
                code="repository_snapshot_stale",
            ) from error
        spec = await self._run_spec_payload(run_spec_id)
        task = self._compile_task(spec=spec, origin_prompt=origin_prompt, mode="readonly")
        config = self._readonly_config(
            self._tool_configurations.runtime_snapshot(),
            working_directory=str(private_path),
        )
        capability = [
            {"name": name, "mode": "readonly", "side_effects": "none"} for name in config.allowed_tools
        ]
        step_input = await self._step_inputs.record(
            run_id=run_id,
            workflow_definition_id=PI_WORKFLOW_ID,
            workflow_version=PI_WORKFLOW_VERSION,
            node_id=PI_NODE_ID,
            input_value={
                "task": task,
                "origin_prompt": origin_prompt,
                "run_spec_id": run_spec_id,
                "repository_fence": fence.public_view(),
                "route_reason_code": route.reason_code,
            },
            agent_profile_key="pi_readonly",
            context_package_id=context_package_id,
            protocol_definition_id=protocol_definition_id,
            protocol_binding_id=protocol_binding_id,
            run_spec_id=run_spec_id,
            capability_allowlist=capability,
            budget={
                "max_model_calls": config.max_model_calls,
                "timeout_seconds": config.timeout_seconds,
            },
            output_contract={
                "type": "pi_readonly_result",
                "hidden_reasoning": "excluded",
                "side_effects": "none",
            },
            stop_conditions=[
                "repository_fence_stale",
                "capability_expansion_requested",
                "provider_failure",
                "timeout",
            ],
        )
        execution_id = await self._create_execution(
            session_id=session_id,
            run_id=run_id,
            run_spec_id=run_spec_id,
            step_input_projection_id=str(step_input["id"]),
            fence=fence,
            config=config,
            input_hash=content_hash({"task": task, "fence": fence.public_view()}),
            capability_hash=content_hash(capability),
            mode="readonly",
        )
        if self._manager is None:
            await self.finish_failed(
                execution_id,
                failure_code="pi_runtime_unavailable",
                metrics={},
            )
            raise ExecutionDispatchError(
                "pi Runtime当前不可用",
                code="pi_runtime_unavailable",
            )
        try:
            execution = await self._manager.start(
                task,
                config,
                repository_fence=fence,
                readonly_tools=self._readonly_tools,
                tool_execution_id=execution_id,
                product_session_id=session_id,
                product_run_id=run_id,
            )
        except Exception as error:
            await self.finish_failed(
                execution_id,
                failure_code=getattr(error, "code", type(error).__name__),
                metrics=getattr(error, "metrics", {}),
            )
            raise
        await self._mark_dispatched(execution_id)
        with bind_context(
            session_id=session_id,
            product_run_id=run_id,
            workflow_id=PI_WORKFLOW_ID,
            workflow_node_id=PI_NODE_ID,
        ):
            logger.info(
                "pi_readonly_dispatched execution_id=%s snapshot_id=%s capability_hash=%s",
                execution_id,
                fence.snapshot_id,
                content_hash(capability)[:12],
            )
        return PreparedPiExecution(
            execution_id=execution_id,
            execution=execution,
            route=route,
            step_input=step_input,
            task=task,
        )

    async def prepare_workspace(
        self,
        *,
        session_id: str,
        run_id: str,
        run_spec_id: str,
        origin_prompt: str,
        context_package_id: str | None,
        protocol_definition_id: str | None,
        protocol_binding_id: str | None,
    ) -> PreparedWorkspaceExecution:
        """Create the durable ToolExecution and exact managed Git worktree."""

        route = await self.route(run_spec_id)
        if route.kind != "pi_workspace" or route.repository_fence is None:
            raise ExecutionDispatchError(
                "RunSpec没有选择pi隔离工作区执行",
                code="PI_WORKSPACE_ROUTE_REQUIRED",
            )
        fence = route.repository_fence
        try:
            await self._repository_context.assert_fresh(fence)
        except ProjectResourceConflict as error:
            raise ExecutionDispatchError(
                str(error),
                code="repository_snapshot_stale",
            ) from error
        spec = await self._run_spec_payload(run_spec_id)
        task = self._compile_task(
            spec=spec,
            origin_prompt=origin_prompt,
            mode="workspace_edit",
        )
        config = self._workspace_config(
            self._tool_configurations.runtime_snapshot(),
            working_directory="managed-at-runtime",
        )
        capability = [
            {
                "name": name,
                "mode": "workspace_write" if name == "edit" else "readonly",
                "side_effects": "managed_workspace_only" if name == "edit" else "none",
            }
            for name in config.allowed_tools
        ]
        step_input = await self._step_inputs.record(
            run_id=run_id,
            workflow_definition_id=PI_WORKFLOW_ID,
            workflow_version=PI_WORKFLOW_VERSION,
            node_id=PI_WORKSPACE_PREPARE_NODE_ID,
            input_value={
                "task": task,
                "origin_prompt": origin_prompt,
                "run_spec_id": run_spec_id,
                "repository_fence": fence.public_view(),
                "route_reason_code": route.reason_code,
            },
            agent_profile_key="pi_workspace",
            context_package_id=context_package_id,
            protocol_definition_id=protocol_definition_id,
            protocol_binding_id=protocol_binding_id,
            run_spec_id=run_spec_id,
            capability_allowlist=capability,
            budget={
                "max_model_calls": config.max_model_calls,
                "timeout_seconds": config.timeout_seconds,
            },
            output_contract={
                "type": "pi_workspace_result",
                "hidden_reasoning": "excluded",
                "side_effects": "managed_workspace_only",
                "integration": "not_authorized",
            },
            stop_conditions=[
                "repository_fence_stale",
                "workspace_create_failed",
                "capability_expansion_requested",
                "provider_failure",
                "tool_operation_outcome_unknown",
                "timeout",
            ],
        )
        execution_id = await self._create_execution(
            session_id=session_id,
            run_id=run_id,
            run_spec_id=run_spec_id,
            step_input_projection_id=str(step_input["id"]),
            fence=fence,
            config=config,
            input_hash=content_hash({"task": task, "fence": fence.public_view()}),
            capability_hash=content_hash(capability),
            mode="workspace_edit",
        )
        ownership = await self._workspace_ownership(execution_id)
        try:
            workspace = await self._execution_workspaces.create(
                ownership=ownership,
                fence=fence,
            )
        except Exception as error:
            await self.finish_failed(
                execution_id,
                failure_code=getattr(error, "code", type(error).__name__),
                metrics={},
            )
            raise
        logger.info(
            "pi_workspace_prepared execution_id=%s workspace_id=%s snapshot_id=%s",
            execution_id,
            workspace["id"],
            fence.snapshot_id,
        )
        return PreparedWorkspaceExecution(
            execution_id=execution_id,
            workspace_id=str(workspace["id"]),
            route=route,
            step_input=step_input,
            task=task,
        )

    async def start_workspace_pi(
        self,
        prepared: PreparedWorkspaceExecution,
        *,
        product_session_id: str,
        product_run_id: str,
    ) -> PreparedPiExecution:
        """Start pi only after the real workspace node has committed its output."""

        if self._manager is None:
            await self.finish_failed(
                prepared.execution_id,
                failure_code="pi_runtime_unavailable",
                metrics={},
            )
            raise ExecutionDispatchError(
                "pi Runtime当前不可用",
                code="pi_runtime_unavailable",
            )
        workspace = await self._execution_workspaces.get_for_tool_execution(prepared.execution_id)
        if workspace is None or workspace["id"] != prepared.workspace_id or workspace["status"] != "ready":
            raise ExecutionDispatchError(
                "Execution Workspace不存在或尚未就绪",
                code="PI_WORKSPACE_NOT_READY",
            )
        private_path = await self._execution_workspaces.private_path(prepared.workspace_id)
        config = self._workspace_config(
            self._tool_configurations.runtime_snapshot(),
            working_directory=str(private_path),
        )
        try:
            execution = await self._manager.start(
                prepared.task,
                config,
                readonly_tools=self._readonly_tools,
                workspace_id=prepared.workspace_id,
                tool_execution_id=prepared.execution_id,
                product_session_id=product_session_id,
                product_run_id=product_run_id,
                execution_workspaces=self._execution_workspaces,
                tool_operations=self._tool_operations,
            )
        except Exception as error:
            await self.finish_failed(
                prepared.execution_id,
                failure_code=getattr(error, "code", type(error).__name__),
                metrics=getattr(error, "metrics", {}),
            )
            raise
        await self._execution_workspaces.mark_running(prepared.workspace_id)
        await self._mark_dispatched(prepared.execution_id)
        return PreparedPiExecution(
            execution_id=prepared.execution_id,
            execution=execution,
            route=prepared.route,
            step_input=prepared.step_input,
            task=prepared.task,
            mode="workspace_edit",
            workspace_id=prepared.workspace_id,
        )

    async def reattach_live_pi(
        self,
        *,
        execution_id: str,
        run_id: str,
        expected_mode: str,
        step_input: Mapping[str, Any],
    ) -> PreparedPiExecution:
        """Reattach a restored MAF Executor to one still-live pi subprocess.

        This is intentionally process-local. A backend restart has no live
        subprocess registry and remains governed by the existing startup
        reconciliation path, which marks the ToolExecution interrupted.
        """

        async with self.database.sessions() as transaction:
            record = await transaction.get(ToolExecutionRecord, execution_id)
        if record is None or record.run_id != run_id or record.run_spec_id is None:
            raise ExecutionDispatchError(
                "Checkpoint引用的pi ToolExecution不存在或不属于当前Run",
                code="PI_EXECUTION_REATTACH_OWNER_MISMATCH",
            )
        if record.status not in {"running", "waiting_human"}:
            raise ExecutionDispatchError(
                "Checkpoint引用的pi ToolExecution已经不在可恢复状态",
                code="PI_EXECUTION_NOT_LIVE",
            )
        if record.mode != expected_mode:
            raise ExecutionDispatchError(
                "Checkpoint中的pi模式与ToolExecution不一致",
                code="PI_EXECUTION_REATTACH_MODE_MISMATCH",
            )
        if self._manager is None:
            raise ExecutionDispatchError(
                "pi Runtime当前不可用",
                code="pi_runtime_unavailable",
            )
        execution = self._manager.live_for_tool_execution(execution_id)
        if execution is None:
            await self.finish_failed(
                execution_id,
                failure_code="PI_EXECUTION_PROCESS_NOT_LIVE",
                metrics={},
            )
            raise ExecutionDispatchError(
                "当前进程中已找不到Checkpoint对应的pi执行",
                code="PI_EXECUTION_PROCESS_NOT_LIVE",
            )
        if execution.config.revision != record.config_revision:
            raise ExecutionDispatchError(
                "pi进程配置与持久ToolExecution不一致",
                code="PI_EXECUTION_REATTACH_CONFIG_MISMATCH",
            )
        route = await self.route(record.run_spec_id)
        expected_route = "pi_workspace" if expected_mode == "workspace_edit" else "pi_readonly"
        if route.kind != expected_route:
            raise ExecutionDispatchError(
                "pi进程路由与已批准RunSpec不一致",
                code="PI_EXECUTION_REATTACH_ROUTE_MISMATCH",
            )
        workspace = await self._execution_workspaces.get_for_tool_execution(execution_id)
        workspace_id = str(workspace["id"]) if workspace is not None else None
        if execution.workspace_id != workspace_id:
            raise ExecutionDispatchError(
                "pi进程绑定的Execution Workspace不一致",
                code="PI_EXECUTION_REATTACH_WORKSPACE_MISMATCH",
            )
        logger.info(
            "pi_execution_reattached execution_id=%s run_id=%s mode=%s",
            execution_id,
            run_id,
            expected_mode,
        )
        return PreparedPiExecution(
            execution_id=execution_id,
            execution=execution,
            route=route,
            step_input=copy.deepcopy(dict(step_input)),
            task=execution.task,
            mode=expected_mode,
            workspace_id=workspace_id,
        )

    async def restore_tool_authorization(
        self,
        value: Mapping[str, Any],
    ) -> ToolAuthorization:
        """Restore only immutable/durable references for a pending Tool HITL."""

        request_id = str(value.get("request_id") or "")
        async with self.database.sessions() as transaction:
            request = await transaction.get(HumanDecisionRequestRecord, request_id)
        if request is None:
            raise ExecutionDispatchError(
                "Checkpoint引用的Tool审核请求不存在",
                code="PI_TOOL_REQUEST_MISSING",
            )
        if (
            request.request_hash != str(value.get("request_hash") or "")
            or request.row_version != int(value.get("request_row_version") or 0)
            or request.status != "pending"
        ):
            raise ExecutionDispatchError(
                "Checkpoint引用的Tool审核请求已经变化",
                code="PI_TOOL_REQUEST_STALE",
            )
        operation_id = str(value.get("operation_id") or "")
        operation = await self._tool_operations.prepared(operation_id) if operation_id else None
        return ToolAuthorization(
            mode="require_human",
            tool_call_request_id=str(value.get("tool_call_request_id") or ""),
            decision_item_key=str(value.get("decision_item_key") or ""),
            request=request,
            consumption_id=None,
            operation=operation,
        )

    async def authorize_tool(
        self,
        *,
        run_id: str,
        run_spec_id: str,
        execution_id: str,
        tool_call_id: str,
        tool_name: str,
        arguments: Mapping[str, Any],
        fence: Any,
        workspace_id: str | None = None,
    ) -> ToolAuthorization:
        allowed_tools = PI_WORKSPACE_TOOLS if workspace_id is not None else PI_TOOLS
        if tool_name not in allowed_tools:
            raise ExecutionDispatchError(
                "pi请求了Capability Allowlist之外的Tool",
                code="PI_TOOL_NOT_ALLOWED",
            )
        operation = (
            await self._tool_operations.propose_exact_edit(
                tool_execution_id=execution_id,
                provider_tool_call_id=tool_call_id,
                arguments=arguments,
            )
            if tool_name == "edit" and workspace_id is not None
            else None
        )
        if tool_name == "edit" and operation is None:
            raise ExecutionDispatchError(
                "edit只能在Execution Workspace中执行",
                code="PI_TOOL_NOT_ALLOWED",
            )
        node_id = PI_WORKSPACE_NODE_ID if workspace_id is not None else PI_NODE_ID
        operation_binding = operation.public_view() if operation is not None else None
        risk = {
            "tool": {
                "risk_level": 2 if operation is not None else 0,
                "has_side_effects": operation is not None,
                "outside_capability": False,
                "side_effect_class": ("managed_workspace_write" if operation is not None else "none"),
            },
            "operation": operation_binding,
        }
        request, subject = await self._governance.register_tool_call(
            run_id=run_id,
            workflow_node_id=node_id,
            provider_tool_call_id=tool_call_id,
            tool_id=tool_name,
            tool_definition_revision=(
                "chat-exact-edit-v1" if operation is not None else "chat-readonly-tools-v1"
            ),
            arguments=arguments,
            target_summary=(
                f"Execution Workspace {workspace_id} · {operation.target_path}"
                if operation is not None
                else (
                    f"Execution Workspace {workspace_id}"
                    if workspace_id is not None
                    else f"Repository Snapshot {fence.snapshot_id} · {fence.relative_path}"
                )
            ),
            risk_snapshot=risk,
            workflow_definition_id=PI_WORKFLOW_ID,
            workflow_version=PI_WORKFLOW_VERSION,
        )
        evaluation, preview = await self._governance.evaluate_subject(
            subject=subject,
            decision_point_key="tool_execution_authorization",
            scopes=[
                {"kind": "product_default", "ref_id": "*"},
                {"kind": "principal", "ref_id": "local-user"},
                {"kind": "run", "ref_id": run_id},
                {"kind": "workflow_node", "ref_id": node_id},
                {"kind": "tool_profile", "ref_id": PI_TOOL_ID},
            ],
            facts=risk,
        )
        final_action = str(preview["final_action"])
        if final_action == "deny":
            if operation is not None:
                await self._tool_operations.deny(operation.operation_id)
            raise ExecutionDispatchError(
                "HITL策略拒绝本次pi Tool调用",
                code="PI_TOOL_DENIED",
            )
        if final_action == "require_human":
            if operation is not None:
                await self._tool_operations.mark_waiting_authorization(operation.operation_id)
            human = await self._governance.create_human_request(
                evaluation=evaluation,
                subject=subject,
                title=("确认pi工作区精确编辑" if operation is not None else "确认pi只读Tool调用"),
                reason="有效HITL策略要求本次Tool调用由用户确认。",
                evidence={
                    "tool_name": tool_name,
                    "arguments": dict(arguments),
                    "repository_snapshot_id": fence.snapshot_id,
                    "execution_workspace_id": workspace_id,
                    "tool_operation": operation_binding,
                },
                consequence={
                    "on_approve": (
                        "只在隔离Execution Workspace执行一次绑定Hash的精确编辑"
                        if operation is not None
                        else "执行一次无副作用只读Tool"
                    )
                },
                allowed_actions=["approve", "deny"],
                decision_point_key="tool_execution_authorization",
            )
            return ToolAuthorization(
                mode="require_human",
                tool_call_request_id=request.id,
                decision_item_key=subject.id,
                request=human,
                consumption_id=None,
                operation=operation,
            )
        _, grant = await self._governance.record_automatic_decision(
            evaluation=evaluation,
            subject=subject,
            decision_code="approve",
            grant_kind="execute_tool",
            binding_hash=subject.subject_hash,
            constraints={
                "tool_name": tool_name,
                "arguments_hash": request.arguments_hash,
                "repository_snapshot_id": fence.snapshot_id,
                "run_spec_id": run_spec_id,
                "execution_workspace_id": workspace_id,
                "operation_hash": operation.operation_hash if operation else None,
                "expected_preimage_hash": (operation.expected_preimage_hash if operation else None),
                "expected_postimage_hash": (operation.expected_postimage_hash if operation else None),
            },
        )
        if grant is None:
            raise ExecutionDispatchError(
                "自动Tool决定没有生成授权",
                code="PI_TOOL_GRANT_MISSING",
            )
        consumption = await self._governance.claim_grant(
            grant_id=grant.id,
            binding_hash=subject.subject_hash,
            consumer_kind="tool_call_request",
            consumer_id=request.id,
            idempotency_key=f"pi-tool:{request.id}:1",
            claimed_by=f"pi-execution:{execution_id}",
        )
        await self._governance.mark_tool_call_authorized(
            tool_call_request_id=request.id,
            authorization_consumption_id=consumption.id,
        )
        if operation is not None:
            await self._tool_operations.authorize(
                operation.operation_id,
                consumption_id=consumption.id,
            )
        return ToolAuthorization(
            mode="auto_continue",
            tool_call_request_id=request.id,
            decision_item_key=subject.id,
            request=None,
            consumption_id=consumption.id,
            operation=operation,
        )

    async def register_pi_model_call(
        self,
        review_card: Mapping[str, Any],
    ) -> PiModelCallGovernance:
        """Persist the pi model boundary before MAF exposes an interrupt."""

        _, revision, evaluation, preview, request = await self._governance.register_model_call(
            review_card=review_card
        )
        return PiModelCallGovernance(
            revision_id=revision.id,
            subject_id=revision.subject_id,
            evaluation_id=evaluation.id,
            final_action=str(preview["final_action"]),
            binding_hash=revision.binding_hash,
            request_id=request.id if request else None,
            request_hash=request.request_hash if request else None,
            request_row_version=request.row_version if request else None,
        )

    async def decide_pi_model_call(
        self,
        *,
        governance: PiModelCallGovernance,
        decision: str,
        execution_id: str,
    ) -> str | None:
        """Resolve one policy decision and return an Attempt ID on approval."""

        async with self.database.sessions() as transaction:
            revision = await transaction.get(
                ModelCallDraftRevisionRecord,
                governance.revision_id,
            )
            subject = await transaction.get(
                DecisionSubjectRecord,
                governance.subject_id,
            )
            evaluation = await transaction.get(
                PolicyEvaluationRecord,
                governance.evaluation_id,
            )
        if revision is None or subject is None or evaluation is None:
            raise ExecutionDispatchError(
                "pi模型调用的持久治理引用不存在",
                code="PI_MODEL_GOVERNANCE_MISSING",
            )
        if decision not in {"approve", "revise", "abandon", "deny"}:
            raise ExecutionDispatchError(
                "pi模型调用决定无效",
                code="PI_MODEL_DECISION_INVALID",
            )

        grant_id: str | None = None
        binding_hash = revision.binding_hash
        if governance.request_id is not None:
            if governance.request_hash is None or governance.request_row_version is None:
                raise ExecutionDispatchError(
                    "pi模型调用缺少人工请求绑定",
                    code="PI_MODEL_REQUEST_BINDING_MISSING",
                )
            resolved = await self._governance.resolve_single_human_request(
                request_id=governance.request_id,
                expected_request_hash=governance.request_hash,
                expected_row_version=governance.request_row_version,
                decision=decision,
            )
            grant_id = str(resolved.get("authorization_grant_id") or "") or None
            binding_hash = str(resolved.get("binding_hash") or binding_hash)
        else:
            _, grant = await self._governance.record_automatic_decision(
                evaluation=evaluation,
                subject=subject,
                decision_code=decision,
                grant_kind="send_model_call" if decision == "approve" else None,
                binding_hash=revision.binding_hash,
            )
            grant_id = grant.id if grant else None

        if decision != "approve":
            return None
        if grant_id is None:
            raise ExecutionDispatchError(
                "pi模型调用批准没有生成授权",
                code="PI_MODEL_GRANT_MISSING",
            )
        consumption = await self._governance.claim_grant(
            grant_id=grant_id,
            binding_hash=binding_hash,
            consumer_kind="model_call_attempt",
            consumer_id=revision.id,
            idempotency_key=f"model-call:{revision.id}",
            claimed_by=f"pi-execution:{execution_id}",
        )
        attempt = await self._governance.start_model_call_attempt(
            revision=revision,
            consumption=consumption,
        )
        return attempt.id

    async def finish_pi_model_call_attempt(
        self,
        *,
        attempt_id: str,
        status: str,
        failure_code: str | None,
    ) -> None:
        if status not in {"completed", "failed", "outcome_unknown", "cancelled"}:
            raise ExecutionDispatchError(
                "pi Provider Attempt终态无效",
                code="PI_MODEL_ATTEMPT_STATUS_INVALID",
            )
        await self._governance.finish_model_call_attempt(
            attempt_id=attempt_id,
            status=status,
            failure_code=failure_code,
        )

    async def resolve_human_tool(
        self,
        *,
        authorization: ToolAuthorization,
        decision: str,
        execution_id: str,
    ) -> str:
        request = authorization.request
        if request is None:
            raise ExecutionDispatchError(
                "缺少人工Tool授权请求",
                code="PI_TOOL_REQUEST_MISSING",
            )
        if decision not in {"approve", "deny"}:
            raise ExecutionDispatchError(
                "Tool审核决定无效",
                code="PI_TOOL_DECISION_INVALID",
            )
        values = await self._governance.resolve_human_request(
            request_id=request.id,
            expected_request_hash=request.request_hash,
            expected_row_version=request.row_version,
            decisions=[
                {
                    "item_key": authorization.decision_item_key,
                    "decision": decision,
                }
            ],
        )
        if decision == "deny":
            if authorization.operation is not None:
                await self._tool_operations.deny(authorization.operation.operation_id)
            return "denied"
        grant_id = str(values[0].get("authorization_grant_id") or "")
        binding_hash = str(values[0].get("binding_hash") or "")
        if not grant_id or not binding_hash:
            raise ExecutionDispatchError(
                "人工Tool批准没有生成授权",
                code="PI_TOOL_GRANT_MISSING",
            )
        consumption = await self._governance.claim_grant(
            grant_id=grant_id,
            binding_hash=binding_hash,
            consumer_kind="tool_call_request",
            consumer_id=authorization.tool_call_request_id,
            idempotency_key=f"pi-tool:{authorization.tool_call_request_id}:1",
            claimed_by=f"pi-execution:{execution_id}",
        )
        await self._governance.mark_tool_call_authorized(
            tool_call_request_id=authorization.tool_call_request_id,
            authorization_consumption_id=consumption.id,
        )
        if authorization.operation is not None:
            await self._tool_operations.authorize(
                authorization.operation.operation_id,
                consumption_id=consumption.id,
            )
        return consumption.id

    async def record_activity(
        self,
        execution_id: str,
        *,
        activity: Mapping[str, Any],
    ) -> int:
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolExecutionRecord, execution_id)
            if value is None:
                raise ExecutionDispatchError(
                    "ToolExecution不存在",
                    code="PI_EXECUTION_NOT_FOUND",
                )
            if value.status not in {"starting", "running", "waiting_human"}:
                raise ExecutionDispatchError(
                    "终态ToolExecution不能追加活动",
                    code="PI_EXECUTION_TERMINAL",
                )
            sequence = value.last_activity_sequence + 1
            metrics = dict(value.metrics or {})
            activities = list(metrics.get("activities") or [])
            activities.append({"sequence": sequence, **dict(activity)})
            metrics["activities"] = activities[-200:]
            value.metrics = metrics
            value.last_activity_sequence = sequence
            value.row_version += 1
        return sequence

    async def mark_waiting(self, execution_id: str) -> None:
        await self._set_status(execution_id, status="waiting_human")

    async def mark_running(self, execution_id: str) -> None:
        await self._set_status(execution_id, status="running")

    async def finish_success(
        self,
        execution_id: str,
        *,
        text: str,
        metrics: Mapping[str, Any],
        terminal_reason_code: str,
    ) -> PiReadonlyResult:
        workspace = await self._retain_workspace(execution_id)
        result_body = {
            "execution_id": execution_id,
            "status": "succeeded",
            "final_text": text,
            "metrics": dict(metrics),
            "terminal_reason_code": terminal_reason_code,
            "mode": "workspace_edit" if workspace is not None else "readonly",
            "workspace": workspace,
        }
        result_hash = content_hash(result_body)
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolExecutionRecord, execution_id)
            if value is None:
                raise ExecutionDispatchError(
                    "ToolExecution不存在",
                    code="PI_EXECUTION_NOT_FOUND",
                )
            self._apply_terminal(
                value,
                status="succeeded",
                result=result_body,
                result_hash=result_hash,
                terminal_reason_code=terminal_reason_code,
                metrics=metrics,
                failure_code=None,
            )
        return PiReadonlyResult(
            execution_id=execution_id,
            status="succeeded",
            final_text=text,
            model_call_count=int(metrics.get("model_call_count") or 0),
            tool_call_count=int(metrics.get("internal_tool_call_count") or 0),
            input_tokens=int(metrics.get("input_tokens") or 0),
            output_tokens=int(metrics.get("output_tokens") or 0),
            duration_ms=int(metrics.get("duration_ms") or 0),
            result_hash=result_hash,
            terminal_reason_code=terminal_reason_code,
            mode="workspace_edit" if workspace is not None else "readonly",
            workspace_id=str(workspace["id"]) if workspace is not None else None,
            workspace_diff_hash=(
                str(workspace["diff_hash"]) if workspace and workspace.get("diff_hash") else None
            ),
            changed_paths=tuple(workspace["changed_paths"]) if workspace is not None else (),
        )

    async def finish_failed(
        self,
        execution_id: str,
        *,
        failure_code: str,
        metrics: Mapping[str, Any],
    ) -> None:
        await self._retain_workspace(execution_id, fail_closed=False)
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolExecutionRecord, execution_id)
            if value is None:
                return
            if value.status in _TERMINAL_EXECUTION_STATUSES:
                return
            self._apply_terminal(
                value,
                status="failed",
                result=None,
                result_hash=None,
                terminal_reason_code=failure_code,
                metrics=metrics,
                failure_code=failure_code,
            )

    async def finish_abandoned(
        self,
        execution_id: str,
        *,
        metrics: Mapping[str, Any],
    ) -> None:
        await self._retain_workspace(execution_id, fail_closed=False)
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolExecutionRecord, execution_id)
            if value is None:
                return
            if value.status in _TERMINAL_EXECUTION_STATUSES:
                return
            self._apply_terminal(
                value,
                status="abandoned",
                result=None,
                result_hash=None,
                terminal_reason_code="user_abandoned",
                metrics=metrics,
                failure_code="user_abandoned",
            )

    async def list_for_run(self, run_id: str) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(ToolExecutionRecord)
                        .where(ToolExecutionRecord.run_id == run_id)
                        .order_by(
                            ToolExecutionRecord.execution_ordinal,
                            ToolExecutionRecord.started_at,
                        )
                    )
                ).all()
            )
        return [await self._enriched_execution_view(value) for value in values]

    async def get(self, execution_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            value = await transaction.get(ToolExecutionRecord, execution_id)
            if value is None:
                raise ExecutionDispatchError(
                    "ToolExecution不存在",
                    code="PI_EXECUTION_NOT_FOUND",
                )
            return await self._enriched_execution_view(value)

    async def _enriched_execution_view(
        self,
        value: ToolExecutionRecord,
    ) -> dict[str, Any]:
        result = self._execution_view(value)
        result["workspace"] = await self._execution_workspaces.get_for_tool_execution(value.id)
        result["operations"] = await self._tool_operations.list_for_tool_execution(value.id)
        return result

    async def _retain_workspace(
        self,
        execution_id: str,
        *,
        fail_closed: bool = True,
    ) -> dict[str, Any] | None:
        workspace = await self._execution_workspaces.get_for_tool_execution(execution_id)
        if workspace is None:
            return None
        if workspace["status"] == "retained":
            return workspace
        try:
            return await self._execution_workspaces.retain(str(workspace["id"]))
        except Exception:
            if fail_closed:
                raise
            logger.exception(
                "execution_workspace_retention_failed execution_id=%s workspace_id=%s",
                execution_id,
                workspace["id"],
            )
            return await self._execution_workspaces.get_for_tool_execution(execution_id)

    async def _run_spec_payload(self, run_spec_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            value = await transaction.get(RunSpecRecord, run_spec_id)
            if value is None:
                raise ExecutionDispatchError(
                    "RunSpec不存在",
                    code="RUN_SPEC_NOT_FOUND",
                )
            return copy.deepcopy(dict(value.spec_json or {}))

    @staticmethod
    def _compile_task(
        *,
        spec: Mapping[str, Any],
        origin_prompt: str,
        mode: str,
    ) -> str:
        brief = dict(spec.get("execution_brief") or {})
        plan = dict(spec.get("plan") or {})
        context = dict(spec.get("context_manifest") or {})
        context_refs = [
            {
                "kind": value.get("source_kind"),
                "id": value.get("source_id"),
                "revision": value.get("source_revision"),
                "title": value.get("title"),
            }
            for value in context.get("items") or []
            if isinstance(value, Mapping)
        ]
        constraints = (
            "只在Chat创建的隔离Execution Workspace中工作；可使用read、grep、find、ls和"
            "单文件精确edit；每次edit都要单独审批。不得修改活动仓库、执行Shell、创建或删除"
            "文件、提交或推送Git、联网访问其他目标，也不得声称Work已经完成。"
            if mode == "workspace_edit"
            else (
                "只读取已批准Repository Snapshot；仅使用read、grep、find、ls；"
                "不得写文件、执行Shell、运行测试、提交Git、联网访问其他目标或声称完成修改。"
            )
        )
        return (
            "# 用户原始请求\n"
            f"{origin_prompt.strip()}\n\n"
            "# 已批准执行目标\n"
            f"{brief.get('text') or ''}\n\n"
            "# 已批准计划\n"
            f"{plan.get('text') or '本次无需独立计划'}\n\n"
            "# 已采用上下文来源\n"
            f"{context_refs}\n\n"
            "# 执行约束\n"
            f"{constraints}"
        )

    @staticmethod
    def _readonly_config(
        config: PiToolConfigSnapshot,
        *,
        working_directory: str,
    ) -> PiToolConfigSnapshot:
        allowed = tuple(name for name in PI_TOOLS if name in set(config.allowed_tools))
        if not allowed:
            raise ExecutionDispatchError(
                "pi配置没有启用任何SD2只读Tool",
                code="PI_READONLY_TOOLS_DISABLED",
            )
        return replace(
            config,
            working_directory=working_directory,
            allowed_tools=allowed,
            max_model_calls=min(config.max_model_calls, 6),
            timeout_seconds=min(config.timeout_seconds, 600),
            system_prompt=(
                f"{config.system_prompt.strip()}\n\n"
                "本次处于Chat SD2只读模式。只能使用Chat注册的read、grep、find、ls；"
                "没有写文件、Shell、Git提交、测试执行或其他网络权限。"
            ),
        )

    @staticmethod
    def _workspace_config(
        config: PiToolConfigSnapshot,
        *,
        working_directory: str,
    ) -> PiToolConfigSnapshot:
        enabled = set(config.allowed_tools)
        if "edit" not in enabled:
            raise ExecutionDispatchError(
                "pi配置尚未启用SD3精确edit Tool",
                code="PI_WORKSPACE_EDIT_DISABLED",
            )
        allowed = tuple(name for name in PI_WORKSPACE_TOOLS if name in enabled)
        return replace(
            config,
            working_directory=working_directory,
            allowed_tools=allowed,
            max_model_calls=min(config.max_model_calls, 8),
            timeout_seconds=min(config.timeout_seconds, 900),
            system_prompt=(
                f"{config.system_prompt.strip()}\n\n"
                "本次处于Chat SD3隔离工作区模式。只能使用Chat注册的read、grep、find、ls、edit；"
                "edit只能精确替换一个现有UTF-8文件中的唯一文本，并在执行前由Chat逐次治理。"
                "不得使用Shell、创建文件、删除文件、提交、推送或修改活动仓库。"
            ),
        )

    async def _create_execution(
        self,
        *,
        session_id: str,
        run_id: str,
        run_spec_id: str,
        step_input_projection_id: str,
        fence: Any,
        config: PiToolConfigSnapshot,
        input_hash: str,
        capability_hash: str,
        mode: str,
    ) -> str:
        async with self.database.sessions.begin() as transaction:
            run = await transaction.get(RunRecord, run_id)
            attempt = await transaction.scalar(
                select(RunAttemptRecord)
                .where(RunAttemptRecord.run_id == run_id)
                .order_by(RunAttemptRecord.attempt_number.desc())
                .limit(1)
            )
            job = (
                await transaction.scalar(
                    select(RuntimeJobRecord).where(RuntimeJobRecord.run_attempt_id == attempt.id)
                )
                if attempt is not None
                else None
            )
            if run is None or run.session_id != session_id or attempt is None or job is None:
                raise ExecutionDispatchError(
                    "pi执行缺少当前Run Attempt或Runtime Job",
                    code="PI_RUNTIME_OWNER_MISSING",
                )
            ordinal = (
                int(
                    await transaction.scalar(
                        select(func.max(ToolExecutionRecord.execution_ordinal)).where(
                            ToolExecutionRecord.run_id == run_id,
                            ToolExecutionRecord.tool_id == PI_TOOL_ID,
                        )
                    )
                    or 0
                )
                + 1
            )
            execution_id = str(uuid4())
            value = ToolExecutionRecord(
                id=execution_id,
                session_id=session_id,
                run_id=run_id,
                run_attempt_id=attempt.id,
                runtime_job_id=job.id,
                run_spec_id=run_spec_id,
                step_input_projection_id=step_input_projection_id,
                repository_binding_id=fence.binding_id,
                repository_snapshot_id=fence.snapshot_id,
                tool_id=PI_TOOL_ID,
                execution_ordinal=ordinal,
                mode=mode,
                config_revision=config.revision,
                status="starting",
                input_hash=input_hash,
                capability_hash=capability_hash,
                process_dispatch_state="not_started",
                metrics={
                    "pi_session": pending_pi_session_view(
                        tool_execution_id=execution_id,
                        product_session_id=session_id,
                        product_run_id=run_id,
                    )
                },
            )
            transaction.add(value)
        return value.id

    async def _workspace_ownership(self, execution_id: str) -> WorkspaceOwnership:
        async with self.database.sessions() as transaction:
            value = await transaction.get(ToolExecutionRecord, execution_id)
            if value is None or value.run_attempt_id is None or value.runtime_job_id is None:
                raise ExecutionDispatchError(
                    "Execution Workspace缺少完整运行血缘",
                    code="PI_RUNTIME_OWNER_MISSING",
                )
            return WorkspaceOwnership(
                scope_id="local-user",
                product_run_id=value.run_id,
                run_attempt_id=value.run_attempt_id,
                runtime_job_id=value.runtime_job_id,
                tool_execution_id=value.id,
            )

    async def _mark_dispatched(self, execution_id: str) -> None:
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolExecutionRecord, execution_id)
            if value is None or value.status != "starting":
                raise ExecutionDispatchError(
                    "pi ToolExecution启动状态冲突",
                    code="PI_EXECUTION_START_CONFLICT",
                )
            value.status = "running"
            value.process_dispatch_state = "started"
            value.row_version += 1

    async def _set_status(self, execution_id: str, *, status: str) -> None:
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolExecutionRecord, execution_id)
            if value is None:
                raise ExecutionDispatchError(
                    "ToolExecution不存在",
                    code="PI_EXECUTION_NOT_FOUND",
                )
            if value.status in _TERMINAL_EXECUTION_STATUSES:
                raise ExecutionDispatchError(
                    "终态ToolExecution不能改变运行状态",
                    code="PI_EXECUTION_TERMINAL",
                )
            value.status = status
            value.row_version += 1

    async def cancel_run(self, run_id: str, *, reason_code: str) -> dict[str, int]:
        """Converge live pi and isolated-write state after Product cancellation."""

        async with self.database.sessions() as transaction:
            execution_ids = list(
                (
                    await transaction.scalars(
                        select(ToolExecutionRecord.id).where(
                            ToolExecutionRecord.run_id == run_id,
                            ToolExecutionRecord.status.in_({"starting", "running", "waiting_human"}),
                        )
                    )
                ).all()
            )
        closed_processes = 0
        terminal_metrics: dict[str, dict[str, Any]] = {}
        if self._manager is not None:
            for execution_id in execution_ids:
                metrics = await self._manager.close_for_tool_execution(execution_id)
                if metrics is not None:
                    closed_processes += 1
                    terminal_metrics[execution_id] = metrics

        async with self.database.sessions.begin() as transaction:
            executions = list(
                (
                    await transaction.scalars(
                        select(ToolExecutionRecord).where(ToolExecutionRecord.id.in_(execution_ids))
                    )
                ).all()
            )
            for execution in executions:
                if execution.status not in {"starting", "running", "waiting_human"}:
                    continue
                metrics = terminal_metrics.get(execution.id, {})
                self._apply_terminal(
                    execution,
                    status="cancelled",
                    result=None,
                    result_hash=None,
                    terminal_reason_code=reason_code[:100],
                    metrics=metrics,
                    failure_code=reason_code[:100],
                )

        operations = await self._tool_operations.cancel_pending_for_run(
            run_id,
            reason_code=reason_code,
        )
        workspaces = await self._execution_workspaces.retain_for_terminal_run(run_id)
        result = {
            "tool_executions": len(executions),
            "pi_processes": closed_processes,
            "tool_operations": operations,
            "workspaces": workspaces,
        }
        if any(result.values()):
            logger.info(
                "execution_dispatch_cancelled run_id=%s reason_code=%s "
                "tool_executions=%d pi_processes=%d tool_operations=%d workspaces=%d",
                run_id,
                reason_code,
                result["tool_executions"],
                result["pi_processes"],
                result["tool_operations"],
                result["workspaces"],
            )
        return result

    @staticmethod
    def _apply_terminal(
        value: ToolExecutionRecord,
        *,
        status: str,
        result: Mapping[str, Any] | None,
        result_hash: str | None,
        terminal_reason_code: str,
        metrics: Mapping[str, Any],
        failure_code: str | None,
    ) -> None:
        value.status = status
        value.process_dispatch_state = "finished"
        value.model_call_count = int(metrics.get("model_call_count") or 0)
        value.internal_tool_call_count = int(metrics.get("internal_tool_call_count") or 0)
        value.input_tokens = int(metrics.get("input_tokens") or 0)
        value.output_tokens = int(metrics.get("output_tokens") or 0)
        value.cache_read_tokens = int(metrics.get("cache_read_tokens") or 0)
        value.cache_write_tokens = int(metrics.get("cache_write_tokens") or 0)
        value.cost = float(metrics.get("cost") or 0)
        value.duration_ms = int(metrics.get("duration_ms") or 0)
        existing_metrics = dict(value.metrics or {})
        value.metrics = {**existing_metrics, **dict(metrics)}
        value.failure_code = failure_code
        value.terminal_reason_code = terminal_reason_code
        value.result_json = dict(result) if result is not None else None
        value.result_hash = result_hash
        value.finished_at = utc_now()
        value.row_version += 1

    @staticmethod
    def _execution_view(value: ToolExecutionRecord) -> dict[str, Any]:
        return {
            "id": value.id,
            "session_id": value.session_id,
            "run_id": value.run_id,
            "run_attempt_id": value.run_attempt_id,
            "runtime_job_id": value.runtime_job_id,
            "run_spec_id": value.run_spec_id,
            "step_input_projection_id": value.step_input_projection_id,
            "repository_binding_id": value.repository_binding_id,
            "repository_snapshot_id": value.repository_snapshot_id,
            "tool_id": value.tool_id,
            "execution_ordinal": value.execution_ordinal,
            "mode": value.mode,
            "config_revision": value.config_revision,
            "status": value.status,
            "process_dispatch_state": value.process_dispatch_state,
            "last_activity_sequence": value.last_activity_sequence,
            "model_call_count": value.model_call_count,
            "internal_tool_call_count": value.internal_tool_call_count,
            "tokens": {
                "input": value.input_tokens,
                "output": value.output_tokens,
                "cache_read": value.cache_read_tokens,
                "cache_write": value.cache_write_tokens,
            },
            "cost": value.cost,
            "duration_ms": value.duration_ms,
            "metrics": dict(value.metrics or {}),
            "result": dict(value.result_json or {}) if value.result_json else None,
            "result_hash": value.result_hash,
            "failure_code": value.failure_code,
            "terminal_reason_code": value.terminal_reason_code,
            "started_at": value.started_at.isoformat(),
            "finished_at": value.finished_at.isoformat() if value.finished_at else None,
            "row_version": value.row_version,
        }
