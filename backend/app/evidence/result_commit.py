"""SD4-C Result Commit Gate: the single Product Store transaction that turns
"code changed, validation passed" into subject state advancement (§9.1).

The gate is the only entrance that writes accepted/waived ResultCommits: the
recording layer (``EvidenceRepository``) stays fail closed and requires the
``ClaimGateRecheck`` this coordinator produces inside the same transaction.
Evidence re-check, Artifact re-check, Decision binding, Artifact disposition,
subject CAS migration, Trace and Outbox succeed together or roll back
together; a rejected Claim never gets blocked by missing Evidence, advanced
Snapshots or subject CAS (§9.1 step 2, failure matrix 17).

Size review (AGENTS.md §7.1, >800 lines): the coordinator intentionally keeps
the whole §9.1 step sequence in one module.  The gate's core invariant is that
steps 1-11 execute in one transaction owned here, so the audit surface must
read as a single linear flow; splitting re-checks into sibling modules would
scatter the atomic boundary this file exists to prove.  Test boundary:
backend/tests/test_result_commit.py exercises each step and the rollback of
their composition.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..harness.commands import HarnessCommandRecorder
from ..harness.contracts import HarnessError, HarnessValidationError
from ..harness.models import ActionItemRecord, WorkItemRecord
from ..harness.participant import HarnessTransitionParticipant
from ..harness.plans import require_current_plan_revision
from ..product_sessions.database import ProductDatabase
from ..project_resources.models import (
    ProjectRepositoryBindingRecord,
    RepositorySnapshotRecord,
)
from .artifact_store import ArtifactStore
from .contracts import (
    ARTIFACT_DISPOSITIONS,
    CLAIM_SUBJECT_TRANSITION_RULES,
    RESULT_COMMIT_STATUSES,
    ArtifactApplicabilityStale,
    ArtifactRevisionSuperseded,
    AssessmentNotSupporting,
    ClaimGateRecheck,
    CompletionClaimAlreadyResolved,
    CompletionRequirementUnsatisfied,
    EvidenceConflict,
    EvidenceInvalid,
    EvidenceNotFound,
    EvidenceValidationError,
    SubjectTransitionNotAllowed,
    WaiverBlockedByFailedRequirement,
    content_hash,
)
from .decision_binding import require_result_commit_decision
from .models import (
    ArtifactBlobRecord,
    ArtifactRecord,
    ArtifactRevisionRecord,
    ClaimEvidenceAdoptionRecord,
    CompletionClaimRecord,
    CompletionClaimRequirementRecord,
    RequirementWaiverRecord,
    ResultCommitRecord,
    SourceInvalidationRecord,
    ValidationContractRecord,
)
from .ownership import EvidenceReferenceResolver
from .service import (
    EvidenceRepository,
    _issue_result_commit_gate_nonce,
    require_bound_result_commit_decision,
)

logger = logging.getLogger(__name__)

# Action states that still block a work_completed Claim (§4.6).  skipped and
# cancelled Actions are resolved outcomes and do not block Work closure.
_OPEN_ACTION_STATUSES = frozenset({"pending", "ready", "in_progress", "blocked"})


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ResultCommitCoordinator:
    """Application coordinator owning the Result Commit Gate transaction.

    This is the single transaction owner for the "commit a completion claim"
    use case (AGENTS.md §7.1): collaborators (EvidenceRepository,
    HarnessTransitionParticipant, HarnessCommandRecorder) receive the open
    ``AsyncSession`` and never begin their own transactions.
    """

    def __init__(
        self,
        database: ProductDatabase,
        *,
        store: ArtifactStore | None,
        scope_id: str,
        principal_id: str,
        clock: Callable[[], datetime] | None = None,
        participant: HarnessTransitionParticipant | None = None,
    ) -> None:
        self.database = database
        self.store = store
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock or _utc_now
        self._recorder = HarnessCommandRecorder(
            scope_id=scope_id,
            principal_id=principal_id,
            clock=self._clock,
        )
        if participant is None:
            participant = HarnessTransitionParticipant(
                scope_id=scope_id,
                principal_id=principal_id,
                clock=self._clock,
                command_recorder=self._recorder,
                completion_reference_validator=self._validate_completion_reference,
            )
        self._participant = participant

    async def commit_result(
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
        """Resolve one candidate Claim in a single Product Store transaction."""
        if commit_status not in RESULT_COMMIT_STATUSES:
            raise EvidenceValidationError(f"未知commit_status: {commit_status}")
        if artifact_disposition not in ARTIFACT_DISPOSITIONS:
            raise EvidenceValidationError(f"未知artifact_disposition: {artifact_disposition}")
        request_hash = content_hash(
            {
                "claim_id": claim_id,
                "claim_hash": claim_hash,
                "expected_claim_row_version": expected_claim_row_version,
                "decision_record_id": decision_record_id,
                "commit_status": commit_status,
                "artifact_disposition": artifact_disposition,
            }
        )
        async with self.database.sessions.begin() as transaction:
            existing = await self._recorder.existing(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            repository = EvidenceRepository(
                scope_id=self.scope_id,
                principal_id=self.principal_id,
                clock=self._clock,
                command_recorder=self._recorder,
            )
            resolver = EvidenceReferenceResolver(scope_id=self.scope_id)
            claim = await repository.get_claim(transaction, claim_id)
            if claim.claim_hash != claim_hash:
                raise EvidenceConflict("commit请求绑定的claim_hash与当前Claim不一致")
            if claim.row_version != expected_claim_row_version:
                raise EvidenceConflict(
                    f"commit请求期望Claim版本{expected_claim_row_version}，当前为{claim.row_version}"
                )
            if claim.status != "candidate":
                raise CompletionClaimAlreadyResolved("只有candidate状态的Claim才能提交ResultCommit")
            # 第七轮复审：纯请求形状（Claim Artifact绑定 × disposition组合）先于
            # Decision精确绑定稳定拒绝；形状错误不消耗也不依赖任何Decision。
            if claim.artifact_revision_id is None and artifact_disposition != "none":
                raise EvidenceValidationError("未绑定Artifact的Claim只能使用artifact_disposition=none")
            if commit_status in {"accepted", "waived"} and claim.artifact_revision_id is not None:
                if artifact_disposition == "none":
                    raise EvidenceValidationError(
                        "绑定当前Artifact Revision的Claim不能记录artifact_disposition=none"
                    )
            if commit_status == "rejected" and claim.artifact_revision_id is not None:
                revision = await resolver.resolve(
                    transaction,
                    kind="artifact_revision",
                    reference_id=claim.artifact_revision_id,
                )
                artifact = await repository.get_artifact_record(transaction, revision.artifact_id)
                current_revision = await repository.get_current_artifact_revision(transaction, artifact.id)
                if current_revision is not None and current_revision.id == claim.artifact_revision_id:
                    if artifact_disposition != "rejected":
                        raise EvidenceValidationError(
                            "Claim绑定的Artifact Revision仍是当前项，rejected只能使用rejected"
                        )
                elif artifact_disposition != "none":
                    raise EvidenceValidationError(
                        "Claim绑定的Artifact Revision已被替代，rejected只能使用artifact_disposition=none"
                    )
            decision = await resolver.resolve(
                transaction, kind="decision_record", reference_id=decision_record_id
            )
            await require_bound_result_commit_decision(
                transaction,
                decision=decision,
                claim=claim,
                commit_status=commit_status,
                artifact_disposition=artifact_disposition,
            )
            if commit_status == "rejected":
                outcome = await self._commit_rejected(
                    transaction,
                    repository=repository,
                    resolver=resolver,
                    claim=claim,
                    artifact_disposition=artifact_disposition,
                    decision_record_id=decision_record_id,
                    command_id=command_id,
                )
            else:
                outcome = await self._commit_adopted(
                    transaction,
                    repository=repository,
                    resolver=resolver,
                    claim=claim,
                    commit_status=commit_status,
                    artifact_disposition=artifact_disposition,
                    decision_record_id=decision_record_id,
                    command_id=command_id,
                )
            result = outcome["result"]
            self._recorder.record(
                transaction,
                command_id=command_id,
                command_kind="commit_result",
                request_hash=request_hash,
                result=result,
                resource_kind="completion_claim",
                resource_id=claim.id,
                event_type=f"evidence.result_commit.{commit_status}",
                trace_payload={
                    "claim_id": claim.id,
                    "result_commit_id": outcome["commit_id"],
                    "commit_status": commit_status,
                    "artifact_disposition": artifact_disposition,
                    "committed_subject_state": result["committed_subject_state"],
                },
                decision_record_id=decision_record_id,
            )
            logger.info(
                "result_commit_resolved claim=%s commit=%s status=%s disposition=%s",
                claim.id,
                outcome["commit_id"],
                commit_status,
                artifact_disposition,
            )
            return result

    async def claim_view(self, claim_id: str) -> dict[str, Any]:
        """Read one Claim with its Requirements, resolutions and ResultCommit."""
        async with self.database.sessions() as transaction:
            claim = await transaction.get(CompletionClaimRecord, claim_id)
            if claim is None or claim.scope_id != self.scope_id:
                raise EvidenceNotFound("Claim不存在")
            requirements = list(
                (
                    await transaction.scalars(
                        select(CompletionClaimRequirementRecord)
                        .where(CompletionClaimRequirementRecord.completion_claim_id == claim.id)
                        .order_by(CompletionClaimRequirementRecord.requirement_index)
                    )
                ).all()
            )
            adoptions = await self._claim_adoptions(transaction, claim_id=claim.id)
            waivers = await self._requirement_waivers(
                transaction, requirement_ids=[item.id for item in requirements]
            )
            commit = await transaction.scalar(
                select(ResultCommitRecord).where(ResultCommitRecord.completion_claim_id == claim.id).limit(1)
            )
            return {
                "id": claim.id,
                "subject_kind": claim.subject_kind,
                "subject_id": claim.subject_id,
                "expected_subject_version": claim.expected_subject_version,
                "from_state": claim.from_state,
                "target_transition": claim.target_transition,
                "target_state": claim.target_state,
                "applicability_policy": claim.applicability_policy,
                "repository_snapshot_id": claim.repository_snapshot_id,
                "artifact_revision_id": claim.artifact_revision_id,
                "expected_artifact_record_version": claim.expected_artifact_record_version,
                "claim_hash": claim.claim_hash,
                "status": claim.status,
                "decision_record_id": claim.decision_record_id,
                "row_version": claim.row_version,
                "requirements": [
                    {
                        "id": item.id,
                        "requirement_index": item.requirement_index,
                        "requirement_kind": item.requirement_kind,
                        "mandatory": item.mandatory,
                        "description": item.description,
                        "resolution": (
                            "adoption" if item.id in adoptions else "waiver" if item.id in waivers else "open"
                        ),
                    }
                    for item in requirements
                ],
                "result_commit": (
                    None
                    if commit is None
                    else {
                        "id": commit.id,
                        "commit_status": commit.commit_status,
                        "artifact_disposition": commit.artifact_disposition,
                        "pre_commit_validity_check_passed": commit.pre_commit_validity_check_passed,
                        "committed_subject_state": commit.committed_subject_state,
                        "created_at": commit.created_at.isoformat(),
                    }
                ),
                "created_at": claim.created_at.isoformat(),
                "updated_at": claim.updated_at.isoformat(),
            }

    async def _commit_rejected(
        self,
        transaction: AsyncSession,
        *,
        repository: EvidenceRepository,
        resolver: EvidenceReferenceResolver,
        claim: CompletionClaimRecord,
        artifact_disposition: str,
        decision_record_id: str,
        command_id: str,
    ) -> dict[str, Any]:
        """§9.1 step 2: rejection never runs evidence/applicability/subject checks."""
        artifact: ArtifactRecord | None = None
        if claim.artifact_revision_id is None:
            if artifact_disposition != "none":
                raise EvidenceValidationError("未绑定Artifact的Claim只能使用artifact_disposition=none")
        else:
            revision = await resolver.resolve(
                transaction, kind="artifact_revision", reference_id=claim.artifact_revision_id
            )
            artifact = await repository.get_artifact_record(transaction, revision.artifact_id)
            current = await repository.get_current_artifact_revision(transaction, artifact.id)
            if current is not None and current.id == claim.artifact_revision_id:
                if artifact_disposition != "rejected":
                    raise EvidenceValidationError(
                        "Claim绑定的Artifact Revision仍是当前项，rejected只能使用rejected"
                    )
                artifact = await repository.transition_artifact_status(
                    transaction,
                    artifact_id=artifact.id,
                    expected_row_version=artifact.row_version,
                    target_status="rejected",
                    command_id=f"{command_id}:artifact",
                    decision_record_id=decision_record_id,
                )
            elif artifact_disposition != "none":
                # 绑定 Revision 已被同事务合法替代：不写回新 Revision（§9.1 2b）。
                raise EvidenceValidationError(
                    "Claim绑定的Artifact Revision已被替代，rejected只能使用artifact_disposition=none"
                )
        commit = await repository.create_result_commit(
            transaction,
            claim_id=claim.id,
            claim_hash=claim.claim_hash,
            expected_claim_row_version=claim.row_version,
            commit_status="rejected",
            artifact_disposition=artifact_disposition,
            decision_record_id=decision_record_id,
            command_id=command_id,
        )
        return {
            "commit_id": commit.id,
            "result": self._result_view(
                commit=commit,
                claim=claim,
                artifact=artifact,
                subject=None,
            ),
        }

    async def _commit_adopted(
        self,
        transaction: AsyncSession,
        *,
        repository: EvidenceRepository,
        resolver: EvidenceReferenceResolver,
        claim: CompletionClaimRecord,
        commit_status: str,
        artifact_disposition: str,
        decision_record_id: str,
        command_id: str,
    ) -> dict[str, Any]:
        # §9.1 step 3: subject verification read; the atomic CAS guard repeats
        # inside the participant's conditional UPDATE at migration time.
        subject = await self._require_subject(transaction, claim=claim)
        if subject.row_version != claim.expected_subject_version:
            raise EvidenceConflict(
                f"subject版本已变化：Claim期望{claim.expected_subject_version}，当前{subject.row_version}"
            )
        if subject.status != claim.from_state:
            raise SubjectTransitionNotAllowed(
                f"subject当前状态{subject.status}与Claim from_state {claim.from_state}不一致"
            )
        # 处置组合先校验：请求本身不合法时 fail fast，不进入任何复检。
        if claim.artifact_revision_id is None and artifact_disposition != "none":
            raise EvidenceValidationError("未绑定Artifact的Claim只能使用artifact_disposition=none")
        if claim.artifact_revision_id is not None and artifact_disposition == "none":
            raise EvidenceValidationError("绑定当前Artifact Revision的Claim不能记录artifact_disposition=none")

        # §9.1 step 4: every mandatory Requirement needs exactly one resolution.
        # A（二次审核）：Adoption不再由验证阶段独立创建，而是由本Gate在同一
        # 事务内按result_commit Decision冻结的Adoption映射创建；映射条目必须
        # 精确对应该Requirement的当前supports Assessment。
        requirements = list(
            (
                await transaction.scalars(
                    select(CompletionClaimRequirementRecord).where(
                        CompletionClaimRequirementRecord.completion_claim_id == claim.id
                    )
                )
            ).all()
        )
        mandatory = [item for item in requirements if item.mandatory]
        if not mandatory:
            raise CompletionRequirementUnsatisfied("accepted/waived至少需要一条mandatory Requirement")
        if claim.target_transition == "action_result_accepted" and claim.validation_contract_id is None:
            raise CompletionRequirementUnsatisfied("action_result_accepted必须绑定validation_contract_id")
        decision_record = await resolver.resolve(
            transaction, kind="decision_record", reference_id=decision_record_id
        )
        # P0复审：共享校验器返回所选outcome；Adoption映射绑定在该outcome内，
        # reject outcome为空，拒绝决定不能挪用映射采用证据。
        _view, outcome = await require_result_commit_decision(
            transaction,
            decision=decision_record,
            claim=claim,
        )
        frozen_adoptions = outcome.get("adoptions")
        if not isinstance(frozen_adoptions, Mapping):
            raise EvidenceConflict("result_commit Decision缺少所选outcome冻结的Adoption映射")
        adoption_by_requirement = await self._claim_adoptions(transaction, claim_id=claim.id)
        waiver_by_requirement = await self._requirement_waivers(
            transaction, requirement_ids=[item.id for item in requirements]
        )
        for requirement in mandatory:
            has_waiver = requirement.id in waiver_by_requirement
            adoption = adoption_by_requirement.get(requirement.id)
            if has_waiver and adoption is not None:
                raise EvidenceConflict("同一Requirement不能同时存在Adoption与Waiver")
            if has_waiver:
                continue
            if adoption is not None and frozen_adoptions.get(requirement.id) != adoption.assessment_id:
                raise EvidenceConflict("既有Adoption与冻结Adoption映射不一致")
            if adoption is None:
                current = await repository.get_current_assessment(transaction, requirement.id)
                if current is None or current.verdict != "supports":
                    raise CompletionRequirementUnsatisfied(
                        f"mandatory Requirement没有当前supports Assessment: {requirement.id}"
                    )
                if frozen_adoptions.get(requirement.id) != current.id:
                    raise CompletionRequirementUnsatisfied(
                        f"冻结Adoption映射与Requirement {requirement.id}的当前supports Assessment不一致"
                    )
                adoption = await repository.create_adoption(
                    transaction,
                    claim_id=claim.id,
                    requirement_id=requirement.id,
                    assessment_id=current.id,
                    decision_record_id=decision_record_id,
                    command_id=f"{command_id}:adoption:{requirement.id}",
                )
                adoption_by_requirement[requirement.id] = adoption
        if commit_status == "accepted" and any(item.id in waiver_by_requirement for item in mandatory):
            raise CompletionRequirementUnsatisfied(
                "accepted要求全部mandatory Requirement均为Adoption，不能含Waiver"
            )
        if commit_status == "waived" and not any(item.id in waiver_by_requirement for item in mandatory):
            raise CompletionRequirementUnsatisfied("waived要求至少一条mandatory Requirement存在Waiver")

        # A Waiver cannot mask evidence that became contradictory after the
        # Waiver was recorded.  Commit always re-reads the current Assessment.
        for requirement in mandatory:
            if requirement.id not in waiver_by_requirement:
                continue
            current = await repository.get_current_assessment(transaction, requirement.id)
            if current is not None and current.verdict == "refutes":
                raise WaiverBlockedByFailedRequirement(
                    f"mandatory Requirement当前Assessment为refutes，不能提交Waiver: {requirement.id}"
                )

        # §9.1 step 5a: adoption chain re-check（全 Waiver 时空集自然通过）。
        for requirement in mandatory:
            adoption = adoption_by_requirement.get(requirement.id)
            if adoption is None:
                continue
            assessment = await repository.get_assessment(transaction, adoption.assessment_id)
            current = await repository.get_current_assessment(transaction, requirement.id)
            if current is None or current.id != assessment.id:
                raise EvidenceConflict("Adoption指向的Assessment已被更新结论取代")
            if current.verdict != "supports":
                raise AssessmentNotSupporting("Adoption指向的当前Assessment不是supports")
            observation = await repository.get_observation(transaction, assessment.observation_id)
            if observation.validity != "valid":
                raise EvidenceInvalid(
                    f"采用链Observation已失效: {observation.id} validity={observation.validity}"
                )
            if (observation.subject_kind, observation.subject_id) != (
                claim.subject_kind,
                claim.subject_id,
            ):
                raise EvidenceValidationError("Observation subject与Claim subject不匹配")
            pending = await self._pending_direct_source_invalidation(
                transaction,
                observation=observation,
            )
            if pending is not None:
                source_kind, source_id = pending
                raise EvidenceInvalid(f"采用链直接来源存在pending失效事件: {source_kind}/{source_id}")

        # §9.1 step 5b: Artifact re-check cannot be skipped even for full Waiver.
        artifact: ArtifactRecord | None = None
        if claim.artifact_revision_id is not None:
            artifact = await self._recheck_artifact(
                transaction,
                repository=repository,
                resolver=resolver,
                claim=claim,
            )

        # §9.1 step 6: applicability（record_only 不比较目标；目标前进不产生失效事件）。
        if claim.applicability_policy == "must_match_current_target":
            current_target = await self._current_target_snapshot_id(transaction, claim.repository_snapshot_id)
            if current_target != claim.repository_snapshot_id:
                raise ArtifactApplicabilityStale(
                    f"Claim绑定基线{claim.repository_snapshot_id}，当前合入目标{current_target}"
                )

        # §9.1 step 7: transition protocol（创建时已校验，提交门以权威状态复核）。
        rule = CLAIM_SUBJECT_TRANSITION_RULES.get((claim.subject_kind, claim.target_transition))
        if rule is None or rule != (claim.from_state, claim.target_state):
            raise SubjectTransitionNotAllowed(
                f"协议不允许{claim.subject_kind}.{claim.target_transition}: "
                f"{claim.from_state} -> {claim.target_state}"
            )
        if claim.subject_kind == "action_item" and isinstance(subject, ActionItemRecord):
            # 第四轮复审P0-1：commit前重检父Work——只有in_progress的父Work
            # 才允许完成其Action；Work已cancelled/离开in_progress即fail closed。
            parent_work = await transaction.get(WorkItemRecord, subject.work_item_id)
            if subject.work_item_id and (parent_work is None or parent_work.status != "in_progress"):
                raise EvidenceConflict("父Work当前不在in_progress，不能完成其Action")
            # 第五轮复审P0-2：父Work必须仍引用Claim绑定的同一accepted Plan
            # revision；第六轮复审P0-1：沿 Work -> revision -> TaskPlan 复核
            # 权威归属链（scope/Work/Project/current/status），不接受裸指针。
            if claim.validation_contract_id is not None and parent_work is not None:
                contract = await transaction.get(ValidationContractRecord, claim.validation_contract_id)
                if contract is None or contract.scope_id != self.scope_id:
                    raise EvidenceNotFound("Claim绑定的Validation Contract不存在")
                if parent_work.scope_id != self.scope_id:
                    raise EvidenceNotFound("父Work不存在于当前scope")
                try:
                    await require_current_plan_revision(
                        transaction,
                        scope_id=self.scope_id,
                        work=parent_work,
                        plan_revision_id=contract.plan_revision_id,
                    )
                except HarnessError as error:
                    raise EvidenceConflict(str(error)) from error
        if claim.subject_kind == "work_item" and claim.target_transition == "work_completed":
            await self._require_work_completion_ready(transaction, work_item_id=claim.subject_id)

        # §9.1 step 8: gate receipt + ResultCommit（同事务证明，记录层结构复核）。
        gate_nonce = _issue_result_commit_gate_nonce(transaction)
        recheck = ClaimGateRecheck(
            claim_id=claim.id,
            claim_hash=claim.claim_hash,
            claim_row_version=claim.row_version,
            commit_status=commit_status,
            mandatory_requirement_ids=tuple(item.id for item in mandatory),
            adoption_ids=tuple(
                adoption_by_requirement[item.id].id
                for item in mandatory
                if item.id in adoption_by_requirement
            ),
            waiver_ids=tuple(
                waiver_by_requirement[item.id].id for item in mandatory if item.id in waiver_by_requirement
            ),
            artifact_record_id=None if artifact is None else artifact.id,
            artifact_revision_id=claim.artifact_revision_id,
            artifact_record_version=claim.expected_artifact_record_version,
            _gate_nonce=gate_nonce,
        )
        commit = await repository.create_result_commit(
            transaction,
            claim_id=claim.id,
            claim_hash=claim.claim_hash,
            expected_claim_row_version=claim.row_version,
            commit_status=commit_status,
            artifact_disposition=artifact_disposition,
            decision_record_id=decision_record_id,
            command_id=command_id,
            committed_subject_state=claim.target_state,
            gate_recheck=recheck,
        )

        # §9.1 step 9: Artifact disposition（不能由 commit_status 机械推断）。
        if artifact is not None:
            expected_artifact_version = claim.expected_artifact_record_version
            if expected_artifact_version is None:
                # create_claim 强制两者同时为空或非空；此处 fail closed。
                raise EvidenceValidationError("绑定Artifact的Claim缺少expected_artifact_record_version")
            artifact = await repository.transition_artifact_status(
                transaction,
                artifact_id=artifact.id,
                expected_row_version=expected_artifact_version,
                target_status=artifact_disposition,
                command_id=f"{command_id}:artifact",
                decision_record_id=decision_record_id,
            )

        # §9.1 step 10: subject CAS migration via the participant；projection
        # Evidence 只携带 ResultCommit/Claim 引用（F02 D12），权威事实留在关系表。
        subject_view = await self._migrate_subject(
            transaction,
            claim=claim,
            commit=commit,
            decision_record_id=decision_record_id,
            command_id=command_id,
        )

        # §9.1 step 11: FK 无法回答 commit -> subject 的归属，只建这一条边。
        await repository.create_provenance_edge(
            transaction,
            source_kind="result_commit",
            source_id=commit.id,
            relation="attributed_to",
            target_kind=claim.subject_kind,
            target_id=claim.subject_id,
            decision_record_id=decision_record_id,
        )
        return {
            "commit_id": commit.id,
            "result": self._result_view(
                commit=commit,
                claim=claim,
                artifact=artifact,
                subject=subject_view,
            ),
        }

    async def _require_subject(
        self,
        transaction: AsyncSession,
        *,
        claim: CompletionClaimRecord,
    ) -> WorkItemRecord | ActionItemRecord:
        record_type = WorkItemRecord if claim.subject_kind == "work_item" else ActionItemRecord
        subject = await transaction.get(record_type, claim.subject_id)
        if subject is None or subject.scope_id != self.scope_id:
            raise EvidenceNotFound("Claim subject不存在")
        return subject

    async def _claim_adoptions(
        self,
        transaction: AsyncSession,
        *,
        claim_id: str,
    ) -> dict[str, ClaimEvidenceAdoptionRecord]:
        rows = (
            await transaction.scalars(
                select(ClaimEvidenceAdoptionRecord).where(
                    ClaimEvidenceAdoptionRecord.completion_claim_id == claim_id
                )
            )
        ).all()
        return {row.requirement_id: row for row in rows}

    async def _requirement_waivers(
        self,
        transaction: AsyncSession,
        *,
        requirement_ids: list[str],
    ) -> dict[str, Any]:
        if not requirement_ids:
            return {}
        rows = (
            await transaction.scalars(
                select(RequirementWaiverRecord).where(
                    RequirementWaiverRecord.requirement_id.in_(tuple(requirement_ids))
                )
            )
        ).all()
        return {row.requirement_id: row for row in rows}

    async def _pending_direct_source_invalidation(
        self,
        transaction: AsyncSession,
        *,
        observation: Any,
    ) -> tuple[str, str] | None:
        """Return a pending invalidation on an Observation or direct source."""
        sources: list[tuple[str, str]] = [("evidence_observation", observation.id)]
        if observation.repository_snapshot_id is not None:
            sources.append(("repository_snapshot", observation.repository_snapshot_id))
        if observation.artifact_revision_id is not None:
            sources.append(("artifact_revision", observation.artifact_revision_id))
            revision = await transaction.get(ArtifactRevisionRecord, observation.artifact_revision_id)
            if revision is None:
                raise EvidenceInvalid(f"采用链Artifact Revision不存在: {observation.artifact_revision_id}")
            sources.append(("artifact_blob", revision.storage_blob_id))
        pending = await transaction.execute(
            select(SourceInvalidationRecord.source_kind, SourceInvalidationRecord.source_id)
            .where(
                SourceInvalidationRecord.scope_id == self.scope_id,
                SourceInvalidationRecord.resolution == "pending",
                or_(
                    *(
                        and_(
                            SourceInvalidationRecord.source_kind == source_kind,
                            SourceInvalidationRecord.source_id == source_id,
                        )
                        for source_kind, source_id in sources
                    )
                ),
            )
            .limit(1)
        )
        row = pending.first()
        return None if row is None else (str(row[0]), str(row[1]))

    async def _recheck_artifact(
        self,
        transaction: AsyncSession,
        *,
        repository: EvidenceRepository,
        resolver: EvidenceReferenceResolver,
        claim: CompletionClaimRecord,
    ) -> ArtifactRecord:
        if claim.artifact_revision_id is None:
            # 调用方只在绑定 Revision 时进入本复检；fail closed 收窄。
            raise EvidenceValidationError("Artifact复检需要artifact_revision_id")
        revision = await resolver.resolve(
            transaction, kind="artifact_revision", reference_id=claim.artifact_revision_id
        )
        artifact = await repository.get_artifact_record(transaction, revision.artifact_id)
        if artifact.row_version != claim.expected_artifact_record_version:
            raise ArtifactRevisionSuperseded(
                f"Artifact Record版本已变化：Claim期望{claim.expected_artifact_record_version}，"
                f"当前{artifact.row_version}"
            )
        current_revision = await repository.get_current_artifact_revision(transaction, artifact.id)
        if current_revision is None or current_revision.id != claim.artifact_revision_id:
            raise ArtifactRevisionSuperseded("Claim绑定的Artifact Revision已非当前项")
        blob = await transaction.get(ArtifactBlobRecord, revision.storage_blob_id)
        if blob is None or blob.integrity_status != "available":
            raise EvidenceInvalid("Artifact Blob不可用于复检")
        if self.store is None:
            # fail closed：没有 Store 就不能证明 Blob Hash，accepted/waived 不得通过。
            raise EvidenceConflict("Artifact Store未配置，完成门无法复检Blob Hash")
        # store.read 重算 Hash；不匹配抛 ArtifactHashMismatch/ArtifactBlobMissing，
        # 整事务回滚；损坏标记与失效事件由 Reconciler/SD4-D 负责。
        await self.store.read(
            storage_path=blob.storage_path,
            sha256=revision.sha256,
            size_bytes=revision.size_bytes,
        )
        return artifact

    async def _current_target_snapshot_id(
        self,
        transaction: AsyncSession,
        snapshot_id: str | None,
    ) -> str | None:
        if snapshot_id is None:
            raise EvidenceValidationError("must_match_current_target需要repository_snapshot_id")
        snapshot = await transaction.get(RepositorySnapshotRecord, snapshot_id)
        if snapshot is None or snapshot.scope_id != self.scope_id:
            raise EvidenceNotFound("Claim绑定的RepositorySnapshot不存在")
        binding = await transaction.get(ProjectRepositoryBindingRecord, snapshot.binding_id)
        if binding is None or binding.scope_id != self.scope_id:
            raise EvidenceNotFound("RepositorySnapshot对应的Binding不存在")
        current = await transaction.scalar(
            select(RepositorySnapshotRecord)
            .where(
                RepositorySnapshotRecord.scope_id == self.scope_id,
                RepositorySnapshotRecord.binding_id == binding.id,
                RepositorySnapshotRecord.sequence == binding.latest_snapshot_sequence,
            )
            .limit(1)
        )
        return None if current is None else current.id

    async def _require_work_completion_ready(
        self,
        transaction: AsyncSession,
        *,
        work_item_id: str,
    ) -> None:
        open_actions = await transaction.scalar(
            select(func.count())
            .select_from(ActionItemRecord)
            .where(
                ActionItemRecord.scope_id == self.scope_id,
                ActionItemRecord.work_item_id == work_item_id,
                ActionItemRecord.status.in_(tuple(_OPEN_ACTION_STATUSES)),
            )
        )
        if open_actions:
            raise CompletionRequirementUnsatisfied(f"Work仍有{open_actions}个Action未解决，不能关闭")
        # 待合入 Artifact：已提交 Action Claim 交付的 Artifact 仍处 accepted
        # （SD5 Integration 才转 retained）；存在时父 Work 不能关闭（§4.6）。
        action_ids = select(ActionItemRecord.id).where(
            ActionItemRecord.scope_id == self.scope_id,
            ActionItemRecord.work_item_id == work_item_id,
        )
        pending_integration = await transaction.scalar(
            select(func.count())
            .select_from(ArtifactRecord)
            .join(
                ArtifactRevisionRecord,
                ArtifactRevisionRecord.artifact_id == ArtifactRecord.id,
            )
            .join(
                CompletionClaimRecord,
                CompletionClaimRecord.artifact_revision_id == ArtifactRevisionRecord.id,
            )
            .where(
                ArtifactRecord.scope_id == self.scope_id,
                ArtifactRecord.status == "accepted",
                CompletionClaimRecord.status == "committed",
                CompletionClaimRecord.subject_kind == "action_item",
                CompletionClaimRecord.subject_id.in_(action_ids),
            )
        )
        if pending_integration:
            raise CompletionRequirementUnsatisfied(f"Work仍有{pending_integration}个待合入Artifact，不能关闭")

    async def _migrate_subject(
        self,
        transaction: AsyncSession,
        *,
        claim: CompletionClaimRecord,
        commit: ResultCommitRecord,
        decision_record_id: str,
        command_id: str,
    ) -> dict[str, Any]:
        projection = [{"result_commit_id": commit.id, "claim_id": claim.id}]
        reason = f"Result Commit Gate {commit.commit_status}: {claim.target_transition}"
        if claim.subject_kind == "action_item":
            view = await self._participant.transition_action_item(
                transaction,
                action_item_id=claim.subject_id,
                command_id=f"{command_id}:subject",
                request_hash=content_hash(
                    {
                        "gate": "result_commit",
                        "claim_id": claim.id,
                        "result_commit_id": commit.id,
                    }
                ),
                target_status=claim.target_state,
                reason=reason,
                evidence=projection,
                decision_record_id=decision_record_id,
                expected_row_version=claim.expected_subject_version,
            )
        else:
            view = await self._participant.transition_work_item(
                transaction,
                work_item_id=claim.subject_id,
                command_id=f"{command_id}:subject",
                request_hash=content_hash(
                    {
                        "gate": "result_commit",
                        "claim_id": claim.id,
                        "result_commit_id": commit.id,
                    }
                ),
                target_status=claim.target_state,
                reason=reason,
                evidence=projection,
                decision_record_id=decision_record_id,
                expected_row_version=claim.expected_subject_version,
            )
        # view 自带的 kind 是 Work/Action 分类（task/diff_patch 等），subject
        # 视图里的 kind 必须始终表示 Claim subject_kind，否则同一字段在两种
        # 主体下含义不同。
        return {**view, "kind": claim.subject_kind, "id": claim.subject_id}

    async def _validate_completion_reference(
        self,
        transaction: AsyncSession,
        subject_kind: str,
        subject_id: str,
        subject_status: str,
        subject_row_version: int,
        target_status: str,
        decision_record_id: str | None,
        reference: Mapping[str, Any],
    ) -> None:
        """Gate-injected chain validator for the reserved projection shape.

        A projection is only consumable once: the referenced Claim must bind
        the subject's *current* row_version, so citing an already-consumed
        ResultCommit deterministically fails (replay protection).
        """
        commit = await transaction.get(ResultCommitRecord, str(reference["result_commit_id"]))
        if (
            commit is None
            or commit.scope_id != self.scope_id
            or commit.commit_status not in {"accepted", "waived"}
        ):
            raise HarnessValidationError("ResultCommit引用无效")
        claim = await transaction.get(CompletionClaimRecord, str(reference["claim_id"]))
        if (
            claim is None
            or claim.scope_id != self.scope_id
            or claim.id != commit.completion_claim_id
            or claim.status != "committed"
        ):
            raise HarnessValidationError("ResultCommit引用投影的Claim无效")
        if claim.subject_kind != subject_kind or claim.subject_id != subject_id:
            raise HarnessValidationError("ResultCommit引用不属于当前subject")
        if claim.target_state != target_status or claim.from_state != subject_status:
            raise HarnessValidationError("ResultCommit引用与当前迁移不一致")
        if claim.expected_subject_version != subject_row_version:
            raise HarnessValidationError("ResultCommit引用对应的subject版本已被消费")
        if decision_record_id is not None and decision_record_id != commit.decision_record_id:
            raise HarnessValidationError("迁移Decision与ResultCommit Decision不一致")

    @staticmethod
    def _result_view(
        *,
        commit: ResultCommitRecord,
        claim: CompletionClaimRecord,
        artifact: ArtifactRecord | None,
        subject: dict[str, Any] | None,
    ) -> dict[str, Any]:
        return {
            "result_commit_id": commit.id,
            "commit_status": commit.commit_status,
            "artifact_disposition": commit.artifact_disposition,
            "pre_commit_validity_check_passed": commit.pre_commit_validity_check_passed,
            "committed_subject_state": commit.committed_subject_state,
            "claim": {
                "id": claim.id,
                "status": claim.status,
                "row_version": claim.row_version,
                "decision_record_id": claim.decision_record_id,
            },
            "artifact": (
                None
                if artifact is None
                else {
                    "id": artifact.id,
                    "status": artifact.status,
                    "row_version": artifact.row_version,
                }
            ),
            "subject": subject,
        }
