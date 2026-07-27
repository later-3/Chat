"""Freeze the approved Validation Contract into the ExecutionDraft (P0-1).

The ExecutionDraft/RunSpec is the only authority a pi workspace run may
validate against.  Before execution authorization, this planner:

1. resolves the single adopted subject Action (id + authoritative revision),
2. reads the Work's *currently accepted* TaskPlan revision and its
   ``validation_contract`` rules,
3. compiles each rule through the Capability Catalog and deterministic
   compiler against the approved Repository Snapshot bytes (``git show``,
   never the mutable source worktree),
4. returns the frozen section embedding plan revision id, subject identity,
   exact argv/argv hash, capability hash and environment fingerprint.

``ResultPipelineCoordinator`` later only consumes and re-verifies this frozen
section; it never re-reads the "current" plan after approval.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from ..evidence.contracts import (
    EvidenceConflict,
    EvidenceValidationError,
    ResultEvidencePrerequisiteMissing,
    content_hash,
)
from ..evidence.validation_runtime import (
    ValidationCapabilityCatalog,
    ValidationCompiler,
    snapshot_validation_files,
)
from ..harness.contracts import HarnessError
from ..harness.models import ActionItemRecord, WorkItemRecord
from ..harness.plans import require_current_plan_revision
from ..product_sessions.database import ProductDatabase
from .contracts import RepositoryFence
from .repository_context import RepositoryExecutionContextService

VALIDATION_CONTRACT_SCHEMA_VERSION = "validation-contract-v2"


class ValidationContractPlanner:
    """Deterministic, read-only planner owned by the draft compile step."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        scope_id: str,
        capabilities: ValidationCapabilityCatalog,
        compiler: ValidationCompiler | None,
        repository_execution_context: RepositoryExecutionContextService,
    ) -> None:
        self.database = database
        self.scope_id = scope_id
        self._capabilities = capabilities
        self._compiler = compiler
        self._repository_execution_context = repository_execution_context

    async def freeze(
        self,
        *,
        context_items: Sequence[Mapping[str, Any]],
        fence: RepositoryFence,
    ) -> dict[str, Any] | None:
        """Return the frozen contract section, or None only with zero adopted Actions.

        P1-4/第四轮复审P0-1：只有“本轮采用了0个Action”才是合法的no-subject；
        一旦存在adopted Action，就必须严格证明它是唯一且一致的主体——两个不同
        Action、同ID但revision冲突、不存在/跨scope、状态不合格、Work缺失、
        Work非in_progress或Action与RepositoryFence不同Project，全部稳定失败，
        绝不把歧义或坏引用当“无完成主体”放行。主Workflow只自动完成
        assignee_kind=agent的Action；唯一adopted主体是user/external责任时
        同样稳定失败并说明主Workflow无权自动完成该责任主体，不能伪装
        “无主体”继续成功（第五轮复审P0-1）。

        规模审查（133行，工程规范§4）：冻结是一次原子证明链——subject解析、
        权威版本/归属/assignee/Work/Plan归属链复核与快照编译必须共享同一个
        判定上下文，拆成多个查询函数会让“哪一步失败导致整体拒绝”失去单一
        证据面；每个分支的错误都是产品语义的一部分，不是可复用查询。
        测试边界：backend/tests/test_validation_contract_planner.py逐分支
        攻击用例（含跨Project、双Action、同ID冲突revision、user assignee、
        父Work状态与TaskPlan归属指针）。
        """
        adopted_actions = [
            item
            for item in context_items
            if item.get("adopted", True) is True and item.get("source_kind") == "action_item"
        ]
        if not adopted_actions:
            return None
        action_ids = {str(item.get("source_id")) for item in adopted_actions}
        if len(action_ids) > 1:
            raise EvidenceValidationError("本轮采用了多个Action，无法唯一确定完成主体；请先收敛到一个Action")
        revisions = {str(item.get("source_revision")) for item in adopted_actions}
        if len(revisions) > 1:
            raise EvidenceConflict("同一Action的采用项revision不一致，请刷新Context后重试")
        action_item = adopted_actions[0]
        action_id = str(action_item.get("source_id"))
        async with self.database.sessions() as transaction:
            action = await transaction.get(ActionItemRecord, action_id)
            if action is None or action.scope_id != self.scope_id:
                raise EvidenceValidationError("采用的Action不存在于当前scope")
            # C：冻结前必须证明用户本轮采用的Action版本仍是权威版本；陈旧
            # Context（其他Session已推进该Action）不能把最新版本静默纳入Draft。
            if str(action_item.get("source_revision")) != str(action.row_version):
                raise EvidenceConflict(
                    f"已采用的Action Context已陈旧：采用时版本{action_item.get('source_revision')}，"
                    f"当前权威版本{action.row_version}；请刷新Context后重新形成ExecutionDraft"
                )
            if action.status not in {"ready", "in_progress"}:
                raise EvidenceValidationError(f"采用的Action当前状态{action.status}不能接受完成声明")
            if action.assignee_kind != "agent":
                raise EvidenceValidationError(
                    f"采用的Action责任主体是{action.assignee_kind}，主Workflow无权自动完成"
                    "非agent责任的Action；请由对应责任路径处理"
                )
            if not action.work_item_id:
                raise EvidenceValidationError("采用的Action缺少所属WorkItem")
            work = await transaction.get(WorkItemRecord, action.work_item_id)
            if work is None or work.scope_id != self.scope_id:
                raise EvidenceValidationError("采用的Action所属Work不存在于当前scope")
            if work.project_id != fence.project_id:
                raise EvidenceValidationError("采用的Action所属Project与Repository Fence的Project不一致")
            if work.status != "in_progress":
                raise EvidenceValidationError(
                    f"父Work当前状态{work.status}，只有in_progress才能接受Action完成"
                )
            revision = None
            if work.current_plan_revision_id:
                # 第六轮复审P0-1：沿 Work -> revision -> TaskPlan 复核权威归属，
                # 不接受裸指针或跨Work/Project注入的accepted Revision。
                try:
                    revision = await require_current_plan_revision(
                        transaction,
                        scope_id=self.scope_id,
                        work=work,
                        plan_revision_id=work.current_plan_revision_id,
                    )
                except HarnessError as error:
                    raise EvidenceValidationError(str(error)) from error
            raw_contract = dict(revision.validation_contract_json or {}) if revision is not None else {}
            raw_rules = raw_contract.get("rules")
            if revision is None or not isinstance(raw_rules, list) or not raw_rules:
                raise ResultEvidencePrerequisiteMissing(
                    "已采纳Action的Work缺少已接受Plan的Validation Contract规则，不能为隔离编辑Run形成完成门"
                )
            subject = {
                "action_item_id": action.id,
                "action_item_revision": action.row_version,
                "work_item_id": action.work_item_id,
                "work_item_revision": work.row_version,
                "project_id": work.project_id,
            }
            plan_revision_id = revision.id
        if self._compiler is None:
            raise EvidenceValidationError("Validation Runtime未配置，不能冻结Validation Contract")
        if not fence.head_oid:
            raise EvidenceValidationError("Repository Snapshot缺少head_oid，不能冻结Validation Contract")
        repo_path = await self._repository_execution_context.resolve_private_path(fence)
        files = await snapshot_validation_files(repo_path, fence.head_oid)
        rules_json: list[dict[str, Any]] = []
        for index, raw in enumerate(raw_rules, start=1):
            if not isinstance(raw, Mapping):
                raise EvidenceValidationError("Validation Contract规则必须是对象")
            capability_key = str(raw.get("capability_key") or "")
            capability_version = str(raw.get("capability_version") or "")
            params = raw.get("params")
            if not capability_key or not capability_version or not isinstance(params, Mapping):
                raise EvidenceValidationError("Validation Contract规则缺少capability或params")
            definition = self._capabilities.require(capability_key, capability_version)
            compiled = self._compiler.compile_with_files(
                definition,
                params=params,
                files=files,
            )
            rules_json.append(
                {
                    "ordinal": index,
                    "capability_key": compiled.capability_key,
                    "capability_version": compiled.capability_version,
                    "capability_hash": compiled.capability_hash,
                    "params": dict(params),
                    "expanded_argv": list(compiled.expanded_argv),
                    "expanded_argv_hash": compiled.expanded_argv_hash,
                    "expected_exit_code": compiled.expected_exit_code,
                    "resolved_executable_hash": compiled.resolved_executable_hash,
                    "environment_fingerprint": compiled.environment_fingerprint,
                }
            )
        contract_hash = content_hash(
            {"schema_version": VALIDATION_CONTRACT_SCHEMA_VERSION, "rules": rules_json}
        )
        return {
            "schema_version": VALIDATION_CONTRACT_SCHEMA_VERSION,
            "subject": subject,
            "plan_revision_id": plan_revision_id,
            "contract_hash": contract_hash,
            "rules": rules_json,
        }
