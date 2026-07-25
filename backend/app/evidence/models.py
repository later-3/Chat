"""SQLAlchemy persistence records for Evidence, Artifact, Provenance and Validation."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..product_sessions.database import Base, utc_now


class ArtifactBlobRecord(Base):
    """Content-addressed blob metadata.  The physical file lives in the Artifact Store."""

    __tablename__ = "artifact_blobs"
    __table_args__ = (
        UniqueConstraint("scope_id", "sha256", name="uq_artifact_blobs_scope_sha256"),
        UniqueConstraint("storage_path", name="uq_artifact_blobs_storage_path"),
        Index("ix_artifact_blobs_scope_created", "scope_id", "created_at"),
        Index("ix_artifact_blobs_scope_gc", "scope_id", "gc_status"),
        CheckConstraint("size_bytes >= 0", name="ck_artifact_blob_size"),
        CheckConstraint(
            "integrity_status IN ('available','missing','corrupt')",
            name="ck_artifact_blob_integrity_status",
        ),
        CheckConstraint(
            "gc_status IN ('active','orphan_candidate','deleting','delete_failed')",
            name="ck_artifact_blob_gc_status",
        ),
        CheckConstraint("row_version >= 1", name="ck_artifact_blob_row_version"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False)
    integrity_status: Mapped[str] = mapped_column(String(20), nullable=False, default="available")
    gc_status: Mapped[str] = mapped_column(String(24), nullable=False, default="active")
    orphaned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_gc_error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    retention_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ArtifactRecord(Base):
    """One logical Artifact.  Current revision is the ArtifactRevision with the
    highest revision_number for this record, not a denormalized pointer."""

    __tablename__ = "artifact_records"
    __table_args__ = (
        UniqueConstraint("scope_id", "command_id", name="uq_artifact_records_command"),
        Index("ix_artifact_records_scope_status", "scope_id", "status", "updated_at"),
        Index("ix_artifact_records_run", "product_run_id", "created_at"),
        CheckConstraint(
            "kind IN ('diff_patch','validation_report','generated_file','design_document',"
            "'result_patch','exported_content')",
            name="ck_artifact_record_kind",
        ),
        CheckConstraint(
            "status IN ('candidate','accepted','rejected','not_adopted','retained','discarded')",
            name="ck_artifact_record_status",
        ),
        CheckConstraint("row_version >= 1", name="ck_artifact_record_row_version"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    media_type: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="candidate")
    product_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"),
        nullable=True,
    )
    run_attempt_id: Mapped[str | None] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="RESTRICT"),
        nullable=True,
    )
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ArtifactRevisionRecord(Base):
    """One immutable revision of an Artifact, pointing to exactly one blob."""

    __tablename__ = "artifact_revisions"
    __table_args__ = (
        UniqueConstraint("artifact_id", "revision_number", name="uq_artifact_revision_number"),
        UniqueConstraint("artifact_id", "command_id", name="uq_artifact_revisions_command"),
        Index("ix_artifact_revisions_current", "artifact_id", "revision_number"),
        Index("ix_artifact_revisions_blob", "storage_blob_id"),
        Index("ix_artifact_revisions_supersedes", "supersedes_revision_id"),
        CheckConstraint("revision_number >= 1", name="ck_artifact_revision_number"),
        CheckConstraint("size_bytes >= 0", name="ck_artifact_revision_size"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    artifact_id: Mapped[str] = mapped_column(
        ForeignKey("artifact_records.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    revision_number: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_blob_id: Mapped[str] = mapped_column(
        ForeignKey("artifact_blobs.id", ondelete="RESTRICT"),
        nullable=False,
    )
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    excerpt: Mapped[str | None] = mapped_column(Text, nullable=True)
    supersedes_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("artifact_revisions.id", ondelete="RESTRICT"),
        nullable=True,
    )
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class EvidenceObservationRecord(Base):
    """One observed material: command output, file hash, tool receipt, model output or
    human confirmation.  Validity is mutable; the payload itself is immutable."""

    __tablename__ = "evidence_observations"
    __table_args__ = (
        UniqueConstraint("scope_id", "command_id", name="uq_evidence_observations_command"),
        Index("ix_evidence_obs_subject", "subject_kind", "subject_id", "validity"),
        Index("ix_evidence_obs_run", "product_run_id", "created_at"),
        Index("ix_evidence_obs_validity", "validity", "updated_at"),
        Index("ix_evidence_obs_validation_run", "validation_run_id"),
        CheckConstraint(
            "kind IN ('validation_result','file_hash_match','tool_receipt',"
            "'model_output_adoption','human_confirmation','external_observation')",
            name="ck_evidence_observation_kind",
        ),
        CheckConstraint(
            "subject_kind IN ('work_item','action_item','artifact_revision')",
            name="ck_evidence_observation_subject_kind",
        ),
        CheckConstraint(
            "validity IN ('valid','stale','unavailable','revoked','unverifiable')",
            name="ck_evidence_observation_validity",
        ),
        CheckConstraint(
            "product_run_id IS NOT NULL OR run_attempt_id IS NOT NULL OR "
            "tool_operation_id IS NOT NULL OR model_call_attempt_id IS NOT NULL OR "
            "validation_run_id IS NOT NULL OR repository_snapshot_id IS NOT NULL OR "
            "decision_record_id IS NOT NULL",
            name="ck_evidence_observation_has_source",
        ),
        CheckConstraint("row_version >= 1", name="ck_evidence_observation_row_version"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    schema_version: Mapped[str] = mapped_column(String(40), nullable=False)
    payload_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    subject_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    subject_id: Mapped[str] = mapped_column(String(100), nullable=False)
    validation_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("validation_runs.id", ondelete="RESTRICT"),
        nullable=True,
    )
    tool_operation_id: Mapped[str | None] = mapped_column(
        ForeignKey("tool_operations.id", ondelete="RESTRICT"),
        nullable=True,
    )
    model_call_attempt_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_call_attempts.id", ondelete="RESTRICT"),
        nullable=True,
    )
    repository_snapshot_id: Mapped[str | None] = mapped_column(
        ForeignKey("repository_snapshots.id", ondelete="RESTRICT"),
        nullable=True,
    )
    artifact_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("artifact_revisions.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    product_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"),
        nullable=True,
    )
    run_attempt_id: Mapped[str | None] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="RESTRICT"),
        nullable=True,
    )
    decision_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"),
        nullable=True,
    )
    validity: Mapped[str] = mapped_column(String(32), nullable=False, default="valid")
    verification_method: Mapped[str | None] = mapped_column(String(80), nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    statement: Mapped[str] = mapped_column(Text, nullable=False)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class CompletionClaimRecord(Base):
    """A candidate assertion that a subject satisfies its requirements and can move."""

    __tablename__ = "completion_claims"
    __table_args__ = (
        UniqueConstraint("scope_id", "command_id", name="uq_completion_claims_command"),
        UniqueConstraint(
            "artifact_revision_id",
            name="uq_completion_claim_artifact_revision",
        ),
        Index("ix_completion_claims_subject", "subject_kind", "subject_id", "status", "updated_at"),
        Index("ix_completion_claims_artifact", "artifact_revision_id"),
        Index("ix_completion_claims_snapshot", "repository_snapshot_id", "status"),
        Index("ix_completion_claims_hash", "scope_id", "claim_hash", "created_at"),
        CheckConstraint(
            "status IN ('candidate','committed','rejected','superseded')",
            name="ck_completion_claim_status",
        ),
        CheckConstraint(
            "status = 'candidate' OR decision_record_id IS NOT NULL",
            name="ck_completion_claim_resolved_decision",
        ),
        CheckConstraint(
            "(artifact_revision_id IS NULL AND expected_artifact_record_version IS NULL) OR "
            "(artifact_revision_id IS NOT NULL AND expected_artifact_record_version IS NOT NULL)",
            name="ck_completion_claim_artifact_consistency",
        ),
        CheckConstraint(
            "applicability_policy != 'must_match_current_target' OR repository_snapshot_id IS NOT NULL",
            name="ck_completion_claim_applicability_snapshot",
        ),
        CheckConstraint(
            "expected_artifact_record_version IS NULL OR expected_artifact_record_version >= 1",
            name="ck_completion_claim_expected_artifact_version",
        ),
        CheckConstraint("row_version >= 1", name="ck_completion_claim_row_version"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    subject_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    subject_id: Mapped[str] = mapped_column(String(100), nullable=False)
    expected_subject_version: Mapped[int] = mapped_column(Integer, nullable=False)
    from_state: Mapped[str] = mapped_column(String(32), nullable=False)
    target_transition: Mapped[str] = mapped_column(String(40), nullable=False)
    target_state: Mapped[str] = mapped_column(String(32), nullable=False)
    artifact_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("artifact_revisions.id", ondelete="RESTRICT"),
        nullable=True,
    )
    expected_artifact_record_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    repository_snapshot_id: Mapped[str | None] = mapped_column(
        ForeignKey("repository_snapshots.id", ondelete="RESTRICT"),
        nullable=True,
    )
    applicability_policy: Mapped[str] = mapped_column(String(40), nullable=False, default="record_only")
    validation_contract_id: Mapped[str | None] = mapped_column(
        ForeignKey("validation_contracts.id", ondelete="RESTRICT"),
        nullable=True,
    )
    claim_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="candidate")
    decision_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"),
        nullable=True,
    )
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class CompletionClaimRequirementRecord(Base):
    """One requirement that a Claim demands evidence for.  Immutable after creation."""

    __tablename__ = "completion_claim_requirements"
    __table_args__ = (
        UniqueConstraint(
            "completion_claim_id",
            "requirement_index",
            name="uq_claim_requirement_index",
        ),
        Index("ix_claim_requirements_claim", "completion_claim_id"),
        CheckConstraint("requirement_index >= 0", name="ck_claim_requirement_index"),
        CheckConstraint(
            "requirement_kind IN ('validation_result','file_hash_match','tool_receipt',"
            "'model_output_adoption','human_confirmation','external_observation')",
            name="ck_claim_requirement_kind",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    completion_claim_id: Mapped[str] = mapped_column(
        ForeignKey("completion_claims.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    requirement_index: Mapped[int] = mapped_column(Integer, nullable=False)
    requirement_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    mandatory: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    contract_rule_ordinal: Mapped[int | None] = mapped_column(Integer, nullable=True)
    params_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    schema_version: Mapped[str] = mapped_column(String(40), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class EvidenceAssessmentRecord(Base):
    """One immutable verdict: an Observation satisfies or refutes a Requirement."""

    __tablename__ = "evidence_assessments"
    __table_args__ = (
        UniqueConstraint(
            "observation_id",
            "requirement_id",
            name="uq_assessment_observation_requirement",
        ),
        UniqueConstraint(
            "requirement_id",
            "assessment_sequence",
            name="uq_assessment_requirement_sequence",
        ),
        UniqueConstraint("scope_id", "command_id", name="uq_assessments_command"),
        Index("ix_assessments_requirement", "requirement_id", "created_at"),
        Index("ix_assessments_observation", "observation_id"),
        CheckConstraint("assessment_sequence >= 1", name="ck_assessment_sequence"),
        CheckConstraint(
            "verdict IN ('supports','refutes','inconclusive')",
            name="ck_assessment_verdict",
        ),
        CheckConstraint(
            "assessor_kind IN ('validator','workflow','human')",
            name="ck_assessment_assessor_kind",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    observation_id: Mapped[str] = mapped_column(
        ForeignKey("evidence_observations.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    requirement_id: Mapped[str] = mapped_column(
        ForeignKey("completion_claim_requirements.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    verdict: Mapped[str] = mapped_column(String(20), nullable=False)
    assessment_sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    supersedes_assessment_id: Mapped[str | None] = mapped_column(
        ForeignKey("evidence_assessments.id", ondelete="RESTRICT"),
        nullable=True,
    )
    assessor_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    assessor_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"),
        nullable=True,
    )
    assessor_principal_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    decision_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"),
        nullable=True,
    )
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ClaimEvidenceAdoptionRecord(Base):
    """A Claim adopts one supporting Assessment for a Requirement.  Immutable."""

    __tablename__ = "claim_evidence_adoptions"
    __table_args__ = (
        UniqueConstraint(
            "completion_claim_id",
            "requirement_id",
            name="uq_adoption_claim_requirement",
        ),
        UniqueConstraint("scope_id", "command_id", name="uq_adoptions_command"),
        Index("ix_adoptions_claim", "completion_claim_id"),
        Index("ix_adoptions_assessment", "assessment_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    completion_claim_id: Mapped[str] = mapped_column(
        ForeignKey("completion_claims.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    requirement_id: Mapped[str] = mapped_column(
        ForeignKey("completion_claim_requirements.id", ondelete="RESTRICT"),
        nullable=False,
    )
    assessment_id: Mapped[str] = mapped_column(
        ForeignKey("evidence_assessments.id", ondelete="RESTRICT"),
        nullable=False,
    )
    decision_record_id: Mapped[str] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"),
        nullable=False,
    )
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class RequirementWaiverRecord(Base):
    """A per-Requirement waiver.  Cannot override a current refutes Assessment."""

    __tablename__ = "requirement_waivers"
    __table_args__ = (
        UniqueConstraint("requirement_id", name="uq_waiver_requirement"),
        UniqueConstraint("scope_id", "command_id", name="uq_waivers_command"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    requirement_id: Mapped[str] = mapped_column(
        ForeignKey("completion_claim_requirements.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    decision_record_id: Mapped[str] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"),
        nullable=False,
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ResultCommitRecord(Base):
    """The final decision on a Claim: accepted, rejected or waived.  Immutable."""

    __tablename__ = "result_commits"
    __table_args__ = (
        UniqueConstraint("completion_claim_id", name="uq_result_commits_claim"),
        UniqueConstraint("scope_id", "command_id", name="uq_result_commits_command"),
        Index("ix_result_commits_status", "commit_status", "created_at"),
        CheckConstraint(
            "commit_status IN ('accepted','rejected','waived')",
            name="ck_result_commit_status",
        ),
        CheckConstraint(
            "artifact_disposition IN ('accepted','rejected','not_adopted','none')",
            name="ck_result_commit_artifact_disposition",
        ),
        CheckConstraint(
            "commit_status = 'rejected' OR pre_commit_validity_check_passed",
            name="ck_result_commit_validity",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    completion_claim_id: Mapped[str] = mapped_column(
        ForeignKey("completion_claims.id", ondelete="RESTRICT"),
        nullable=False,
    )
    commit_status: Mapped[str] = mapped_column(String(20), nullable=False)
    artifact_disposition: Mapped[str] = mapped_column(String(20), nullable=False)
    pre_commit_validity_check_passed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    decision_record_id: Mapped[str] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"),
        nullable=False,
    )
    committed_subject_state: Mapped[str | None] = mapped_column(String(32), nullable=True)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ValidationCapabilityRecord(Base):
    """A seeded, versioned validation capability.  Not created by users or models."""

    __tablename__ = "validation_capabilities"
    __table_args__ = (
        UniqueConstraint(
            "scope_id",
            "capability_key",
            "capability_version",
            name="uq_validation_capabilities_key_version",
        ),
        UniqueConstraint("scope_id", "capability_hash", name="uq_validation_capabilities_hash"),
        CheckConstraint(
            "executable_policy IN ('project_venv_python','pinned_binary','builtin')",
            name="ck_validation_capability_executable_policy",
        ),
        CheckConstraint(
            "allowed_paths_policy IN ('workspace_only','workspace_plus_declared_read')",
            name="ck_validation_capability_paths_policy",
        ),
        CheckConstraint(
            "side_effect_class IN ('readonly','temp_write')",
            name="ck_validation_capability_side_effect",
        ),
        CheckConstraint(
            "network_policy IN ('deny','allowlist')",
            name="ck_validation_capability_network_policy",
        ),
        CheckConstraint(
            "status IN ('active','deprecated')",
            name="ck_validation_capability_status",
        ),
        CheckConstraint("row_version >= 1", name="ck_validation_capability_row_version"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    capability_key: Mapped[str] = mapped_column(String(80), nullable=False)
    capability_version: Mapped[str] = mapped_column(String(40), nullable=False)
    capability_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    executable_policy: Mapped[str] = mapped_column(String(40), nullable=False)
    executable_ref: Mapped[str] = mapped_column(String(100), nullable=False)
    renderer_key: Mapped[str] = mapped_column(String(100), nullable=False)
    argv_prefix_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    params_schema_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    allowed_paths_policy: Mapped[str] = mapped_column(String(40), nullable=False)
    side_effect_class: Mapped[str] = mapped_column(String(20), nullable=False)
    network_policy: Mapped[str] = mapped_column(String(20), nullable=False)
    egress_allowlist_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    resource_limits_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    sandbox_requirement: Mapped[str] = mapped_column(String(40), nullable=False)
    redaction_baseline_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ValidationContractRecord(Base):
    """A Planner-declared contract, compiled into a RunSpec and bound by Hash."""

    __tablename__ = "validation_contracts"
    __table_args__ = (
        UniqueConstraint("scope_id", "command_id", name="uq_validation_contracts_command"),
        Index("ix_validation_contracts_hash", "scope_id", "contract_hash", "created_at"),
        CheckConstraint("max_repair_cycles BETWEEN 0 AND 5", name="ck_validation_contract_repair_cycles"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    plan_revision_id: Mapped[str] = mapped_column(
        ForeignKey("task_plan_revisions.id", ondelete="RESTRICT"),
        nullable=False,
    )
    contract_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    schema_version: Mapped[str] = mapped_column(String(40), nullable=False)
    rules_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    requires_integration: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    max_repair_cycles: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    network_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ValidationRunRecord(Base):
    """One deterministic validation command execution."""

    __tablename__ = "validation_runs"
    __table_args__ = (
        UniqueConstraint("scope_id", "command_id", name="uq_validation_runs_command"),
        UniqueConstraint(
            "scope_id",
            "outcome_command_id",
            name="uq_validation_runs_outcome_command",
        ),
        Index("ix_validation_runs_contract", "validation_contract_id", "rule_ordinal", "repair_cycle"),
        Index("ix_validation_runs_status", "status", "created_at"),
        Index("ix_validation_runs_workspace", "workspace_id", "status"),
        Index("ix_validation_runs_attempt", "run_attempt_id", "runtime_lease_epoch"),
        CheckConstraint(
            "status IN ('pending','running','passed','failed','timeout','error','cancelled','outcome_unknown')",
            name="ck_validation_run_status",
        ),
        CheckConstraint("repair_cycle >= 0", name="ck_validation_run_repair_cycle"),
        CheckConstraint("row_version >= 1", name="ck_validation_run_row_version"),
        CheckConstraint(
            "duration_ms IS NULL OR duration_ms >= 0",
            name="ck_validation_run_duration",
        ),
        CheckConstraint(
            "(status != 'pending' OR (started_at IS NULL AND finished_at IS NULL)) AND "
            "(status != 'running' OR (started_at IS NOT NULL AND finished_at IS NULL)) AND "
            "(status IN ('pending','running') OR finished_at IS NOT NULL) AND "
            "(status NOT IN ('passed','failed') OR exit_code IS NOT NULL)",
            name="ck_validation_run_state_consistency",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("execution_workspaces.id", ondelete="RESTRICT"),
        nullable=False,
    )
    repository_snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("repository_snapshots.id", ondelete="RESTRICT"),
        nullable=False,
    )
    validation_contract_id: Mapped[str] = mapped_column(
        ForeignKey("validation_contracts.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    contract_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    rule_ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    capability_key: Mapped[str] = mapped_column(String(80), nullable=False)
    capability_version: Mapped[str] = mapped_column(String(40), nullable=False)
    capability_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    resolved_executable_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    environment_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    expanded_argv_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    expanded_argv_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    working_dir: Mapped[str] = mapped_column(String(240), nullable=False)
    repair_cycle: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    runtime_job_id: Mapped[str] = mapped_column(
        ForeignKey("runtime_jobs.id", ondelete="RESTRICT"),
        nullable=False,
    )
    run_attempt_id: Mapped[str] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    runtime_lease_epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    report_artifact_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("artifact_revisions.id", ondelete="RESTRICT"),
        nullable=True,
    )
    stdout_tail: Mapped[str | None] = mapped_column(Text, nullable=True)
    stderr_tail: Mapped[str | None] = mapped_column(Text, nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    outcome_command_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    outcome_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ProvenanceEdgeRecord(Base):
    """One directed, append-only relationship that cannot be expressed by a hard FK."""

    __tablename__ = "provenance_edges"
    __table_args__ = (
        UniqueConstraint(
            "scope_id",
            "source_kind",
            "source_id",
            "relation",
            "target_kind",
            "target_id",
            name="uq_provenance_edge",
        ),
        Index("ix_provenance_source", "scope_id", "source_kind", "source_id"),
        Index("ix_provenance_target", "scope_id", "target_kind", "target_id"),
        Index("ix_provenance_run", "product_run_id", "created_at"),
        CheckConstraint(
            "relation IN ('derived_from','generated_by','used','attributed_to','invalidated_by')",
            name="ck_provenance_relation",
        ),
        CheckConstraint(
            "source_kind IN ('artifact_revision','evidence_observation','evidence_assessment',"
            "'claim_evidence_adoption','requirement_waiver','validation_run','completion_claim',"
            "'result_commit','tool_operation','product_run','run_attempt')",
            name="ck_provenance_source_kind",
        ),
        CheckConstraint(
            "target_kind IN ('artifact_revision','evidence_observation','evidence_assessment',"
            "'claim_evidence_adoption','requirement_waiver','validation_run','execution_workspace',"
            "'repository_snapshot','decision_record','work_item','action_item','source_invalidation',"
            "'completion_claim','result_commit','tool_operation','product_run','run_attempt')",
            name="ck_provenance_target_kind",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    source_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    source_id: Mapped[str] = mapped_column(String(100), nullable=False)
    relation: Mapped[str] = mapped_column(String(32), nullable=False)
    target_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    target_id: Mapped[str] = mapped_column(String(100), nullable=False)
    product_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    decision_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class SourceInvalidationRecord(Base):
    """An append-only event recording that a source changed, became unavailable or was revoked."""

    __tablename__ = "source_invalidations"
    __table_args__ = (
        UniqueConstraint(
            "scope_id",
            "source_kind",
            "source_id",
            "sequence",
            name="uq_source_invalidation_sequence",
        ),
        UniqueConstraint("scope_id", "command_id", name="uq_source_invalidations_command"),
        Index("ix_source_invalidation_source", "source_kind", "source_id", "resolution"),
        Index("ix_source_invalidation_pending", "scope_id", "resolution", "created_at"),
        CheckConstraint("sequence >= 1", name="ck_source_invalidation_sequence"),
        CheckConstraint(
            "invalidation_kind IN ('stale','unavailable','revoked','recovered')",
            name="ck_source_invalidation_kind",
        ),
        CheckConstraint(
            "source_kind IN ('artifact_blob','repository_snapshot','artifact_revision',"
            "'evidence_observation')",
            name="ck_source_invalidation_source_kind",
        ),
        CheckConstraint(
            "resolution IN ('pending','applied','dismissed')",
            name="ck_source_invalidation_resolution",
        ),
        CheckConstraint(
            "(invalidation_kind = 'recovered') = (recovers_invalidation_id IS NOT NULL)",
            name="ck_source_invalidation_recovered_pair",
        ),
        CheckConstraint(
            "invalidation_kind != 'revoked' OR resolution_decision_record_id IS NOT NULL",
            name="ck_source_invalidation_revoked_decision",
        ),
        CheckConstraint(
            "resolution != 'dismissed' OR resolution_decision_record_id IS NOT NULL",
            name="ck_source_invalidation_dismissed_decision",
        ),
        CheckConstraint(
            "invalidation_kind != 'stale' OR current_fingerprint IS NOT previous_fingerprint",
            name="ck_source_invalidation_stale_fingerprint",
        ),
        CheckConstraint("row_version >= 1", name="ck_source_invalidation_row_version"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    source_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    source_id: Mapped[str] = mapped_column(String(100), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    invalidation_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    recovers_invalidation_id: Mapped[str | None] = mapped_column(
        ForeignKey("source_invalidations.id", ondelete="RESTRICT"),
        nullable=True,
    )
    previous_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    current_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    resolution: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    resolution_decision_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"),
        nullable=True,
    )
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
