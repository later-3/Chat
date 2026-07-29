"""持续协作节点28-29：把pi隔离编辑结果转成可审核Claim与证据链。

节点28 ``result_claim_prepare``重新校验RunSpec冻结的Validation Contract与Action/Work
主体，建立Diff Artifact、CompletionClaim、Requirements、Observation和Assessment。
只有“不适用”条件明确成立才允许空Claim；歧义、缺前置或验证失败一律关闭Run。

节点29 ``result_claim_decision``在``result_commit``决定点把Claim版本、各动作结局和
requirement -> assessment Adoption映射冻结到DecisionSubject。接受时通过Result Commit
Gate在同一事务提交；拒绝走独立路径，不把旧Subject迁移到新Claim。

两个MAF节点都不拥有产品事务；事务属于应用Coordinator，本文件只编排状态与interrupt。
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import asdict, replace
from typing import Any

from agent_framework import Executor, WorkflowContext, handler, response_handler
from agent_framework._workflows._request_info_mixin import RequestInfoMixin

from ..evidence.result_pipeline import ResultPipelineCoordinator
from ..evidence.service import result_commit_decision_view
from ..governance.service import ExecutionGovernanceService
from ..product_sessions.service import ProductSessionService
from ..workflows.continuous_chat_contracts import CollaborationState, state_from_snapshot
from .service import ExecutionDispatchError

WORKFLOW_ID = "continuous-collaboration"
WORKFLOW_VERSION = "1.8.0"

logger = logging.getLogger(__name__)


def _failure_code_and_message(error: Exception, *, fallback_code: str) -> tuple[str, str]:
    """Map any failure to a stable product error code and a safe message.

    Known domain errors keep their stable code and curated message; anything
    else collapses to one stable code with a sanitized message so internal
    paths, SQL text or unexpected exception details never reach the Run
    failure record (第四轮复审P1-5)。
    """

    code = getattr(error, "code", None)
    if isinstance(code, str) and code:
        return code, str(error)
    return fallback_code, "本轮结果处理失败，请重试；若持续出现请联系管理员。"


def _require_frozen_disposition(
    frozen: Mapping[str, Any],
    *,
    key: str,
    allowed: set[str],
) -> str:
    """Require a frozen artifact disposition to be present and exactly allowed.

    Missing, empty or out-of-set values indicate a forged or drifting decision
    card and must fail closed before any grant consumption or commit call
    (第九轮复审P1)。
    """

    value = frozen.get(key)
    if not isinstance(value, str) or value not in allowed:
        raise ExecutionDispatchError(
            f"冻结处置字段{key}缺失或非法",
            code="RESULT_CLAIM_FROZEN_DISPOSITION_INVALID",
        )
    return value


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
    """记录Claim节点公开输入/输出，供终态双Trace解释完成声明为何成立或为空。"""
    await sessions.record_trace(
        thread_id,
        run_id,
        "workflow.node.content",
        {
            "workflow_id": WORKFLOW_ID,
            "executor_id": executor_id,
            "actor": "result_evidence_gate",
            "content_type": content_type,
            "public_input": dict(public_input),
            "public_output": dict(public_output),
            "step_input_projection": None,
        },
    )


class ResultClaimPrepareExecutor(Executor):
    """节点28：确定性建立Claim及Evidence链；任何歧义都fail closed。"""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        result_pipeline: ResultPipelineCoordinator,
    ) -> None:
        super().__init__(id="result_claim_prepare")
        self._thread_id = thread_id
        self._run_id = run_id
        self._sessions = sessions
        self._pipeline = result_pipeline

    @handler(input=CollaborationState)
    async def prepare(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        """执行节点28：运行证据管线并把Claim版本、验证结论和失败原因写Trace。"""
        try:
            workspace = dict(state.execution_workspace or {})
            execution_id = str(workspace.get("execution_id") or "")
            if not execution_id:
                raise ExecutionDispatchError(
                    "结果证据门缺少pi ToolExecution",
                    code="RESULT_GATE_EXECUTION_MISSING",
                )
            result = await self._pipeline.prepare(
                session_id=self._thread_id,
                run_id=self._run_id(),
                tool_execution_id=execution_id,
            )
        except Exception as error:
            # P1-6：已知domain code原样保留；未知异常统一稳定错误码与脱敏
            # 消息，不把内部细节泄露给用户可见的失败原因。
            code, message = _failure_code_and_message(
                error,
                fallback_code="RESULT_CLAIM_PREPARE_FAILED",
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                error_code=code,
                message=message,
            )
            raise
        await _record_trace(
            sessions=self._sessions,
            thread_id=self._thread_id,
            run_id=self._run_id(),
            executor_id=self.id,
            content_type="result_claim_prepare",
            public_input={
                "tool_execution_id": execution_id,
            },
            public_output=result,
        )
        next_state = replace(
            state,
            result_claim=result if result.get("status") == "prepared" else None,
        )
        await ctx.send_message(next_state)


class ResultClaimDecisionExecutor(Executor, RequestInfoMixin):
    """节点29：把result_commit决定绑定到精确Claim版本并运行提交Gate。"""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
        result_pipeline: ResultPipelineCoordinator,
    ) -> None:
        super().__init__(id="result_claim_decision")
        self._thread_id = thread_id
        self._run_id = run_id
        self._sessions = sessions
        self._governance = governance
        self._pipeline = result_pipeline

    @handler(input=CollaborationState)
    async def decide(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        """执行节点29入口：登记Claim Subject，评估Policy并自动继续或等待人工。"""
        try:
            await self._decide(state, ctx)
        except PermissionError:
            raise
        except Exception as error:
            code, message = _failure_code_and_message(
                error,
                fallback_code="RESULT_CLAIM_DECISION_FAILED",
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                error_code=code,
                message=message,
            )
            raise

    async def _decide(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        """登记/评估result_commit决定，按Policy自动继续或发出interrupt。

        规模说明（>80行审查）：本方法把“重放短路 -> 冻结视图 -> 策略评估 ->
        自动/人工分支 -> 卡片签发”作为一条HITL状态机路径保持在一起；拆开会让
        治理写入重入复用（第四轮复审P1-4）的检查点语义分散。治理事实写入全部
        委托ExecutionGovernanceService的重入安全方法，提交事务仍属Gate。
        """
        claim_state = state.result_claim
        if not claim_state:
            await self._trace(
                {"claim_id": None},
                {"status": "not_applicable", "reason": "本轮没有需要提交完成声明的Claim"},
            )
            await ctx.send_message(state)
            return
        snapshot = await self._pipeline.claim_snapshot(str(claim_state["claim_id"]))
        if snapshot["status"] != "candidate":
            # 恢复重放：Claim已由同一命令解决。投影既有ResultCommit而不是
            # 只改状态，下游与审计仍能看到result_commit_id与结局。
            outcome = await self._pipeline.claim_outcome(str(claim_state["claim_id"]))
            commit = outcome.get("result_commit") or {}
            await self._trace(
                dict(snapshot),
                {
                    "status": "already_resolved",
                    "claim_status": snapshot["status"],
                    "result_commit_id": commit.get("id"),
                    "commit_status": commit.get("commit_status"),
                },
            )
            await ctx.send_message(
                replace(
                    state,
                    result_claim={
                        **claim_state,
                        "status": snapshot["status"],
                        "result_commit_id": commit.get("id"),
                        "commit_status": commit.get("commit_status"),
                        "committed_subject_state": commit.get("committed_subject_state"),
                    },
                )
            )
            return
        committable = await self._pipeline.committable(snapshot["claim_id"])
        # append-only合同（治理§6.3）：单个不可变DecisionSubject冻结Claim身份、
        # 每个允许action对应的精确结局映射与Adoption映射；DecisionRecord创建时
        # 即绑定该Subject，decision_code决定所选映射，Gate同事务按映射创建
        # Adoption，绝不事后改写Subject或Decision。
        adoptions = await self._pipeline.adoption_map(snapshot["claim_id"])
        # 第八轮复审P1：disposition只由权威Claim/Revision事实决定；Workflow
        # state只是投影，丢失或被篡改都不能改变冻结结果。
        has_artifact = snapshot["artifact_revision_id"] is not None
        accept_disposition = "accepted" if has_artifact else "none"
        reject_disposition = "rejected" if has_artifact and snapshot["artifact_revision_current"] else "none"
        decision_view = result_commit_decision_view(
            claim_id=str(snapshot["claim_id"]),
            claim_hash=str(snapshot["claim_hash"]),
            claim_row_version=int(snapshot["claim_row_version"]),
            action_outcomes={
                "accept": {
                    "commit_status": "accepted",
                    "artifact_disposition": accept_disposition,
                    "adoptions": adoptions,
                },
                "waive": {
                    "commit_status": "waived",
                    "artifact_disposition": accept_disposition,
                    "adoptions": adoptions,
                },
                "reject": {
                    "commit_status": "rejected",
                    "artifact_disposition": reject_disposition,
                    "adoptions": {},
                },
            },
        )
        run_context = await self._governance.run_context(self._run_id())
        subject = await self._governance.register_subject(
            subject_kind="result_candidate",
            resource_id=str(snapshot["claim_id"]),
            resource_revision=str(snapshot["claim_row_version"]),
            subject_content=decision_view,
            session_id=str(run_context["session_id"]),
            interaction_id=run_context["interaction_id"],
            run_id=str(run_context["run_id"]),
            run_attempt_id=run_context["run_attempt_id"],
            workflow_definition_id=WORKFLOW_ID,
            workflow_version=WORKFLOW_VERSION,
            node_id=self.id,
            decision_view=decision_view,
        )
        scopes = [
            {"kind": "product_default", "ref_id": "*"},
            {"kind": "principal", "ref_id": self._governance.principal_id},
            {"kind": "product_session", "ref_id": self._thread_id},
            {"kind": "interaction", "ref_id": str(run_context["interaction_id"] or "")},
            {"kind": "run", "ref_id": self._run_id()},
            {"kind": "workflow_version", "ref_id": WORKFLOW_ID},
            {"kind": "workflow_node", "ref_id": self.id},
            {"kind": "scenario", "ref_id": state.scenario},
        ]
        facts = {
            "result": {
                "evidence_sufficient": committable,
                "external_delivery": False,
                "changes_long_term_state": True,
            }
        }
        evaluation, preview = await self._governance.evaluate_subject(
            subject=subject,
            decision_point_key="result_commit",
            scopes=scopes,
            facts=facts,
        )
        final_action = str(preview["final_action"])
        if final_action == "deny":
            await self._governance.record_automatic_decision(
                evaluation=evaluation,
                subject=subject,
                decision_code="deny",
                grant_kind=None,
                binding_hash=subject.subject_hash,
            )
            await self._trace(dict(snapshot), {"status": "denied", "reason": "HITL策略阻止结果提交"})
            raise PermissionError("HITL策略阻止决策点: result_claim_decision")
        if final_action == "auto_continue" and committable:
            record, grant = await self._governance.record_automatic_decision(
                evaluation=evaluation,
                subject=subject,
                decision_code="accept",
                grant_kind="commit_result",
                binding_hash=subject.subject_hash,
            )
            if grant is not None:
                await self._consume_grant(grant.id, subject.subject_hash)
            next_state = await self._commit(
                state,
                frozen=snapshot,
                decision_record_id=record.id,
                commit_status="accepted",
                artifact_disposition=accept_disposition,
                outcome="auto_accepted",
            )
            await ctx.send_message(next_state)
            return
        # 证据不足或结果未知时强制人工，即使策略允许自动推进；用户只能拒绝。
        allowed_actions = ["accept", "reject"] if committable else ["reject"]
        request = await self._governance.create_human_request(
            evaluation=evaluation,
            subject=subject,
            decision_point_key="result_commit",
            title="确认隔离执行结果并完成Action",
            reason=(
                "确定性Validation与文件Hash证据均已支持完成声明。"
                if committable
                else "Validation失败、超时或结果未知：不能自动接受，只能拒绝本次完成声明。"
            ),
            evidence={
                "workflow_node_id": self.id,
                "claim": dict(snapshot),
                "committable": committable,
                "validations": list(claim_state.get("validations") or []),
                "policy": preview,
            },
            consequence={
                "accept": "接受证据并原子完成该Action；父Work保持进行中。",
                "reject": "拒绝本次结果；Claim与Artifact记为rejected，Action状态不变。",
            },
            allowed_actions=allowed_actions,
        )
        card = {
            "review_kind": "product_decision",
            "message": "隔离执行与确定性Validation已完成，是否接受结果并完成对应Action？",
            "approval_id": request.id,
            "decision_request_id": request.id,
            "decision_item_key": subject.id,
            "decision_point_key": "result_commit",
            "title": "确认隔离执行结果并完成Action",
            "reason_summary": request.reason_summary,
            "request_hash": request.request_hash,
            "row_version": request.row_version,
            "subject_hash": subject.subject_hash,
            "subject_resource_id": subject.resource_id,
            "subject": {
                "goal": "接受证据并完成隔离执行Action，或拒绝本次结果",
                "claim": dict(snapshot),
                "committable": committable,
                "validations": list(claim_state.get("validations") or []),
            },
            "facts": facts,
            "policy": preview,
            "claim": {
                **dict(snapshot),
                "accept_artifact_disposition": accept_disposition,
                "reject_artifact_disposition": reject_disposition,
            },
            "committable": committable,
            "validations": list(claim_state.get("validations") or []),
            "allowed_actions": allowed_actions,
            "editable_fields": [],
            "execution_context": {
                "workflow_id": WORKFLOW_ID,
                "workflow_version": WORKFLOW_VERSION,
                "executor_id": self.id,
                "workflow_state": _state_mapping(state),
                "wait_reason": "product_decision",
            },
        }
        await self._sessions.mark_waiting_approval(self._thread_id, approval_id=request.id)
        await self._trace(
            dict(snapshot),
            {"status": "waiting_human", "committable": committable},
        )
        await ctx.request_info(card, dict, request_id=request.id)

    @response_handler(request=dict, response=dict, workflow_output=str)
    async def resolve(self, original_request, decision, ctx) -> None:
        """Resolve the human decision and commit through the gate.

        规模审查（93行，工程规范§4）：resume重放一致性校验、冻结身份/处置
        fail-closed、Grant消费与accept/reject两条提交路径共享一个错误边界
        （已知domain code保留、未知脱敏）；拆开会让“先验证后消费”的顺序
        保证被切割。测试边界：backend/tests/test_result_gate.py的冻结字段
        缺失/非法、auto重进、superseded reject-none与无Artifact accept用例。
        """
        try:
            state_value = original_request.get("execution_context", {}).get("workflow_state")
            if not isinstance(state_value, dict):
                raise ExecutionDispatchError(
                    "结果Claim决定缺少Workflow状态",
                    code="RESULT_CLAIM_STATE_MISSING",
                )
            state = state_from_snapshot(state_value)
            action = str(decision.get("decision") or "")
            if decision.get("decision_recorded") is True:
                [resolved] = await self._governance.resolved_human_request(
                    str(original_request["decision_request_id"])
                )
                if resolved["decision"] != action:
                    raise ExecutionDispatchError(
                        "Outbox决定与MAF Resume payload不一致",
                        code="RESULT_CLAIM_DECISION_MISMATCH",
                    )
            else:
                resolved = await self._governance.resolve_single_human_request(
                    request_id=str(original_request["decision_request_id"]),
                    expected_request_hash=str(original_request["request_hash"]),
                    expected_row_version=int(original_request["row_version"]),
                    decision=action,
                )
            claim_state = dict(state.result_claim or {})
            # 提交必须使用人工卡中冻结的Claim身份：首次与Outbox重放的
            # request_hash完全相同，Gate按同一command_id返回原结果；陈旧或
            # 并发仍由Gate在自己的事务内拒绝。
            frozen = original_request.get("claim")
            if not isinstance(frozen, Mapping) or frozen.get("claim_id") != claim_state.get("claim_id"):
                raise ExecutionDispatchError(
                    "结果Claim决定请求缺少冻结的Claim身份",
                    code="RESULT_CLAIM_FROZEN_IDENTITY_MISSING",
                )
            decision_record_id = str(resolved["decision_record_id"])
            if action == "accept":
                # 第九轮复审P1：处置值必须存在且精确属于允许集合；缺失/空/非法
                # 一律稳定失败，且在任何Grant消费之前。
                accept_disposition = _require_frozen_disposition(
                    frozen,
                    key="accept_artifact_disposition",
                    allowed={"accepted", "none"},
                )
                grant_id = resolved.get("authorization_grant_id")
                if grant_id:
                    await self._consume_grant(str(grant_id), str(resolved["binding_hash"]))
                next_state = await self._commit(
                    state,
                    frozen=frozen,
                    decision_record_id=decision_record_id,
                    commit_status="accepted",
                    artifact_disposition=accept_disposition,
                    outcome="accepted",
                )
            elif action == "reject":
                # 冻结的reject disposition来自权威Revision事实（当前项rejected、
                # 已替代none）；decision_code=reject选中冻结outcome，独立拒绝
                # 路径不迁移subject。
                reject_disposition = _require_frozen_disposition(
                    frozen,
                    key="reject_artifact_disposition",
                    allowed={"rejected", "none"},
                )
                next_state = await self._commit(
                    state,
                    frozen=frozen,
                    decision_record_id=decision_record_id,
                    commit_status="rejected",
                    artifact_disposition=reject_disposition,
                    outcome="rejected",
                )
            else:
                raise ExecutionDispatchError(
                    "不支持的结果Claim决定",
                    code="RESULT_CLAIM_DECISION_INVALID",
                )
            await ctx.send_message(next_state)
        except PermissionError:
            raise
        except Exception as error:
            code, message = _failure_code_and_message(
                error,
                fallback_code="RESULT_CLAIM_DECISION_FAILED",
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                error_code=code,
                message=message,
            )
            raise

    async def _commit(
        self,
        state: CollaborationState,
        *,
        frozen: Mapping[str, Any],
        decision_record_id: str,
        commit_status: str,
        artifact_disposition: str,
        outcome: str,
    ) -> CollaborationState:
        result = await self._pipeline.commit(
            claim_id=str(frozen["claim_id"]),
            claim_hash=str(frozen["claim_hash"]),
            expected_claim_row_version=int(frozen["claim_row_version"]),
            decision_record_id=decision_record_id,
            commit_status=commit_status,
            artifact_disposition=artifact_disposition,
            command_id=f"sd4:{self._run_id()}:commit-result",
        )
        claim_state = dict(state.result_claim or {})
        claim_state.update(
            {
                "status": result["claim"]["status"],
                "result_commit_id": result["result_commit_id"],
                "commit_status": commit_status,
                "committed_subject_state": result["committed_subject_state"],
            }
        )
        await self._trace(
            dict(frozen),
            {
                "status": outcome,
                "result_commit_id": result["result_commit_id"],
                "commit_status": commit_status,
                "artifact_disposition": artifact_disposition,
                "committed_subject_state": result["committed_subject_state"],
            },
        )
        return replace(state, result_claim=claim_state)

    async def _consume_grant(self, grant_id: str, binding_hash: str) -> None:
        await self._governance.claim_grant(
            grant_id=grant_id,
            binding_hash=binding_hash,
            consumer_kind="workflow_decision",
            consumer_id=f"{self._run_id()}:{self.id}",
            idempotency_key=f"workflow-decision:{self._run_id()}:{self.id}:{binding_hash}",
            claimed_by=f"api-pid-{os.getpid()}:{self.id}",
        )

    async def _trace(
        self,
        public_input: Mapping[str, Any],
        public_output: Mapping[str, Any],
    ) -> None:
        await _record_trace(
            sessions=self._sessions,
            thread_id=self._thread_id,
            run_id=self._run_id(),
            executor_id=self.id,
            content_type="result_claim_decision",
            public_input=public_input,
            public_output=public_output,
        )


def _state_mapping(state: CollaborationState) -> dict[str, Any]:
    return asdict(state)
