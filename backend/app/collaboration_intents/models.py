"""Durable, revisioned intent and clarification records.

Pointers such as ``current_revision_id`` deliberately remain service-enforced
references instead of database foreign keys.  The revision rows point back to
their aggregate roots, which avoids circular DDL and keeps SQLite migration
behavior deterministic.  ``CollaborationIntentService`` updates both sides in
one transaction and contract tests guard the pointer invariant.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..governance.models import ModelCallDraftRevisionRecord  # noqa: F401
from ..product_sessions.database import Base, utc_now


class CollaborationIntentSetRecord(Base):
    """Aggregate root for all user intents recognized in one Product Run."""

    __tablename__ = "collaboration_intent_sets"
    __table_args__ = (
        UniqueConstraint("run_id", name="uq_collaboration_intent_set_run"),
        Index("ix_collaboration_intent_set_session_created", "session_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    interaction_id: Mapped[str] = mapped_column(
        ForeignKey("interactions.id", ondelete="CASCADE"),
        nullable=False,
    )
    run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="candidate")
    current_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    accepted_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class CollaborationIntentRecord(Base):
    """Stable identity of one ordered intent branch inside an Intent Set."""

    __tablename__ = "collaboration_intents"
    __table_args__ = (
        UniqueConstraint("intent_set_id", "branch_key", name="uq_collaboration_intent_branch"),
        UniqueConstraint("intent_set_id", "ordinal", name="uq_collaboration_intent_ordinal"),
        Index("ix_collaboration_intent_set_status", "intent_set_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    intent_set_id: Mapped[str] = mapped_column(
        ForeignKey("collaboration_intent_sets.id", ondelete="CASCADE"),
        nullable=False,
    )
    branch_key: Mapped[str] = mapped_column(String(80), nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="candidate")
    current_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    accepted_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class CollaborationIntentRevisionRecord(Base):
    """Immutable semantic meaning of one intent branch."""

    __tablename__ = "collaboration_intent_revisions"
    __table_args__ = (
        UniqueConstraint("intent_id", "revision", name="uq_collaboration_intent_revision"),
        Index("ix_collaboration_intent_revision_hash", "revision_hash"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    intent_id: Mapped[str] = mapped_column(
        ForeignKey("collaboration_intents.id", ondelete="CASCADE"),
        nullable=False,
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    previous_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("collaboration_intent_revisions.id", ondelete="RESTRICT"),
        nullable=True,
    )
    scenario: Mapped[str] = mapped_column(String(40), nullable=False)
    query_kind: Mapped[str | None] = mapped_column(String(60), nullable=True)
    goal: Mapped[str] = mapped_column(Text, nullable=False)
    expected_outcome: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    project_hint: Mapped[str | None] = mapped_column(String(240), nullable=True)
    selected_project_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_projects.id", ondelete="SET NULL"),
        nullable=True,
    )
    needs_plan: Mapped[bool] = mapped_column(nullable=False, default=False)
    needs_clarification: Mapped[bool] = mapped_column(nullable=False, default=False)
    clarification_question: Mapped[str | None] = mapped_column(Text, nullable=True)
    context_keywords_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    dependency_branch_keys_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    constraints_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    reason_summary: Mapped[str] = mapped_column(Text, nullable=False)
    source_model_call_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_call_draft_revisions.id", ondelete="SET NULL"),
        nullable=True,
    )
    author_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="candidate")
    revision_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class CollaborationIntentSetRevisionRecord(Base):
    """Immutable ordering and dependency snapshot for an Intent Set."""

    __tablename__ = "collaboration_intent_set_revisions"
    __table_args__ = (
        UniqueConstraint("intent_set_id", "revision", name="uq_collaboration_intent_set_revision"),
        Index("ix_collaboration_intent_set_revision_hash", "revision_hash"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    intent_set_id: Mapped[str] = mapped_column(
        ForeignKey("collaboration_intent_sets.id", ondelete="CASCADE"),
        nullable=False,
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    previous_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("collaboration_intent_set_revisions.id", ondelete="RESTRICT"),
        nullable=True,
    )
    intent_revision_ids_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    execution_order_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    combination_policy: Mapped[str] = mapped_column(String(32), nullable=False)
    source_prompt_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    revision_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    author_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="candidate")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ClarificationRequestRecord(Base):
    """One explicit question whose answer must arrive through normal Chat input."""

    __tablename__ = "clarification_requests"
    __table_args__ = (
        UniqueConstraint("intent_revision_id", name="uq_clarification_intent_revision"),
        Index("ix_clarification_session_status_created", "session_id", "status", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
    originating_run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    intent_revision_id: Mapped[str] = mapped_column(
        ForeignKey("collaboration_intent_revisions.id", ondelete="CASCADE"),
        nullable=False,
    )
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer_schema_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    options_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="open")
    current_answer_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ClarificationAnswerRecord(Base):
    """Immutable user answer, tied to the follow-up Product Run."""

    __tablename__ = "clarification_answers"
    __table_args__ = (
        UniqueConstraint("clarification_request_id", "revision", name="uq_clarification_answer_revision"),
        Index("ix_clarification_answer_hash", "answer_hash"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    clarification_request_id: Mapped[str] = mapped_column(
        ForeignKey("clarification_requests.id", ondelete="CASCADE"),
        nullable=False,
    )
    answering_run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    answer_text: Mapped[str] = mapped_column(Text, nullable=False)
    answer_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
