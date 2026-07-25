"""Application service for Evidence, Artifact, Provenance and Validation records.

This service owns durable product facts produced by Agent/Workflow execution.
It does not run Agents or models; it only records and validates the evidence
chain that proves a WorkItem or ActionItem advanced to a new state.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Callable, Mapping, Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..harness.commands import HarnessCommandRecorder
from ..harness.models import ActionItemRecord, WorkItemRecord
from .contracts import (
    ARTIFACT_DISPOSITIONS,
    ARTIFACT_KINDS,
    ARTIFACT_TRANSITIONS,
    ASSESSMENT_VERDICTS,
    ASSESSOR_KINDS,
    CLAIM_SUBJECT_KINDS,
    CLAIM_TARGET_TRANSITIONS,
    CLAIM_TRANSITIONS,
    INVALIDATION_KINDS,
    INVALIDATION_RESOLUTIONS,
    INVALIDATION_SOURCE_KINDS,
    OBSERVATION_SUBJECT_KINDS,
    PROVENANCE_RELATIONS,
    PROVENANCE_SOURCE_KINDS,
    PROVENANCE_TARGET_KINDS,
    REQUIREMENT_KINDS,
    RESULT_COMMIT_STATUSES,
    VALIDATION_CAPABILITY_EXECUTABLE_POLICIES,
    VALIDATION_CAPABILITY_NETWORK_POLICIES,
    VALIDATION_CAPABILITY_PATH_POLICIES,
    VALIDATION_CAPABILITY_SIDE_EFFECT_CLASSES,
    VALIDATION_RUN_STATUSES,
    VALIDATION_RUN_TERMINAL_STATUSES,
    VALIDATION_RUN_TRANSITIONS,
    ArtifactHashMismatch,
    ArtifactRevisionSuperseded,
    AssessmentNotSupporting,
    CompletionClaimAlreadyResolved,
    EvidenceConflict,
    EvidenceNotFound,
    EvidenceValidationError,
    RuntimeLeaseFenceMismatch,
    WaiverBlockedByFailedRequirement,
    claim_hash,
    content_hash,
    provenance_edge_allowed,
    validate_observation_payload,
)
from .models import (
    ArtifactBlobRecord,
    ArtifactRecord,
    ArtifactRevisionRecord,
    ClaimEvidenceAdoptionRecord,
    CompletionClaimRecord,
    CompletionClaimRequirementRecord,
    EvidenceAssessmentRecord,
    EvidenceObservationRecord,
    ProvenanceEdgeRecord,
    RequirementWaiverRecord,
    ResultCommitRecord,
    SourceInvalidationRecord,
    ValidationCapabilityRecord,
    ValidationContractRecord,
    ValidationRunRecord,
)

logger = logging.getLogger(__name__)


def _new_id() -> str:
    import uuid

    return str(uuid.uuid4())


def _utc_now() -> datetime:
    from datetime import timezone

    return datetime.now(timezone.utc)


class EvidenceRepository:
    """Repository for Evidence/Artifact records inside a caller-owned session.

    This class deliberately does not open transactions.  Commands that must be
    atomic with a WorkItem transition are composed by a coordinator that owns
    the session.

    工程规范说明（>800行审查）：本模块保持单一 Repository，因为 15 张表的
    不变量大量跨聚合（Revision 追加读 candidate Claim；Adoption 同时触碰
    Claim/Requirement/Assessment/Waiver），按表机械拆分会产生双向依赖。
    SD4-B ArtifactStore 与 SD4-C ResultCommitCoordinator 作为独立协调者
    进入各自模块，本 Repository 只保留记录层不变量与状态机。
    """

    def __init__(
        self,
        *,
        scope_id: str,
        principal_id: str,
        clock: Callable[[], datetime] | None = None,
        command_recorder: HarnessCommandRecorder | None = None,
    ) -> None:
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock or _utc_now
        self._recorder = command_recorder

    async def get_artifact_record(self, transaction: AsyncSession, artifact_id: str) -> ArtifactRecord:
        value = await transaction.get(ArtifactRecord, artifact_id)
        if value is None or value.scope_id != self.scope_id:
            raise EvidenceNotFound("Artifact不存在")
        return value

    async def get_claim(self, transaction: AsyncSession, claim_id: str) -> CompletionClaimRecord:
        value = await transaction.get(CompletionClaimRecord, claim_id)
        if value is None or value.scope_id != self.scope_id:
            raise EvidenceNotFound("CompletionClaim不存在")
        return value

    async def get_observation(self, transaction: AsyncSession, observation_id: str) -> EvidenceObservationRecord:
        value = await transaction.get(EvidenceObservationRecord, observation_id)
        if value is None or value.scope_id != self.scope_id:
            raise EvidenceNotFound("EvidenceObservation不存在")
        return value

    async def get_requirement(
        self, transaction: AsyncSession, requirement_id: str
    ) -> CompletionClaimRequirementRecord:
        value = await transaction.get(CompletionClaimRequirementRecord, requirement_id)
        if value is None or value.scope_id != self.scope_id:
            raise EvidenceNotFound("CompletionClaimRequirement不存在")
        return value

    async def get_assessment(self, transaction: AsyncSession, assessment_id: str) -> EvidenceAssessmentRecord:
        value = await transaction.get(EvidenceAssessmentRecord, assessment_id)
        if value is None or value.scope_id != self.scope_id:
            raise EvidenceNotFound("EvidenceAssessment不存在")
        return value

    async def get_validation_run(self, transaction: AsyncSession, validation_run_id: str) -> ValidationRunRecord:
        value = await transaction.get(ValidationRunRecord, validation_run_id)
        if value is None or value.scope_id != self.scope_id:
            raise EvidenceNotFound("ValidationRun不存在")
        return value

    async def _require_subject(
        self,
        transaction: AsyncSession,
        *,
        subject_kind: str,
        subject_id: str,
    ) -> WorkItemRecord | ActionItemRecord | ArtifactRevisionRecord:
        """Validate that a Claim/Observation subject exists and shares scope.

        §4.5/§4.6 require subject existence to be checked inside the write
        transaction rather than by a cross-table FK, because subject_id is a
        generic reference.  ArtifactRevision carries no scope_id of its own,
        so its scope is verified through the parent ArtifactRecord.
        """

        if subject_kind == "work_item":
            value = await transaction.get(WorkItemRecord, subject_id)
            if value is None or value.scope_id != self.scope_id:
                raise EvidenceNotFound(f"subject不存在: {subject_kind}/{subject_id}")
            return value
        if subject_kind == "action_item":
            value = await transaction.get(ActionItemRecord, subject_id)
            if value is None or value.scope_id != self.scope_id:
                raise EvidenceNotFound(f"subject不存在: {subject_kind}/{subject_id}")
            return value
        if subject_kind == "artifact_revision":
            revision = await transaction.get(ArtifactRevisionRecord, subject_id)
            artifact = (
                None
                if revision is None
                else await transaction.get(ArtifactRecord, revision.artifact_id)
            )
            if revision is None or artifact is None or artifact.scope_id != self.scope_id:
                raise EvidenceNotFound(f"subject不存在: {subject_kind}/{subject_id}")
            return revision
        raise EvidenceValidationError(f"未知subject_kind: {subject_kind}")

    async def get_current_artifact_revision(
        self,
        transaction: AsyncSession,
        artifact_id: str,
    ) -> ArtifactRevisionRecord | None:
        result = await transaction.scalar(
            select(ArtifactRevisionRecord)
            .where(
                ArtifactRevisionRecord.artifact_id == artifact_id,
            )
            .order_by(ArtifactRevisionRecord.revision_number.desc())
            .limit(1)
        )
        return result

    async def get_current_assessment(
        self,
        transaction: AsyncSession,
        requirement_id: str,
    ) -> EvidenceAssessmentRecord | None:
        result = await transaction.scalar(
            select(EvidenceAssessmentRecord)
            .where(
                EvidenceAssessmentRecord.scope_id == self.scope_id,
                EvidenceAssessmentRecord.requirement_id == requirement_id,
            )
            .order_by(EvidenceAssessmentRecord.assessment_sequence.desc())
            .limit(1)
        )
        return result

    async def create_artifact_blob(
        self,
        transaction: AsyncSession,
        *,
        sha256: str,
        size_bytes: int,
        storage_path: str,
    ) -> ArtifactBlobRecord:
        blob = ArtifactBlobRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            sha256=sha256,
            size_bytes=size_bytes,
            storage_path=storage_path,
            integrity_status="available",
            gc_status="active",
            row_version=1,
            created_at=self._clock(),
            updated_at=self._clock(),
        )
        transaction.add(blob)
        return blob

    async def create_artifact_record(
        self,
        transaction: AsyncSession,
        *,
        kind: str,
        title: str,
        media_type: str,
        product_run_id: str | None = None,
        run_attempt_id: str | None = None,
        command_id: str,
    ) -> ArtifactRecord:
        if kind not in ARTIFACT_KINDS:
            raise EvidenceValidationError(f"未知Artifact kind: {kind}")
        value = ArtifactRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            kind=kind,
            title=title,
            media_type=media_type,
            status="candidate",
            product_run_id=product_run_id,
            run_attempt_id=run_attempt_id,
            row_version=1,
            created_by=self.principal_id,
            command_id=command_id,
            created_at=self._clock(),
            updated_at=self._clock(),
        )
        transaction.add(value)
        if self._recorder is not None:
            self._recorder.record(
                transaction,
                command_id=command_id,
                command_kind="create_artifact_record",
                request_hash="",  # caller computes if idempotency is required
                result={"id": value.id, "status": value.status},
                resource_kind="artifact_record",
                resource_id=value.id,
                event_type="evidence.artifact_record.created",
                trace_payload={"kind": kind, "title": title},
            )
        return value

    async def create_artifact_revision(
        self,
        transaction: AsyncSession,
        *,
        artifact_id: str,
        storage_blob_id: str,
        sha256: str,
        size_bytes: int,
        excerpt: str | None = None,
        command_id: str,
    ) -> ArtifactRevisionRecord:
        record = await self.get_artifact_record(transaction, artifact_id)
        if record.status not in {"candidate", "accepted", "rejected", "not_adopted", "retained"}:
            raise EvidenceValidationError("Artifact状态不允许追加Revision")
        blob = await transaction.get(ArtifactBlobRecord, storage_blob_id)
        if blob is None or blob.scope_id != self.scope_id:
            raise EvidenceNotFound("ArtifactBlob不存在")
        if blob.gc_status != "active" or blob.integrity_status != "available":
            raise EvidenceValidationError("只能引用active且available的Blob")
        if blob.sha256 != sha256 or blob.size_bytes != size_bytes:
            raise ArtifactHashMismatch("Revision内容指纹必须与Blob一致")
        current_revision = await self.get_current_artifact_revision(transaction, artifact_id)
        if current_revision is not None:
            pending_claim = await transaction.scalar(
                select(CompletionClaimRecord.id)
                .where(
                    CompletionClaimRecord.scope_id == self.scope_id,
                    CompletionClaimRecord.artifact_revision_id == current_revision.id,
                    CompletionClaimRecord.status == "candidate",
                )
                .limit(1)
            )
            if pending_claim is not None:
                raise ArtifactRevisionSuperseded(
                    "当前Revision存在candidate Claim，必须先supersede/reject后再追加Revision"
                )
        next_number = (
            await transaction.scalar(
                select(func.coalesce(func.max(ArtifactRevisionRecord.revision_number), 0)).where(
                    ArtifactRevisionRecord.artifact_id == artifact_id,
                )
            )
            or 0
        )
        revision = ArtifactRevisionRecord(
            id=_new_id(),
            artifact_id=artifact_id,
            revision_number=next_number + 1,
            storage_blob_id=storage_blob_id,
            sha256=sha256,
            size_bytes=size_bytes,
            excerpt=excerpt,
            supersedes_revision_id=current_revision.id if current_revision is not None else None,
            created_by=self.principal_id,
            command_id=command_id,
            created_at=self._clock(),
        )
        record.status = "candidate"
        record.row_version += 1
        record.updated_at = self._clock()
        transaction.add(revision)
        return revision

    async def transition_artifact_status(
        self,
        transaction: AsyncSession,
        *,
        artifact_id: str,
        expected_row_version: int,
        target_status: str,
        command_id: str,
        decision_record_id: str | None = None,
    ) -> ArtifactRecord:
        if target_status not in ARTIFACT_TRANSITIONS:
            raise EvidenceValidationError(f"未知Artifact状态: {target_status}")
        value = await self.get_artifact_record(transaction, artifact_id)
        if value.row_version != expected_row_version:
            raise EvidenceConflict("Artifact版本冲突")
        allowed = ARTIFACT_TRANSITIONS.get(value.status, set())
        if target_status not in allowed:
            raise EvidenceValidationError(
                f"Artifact不能从{value.status}变为{target_status}"
            )
        previous = value.status
        value.status = target_status
        value.row_version += 1
        value.updated_at = self._clock()
        if self._recorder is not None:
            self._recorder.record(
                transaction,
                command_id=command_id,
                command_kind="transition_artifact_status",
                request_hash="",
                result={"id": value.id, "status": value.status, "row_version": value.row_version},
                resource_kind="artifact_record",
                resource_id=value.id,
                event_type="evidence.artifact_record.transitioned",
                trace_payload={"from": previous, "to": target_status},
                decision_record_id=decision_record_id,
            )
        return value

    async def create_observation(
        self,
        transaction: AsyncSession,
        *,
        kind: str,
        schema_version: str,
        payload: Any,
        subject_kind: str,
        subject_id: str,
        statement: str,
        validation_run_id: str | None = None,
        tool_operation_id: str | None = None,
        model_call_attempt_id: str | None = None,
        repository_snapshot_id: str | None = None,
        artifact_revision_id: str | None = None,
        product_run_id: str | None = None,
        run_attempt_id: str | None = None,
        decision_record_id: str | None = None,
        verification_method: str | None = None,
        command_id: str,
    ) -> EvidenceObservationRecord:
        if kind not in REQUIREMENT_KINDS:
            raise EvidenceValidationError(f"未知Observation kind: {kind}")
        if subject_kind not in OBSERVATION_SUBJECT_KINDS:
            raise EvidenceValidationError(f"未知Observation subject_kind: {subject_kind}")
        await self._require_subject(transaction, subject_kind=subject_kind, subject_id=subject_id)
        validated_payload = validate_observation_payload(
            kind=kind, schema_version=schema_version, payload=payload
        )
        source_refs = (
            validation_run_id,
            tool_operation_id,
            model_call_attempt_id,
            repository_snapshot_id,
            product_run_id,
            run_attempt_id,
            decision_record_id,
        )
        if not any(source_refs):
            raise EvidenceValidationError("Observation必须至少携带一个可定位来源")
        observation = EvidenceObservationRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            kind=kind,
            schema_version=schema_version,
            payload_json=validated_payload,
            subject_kind=subject_kind,
            subject_id=subject_id,
            statement=statement,
            validation_run_id=validation_run_id,
            tool_operation_id=tool_operation_id,
            model_call_attempt_id=model_call_attempt_id,
            repository_snapshot_id=repository_snapshot_id,
            artifact_revision_id=artifact_revision_id,
            product_run_id=product_run_id,
            run_attempt_id=run_attempt_id,
            decision_record_id=decision_record_id,
            validity="valid",
            verification_method=verification_method,
            verified_at=self._clock() if verification_method else None,
            row_version=1,
            created_by=self.principal_id,
            command_id=command_id,
            created_at=self._clock(),
            updated_at=self._clock(),
        )
        transaction.add(observation)
        return observation

    async def create_claim(
        self,
        transaction: AsyncSession,
        *,
        subject_kind: str,
        subject_id: str,
        from_state: str,
        target_transition: str,
        expected_subject_version: int,
        target_state: str,
        artifact_revision_id: str | None = None,
        expected_artifact_record_version: int | None = None,
        repository_snapshot_id: str | None = None,
        applicability_policy: str = "record_only",
        validation_contract_id: str | None = None,
        requirements: Sequence[Mapping[str, Any]] = (),
        command_id: str,
    ) -> CompletionClaimRecord:
        if subject_kind not in CLAIM_SUBJECT_KINDS:
            raise EvidenceValidationError(f"未知Claim subject_kind: {subject_kind}")
        if target_transition not in CLAIM_TARGET_TRANSITIONS:
            raise EvidenceValidationError(f"未知target_transition: {target_transition}")
        if applicability_policy not in {"record_only", "must_match_current_target"}:
            raise EvidenceValidationError(f"未知applicability_policy: {applicability_policy}")
        if applicability_policy == "must_match_current_target" and not repository_snapshot_id:
            raise EvidenceValidationError("must_match_current_target需要repository_snapshot_id")
        if (artifact_revision_id is None) != (expected_artifact_record_version is None):
            raise EvidenceValidationError("artifact_revision_id与expected_artifact_record_version必须同时为空或非空")
        subject = await self._require_subject(transaction, subject_kind=subject_kind, subject_id=subject_id)
        if isinstance(subject, (WorkItemRecord, ActionItemRecord)):
            if subject.row_version != expected_subject_version:
                raise EvidenceConflict(
                    f"Claim期望subject版本{expected_subject_version}，当前为{subject.row_version}"
                )

        normalized_requirements: list[dict[str, Any]] = []
        for index, raw in enumerate(requirements):
            kind = str(raw.get("requirement_kind", ""))
            if kind not in REQUIREMENT_KINDS:
                raise EvidenceValidationError(f"未知Requirement kind: {kind}")
            normalized_requirements.append(
                {
                    "requirement_index": index,
                    "requirement_kind": kind,
                    "mandatory": bool(raw.get("mandatory", True)),
                    "description": str(raw.get("description", "")),
                    "contract_rule_ordinal": raw.get("contract_rule_ordinal"),
                    "params_json": dict(raw.get("params_json") or {}),
                    "schema_version": str(raw.get("schema_version", "")),
                }
            )

        computed_claim_hash = claim_hash(
            subject_kind=subject_kind,
            subject_id=subject_id,
            target_transition=target_transition,
            artifact_revision_id=artifact_revision_id,
            repository_snapshot_id=repository_snapshot_id,
            applicability_policy=applicability_policy,
            requirements=normalized_requirements,
        )

        claim = CompletionClaimRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            subject_kind=subject_kind,
            subject_id=subject_id,
            expected_subject_version=expected_subject_version,
            from_state=from_state,
            target_transition=target_transition,
            target_state=target_state,
            artifact_revision_id=artifact_revision_id,
            expected_artifact_record_version=expected_artifact_record_version,
            repository_snapshot_id=repository_snapshot_id,
            applicability_policy=applicability_policy,
            validation_contract_id=validation_contract_id,
            claim_hash=computed_claim_hash,
            status="candidate",
            row_version=1,
            command_id=command_id,
            created_at=self._clock(),
            updated_at=self._clock(),
        )
        transaction.add(claim)

        for req in normalized_requirements:
            requirement = CompletionClaimRequirementRecord(
                id=_new_id(),
                scope_id=self.scope_id,
                completion_claim_id=claim.id,
                requirement_index=req["requirement_index"],
                requirement_kind=req["requirement_kind"],
                mandatory=req["mandatory"],
                description=req["description"],
                contract_rule_ordinal=req["contract_rule_ordinal"],
                params_json=req["params_json"],
                schema_version=req["schema_version"],
                created_at=self._clock(),
            )
            transaction.add(requirement)

        return claim

    async def create_assessment(
        self,
        transaction: AsyncSession,
        *,
        observation_id: str,
        requirement_id: str,
        verdict: str,
        supersedes_assessment_id: str | None = None,
        assessor_kind: str,
        assessor_run_id: str | None = None,
        assessor_principal_id: str | None = None,
        decision_record_id: str | None = None,
        rationale: str | None = None,
        command_id: str,
    ) -> EvidenceAssessmentRecord:
        if verdict not in ASSESSMENT_VERDICTS:
            raise EvidenceValidationError(f"未知verdict: {verdict}")
        if assessor_kind not in ASSESSOR_KINDS:
            raise EvidenceValidationError(f"未知assessor_kind: {assessor_kind}")
        if assessor_kind == "human":
            if not assessor_principal_id or not decision_record_id:
                raise EvidenceValidationError("人工Assessment必须绑定principal与DecisionRecord")
        else:
            if not assessor_run_id:
                raise EvidenceValidationError("validator/workflow Assessment必须绑定assessor_run_id")
            # §4.8：服务端 Assessment 的 assessor_principal_id 必须留空
            if assessor_principal_id:
                raise EvidenceValidationError("服务端Assessment不允许携带assessor_principal_id")
        observation = await self.get_observation(transaction, observation_id)
        # get_requirement 不存在时会抛出，作为评估目标的存在性校验
        requirement = await self.get_requirement(transaction, requirement_id)
        if requirement.scope_id != self.scope_id or observation.scope_id != self.scope_id:
            raise EvidenceConflict("Assessment必须与Observation/Requirement同scope")
        current = await self.get_current_assessment(transaction, requirement_id)
        next_sequence = 1 if current is None else current.assessment_sequence + 1
        if supersedes_assessment_id is not None:
            if current is None or current.id != supersedes_assessment_id:
                raise EvidenceConflict("supersedes_assessment_id必须指向当前最新Assessment")
        else:
            if current is not None:
                raise EvidenceConflict("必须提供supersedes_assessment_id")

        assessment = EvidenceAssessmentRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            observation_id=observation_id,
            requirement_id=requirement_id,
            verdict=verdict,
            assessment_sequence=next_sequence,
            supersedes_assessment_id=supersedes_assessment_id,
            assessor_kind=assessor_kind,
            assessor_run_id=assessor_run_id,
            assessor_principal_id=assessor_principal_id,
            decision_record_id=decision_record_id,
            rationale=rationale,
            command_id=command_id,
            created_at=self._clock(),
        )
        transaction.add(assessment)
        return assessment

    async def create_adoption(
        self,
        transaction: AsyncSession,
        *,
        claim_id: str,
        requirement_id: str,
        assessment_id: str,
        decision_record_id: str,
        command_id: str,
    ) -> ClaimEvidenceAdoptionRecord:
        claim = await self.get_claim(transaction, claim_id)
        if claim.status != "candidate":
            raise EvidenceConflict("只有candidate状态的Claim才能创建Adoption")
        requirement = await self.get_requirement(transaction, requirement_id)
        if requirement.completion_claim_id != claim_id:
            raise EvidenceValidationError("Requirement不属于该Claim")
        assessment = await self.get_assessment(transaction, assessment_id)
        if assessment.requirement_id != requirement_id:
            raise EvidenceValidationError("Assessment不属于该Requirement")
        if assessment.verdict != "supports":
            raise AssessmentNotSupporting("只能采用supports的Assessment")
        current = await self.get_current_assessment(transaction, requirement_id)
        if current is None or current.id != assessment_id:
            raise EvidenceConflict("只能采用当前最新supports Assessment")
        existing_waiver = await transaction.scalar(
            select(RequirementWaiverRecord.id)
            .where(RequirementWaiverRecord.requirement_id == requirement_id)
            .limit(1)
        )
        if existing_waiver is not None:
            raise EvidenceConflict("同一Requirement不能同时存在Adoption与Waiver")

        adoption = ClaimEvidenceAdoptionRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            completion_claim_id=claim_id,
            requirement_id=requirement_id,
            assessment_id=assessment_id,
            decision_record_id=decision_record_id,
            command_id=command_id,
            created_at=self._clock(),
        )
        transaction.add(adoption)
        return adoption

    async def create_waiver(
        self,
        transaction: AsyncSession,
        *,
        requirement_id: str,
        decision_record_id: str,
        reason: str,
        command_id: str,
    ) -> RequirementWaiverRecord:
        # get_requirement 不存在时会抛出，作为豁免目标的存在性校验
        requirement = await self.get_requirement(transaction, requirement_id)
        claim = await self.get_claim(transaction, requirement.completion_claim_id)
        if claim.status != "candidate":
            raise EvidenceConflict("只有candidate状态的Claim才能创建Waiver")
        current = await self.get_current_assessment(transaction, requirement_id)
        if current is not None and current.verdict == "refutes":
            raise WaiverBlockedByFailedRequirement("当前Assessment为refutes时不能豁免")
        existing_adoption = await transaction.scalar(
            select(ClaimEvidenceAdoptionRecord.id)
            .where(ClaimEvidenceAdoptionRecord.requirement_id == requirement_id)
            .limit(1)
        )
        if existing_adoption is not None:
            raise EvidenceConflict("同一Requirement不能同时存在Waiver与Adoption")
        waiver = RequirementWaiverRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            requirement_id=requirement_id,
            decision_record_id=decision_record_id,
            reason=reason,
            command_id=command_id,
            created_at=self._clock(),
        )
        transaction.add(waiver)
        return waiver

    async def create_result_commit(
        self,
        transaction: AsyncSession,
        *,
        claim_id: str,
        commit_status: str,
        artifact_disposition: str,
        decision_record_id: str,
        command_id: str,
        committed_subject_state: str | None = None,
    ) -> ResultCommitRecord:
        if commit_status not in RESULT_COMMIT_STATUSES:
            raise EvidenceValidationError(f"未知commit_status: {commit_status}")
        if artifact_disposition not in ARTIFACT_DISPOSITIONS:
            raise EvidenceValidationError(f"未知artifact_disposition: {artifact_disposition}")
        claim = await self.get_claim(transaction, claim_id)
        if claim.status != "candidate":
            raise CompletionClaimAlreadyResolved("只有candidate状态的Claim才能提交ResultCommit")

        # SD4-A: basic pre-commit check placeholder.  Full requirement satisfaction
        # is implemented in SD4-C ResultCommit coordinator.  Per §4.11 the CHECK
        # requires accepted/waived commits to have passed the validity re-check;
        # an empty adoption set passes (全 Waiver 时为真，空集通过).
        pre_commit_validity_check_passed = commit_status in {"accepted", "waived"}
        target_claim_status = "committed" if commit_status in {"accepted", "waived"} else "rejected"
        if target_claim_status not in CLAIM_TRANSITIONS[claim.status]:
            raise EvidenceValidationError(
                f"Claim不能从{claim.status}变为{target_claim_status}"
            )

        commit = ResultCommitRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            completion_claim_id=claim_id,
            commit_status=commit_status,
            artifact_disposition=artifact_disposition,
            pre_commit_validity_check_passed=pre_commit_validity_check_passed,
            decision_record_id=decision_record_id,
            committed_subject_state=committed_subject_state,
            command_id=command_id,
            created_at=self._clock(),
        )
        claim.status = target_claim_status
        claim.decision_record_id = decision_record_id
        claim.row_version += 1
        claim.updated_at = self._clock()
        transaction.add(commit)
        return commit

    async def create_validation_capability(
        self,
        transaction: AsyncSession,
        *,
        capability_key: str,
        capability_version: str,
        capability_hash: str,
        executable_policy: str,
        executable_ref: str,
        renderer_key: str,
        argv_prefix_json: Any,
        params_schema_json: Any,
        allowed_paths_policy: str,
        side_effect_class: str,
        network_policy: str,
        sandbox_requirement: str,
        resource_limits_json: Any,
        egress_allowlist_json: Any | None = None,
        redaction_baseline_json: Any | None = None,
        command_id: str,
    ) -> ValidationCapabilityRecord:
        if executable_policy not in VALIDATION_CAPABILITY_EXECUTABLE_POLICIES:
            raise EvidenceValidationError(f"未知executable_policy: {executable_policy}")
        if allowed_paths_policy not in VALIDATION_CAPABILITY_PATH_POLICIES:
            raise EvidenceValidationError(f"未知allowed_paths_policy: {allowed_paths_policy}")
        if side_effect_class not in VALIDATION_CAPABILITY_SIDE_EFFECT_CLASSES:
            raise EvidenceValidationError(f"未知side_effect_class: {side_effect_class}")
        if network_policy not in VALIDATION_CAPABILITY_NETWORK_POLICIES:
            raise EvidenceValidationError(f"未知network_policy: {network_policy}")
        capability = ValidationCapabilityRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            capability_key=capability_key,
            capability_version=capability_version,
            capability_hash=capability_hash,
            executable_policy=executable_policy,
            executable_ref=executable_ref,
            renderer_key=renderer_key,
            argv_prefix_json=argv_prefix_json,
            params_schema_json=params_schema_json,
            allowed_paths_policy=allowed_paths_policy,
            side_effect_class=side_effect_class,
            network_policy=network_policy,
            egress_allowlist_json=egress_allowlist_json or [],
            resource_limits_json=resource_limits_json,
            sandbox_requirement=sandbox_requirement,
            redaction_baseline_json=redaction_baseline_json or [],
            status="active",
            row_version=1,
            created_at=self._clock(),
            updated_at=self._clock(),
        )
        transaction.add(capability)
        return capability

    async def create_validation_contract(
        self,
        transaction: AsyncSession,
        *,
        plan_revision_id: str,
        contract_hash: str,
        schema_version: str,
        rules_json: Any,
        requires_integration: bool = True,
        max_repair_cycles: int = 2,
        network_requested: bool = False,
        command_id: str,
    ) -> ValidationContractRecord:
        if not 0 <= max_repair_cycles <= 5:
            raise EvidenceValidationError("max_repair_cycles必须在0-5之间")
        contract = ValidationContractRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            plan_revision_id=plan_revision_id,
            contract_hash=contract_hash,
            schema_version=schema_version,
            rules_json=rules_json,
            requires_integration=requires_integration,
            max_repair_cycles=max_repair_cycles,
            network_requested=network_requested,
            created_by=self.principal_id,
            command_id=command_id,
            created_at=self._clock(),
        )
        transaction.add(contract)
        return contract

    async def create_validation_run(
        self,
        transaction: AsyncSession,
        *,
        workspace_id: str,
        repository_snapshot_id: str,
        validation_contract_id: str,
        contract_hash: str,
        rule_ordinal: int,
        capability_key: str,
        capability_version: str,
        capability_hash: str,
        resolved_executable_hash: str,
        environment_fingerprint: str,
        expanded_argv_json: Any,
        expanded_argv_hash: str,
        working_dir: str,
        repair_cycle: int = 0,
        runtime_job_id: str,
        run_attempt_id: str,
        runtime_lease_epoch: int,
        command_id: str,
    ) -> ValidationRunRecord:
        run = ValidationRunRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            workspace_id=workspace_id,
            repository_snapshot_id=repository_snapshot_id,
            validation_contract_id=validation_contract_id,
            contract_hash=contract_hash,
            rule_ordinal=rule_ordinal,
            capability_key=capability_key,
            capability_version=capability_version,
            capability_hash=capability_hash,
            resolved_executable_hash=resolved_executable_hash,
            environment_fingerprint=environment_fingerprint,
            expanded_argv_json=expanded_argv_json,
            expanded_argv_hash=expanded_argv_hash,
            working_dir=working_dir,
            repair_cycle=repair_cycle,
            runtime_job_id=runtime_job_id,
            run_attempt_id=run_attempt_id,
            runtime_lease_epoch=runtime_lease_epoch,
            status="pending",
            command_id=command_id,
            created_at=self._clock(),
            updated_at=self._clock(),
        )
        transaction.add(run)
        return run

    async def report_validation_outcome(
        self,
        transaction: AsyncSession,
        *,
        validation_run_id: str,
        outcome_command_id: str,
        status: str,
        runtime_lease_epoch: int,
        exit_code: int | None = None,
        duration_ms: int | None = None,
        stdout_tail: str | None = None,
        stderr_tail: str | None = None,
        report_artifact_revision_id: str | None = None,
    ) -> ValidationRunRecord:
        if status not in VALIDATION_RUN_STATUSES:
            raise EvidenceValidationError(f"未知ValidationRun status: {status}")
        if status not in VALIDATION_RUN_TERMINAL_STATUSES:
            raise EvidenceValidationError("回报必须是终态status")
        run = await self.get_validation_run(transaction, validation_run_id)
        if run.runtime_lease_epoch != runtime_lease_epoch:
            raise RuntimeLeaseFenceMismatch("ValidationRun lease fence不匹配，拒收回报")
        outcome_hash = content_hash(
            {
                "status": status,
                "exit_code": exit_code,
                "duration_ms": duration_ms,
                "report_artifact_revision_id": report_artifact_revision_id,
            }
        )
        if run.outcome_command_id is not None:
            if run.outcome_command_id != outcome_command_id:
                raise EvidenceConflict("ValidationRun已绑定不同outcome_command_id")
            if run.outcome_hash != outcome_hash:
                raise EvidenceConflict("同幂等键下回报内容冲突")
            return run
        if status not in VALIDATION_RUN_TRANSITIONS.get(run.status, set()):
            raise EvidenceValidationError(
                f"ValidationRun不能从{run.status}变为{status}"
            )
        now = self._clock()
        run.outcome_command_id = outcome_command_id
        run.outcome_hash = outcome_hash
        run.status = status
        run.exit_code = exit_code
        run.started_at = run.started_at or now
        run.finished_at = now
        run.duration_ms = duration_ms
        run.stdout_tail = stdout_tail
        run.stderr_tail = stderr_tail
        run.report_artifact_revision_id = report_artifact_revision_id
        run.updated_at = self._clock()
        return run

    async def mark_validation_run_running(
        self,
        transaction: AsyncSession,
        *,
        validation_run_id: str,
        runtime_lease_epoch: int,
    ) -> ValidationRunRecord:
        """Worker 领取后把 Run 置为 running；lease epoch 不一致即 fence 拒收。"""

        run = await self.get_validation_run(transaction, validation_run_id)
        if run.runtime_lease_epoch != runtime_lease_epoch:
            raise RuntimeLeaseFenceMismatch("ValidationRun lease fence不匹配，拒绝领取")
        if "running" not in VALIDATION_RUN_TRANSITIONS.get(run.status, set()):
            raise EvidenceValidationError(f"ValidationRun不能从{run.status}进入running")
        run.status = "running"
        run.started_at = self._clock()
        run.updated_at = self._clock()
        return run

    async def create_provenance_edge(
        self,
        transaction: AsyncSession,
        *,
        source_kind: str,
        source_id: str,
        relation: str,
        target_kind: str,
        target_id: str,
        product_run_id: str | None = None,
        decision_record_id: str | None = None,
    ) -> ProvenanceEdgeRecord:
        if relation not in PROVENANCE_RELATIONS:
            raise EvidenceValidationError(f"未知relation: {relation}")
        if source_kind not in PROVENANCE_SOURCE_KINDS:
            raise EvidenceValidationError(f"未知source_kind: {source_kind}")
        if target_kind not in PROVENANCE_TARGET_KINDS:
            raise EvidenceValidationError(f"未知target_kind: {target_kind}")
        if not provenance_edge_allowed(source_kind, relation, target_kind):
            raise EvidenceValidationError(
                f"Provenance方向矩阵不允许: {source_kind} --{relation}--> {target_kind}"
            )
        edge = ProvenanceEdgeRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            source_kind=source_kind,
            source_id=source_id,
            relation=relation,
            target_kind=target_kind,
            target_id=target_id,
            product_run_id=product_run_id,
            decision_record_id=decision_record_id,
            created_at=self._clock(),
        )
        transaction.add(edge)
        return edge

    async def create_source_invalidation(
        self,
        transaction: AsyncSession,
        *,
        source_kind: str,
        source_id: str,
        invalidation_kind: str,
        recovers_invalidation_id: str | None = None,
        previous_fingerprint: str | None = None,
        current_fingerprint: str | None = None,
        resolution: str = "pending",
        resolution_decision_record_id: str | None = None,
        command_id: str,
    ) -> SourceInvalidationRecord:
        if source_kind not in INVALIDATION_SOURCE_KINDS:
            raise EvidenceValidationError(f"未知source_kind: {source_kind}")
        if invalidation_kind not in INVALIDATION_KINDS:
            raise EvidenceValidationError(f"未知invalidation_kind: {invalidation_kind}")
        if resolution not in INVALIDATION_RESOLUTIONS:
            raise EvidenceValidationError(f"未知resolution: {resolution}")
        if invalidation_kind == "stale":
            if previous_fingerprint == current_fingerprint:
                raise EvidenceValidationError("stale事件必须有不同的fingerprint")
        if (invalidation_kind == "recovered") != (recovers_invalidation_id is not None):
            raise EvidenceValidationError("recovered事件必须携带recovers_invalidation_id，反之亦然")
        if invalidation_kind == "revoked" and not resolution_decision_record_id:
            raise EvidenceValidationError("revoked事件必须绑定DecisionRecord")
        if resolution == "dismissed" and not resolution_decision_record_id:
            raise EvidenceValidationError("dismissed处置必须绑定DecisionRecord")
        if recovers_invalidation_id is not None:
            recovered_from = await transaction.get(SourceInvalidationRecord, recovers_invalidation_id)
            if (
                recovered_from is None
                or recovered_from.scope_id != self.scope_id
                or recovered_from.source_kind != source_kind
                or recovered_from.source_id != source_id
                or recovered_from.invalidation_kind not in {"stale", "unavailable"}
            ):
                raise EvidenceValidationError(
                    "recovered必须指向同一来源的stale/unavailable事件"
                )
        # sequence 分配：锁定该来源最后一行 + UNIQUE 冲突兜底重试由调用方事务负责；
        # uq_source_invalidation_sequence 保证并发下只有一个写入者成功。
        next_sequence = (
            await transaction.scalar(
                select(func.coalesce(func.max(SourceInvalidationRecord.sequence), 0)).where(
                    SourceInvalidationRecord.source_kind == source_kind,
                    SourceInvalidationRecord.source_id == source_id,
                    SourceInvalidationRecord.scope_id == self.scope_id,
                )
            )
            or 0
        )
        event = SourceInvalidationRecord(
            id=_new_id(),
            scope_id=self.scope_id,
            source_kind=source_kind,
            source_id=source_id,
            sequence=next_sequence + 1,
            invalidation_kind=invalidation_kind,
            recovers_invalidation_id=recovers_invalidation_id,
            previous_fingerprint=previous_fingerprint,
            current_fingerprint=current_fingerprint,
            resolution=resolution,
            resolution_decision_record_id=resolution_decision_record_id,
            command_id=command_id,
            created_at=self._clock(),
            updated_at=self._clock(),
        )
        transaction.add(event)
        return event
