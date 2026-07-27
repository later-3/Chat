"""Persistent product facts for execution, decisions and HITL governance."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..product_sessions.database import Base, utc_now


class DecisionPointDefinitionRecord(Base):
    __tablename__ = "decision_point_definitions"
    __table_args__ = (UniqueConstraint("key", "version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    key: Mapped[str] = mapped_column(String(80), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    category: Mapped[str] = mapped_column(String(80), nullable=False)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    subject_kind: Mapped[str] = mapped_column(String(80), nullable=False)
    default_mode: Mapped[str] = mapped_column(String(32), nullable=False)
    allowed_human_actions_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    applicability_schema_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    response_schema_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    definition_hash: Mapped[str] = mapped_column(String(64), nullable=False)


class TurnSummaryRecord(Base):
    """TurnDigest v1; per-interaction focus, never accepted memory by itself."""

    __tablename__ = "turn_summaries"
    __table_args__ = (
        UniqueConstraint("interaction_id"),
        Index("ix_turn_summaries_session_created", "session_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="RESTRICT"), nullable=False
    )
    interaction_id: Mapped[str] = mapped_column(
        ForeignKey("interactions.id", ondelete="RESTRICT"), nullable=False
    )
    run_id: Mapped[str] = mapped_column(ForeignKey("product_runs.id", ondelete="RESTRICT"), nullable=False)
    topic: Mapped[str] = mapped_column(String(240), nullable=False)
    summary_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    project_hint: Mapped[str | None] = mapped_column(String(240), nullable=True)
    extraction_status: Mapped[str] = mapped_column(String(32), nullable=False, default="candidate")
    source_model_call_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_call_draft_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    summary_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class DecisionSubjectRecord(Base):
    __tablename__ = "decision_subjects"
    __table_args__ = (
        UniqueConstraint("subject_kind", "resource_id", "resource_revision", "subject_hash"),
        Index(
            "uq_decision_subjects_identity",
            "subject_kind",
            "resource_id",
            "resource_revision",
            unique=True,
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    subject_kind: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(100), nullable=False)
    resource_revision: Mapped[str] = mapped_column(String(100), nullable=False)
    subject_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    interaction_id: Mapped[str | None] = mapped_column(
        ForeignKey("interactions.id", ondelete="RESTRICT"), nullable=True
    )
    run_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"), nullable=True
    )
    run_attempt_id: Mapped[str | None] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="RESTRICT"), nullable=True
    )
    workflow_definition_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    workflow_version: Mapped[str | None] = mapped_column(String(40), nullable=True)
    node_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    decision_view_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ExecutionDraftRecord(Base):
    __tablename__ = "execution_drafts"
    __table_args__ = (UniqueConstraint("interaction_id", "workflow_definition_id", "branch_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    interaction_id: Mapped[str] = mapped_column(
        ForeignKey("interactions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    principal_id: Mapped[str] = mapped_column(String(100), nullable=False)
    workflow_definition_id: Mapped[str] = mapped_column(String(100), nullable=False)
    workflow_version: Mapped[str] = mapped_column(String(40), nullable=False)
    branch_key: Mapped[str] = mapped_column(String(80), nullable=False, default="main")
    current_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("execution_draft_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    accepted_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("execution_draft_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    acceptance_decision_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="building", index=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ExecutionDraftRevisionRecord(Base):
    __tablename__ = "execution_draft_revisions"
    __table_args__ = (UniqueConstraint("draft_id", "revision"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    draft_id: Mapped[str] = mapped_column(
        ForeignKey("execution_drafts.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    previous_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("execution_draft_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    subject_id: Mapped[str] = mapped_column(
        ForeignKey("decision_subjects.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    schema_version: Mapped[str] = mapped_column(String(40), nullable=False)
    payload_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    execution_brief_text: Mapped[str] = mapped_column(Text, nullable=False)
    context_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    draft_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    author_type: Mapped[str] = mapped_column(String(32), nullable=False)
    author_id: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="reviewable")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class HitlPolicySetRecord(Base):
    __tablename__ = "hitl_policy_sets"
    __table_args__ = (
        UniqueConstraint(
            "authority", "scope_kind", "scope_ref_id", "scope_ref_revision", "owner_principal_id"
        ),
        Index("ix_hitl_policy_scope", "scope_kind", "scope_ref_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    authority: Mapped[str] = mapped_column(String(40), nullable=False)
    scope_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    scope_ref_id: Mapped[str] = mapped_column(String(120), nullable=False)
    scope_ref_revision: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    owner_principal_id: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    active_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("hitl_policy_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class HitlPolicyRevisionRecord(Base):
    __tablename__ = "hitl_policy_revisions"
    __table_args__ = (UniqueConstraint("policy_set_id", "revision"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    policy_set_id: Mapped[str] = mapped_column(
        ForeignKey("hitl_policy_sets.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    base_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("hitl_policy_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    schema_version: Mapped[str] = mapped_column(String(40), nullable=False)
    policy_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    change_summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    effective_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    activated_by: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class HitlPolicyRuleRecord(Base):
    __tablename__ = "hitl_policy_rules"
    __table_args__ = (UniqueConstraint("policy_revision_id", "decision_point_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    policy_revision_id: Mapped[str] = mapped_column(
        ForeignKey("hitl_policy_revisions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    decision_point_key: Mapped[str] = mapped_column(String(80), nullable=False)
    definition_version: Mapped[int] = mapped_column(Integer, nullable=False)
    mode: Mapped[str] = mapped_column(String(32), nullable=False)
    condition_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    on_match: Mapped[str | None] = mapped_column(String(32), nullable=True)
    constraints_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    reason_template: Mapped[str] = mapped_column(Text, nullable=False, default="")
    condition_specificity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rule_hash: Mapped[str] = mapped_column(String(64), nullable=False)


class HitlPolicySnapshotRecord(Base):
    __tablename__ = "hitl_policy_snapshots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    principal_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    resolver_version: Mapped[str] = mapped_column(String(40), nullable=False)
    active_revision_refs_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    preference_rules_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    floor_rules_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    snapshot_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class RunSpecRecord(Base):
    __tablename__ = "run_specs"
    __table_args__ = (UniqueConstraint("draft_revision_id", "compiler_version", "run_spec_hash"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    draft_revision_id: Mapped[str] = mapped_column(
        ForeignKey("execution_draft_revisions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    subject_id: Mapped[str] = mapped_column(
        ForeignKey("decision_subjects.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    policy_snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("hitl_policy_snapshots.id", ondelete="RESTRICT"), nullable=False
    )
    schema_version: Mapped[str] = mapped_column(String(40), nullable=False)
    compiler_version: Mapped[str] = mapped_column(String(40), nullable=False)
    spec_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    run_spec_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="compiled")
    bound_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"), nullable=True, unique=True
    )
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reason_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class PolicyEvaluationRecord(Base):
    __tablename__ = "policy_evaluations"
    __table_args__ = (
        Index("ix_policy_eval_subject_point", "subject_id", "decision_point_definition_id", "evaluated_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    subject_id: Mapped[str] = mapped_column(
        ForeignKey("decision_subjects.id", ondelete="RESTRICT"), nullable=False
    )
    decision_point_definition_id: Mapped[str] = mapped_column(
        ForeignKey("decision_point_definitions.id", ondelete="RESTRICT"), nullable=False
    )
    policy_snapshot_id: Mapped[str | None] = mapped_column(
        ForeignKey("hitl_policy_snapshots.id", ondelete="RESTRICT"), nullable=True
    )
    principal_id: Mapped[str] = mapped_column(String(100), nullable=False)
    applicability_status: Mapped[str] = mapped_column(String(32), nullable=False)
    facts_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    facts_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    matched_rule_refs_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    floor_action: Mapped[str] = mapped_column(String(32), nullable=False)
    preference_action: Mapped[str] = mapped_column(String(32), nullable=False)
    final_action: Mapped[str | None] = mapped_column(String(32), nullable=True)
    result_status: Mapped[str] = mapped_column(String(32), nullable=False)
    reason_codes_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    resolver_version: Mapped[str] = mapped_column(String(40), nullable=False)
    evaluated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class HumanDecisionRequestRecord(Base):
    __tablename__ = "human_decision_requests"
    __table_args__ = (
        Index("ix_human_request_principal_status", "principal_id", "status", "expires_at"),
        Index("ix_human_request_run_status", "run_id", "status", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    decision_point_key: Mapped[str] = mapped_column(String(80), nullable=False)
    principal_id: Mapped[str] = mapped_column(String(100), nullable=False)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="RESTRICT"), nullable=False
    )
    interaction_id: Mapped[str | None] = mapped_column(
        ForeignKey("interactions.id", ondelete="RESTRICT"), nullable=True
    )
    run_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"), nullable=True
    )
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(180), nullable=False)
    reason_summary: Mapped[str] = mapped_column(Text, nullable=False)
    visible_evidence_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    consequence_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    superseded_by_request_id: Mapped[str | None] = mapped_column(
        ForeignKey("human_decision_requests.id", ondelete="RESTRICT"), nullable=True
    )


class HumanDecisionRequestItemRecord(Base):
    __tablename__ = "human_decision_request_items"
    __table_args__ = (UniqueConstraint("request_id", "item_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    request_id: Mapped[str] = mapped_column(
        ForeignKey("human_decision_requests.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    policy_evaluation_id: Mapped[str] = mapped_column(
        ForeignKey("policy_evaluations.id", ondelete="RESTRICT"), nullable=False
    )
    subject_id: Mapped[str] = mapped_column(
        ForeignKey("decision_subjects.id", ondelete="RESTRICT"), nullable=False
    )
    item_key: Mapped[str] = mapped_column(String(160), nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    allowed_actions_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    decision_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"), nullable=True
    )


class DecisionRecord(Base):
    __tablename__ = "decision_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    policy_evaluation_id: Mapped[str] = mapped_column(
        ForeignKey("policy_evaluations.id", ondelete="RESTRICT"), nullable=False
    )
    request_id: Mapped[str | None] = mapped_column(
        ForeignKey("human_decision_requests.id", ondelete="RESTRICT"), nullable=True
    )
    request_item_id: Mapped[str | None] = mapped_column(
        ForeignKey("human_decision_request_items.id", ondelete="RESTRICT"), nullable=True
    )
    subject_id: Mapped[str] = mapped_column(
        ForeignKey("decision_subjects.id", ondelete="RESTRICT"), nullable=False
    )
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_principal_id: Mapped[str] = mapped_column(String(100), nullable=False)
    decision_code: Mapped[str] = mapped_column(String(40), nullable=False)
    authorization_effect: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    bound_subject_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    policy_rule_refs_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    record_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    revokes_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class AuthorizationGrantRecord(Base):
    __tablename__ = "authorization_grants"
    __table_args__ = (Index("ix_authorization_grant_status_expiry", "status", "expires_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    decision_record_id: Mapped[str] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    subject_id: Mapped[str] = mapped_column(
        ForeignKey("decision_subjects.id", ondelete="RESTRICT"), nullable=False
    )
    grant_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    binding_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    constraints_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    max_consumptions: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    consumed_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    valid_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    invalidation_reason: Mapped[str | None] = mapped_column(String(120), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class AuthorizationConsumptionRecord(Base):
    __tablename__ = "authorization_consumptions"
    __table_args__ = (
        UniqueConstraint("grant_id", "consumption_no"),
        UniqueConstraint("idempotency_key"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    grant_id: Mapped[str] = mapped_column(
        ForeignKey("authorization_grants.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    consumption_no: Mapped[int] = mapped_column(Integer, nullable=False)
    consumer_kind: Mapped[str] = mapped_column(String(50), nullable=False)
    consumer_id: Mapped[str] = mapped_column(String(120), nullable=False)
    attempt_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(180), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="claimed")
    claimed_by: Mapped[str] = mapped_column(String(120), nullable=False)
    claimed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)


class RuntimeInterruptLinkRecord(Base):
    __tablename__ = "runtime_interrupt_links"
    __table_args__ = (
        UniqueConstraint("maf_checkpoint_id", "maf_request_id"),
        Index("ix_runtime_interrupt_run_status", "product_run_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    decision_request_id: Mapped[str] = mapped_column(
        ForeignKey("human_decision_requests.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    product_run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"), nullable=False
    )
    run_attempt_id: Mapped[str] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="RESTRICT"), nullable=False
    )
    maf_workflow_name: Mapped[str] = mapped_column(String(120), nullable=False)
    maf_graph_signature_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    maf_checkpoint_id: Mapped[str] = mapped_column(String(160), nullable=False)
    maf_request_id: Mapped[str] = mapped_column(String(160), nullable=False)
    maf_executor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    agui_thread_id: Mapped[str] = mapped_column(String(120), nullable=False)
    agui_run_id: Mapped[str] = mapped_column(String(120), nullable=False)
    agui_interrupt_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="waiting_checkpoint")
    last_projected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resume_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class MafWorkflowCheckpointRecord(Base):
    """Opaque MAF checkpoint bound to one Product Run and workflow graph version.

    The encoded payload remains owned by MAF.  Product columns exist only for
    authorization, retention, compatibility checks and recovery lookup; they
    must never be projected as Product Message or accepted business state.
    """

    __tablename__ = "maf_workflow_checkpoints"
    __table_args__ = (
        Index(
            "ix_maf_checkpoint_run_workflow_created",
            "product_run_id",
            "workflow_name",
            "created_at",
        ),
        Index("ix_maf_checkpoint_status_created", "status", "created_at"),
    )

    checkpoint_id: Mapped[str] = mapped_column(String(160), primary_key=True)
    product_run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"), nullable=False
    )
    run_attempt_id: Mapped[str] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="RESTRICT"), nullable=False
    )
    workflow_definition_id: Mapped[str] = mapped_column(String(100), nullable=False)
    workflow_version: Mapped[str] = mapped_column(String(40), nullable=False)
    workflow_name: Mapped[str] = mapped_column(String(120), nullable=False)
    graph_signature_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    previous_checkpoint_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    iteration_count: Mapped[int] = mapped_column(Integer, nullable=False)
    pending_request_ids_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    encoded_checkpoint_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    encoding_version: Mapped[str] = mapped_column(String(40), nullable=False, default="maf-json-v1")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="available")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class GovernanceOutboxRecord(Base):
    __tablename__ = "governance_outbox"
    __table_args__ = (Index("ix_governance_outbox_status_available", "status", "available_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    aggregate_kind: Mapped[str] = mapped_column(String(80), nullable=False)
    aggregate_id: Mapped[str] = mapped_column(String(100), nullable=False)
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    payload_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    dedupe_key: Mapped[str] = mapped_column(String(180), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ModelCallDraftRecord(Base):
    __tablename__ = "model_call_drafts"
    __table_args__ = (
        UniqueConstraint("run_id", "workflow_node_id", "call_ordinal"),
        Index("ix_model_call_slot", "run_id", "workflow_node_id", "call_ordinal"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("product_runs.id", ondelete="RESTRICT"), nullable=False)
    run_attempt_id: Mapped[str] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="RESTRICT"), nullable=False
    )
    workflow_node_id: Mapped[str] = mapped_column(String(120), nullable=False)
    call_ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    current_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_call_draft_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="building")
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ModelCallDraftRevisionRecord(Base):
    __tablename__ = "model_call_draft_revisions"
    __table_args__ = (UniqueConstraint("model_call_draft_id", "revision"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    model_call_draft_id: Mapped[str] = mapped_column(
        ForeignKey("model_call_drafts.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    previous_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_call_draft_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    subject_id: Mapped[str] = mapped_column(
        ForeignKey("decision_subjects.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    provider_id: Mapped[str] = mapped_column(String(100), nullable=False)
    provider_protocol: Mapped[str] = mapped_column(String(80), nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    provider_request_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    provider_body: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    provider_body_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    binding_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    effective_context_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    context_source_annotations_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    adapter_version: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="reviewable")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ModelCallAttemptRecord(Base):
    __tablename__ = "model_call_attempts"
    __table_args__ = (UniqueConstraint("model_call_draft_revision_id", "attempt_number"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    model_call_draft_revision_id: Mapped[str] = mapped_column(
        ForeignKey("model_call_draft_revisions.id", ondelete="RESTRICT"), nullable=False
    )
    authorization_consumption_id: Mapped[str] = mapped_column(
        ForeignKey("authorization_consumptions.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    run_id: Mapped[str] = mapped_column(ForeignKey("product_runs.id", ondelete="RESTRICT"), nullable=False)
    run_attempt_id: Mapped[str] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="RESTRICT"), nullable=False
    )
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    transport_idempotency_key: Mapped[str] = mapped_column(String(180), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    http_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    provider_response_id: Mapped[str | None] = mapped_column(String(180), nullable=True)
    provider_request_id: Mapped[str | None] = mapped_column(String(180), nullable=True)
    usage_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    response_metadata_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    output_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    output_text_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    output_disposition: Mapped[str | None] = mapped_column(String(64), nullable=True)
    output_disposition_reason: Mapped[str | None] = mapped_column(String(240), nullable=True)
    transport_event_sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    first_byte_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    failure_code: Mapped[str | None] = mapped_column(String(100), nullable=True)


class ModelCallTransportEventRecord(Base):
    """One safe, ordered transport transition for a governed model attempt.

    The event stores only allowlisted protocol metadata. Provider bodies,
    authentication headers, raw response envelopes and hidden reasoning never
    enter this ledger.
    """

    __tablename__ = "model_call_transport_events"
    __table_args__ = (
        UniqueConstraint("model_call_attempt_id", "sequence"),
        Index("ix_model_transport_event_attempt", "model_call_attempt_id", "sequence"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    model_call_attempt_id: Mapped[str] = mapped_column(
        ForeignKey("model_call_attempts.id", ondelete="CASCADE"), nullable=False
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    stage: Mapped[str] = mapped_column(String(80), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    details_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ToolCallRequestRecord(Base):
    __tablename__ = "tool_call_requests"
    __table_args__ = (UniqueConstraint("run_id", "provider_tool_call_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    run_attempt_id: Mapped[str] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="RESTRICT"), nullable=False
    )
    workflow_node_id: Mapped[str] = mapped_column(String(120), nullable=False)
    provider_tool_call_id: Mapped[str] = mapped_column(String(180), nullable=False)
    tool_id: Mapped[str] = mapped_column(String(100), nullable=False)
    tool_definition_revision: Mapped[str] = mapped_column(String(80), nullable=False)
    arguments_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    arguments_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    target_summary: Mapped[str] = mapped_column(Text, nullable=False)
    risk_snapshot_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    subject_id: Mapped[str] = mapped_column(
        ForeignKey("decision_subjects.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
