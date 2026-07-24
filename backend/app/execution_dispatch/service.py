"""Application coordinator for governed pi read-only execution.

The coordinator owns Product transactions and external-dispatch boundaries.
MAF Executors consume this service but do not query tables, resolve filesystem
paths, or invent permissions themselves.
"""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass, replace
from typing import Any, Mapping
from uuid import uuid4

from sqlalchemy import func, select

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
from .contracts import ExecutionRoute, PiReadonlyResult, route_from_run_spec
from .repository_context import RepositoryExecutionContextService

logger = logging.getLogger(__name__)

PI_WORKFLOW_ID = "continuous-collaboration"
PI_WORKFLOW_VERSION = "1.6.0"
PI_NODE_ID = "pi_readonly_dispatch"
PI_TOOLS = ("read", "grep", "find", "ls")


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


@dataclass(frozen=True, slots=True)
class ToolAuthorization:
    mode: str
    tool_call_request_id: str
    decision_item_key: str
    request: HumanDecisionRequestRecord | None
    consumption_id: str | None

    def review_card(
        self,
        *,
        tool_name: str,
        arguments: Mapping[str, Any],
        fence_label: str,
    ) -> dict[str, Any]:
        request = self.request
        if request is None:
            raise ExecutionDispatchError(
                "自动Tool授权没有人工审核卡",
                code="TOOL_AUTHORIZATION_STATE_INVALID",
            )
        return {
            "review_kind": "tool_execution",
            "message": "请审核pi只读Tool调用",
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
            "risk": "只读、无副作用；仍受Repository Snapshot围栏约束",
            "allowed_actions": ["approve", "deny"],
            "execution_context": {
                "workflow_id": PI_WORKFLOW_ID,
                "executor_id": PI_NODE_ID,
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


class ExecutionDispatchService:
    """Own the SD2 dispatch use case without owning the MAF graph.

    This coordinator intentionally keeps route preparation, authorization and
    ToolExecution transitions behind one application boundary.  Splitting
    those public operations into independent table services would let an MAF
    executor start a process without the corresponding fence, grant or ledger.
    Pure compilation, repository resolution and read tools are already
    extracted; F01 will introduce a separate side-effect ledger rather than
    growing this read-only coordinator.
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
    ) -> None:
        self.database = database
        self._governance = governance
        self._repository_context = repository_context
        self._step_inputs = step_inputs
        self._tool_configurations = tool_configurations
        self._manager = manager
        self._readonly_tools = readonly_tools

    async def route(self, run_spec_id: str) -> ExecutionRoute:
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
        task = self._compile_task(spec=spec, origin_prompt=origin_prompt)
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
            )
        except Exception as error:
            await self.finish_failed(
                execution_id,
                failure_code=getattr(error, "code", type(error).__name__),
                metrics={},
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
    ) -> ToolAuthorization:
        if tool_name not in PI_TOOLS:
            raise ExecutionDispatchError(
                "pi请求了Capability Allowlist之外的Tool",
                code="PI_TOOL_NOT_ALLOWED",
            )
        risk = {
            "tool": {
                "risk_level": 0,
                "has_side_effects": False,
                "outside_capability": False,
            }
        }
        request, subject = await self._governance.register_tool_call(
            run_id=run_id,
            workflow_node_id=PI_NODE_ID,
            provider_tool_call_id=tool_call_id,
            tool_id=tool_name,
            tool_definition_revision="chat-readonly-tools-v1",
            arguments=arguments,
            target_summary=(f"Repository Snapshot {fence.snapshot_id} · {fence.relative_path}"),
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
                {"kind": "workflow_node", "ref_id": PI_NODE_ID},
                {"kind": "tool_profile", "ref_id": PI_TOOL_ID},
            ],
            facts=risk,
        )
        final_action = str(preview["final_action"])
        if final_action == "deny":
            raise ExecutionDispatchError(
                "HITL策略拒绝本次pi只读Tool调用",
                code="PI_TOOL_DENIED",
            )
        if final_action == "require_human":
            human = await self._governance.create_human_request(
                evaluation=evaluation,
                subject=subject,
                title="确认pi只读Tool调用",
                reason="有效HITL策略要求本次Tool调用由用户确认。",
                evidence={
                    "tool_name": tool_name,
                    "arguments": dict(arguments),
                    "repository_snapshot_id": fence.snapshot_id,
                },
                consequence={"on_approve": "执行一次无副作用只读Tool"},
                allowed_actions=["approve", "deny"],
                decision_point_key="tool_execution_authorization",
            )
            return ToolAuthorization(
                mode="require_human",
                tool_call_request_id=request.id,
                decision_item_key=subject.id,
                request=human,
                consumption_id=None,
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
        return ToolAuthorization(
            mode="auto_continue",
            tool_call_request_id=request.id,
            decision_item_key=subject.id,
            request=None,
            consumption_id=consumption.id,
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
        result_body = {
            "execution_id": execution_id,
            "status": "succeeded",
            "final_text": text,
            "metrics": dict(metrics),
            "terminal_reason_code": terminal_reason_code,
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
        )

    async def finish_failed(
        self,
        execution_id: str,
        *,
        failure_code: str,
        metrics: Mapping[str, Any],
    ) -> None:
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolExecutionRecord, execution_id)
            if value is None:
                return
            if value.status in {"succeeded", "failed", "cancelled", "abandoned"}:
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
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolExecutionRecord, execution_id)
            if value is None:
                return
            if value.status in {"succeeded", "failed", "cancelled", "abandoned"}:
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
        return [self._execution_view(value) for value in values]

    async def get(self, execution_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            value = await transaction.get(ToolExecutionRecord, execution_id)
            if value is None:
                raise ExecutionDispatchError(
                    "ToolExecution不存在",
                    code="PI_EXECUTION_NOT_FOUND",
                )
            return self._execution_view(value)

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
    def _compile_task(*, spec: Mapping[str, Any], origin_prompt: str) -> str:
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
            "只读取已批准Repository Snapshot；仅使用read、grep、find、ls；"
            "不得写文件、执行Shell、运行测试、提交Git、联网访问其他目标或声称完成修改。"
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
            value = ToolExecutionRecord(
                id=str(uuid4()),
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
                mode="readonly",
                config_revision=config.revision,
                status="starting",
                input_hash=input_hash,
                capability_hash=capability_hash,
                process_dispatch_state="not_started",
                metrics={},
            )
            transaction.add(value)
        return value.id

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
            if value.status in {"succeeded", "failed", "cancelled", "abandoned"}:
                raise ExecutionDispatchError(
                    "终态ToolExecution不能改变运行状态",
                    code="PI_EXECUTION_TERMINAL",
                )
            value.status = status
            value.row_version += 1

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
