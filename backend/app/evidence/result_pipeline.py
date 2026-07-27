"""SD4-C result evidence pipeline: consume the approved Validation Contract.

This coordinator turns one *succeeded* governed pi workspace execution into a
CompletionClaim backed by deterministic Evidence.  The contract it validates
against is **never re-read from the live plan**: the ExecutionDraft/RunSpec
froze the exact TaskPlan revision, subject Action identity + revision and the
compiled argv/hash/capability binding before execution authorization (P0-1,
``ValidationContractPlanner``).  ``prepare`` only:

```text
approved RunSpec.validation_evidence.contract (frozen)
-> re-verify contract hash + recompile rules against the managed workspace
-> re-verify frozen subject Action id + revision (P0-2)
-> diff_patch Artifact (managed workspace diff bytes, content-addressed)
-> ValidationContract + CompletionClaim + mandatory Requirements
-> ResultValidationRunner (ValidationRun -> Observation -> Assessment)
-> ResultCommitCoordinator (Gate同事务按Decision映射创建Adoption并原子推进Action)
```

Failure boundary (P1-4): a succeeded workspace run with approved edits is
*never* silently "not applicable" when completion prerequisites are missing —
no Artifact Store, no Validation Runtime, no frozen contract or any drift
raises a stable domain error and fails the Run instead of bypassing the gate.
``not_applicable`` remains only for runs that are not workspace executions or
produced no approved change (nothing to complete).

Every step is keyed by deterministic ``sd4:{run_id}:...`` command ids, so a
checkpoint resume or retried executor never duplicates a Contract, Artifact,
Claim, ValidationRun, Observation or Assessment; Adoptions are only created
by the Result Commit Gate inside its transaction (``:adoption:`` command ids
make that path replay-safe as well).  Artifact bytes use
the ArtifactStore staging/publish protocol (filesystem cannot join a DB
transaction); a committed *candidate* Artifact surviving a later Claim failure
is an honest, retry-safe state per §9.1.  The Result Commit itself is
delegated to ``ResultCommitCoordinator``, the single owner of the §9.1 gate
transaction; validation execution and Evidence recording live in the
``ResultValidationRunner`` collaborator (result_validation.py).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..execution_workspaces.service import ExecutionWorkspaceService
from ..governance.catalog import COMPILER_VERSION as _COMPILER_VERSION
from ..governance.catalog import RUN_SPEC_SCHEMA_VERSION as _RUN_SPEC_SCHEMA_VERSION
from ..governance.models import RunSpecRecord
from ..governance.service import run_spec_content_hash
from ..harness.commands import HarnessCommandRecorder
from ..harness.contracts import HarnessError
from ..harness.models import ActionItemRecord, WorkItemRecord
from ..harness.participant import HarnessTransitionParticipant
from ..harness.plans import require_current_plan_revision
from ..product_sessions.database import ProductDatabase, ToolExecutionRecord
from ..runtime_execution.service import RuntimeExecutionService
from ..tool_execution.service import ToolOperationService
from .artifact_store import ArtifactCoordinator
from .contracts import (
    EvidenceConflict,
    EvidenceNotFound,
    ResultEvidencePrerequisiteMissing,
    ValidationContractMismatch,
    content_hash,
)
from .models import (
    ArtifactRecord,
    ArtifactRevisionRecord,
    CompletionClaimRecord,
    CompletionClaimRequirementRecord,
    EvidenceAssessmentRecord,
    RequirementWaiverRecord,
    ValidationContractRecord,
)
from .result_commit import ResultCommitCoordinator
from .result_validation import FrozenValidationPlan, ResultValidationRunner
from .service import EvidenceRepository
from .validation_runtime import (
    CompiledValidation,
    ValidationCapabilityCatalog,
    ValidationCompiler,
    ValidationProcessRunner,
    workspace_validation_files,
)

logger = logging.getLogger(__name__)

_CONTRACT_SCHEMA_VERSION = "validation-contract-v2"
_MAX_DIFF_BYTES = 512 * 1024


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ResultPipelineCoordinator:
    """Own the deterministic result-evidence use cases for one Product Run."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        scope_id: str,
        principal_id: str,
        artifact_coordinator: ArtifactCoordinator | None,
        validation_capabilities: ValidationCapabilityCatalog,
        validation_compiler: ValidationCompiler | None,
        validation_runner: ValidationProcessRunner,
        result_commit: ResultCommitCoordinator,
        workspaces: ExecutionWorkspaceService,
        tool_operations: ToolOperationService,
        runtime: RuntimeExecutionService,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.database = database
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock or _utc_now
        self._artifact_coordinator = artifact_coordinator
        self._capabilities = validation_capabilities
        self._compiler = validation_compiler
        self._result_commit = result_commit
        self._workspaces = workspaces
        self._tool_operations = tool_operations
        self._recorder = HarnessCommandRecorder(
            scope_id=scope_id,
            principal_id=principal_id,
            clock=self._clock,
        )
        self._validation = ResultValidationRunner(
            database,
            scope_id=scope_id,
            principal_id=principal_id,
            clock=self._clock,
            recorder=self._recorder,
            validation_runner=validation_runner,
            runtime=runtime,
        )

    # ------------------------------------------------------------------
    # public use cases
    # ------------------------------------------------------------------

    async def prepare(
        self,
        *,
        session_id: str,
        run_id: str,
        tool_execution_id: str,
    ) -> dict[str, Any]:
        """Build Claim + contract + artifact + Evidence for one pi workspace run.

        ``{"status": "not_applicable"}`` only when this is not a succeeded
        workspace execution, produced no approved change, or the approved
        Draft explicitly recorded "no completion subject this turn"; every
        other missing prerequisite raises a stable domain error (fail closed).

        规模说明（>80行审查）：本函数是§14结果证据链的唯一编排入口，
        “执行事实读取 -> 冻结合同复检 -> Artifact -> Claim事务 -> 验证执行”
        必须作为一个可审计线性序列阅读；步骤拆散会让重放/失败边界失去单一
        证据面。可变状态只落在``_get_or_create_*``与ResultValidationRunner，
        测试边界：backend/tests/test_result_pipeline.py逐场景覆盖每个分支。
        """
        async with self.database.sessions() as transaction:
            execution = await transaction.get(ToolExecutionRecord, tool_execution_id)
            if execution is None or execution.run_id != run_id or execution.session_id != session_id:
                raise EvidenceNotFound("结果证据链缺少对应的ToolExecution")
            if execution.status != "succeeded" or execution.mode != "workspace_edit":
                return self._not_applicable("tool_execution_not_succeeded")
            if not execution.repository_snapshot_id or not execution.run_attempt_id:
                raise ResultEvidencePrerequisiteMissing("ToolExecution缺少Snapshot或Attempt绑定")
            snapshot_id = str(execution.repository_snapshot_id)
            run_attempt_id = str(execution.run_attempt_id)
        workspace = await self._workspaces.get_for_tool_execution(tool_execution_id)
        if workspace is None or workspace.get("status") != "retained":
            raise ResultEvidencePrerequisiteMissing("Execution Workspace未处于retained终态")
        workspace_id = str(workspace["id"])
        operations = await self._tool_operations.list_for_tool_execution(tool_execution_id)
        edit_operations = [
            operation
            for operation in operations
            if operation["tool_name"] == "edit" and operation["status"] == "succeeded"
        ]
        if not edit_operations:
            return self._not_applicable("no_committed_edit_operation")
        workspace_path = await self._workspaces.private_path(workspace_id)
        diff_bytes = await self._workspaces.diff_text(workspace_id, max_bytes=_MAX_DIFF_BYTES)
        if not diff_bytes.strip():
            return self._not_applicable("empty_workspace_diff")

        # P0-1/P1-4：先消费RunSpec冻结判定。Draft冻结阶段已明确“本轮无完成
        # 主体”（contract显式为null）时才允许not_applicable；合同存在但
        # Store/Compiler缺失是基础设施缺口，必须fail closed。
        frozen_value = await self._frozen_contract_value(run_id=run_id)
        if frozen_value is None:
            return self._not_applicable("no_completion_subject")
        frozen = frozen_value
        if self._artifact_coordinator is None:
            raise ResultEvidencePrerequisiteMissing("Artifact Store未配置，不能形成完成Artifact")
        if self._compiler is None:
            raise ResultEvidencePrerequisiteMissing("Validation Runtime未配置，不能执行冻结合同")

        rules_json = list(frozen["rules"])
        contract_hash = str(frozen["contract_hash"])
        if content_hash({"schema_version": _CONTRACT_SCHEMA_VERSION, "rules": rules_json}) != (contract_hash):
            raise ValidationContractMismatch("冻结Validation Contract内容与Hash不一致")
        compiled_rules = self._reverify_rules(
            rules_json,
            workspace_path=workspace_path,
        )

        artifact = await self._artifact_coordinator.create_artifact(
            kind="diff_patch",
            title=f"隔离工作区变更 Diff（Run {run_id[:8]}）",
            media_type="text/x-diff",
            content=diff_bytes,
            command_id=f"sd4:{run_id}:diff-artifact",
            excerpt=diff_bytes[:480].decode("utf-8", errors="replace"),
            product_run_id=run_id,
            run_attempt_id=run_attempt_id,
        )

        async with self.database.sessions.begin() as transaction:
            contract = await self._get_or_create_contract(
                transaction,
                plan_revision_id=str(frozen["plan_revision_id"]),
                contract_hash=contract_hash,
                rules_json=rules_json,
                command_id=f"sd4:{run_id}:validation-contract",
            )
            artifact_record = await transaction.get(ArtifactRecord, artifact.artifact_id)
            if artifact_record is None:
                raise EvidenceNotFound("结果Artifact Record不存在")
            action = await self._require_frozen_subject(
                transaction,
                run_id=run_id,
                subject=frozen["subject"],
                frozen_plan_revision_id=str(frozen["plan_revision_id"]),
            )
            requirements = self._claim_requirements(
                rules_json=rules_json,
                edit_operations=edit_operations,
            )
            claim = await self._get_or_create_claim(
                transaction,
                action=action,
                contract=contract,
                artifact=artifact,
                artifact_record=artifact_record,
                repository_snapshot_id=snapshot_id,
                requirements=requirements,
                command_id=f"sd4:{run_id}:claim",
            )
        validation_summary = await self._validation.execute(
            FrozenValidationPlan(
                run_id=run_id,
                run_attempt_id=run_attempt_id,
                session_id=session_id,
                claim=claim,
                contract=contract,
                contract_hash=contract_hash,
                frozen_rules=rules_json,
                compiled_rules=compiled_rules,
                workspace_id=workspace_id,
                workspace_path=workspace_path,
                snapshot_id=snapshot_id,
                edit_operations=edit_operations,
            )
        )
        committable = await self.committable(claim.id)
        logger.info(
            "result_claim_prepared run=%s claim=%s committable=%s validations=%d",
            run_id,
            claim.id,
            committable,
            len(validation_summary),
        )
        return {
            "status": "prepared",
            "claim_id": claim.id,
            "claim_hash": claim.claim_hash,
            "claim_row_version": claim.row_version,
            "subject_kind": "action_item",
            "subject_id": action.id,
            "validation_contract_id": contract.id,
            "artifact_revision_id": artifact.artifact_revision_id,
            "artifact_id": artifact.artifact_id,
            "repository_snapshot_id": snapshot_id,
            "committable": committable,
            "validations": validation_summary,
        }

    async def claim_snapshot(self, claim_id: str) -> dict[str, Any]:
        """Fresh authoritative Claim identity for decision registration only.

        Commit calls must instead use the frozen identity captured in the
        human card / DecisionSubject so a replayed command carries the exact
        same request hash (幂等审查：fresh row_version would collide with the
        recorded command instead of replaying it).  Artifact facts come from
        the authoritative rows only — Workflow state is a projection and must
        never decide dispositions (第八轮复审P1)。
        """

        async with self.database.sessions() as transaction:
            claim = await transaction.get(CompletionClaimRecord, claim_id)
            if claim is None or claim.scope_id != self.scope_id:
                raise EvidenceNotFound("CompletionClaim不存在")
            artifact_revision_current: bool | None = None
            if claim.artifact_revision_id is not None:
                revision = await transaction.get(ArtifactRevisionRecord, claim.artifact_revision_id)
                current = None
                if revision is not None:
                    current = await transaction.scalar(
                        select(ArtifactRevisionRecord)
                        .where(ArtifactRevisionRecord.artifact_id == revision.artifact_id)
                        .order_by(ArtifactRevisionRecord.revision_number.desc())
                        .limit(1)
                    )
                artifact_revision_current = current is not None and current.id == claim.artifact_revision_id
            return {
                "claim_id": claim.id,
                "claim_hash": claim.claim_hash,
                "claim_row_version": claim.row_version,
                "status": claim.status,
                "artifact_revision_id": claim.artifact_revision_id,
                "artifact_revision_current": artifact_revision_current,
            }

    async def claim_outcome(self, claim_id: str) -> dict[str, Any]:
        """Project an already-resolved Claim with its ResultCommit for resume."""

        return await self._result_commit.claim_view(claim_id)

    async def adoption_map(self, claim_id: str) -> dict[str, str]:
        """Map each adoptable mandatory Requirement to its current supports Assessment.

        A（二次审核）：Adoption不再由验证阶段创建；result_commit Decision冻结
        这份映射，Result Commit Gate在同事务按映射创建Adoption。被豁免或没有
        当前supports结论的Requirement不进入映射。
        """

        async with self.database.sessions() as transaction:
            requirements = list(
                (
                    await transaction.scalars(
                        select(CompletionClaimRequirementRecord).where(
                            CompletionClaimRequirementRecord.completion_claim_id == claim_id,
                            CompletionClaimRequirementRecord.mandatory.is_(True),
                        )
                    )
                ).all()
            )
            mapping: dict[str, str] = {}
            for requirement in requirements:
                waived = await transaction.scalar(
                    select(RequirementWaiverRecord.id)
                    .where(RequirementWaiverRecord.requirement_id == requirement.id)
                    .limit(1)
                )
                if waived is not None:
                    continue
                current = await transaction.scalar(
                    select(EvidenceAssessmentRecord)
                    .where(
                        EvidenceAssessmentRecord.scope_id == self.scope_id,
                        EvidenceAssessmentRecord.requirement_id == requirement.id,
                    )
                    .order_by(EvidenceAssessmentRecord.assessment_sequence.desc())
                    .limit(1)
                )
                if current is not None and current.verdict == "supports":
                    mapping[requirement.id] = current.id
            return mapping

    async def committable(self, claim_id: str) -> bool:
        """True when every mandatory Requirement has an adoptable supports Assessment."""

        async with self.database.sessions() as transaction:
            mandatory_count = int(
                await transaction.scalar(
                    select(func.count())
                    .select_from(CompletionClaimRequirementRecord)
                    .where(
                        CompletionClaimRequirementRecord.completion_claim_id == claim_id,
                        CompletionClaimRequirementRecord.mandatory.is_(True),
                    )
                )
                or 0
            )
        mapping = await self.adoption_map(claim_id)
        return mandatory_count > 0 and len(mapping) == mandatory_count

    async def commit(
        self,
        *,
        claim_id: str,
        claim_hash: str,
        expected_claim_row_version: int,
        decision_record_id: str,
        commit_status: str,
        artifact_disposition: str,
        command_id: str,
    ) -> dict[str, Any]:
        """Delegate to the §9.1 gate with the frozen Claim identity.

        The caller passes the identity frozen in the decision card; the gate
        re-validates staleness and concurrency inside its own transaction.
        """

        return await self._result_commit.commit_result(
            claim_id=claim_id,
            claim_hash=claim_hash,
            expected_claim_row_version=expected_claim_row_version,
            decision_record_id=decision_record_id,
            commit_status=commit_status,
            artifact_disposition=artifact_disposition,
            command_id=command_id,
        )

    # ------------------------------------------------------------------
    # frozen contract consumption (P0-1)
    # ------------------------------------------------------------------

    @staticmethod
    def _not_applicable(reason: str) -> dict[str, Any]:
        logger.info("result_claim_not_applicable reason=%s", reason)
        return {"status": "not_applicable", "reason": reason}

    async def _frozen_contract_value(self, *, run_id: str) -> Mapping[str, Any] | None:
        """Resolve the frozen contract decision from the immutable RunSpec.

        Returns None only when the approved Draft explicitly recorded "no
        completion subject this turn" (``contract: null``).  A missing key or
        any integrity drift fails closed (D).
        """

        async with self.database.sessions() as transaction:
            spec = await transaction.scalar(select(RunSpecRecord).where(RunSpecRecord.bound_run_id == run_id))
        if spec is None:
            raise ResultEvidencePrerequisiteMissing("Product Run缺少绑定的不可变RunSpec")
        # D：先验证RunSpec行的权威状态与完整内容Hash，再信任其中冻结的合同；
        # spec_json被兼容层或手工篡改时必须fail closed。
        if spec.status != "bound" or spec.bound_run_id != run_id:
            raise ValidationContractMismatch("RunSpec不是当前Run的bound不可变合同")
        if spec.schema_version != _RUN_SPEC_SCHEMA_VERSION or spec.compiler_version != _COMPILER_VERSION:
            raise ValidationContractMismatch("RunSpec schema或compiler版本不受支持")
        if spec.run_spec_hash != run_spec_content_hash(dict(spec.spec_json or {})):
            raise ValidationContractMismatch("RunSpec内容Hash与spec_json不一致")
        evidence_plan = dict(spec.spec_json or {}).get("validation_evidence") or {}
        if "contract" not in evidence_plan:
            raise ResultEvidencePrerequisiteMissing(
                "已批准RunSpec缺少冻结的Validation Contract，需要重新授权ExecutionDraft"
            )
        frozen = evidence_plan["contract"]
        if frozen is None:
            return None
        if not isinstance(frozen, Mapping):
            raise ValidationContractMismatch("冻结Validation Contract结构无效")
        if frozen.get("schema_version") != _CONTRACT_SCHEMA_VERSION:
            raise ValidationContractMismatch("冻结Validation Contract的schema版本不受支持")
        rules = frozen.get("rules")
        subject = frozen.get("subject")
        if not isinstance(rules, list) or not rules or not isinstance(subject, Mapping):
            raise ValidationContractMismatch("冻结Validation Contract缺少规则或subject绑定")
        return frozen

    def _reverify_rules(
        self,
        rules_json: Sequence[Mapping[str, Any]],
        *,
        workspace_path: Any,
    ) -> dict[int, CompiledValidation]:
        """Recompile frozen params against the live workspace and compare hashes.

        The executed argv/capability must equal the approved ones; any drift
        (config pinning, capability definition, params) fails closed and
        requires a new authorized Draft instead of silently running a
        different command (E01).
        """
        assert self._compiler is not None
        files = workspace_validation_files(workspace_path)
        compiled_rules: dict[int, CompiledValidation] = {}
        for raw in rules_json:
            ordinal = int(raw["ordinal"])
            params = raw.get("params")
            if not isinstance(params, Mapping):
                raise ValidationContractMismatch("冻结Validation规则缺少params")
            definition = self._capabilities.require(
                str(raw["capability_key"]),
                str(raw["capability_version"]),
            )
            compiled = self._compiler.compile_with_files(
                definition,
                params=params,
                files=files,
            )
            if (
                compiled.capability_hash != raw["capability_hash"]
                or compiled.expanded_argv_hash != raw["expanded_argv_hash"]
                or list(compiled.expanded_argv) != list(raw["expanded_argv"])
            ):
                raise ValidationContractMismatch(
                    f"冻结Validation规则{ordinal}与当前Capability/Workspace编译结果不一致"
                )
            if (
                compiled.resolved_executable_hash != raw["resolved_executable_hash"]
                or compiled.environment_fingerprint != raw["environment_fingerprint"]
            ):
                raise ValidationContractMismatch(
                    f"冻结Validation规则{ordinal}的执行环境指纹已漂移，需要重新授权"
                )
            compiled_rules[ordinal] = compiled
        return compiled_rules

    async def _get_or_create_contract(
        self,
        transaction: AsyncSession,
        *,
        plan_revision_id: str,
        contract_hash: str,
        rules_json: list[dict[str, Any]],
        command_id: str,
    ) -> ValidationContractRecord:
        existing = await transaction.scalar(
            select(ValidationContractRecord).where(
                ValidationContractRecord.scope_id == self.scope_id,
                ValidationContractRecord.command_id == command_id,
            )
        )
        if existing is not None:
            if existing.contract_hash != contract_hash:
                raise EvidenceConflict("同一Validation Contract命令对应不同合同内容")
            return existing
        repository = self._repository()
        return await repository.create_validation_contract(
            transaction,
            plan_revision_id=plan_revision_id,
            contract_hash=contract_hash,
            schema_version=_CONTRACT_SCHEMA_VERSION,
            rules_json={"rules": rules_json},
            requires_integration=True,
            command_id=command_id,
        )

    async def _require_frozen_subject(
        self,
        transaction: AsyncSession,
        *,
        run_id: str,
        subject: Mapping[str, Any],
        frozen_plan_revision_id: str,
    ) -> ActionItemRecord:
        """Re-verify the approved subject Action identity and revision (P0-2/G).

        G幂等：同一命令已创建过Claim（checkpoint重放）时，Action已被本管线启动，
        row_version已越过冻结版本；此时以既有Claim为唯一事实源并返回当前
        Action，绝不要求新授权。

        规模审查（108行，工程规范§4）：本方法是一条“重放/新创建”双分支证明
        链——既有Claim重放复核、冻结revision比对、ready启动与Work/Plan归属
        链复检共享同一个事务与同一组不变量；拆开会让“哪个版本在哪个分支被
        接受”失去单一审计面，且启动Action与创建Claim的原子性被切割。
        测试边界：backend/tests/test_result_pipeline.py的G重放/外部推进/
        双Action/父Work取消/Plan推进攻击用例。
        """

        action_id = str(subject.get("action_item_id") or "")
        expected_revision = subject.get("action_item_revision")
        work_item_id = str(subject.get("work_item_id") or "")
        action = await transaction.get(ActionItemRecord, action_id)
        if (
            not action_id
            or action is None
            or action.scope_id != self.scope_id
            or action.work_item_id != work_item_id
        ):
            raise EvidenceNotFound("冻结的subject Action不存在于当前scope")
        # 第四轮复审P0-1：父Work与Project绑定在prepare时重检；Work被取消或
        # 离开in_progress时不得完成Action。第五轮复审P0-2：冻结的Work
        # revision与Plan revision也必须一致——授权后换了Plan或推进了Work，
        # 旧合同不得继续完成Action。管线自身不修改Work row_version，因此
        # 冻结值仍是可重检基线。
        work = await transaction.get(WorkItemRecord, work_item_id)
        if work is None or work.scope_id != self.scope_id:
            raise EvidenceNotFound("冻结的subject Work不存在于当前scope")
        if work.project_id != str(subject.get("project_id") or ""):
            raise EvidenceConflict("冻结的Project绑定与当前Work不一致")
        if work.status != "in_progress":
            raise EvidenceConflict(f"父Work当前状态{work.status}，不能接受Action完成")
        if work.row_version != subject.get("work_item_revision"):
            raise EvidenceConflict(
                f"父Work版本已变化：RunSpec冻结{subject.get('work_item_revision')}，"
                f"当前{work.row_version}；需要重新授权ExecutionDraft"
            )
        # 第六轮复审P0-1：沿 Work -> revision -> TaskPlan 复核权威归属与当前性，
        # 再与冻结合同的plan_revision_id精确比对。
        try:
            revision = await require_current_plan_revision(
                transaction,
                scope_id=self.scope_id,
                work=work,
                plan_revision_id=str(work.current_plan_revision_id or ""),
            )
        except HarnessError as error:
            raise EvidenceConflict(str(error)) from error
        if revision.id != str(frozen_plan_revision_id):
            raise EvidenceConflict("父Work当前Plan revision与冻结合同不一致")
        existing_claim = await transaction.scalar(
            select(CompletionClaimRecord).where(
                CompletionClaimRecord.scope_id == self.scope_id,
                CompletionClaimRecord.command_id == f"sd4:{run_id}:claim",
            )
        )
        if existing_claim is not None:
            # G收紧：重放只在“既有Claim正是本Run同Action命令、且当前Action
            # 仍是该Claim绑定的权威版本与from_state”时成立；任何外部推进都
            # fail closed，绝不继续验证或写入。
            if existing_claim.subject_id != action.id:
                raise EvidenceConflict("既有CompletionClaim的subject与冻结Action不一致")
            if action.row_version != existing_claim.expected_subject_version:
                raise EvidenceConflict(
                    f"subject Action版本已被外部推进：Claim期望{existing_claim.expected_subject_version}，"
                    f"当前{action.row_version}"
                )
            if action.status != existing_claim.from_state:
                raise EvidenceConflict(
                    f"subject Action状态已变化：Claim from_state {existing_claim.from_state}，"
                    f"当前{action.status}"
                )
        elif action.row_version != expected_revision:
            raise EvidenceConflict(
                f"subject Action版本已变化：RunSpec期望{expected_revision}，当前{action.row_version}；"
                "需要重新授权ExecutionDraft"
            )
        if action.status == "ready":
            # 已批准的 RunSpec 正在执行该 Action：同一事务内推进到
            # in_progress 后 Claim 才能绑定权威 from_state。
            participant = HarnessTransitionParticipant(
                scope_id=self.scope_id,
                principal_id=self.principal_id,
                clock=self._clock,
                command_recorder=self._recorder,
            )
            await participant.transition_action_item(
                transaction,
                action_item_id=action.id,
                command_id=f"sd4:{run_id}:action-start",
                request_hash=content_hash({"run_id": run_id, "action_id": action.id}),
                target_status="in_progress",
                reason="主Workflow开始隔离执行与验证该Action",
            )
            await transaction.flush()
            action = await transaction.get(ActionItemRecord, action.id)
            assert action is not None
        if action.status != "in_progress":
            raise EvidenceConflict(f"subject Action当前状态{action.status}不能接受完成声明")
        return action

    @staticmethod
    def _claim_requirements(
        *,
        rules_json: Sequence[Mapping[str, Any]],
        edit_operations: Sequence[Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        requirements: list[dict[str, Any]] = []
        for rule in rules_json:
            requirements.append(
                {
                    "requirement_kind": "validation_result",
                    "mandatory": True,
                    "description": (
                        f"确定性Validation规则{rule['ordinal']} "
                        f"({rule['capability_key']}@{rule['capability_version']})必须通过"
                    ),
                    "contract_rule_ordinal": int(rule["ordinal"]),
                    "params_json": {"expanded_argv_hash": rule["expanded_argv_hash"]},
                    "schema_version": "validation-result-v1",
                }
            )
        for operation in edit_operations:
            requirements.append(
                {
                    "requirement_kind": "file_hash_match",
                    "mandatory": True,
                    "description": (
                        f"精确edit文件{operation['target_path']}的观察Hash必须等于已批准postimage"
                    ),
                    "contract_rule_ordinal": None,
                    "params_json": {
                        "tool_operation_id": operation["id"],
                        "target_path": operation["target_path"],
                    },
                    "schema_version": "file-hash-match-v1",
                }
            )
        return requirements

    async def _get_or_create_claim(
        self,
        transaction: AsyncSession,
        *,
        action: ActionItemRecord,
        contract: ValidationContractRecord,
        artifact: Any,
        artifact_record: ArtifactRecord,
        repository_snapshot_id: str,
        requirements: list[dict[str, Any]],
        command_id: str,
    ) -> CompletionClaimRecord:
        existing = await transaction.scalar(
            select(CompletionClaimRecord).where(
                CompletionClaimRecord.scope_id == self.scope_id,
                CompletionClaimRecord.command_id == command_id,
            )
        )
        if existing is not None:
            if (
                existing.subject_id != action.id
                or existing.validation_contract_id != contract.id
                or existing.artifact_revision_id != artifact.artifact_revision_id
            ):
                raise EvidenceConflict("同一CompletionClaim命令对应不同声明内容")
            return existing
        repository = self._repository()
        return await repository.create_claim(
            transaction,
            subject_kind="action_item",
            subject_id=action.id,
            from_state="in_progress",
            target_transition="action_result_accepted",
            expected_subject_version=action.row_version,
            target_state="completed",
            artifact_revision_id=artifact.artifact_revision_id,
            expected_artifact_record_version=artifact_record.row_version,
            repository_snapshot_id=repository_snapshot_id,
            applicability_policy="record_only",
            validation_contract_id=contract.id,
            requirements=requirements,
            command_id=command_id,
        )

    def _repository(self) -> EvidenceRepository:
        return EvidenceRepository(
            scope_id=self.scope_id,
            principal_id=self.principal_id,
            clock=self._clock,
            command_recorder=self._recorder,
        )
