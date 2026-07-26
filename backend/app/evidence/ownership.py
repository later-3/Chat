"""Ownership resolution for Evidence generic references.

Evidence and Provenance use ``kind + id`` references where one database foreign
key cannot express the target table.  This module is the single place that maps
those public kinds to authoritative product records and derives their Product
Scope.  It participates in the caller-owned transaction and never commits.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from ..execution_workspaces.models import ExecutionWorkspaceRecord
from ..governance.models import (
    DecisionRecord,
    DecisionSubjectRecord,
    ModelCallAttemptRecord,
)
from ..harness.models import ActionItemRecord, WorkItemRecord
from ..product_sessions.database import RunAttemptRecord, RunRecord, SessionRecord
from ..project_resources.models import RepositorySnapshotRecord
from ..tool_execution.models import ToolOperationRecord
from .contracts import EvidenceNotFound, EvidenceValidationError
from .models import (
    ArtifactBlobRecord,
    ArtifactRecord,
    ArtifactRevisionRecord,
    ClaimEvidenceAdoptionRecord,
    CompletionClaimRecord,
    EvidenceAssessmentRecord,
    EvidenceObservationRecord,
    RequirementWaiverRecord,
    ResultCommitRecord,
    SourceInvalidationRecord,
    ValidationContractRecord,
    ValidationRunRecord,
)

_DIRECT_SCOPE_RECORD_TYPES: dict[str, type[Any]] = {
    "work_item": WorkItemRecord,
    "action_item": ActionItemRecord,
    "artifact_blob": ArtifactBlobRecord,
    "evidence_observation": EvidenceObservationRecord,
    "evidence_assessment": EvidenceAssessmentRecord,
    "claim_evidence_adoption": ClaimEvidenceAdoptionRecord,
    "requirement_waiver": RequirementWaiverRecord,
    "validation_run": ValidationRunRecord,
    "validation_contract": ValidationContractRecord,
    "completion_claim": CompletionClaimRecord,
    "result_commit": ResultCommitRecord,
    "source_invalidation": SourceInvalidationRecord,
    "repository_snapshot": RepositorySnapshotRecord,
    "execution_workspace": ExecutionWorkspaceRecord,
    "tool_operation": ToolOperationRecord,
}


class EvidenceReferenceResolver:
    """Resolve a supported reference and prove that it belongs to one scope."""

    def __init__(self, *, scope_id: str) -> None:
        self.scope_id = scope_id

    async def _session_scope(
        self,
        transaction: AsyncSession,
        session_id: str,
    ) -> str | None:
        session = await transaction.get(SessionRecord, session_id)
        return None if session is None else session.scope_id

    async def _run_scope(
        self,
        transaction: AsyncSession,
        run_id: str,
    ) -> str | None:
        run = await transaction.get(RunRecord, run_id)
        return None if run is None else await self._session_scope(transaction, run.session_id)

    async def resolve(
        self,
        transaction: AsyncSession,
        *,
        kind: str,
        reference_id: str,
    ) -> Any:
        """Return the referenced row or fail without leaking cross-scope IDs."""

        row: Any = None
        row_scope: str | None = None
        direct_type = _DIRECT_SCOPE_RECORD_TYPES.get(kind)
        if direct_type is not None:
            row = await transaction.get(direct_type, reference_id)
            row_scope = None if row is None else row.scope_id
        elif kind == "artifact_revision":
            row = await transaction.get(ArtifactRevisionRecord, reference_id)
            if row is not None:
                artifact = await transaction.get(ArtifactRecord, row.artifact_id)
                row_scope = None if artifact is None else artifact.scope_id
        elif kind == "product_run":
            row = await transaction.get(RunRecord, reference_id)
            if row is not None:
                row_scope = await self._session_scope(transaction, row.session_id)
        elif kind == "run_attempt":
            row = await transaction.get(RunAttemptRecord, reference_id)
            if row is not None:
                row_scope = await self._run_scope(transaction, row.run_id)
        elif kind == "model_call_attempt":
            row = await transaction.get(ModelCallAttemptRecord, reference_id)
            if row is not None:
                row_scope = await self._run_scope(transaction, row.run_id)
        elif kind == "decision_record":
            row = await transaction.get(DecisionRecord, reference_id)
            if row is not None:
                subject = await transaction.get(DecisionSubjectRecord, row.subject_id)
                row_scope = (
                    None if subject is None else await self._session_scope(transaction, subject.session_id)
                )
        else:
            raise EvidenceValidationError(f"未注册引用解析的kind: {kind}")

        if row is None or row_scope != self.scope_id:
            # Missing and cross-scope are intentionally indistinguishable: a
            # caller must not use this resolver to probe another user's IDs.
            raise EvidenceNotFound(f"引用不存在或不在当前scope: {kind}/{reference_id}")
        return row
