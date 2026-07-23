"""Authoritative Product Harness persistence records.

MAF owns Agent and Workflow runtime state.  These records own durable user
work and knowledge facts and therefore remain independent of AgentSession and
Workflow Checkpoint payloads.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..product_sessions.database import Base, utc_now


class ProductProjectRecord(Base):
    __tablename__ = "product_projects"
    __table_args__ = (
        Index("ix_product_projects_scope_status", "scope_id", "status", "updated_at"),
        Index("ix_product_projects_scope_kind", "scope_id", "kind", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(180), nullable=False)
    goal: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="proposed")
    current_milestone_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class WorkItemRecord(Base):
    __tablename__ = "work_items"
    __table_args__ = (
        Index("ix_work_items_project_status", "project_id", "status", "updated_at"),
        Index("ix_work_items_scope_status", "scope_id", "status", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_projects.id", ondelete="RESTRICT"), nullable=True
    )
    parent_work_item_id: Mapped[str | None] = mapped_column(
        ForeignKey("work_items.id", ondelete="RESTRICT"), nullable=True
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    objective: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    priority: Mapped[str] = mapped_column(String(20), nullable=False, default="normal")
    current_plan_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    completion_evidence_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    completion_waiver_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class TaskPlanRecord(Base):
    __tablename__ = "task_plans"
    __table_args__ = (Index("ix_task_plans_work_status", "work_item_id", "status"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_projects.id", ondelete="RESTRICT"), nullable=True
    )
    work_item_id: Mapped[str] = mapped_column(
        ForeignKey("work_items.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    current_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class TaskPlanRevisionRecord(Base):
    __tablename__ = "task_plan_revisions"
    __table_args__ = (UniqueConstraint("task_plan_id", "revision"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    task_plan_id: Mapped[str] = mapped_column(
        ForeignKey("task_plans.id", ondelete="RESTRICT"), nullable=False
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    previous_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("task_plan_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    validation_contract_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="candidate")
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class PlanNodeRecord(Base):
    __tablename__ = "plan_nodes"
    __table_args__ = (UniqueConstraint("plan_revision_id", "node_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    plan_revision_id: Mapped[str] = mapped_column(
        ForeignKey("task_plan_revisions.id", ondelete="RESTRICT"), nullable=False
    )
    node_key: Mapped[str] = mapped_column(String(80), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    objective: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    assignee_kind: Mapped[str] = mapped_column(String(20), nullable=False, default="agent")
    dependency_keys_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    validation_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    stop_condition: Mapped[str] = mapped_column(Text, nullable=False, default="")
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)


class ActionItemRecord(Base):
    __tablename__ = "action_items"
    __table_args__ = (Index("ix_action_items_work_status", "work_item_id", "status"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_projects.id", ondelete="RESTRICT"), nullable=True
    )
    work_item_id: Mapped[str | None] = mapped_column(
        ForeignKey("work_items.id", ondelete="RESTRICT"), nullable=True
    )
    plan_node_id: Mapped[str | None] = mapped_column(
        ForeignKey("plan_nodes.id", ondelete="RESTRICT"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    assignee_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    evidence_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class NoteRecord(Base):
    __tablename__ = "knowledge_notes"
    __table_args__ = (Index("ix_knowledge_notes_scope_status", "scope_id", "status", "updated_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(220), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    current_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class NoteRevisionRecord(Base):
    __tablename__ = "knowledge_note_revisions"
    __table_args__ = (UniqueConstraint("note_id", "revision"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    note_id: Mapped[str] = mapped_column(
        ForeignKey("knowledge_notes.id", ondelete="RESTRICT"), nullable=False
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    previous_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("knowledge_note_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source_refs_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class MemoryCandidateRecord(Base):
    __tablename__ = "memory_candidates"
    __table_args__ = (Index("ix_memory_candidates_scope_status", "scope_id", "status", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    scope_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    scope_ref_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    memory_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="candidate")
    source_refs_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    proposed_by: Mapped[str] = mapped_column(String(100), nullable=False)
    decision_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AcceptedMemoryRecord(Base):
    __tablename__ = "accepted_memories"
    __table_args__ = (Index("ix_accepted_memories_scope_status", "scope_id", "status", "updated_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    scope_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    scope_ref_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    memory_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="accepted")
    current_revision_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class MemoryRevisionRecord(Base):
    __tablename__ = "memory_revisions"
    __table_args__ = (UniqueConstraint("memory_id", "revision"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    memory_id: Mapped[str] = mapped_column(
        ForeignKey("accepted_memories.id", ondelete="RESTRICT"), nullable=False
    )
    candidate_id: Mapped[str | None] = mapped_column(
        ForeignKey("memory_candidates.id", ondelete="RESTRICT"), nullable=True
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    previous_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("memory_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    source_refs_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    decision_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"), nullable=True
    )
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ResourceSessionLinkRecord(Base):
    __tablename__ = "resource_session_links"
    __table_args__ = (UniqueConstraint("resource_kind", "resource_id", "session_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    resource_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(100), nullable=False)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="RESTRICT"), nullable=False
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    source_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ResourceMessageLinkRecord(Base):
    __tablename__ = "resource_message_links"
    __table_args__ = (UniqueConstraint("resource_kind", "resource_id", "message_id", "relation"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    resource_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(100), nullable=False)
    message_id: Mapped[str] = mapped_column(
        ForeignKey("product_messages.id", ondelete="RESTRICT"), nullable=False
    )
    relation: Mapped[str] = mapped_column(String(40), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ProjectWorkLinkRecord(Base):
    __tablename__ = "project_work_links"
    __table_args__ = (UniqueConstraint("project_id", "work_item_id", "relation"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("product_projects.id", ondelete="RESTRICT"), nullable=False
    )
    work_item_id: Mapped[str] = mapped_column(
        ForeignKey("work_items.id", ondelete="RESTRICT"), nullable=False
    )
    relation: Mapped[str] = mapped_column(String(40), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class NoteResourceLinkRecord(Base):
    __tablename__ = "note_resource_links"
    __table_args__ = (UniqueConstraint("note_id", "resource_kind", "resource_id", "relation"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    note_id: Mapped[str] = mapped_column(
        ForeignKey("knowledge_notes.id", ondelete="RESTRICT"), nullable=False
    )
    resource_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(100), nullable=False)
    relation: Mapped[str] = mapped_column(String(40), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class MemorySourceLinkRecord(Base):
    __tablename__ = "memory_source_links"
    __table_args__ = (UniqueConstraint("memory_revision_id", "source_kind", "source_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    memory_revision_id: Mapped[str] = mapped_column(
        ForeignKey("memory_revisions.id", ondelete="RESTRICT"), nullable=False
    )
    source_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    source_id: Mapped[str] = mapped_column(String(100), nullable=False)
    source_revision: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ContextPackageRecord(Base):
    __tablename__ = "context_packages"
    __table_args__ = (
        UniqueConstraint("run_id", "stage", "revision"),
        Index("ix_context_packages_session_created", "session_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="RESTRICT"), nullable=False
    )
    interaction_id: Mapped[str] = mapped_column(
        ForeignKey("interactions.id", ondelete="RESTRICT"), nullable=False
    )
    run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"), nullable=False
    )
    stage: Mapped[str] = mapped_column(String(20), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    selected_project_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_projects.id", ondelete="RESTRICT"), nullable=True
    )
    selected_work_item_id: Mapped[str | None] = mapped_column(
        ForeignKey("work_items.id", ondelete="RESTRICT"), nullable=True
    )
    token_budget: Mapped[int] = mapped_column(Integer, nullable=False)
    estimated_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    package_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="candidate")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class ContextAdoptionRecord(Base):
    __tablename__ = "context_adoption_records"
    __table_args__ = (UniqueConstraint("context_package_id", "ordinal"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    context_package_id: Mapped[str] = mapped_column(
        ForeignKey("context_packages.id", ondelete="RESTRICT"), nullable=False
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    source_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    source_id: Mapped[str] = mapped_column(String(100), nullable=False)
    source_revision: Mapped[str | None] = mapped_column(String(100), nullable=True)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    content_text: Mapped[str] = mapped_column(Text, nullable=False)
    adopted: Mapped[bool] = mapped_column(nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    token_estimate: Mapped[int] = mapped_column(Integer, nullable=False)


class HarnessCommandRecord(Base):
    __tablename__ = "harness_commands"
    __table_args__ = (UniqueConstraint("scope_id", "command_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    command_kind: Mapped[str] = mapped_column(String(80), nullable=False)
    principal_id: Mapped[str] = mapped_column(String(100), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    result_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    decision_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class HarnessTraceRecord(Base):
    __tablename__ = "harness_trace_events"
    __table_args__ = (Index("ix_harness_trace_scope_created", "scope_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    command_id: Mapped[str] = mapped_column(String(160), nullable=False)
    event_type: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(100), nullable=False)
    payload_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
