"""add authoritative Product Harness resources

Revision ID: c3f84a1d92e7
Revises: 92f617c3a8d1
Create Date: 2026-07-23 14:30:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c3f84a1d92e7"
down_revision: Union[str, Sequence[str], None] = "92f617c3a8d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "product_projects",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=180), nullable=False),
        sa.Column("goal", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("current_milestone_id", sa.String(length=36), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_product_projects_scope_kind", "product_projects", ["scope_id", "kind", "updated_at"])
    op.create_index("ix_product_projects_scope_status", "product_projects", ["scope_id", "status", "updated_at"])

    op.create_table(
        "work_items",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=True),
        sa.Column("parent_work_item_id", sa.String(length=36), nullable=True),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("objective", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("priority", sa.String(length=20), nullable=False),
        sa.Column("current_plan_revision_id", sa.String(length=36), nullable=True),
        sa.Column("completion_evidence_json", sa.JSON(), nullable=False),
        sa.Column("completion_waiver_reason", sa.Text(), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["parent_work_item_id"], ["work_items.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["project_id"], ["product_projects.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_work_items_project_status", "work_items", ["project_id", "status", "updated_at"])
    op.create_index("ix_work_items_scope_status", "work_items", ["scope_id", "status", "updated_at"])

    op.create_table(
        "task_plans",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=True),
        sa.Column("work_item_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("current_revision_id", sa.String(length=36), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["product_projects.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["work_item_id"], ["work_items.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_task_plans_work_status", "task_plans", ["work_item_id", "status"])

    op.create_table(
        "task_plan_revisions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("task_plan_id", sa.String(length=36), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("previous_revision_id", sa.String(length=36), nullable=True),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("validation_contract_json", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["previous_revision_id"], ["task_plan_revisions.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["task_plan_id"], ["task_plans.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_plan_id", "revision"),
    )

    op.create_table(
        "plan_nodes",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("plan_revision_id", sa.String(length=36), nullable=False),
        sa.Column("node_key", sa.String(length=80), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("objective", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("assignee_kind", sa.String(length=20), nullable=False),
        sa.Column("dependency_keys_json", sa.JSON(), nullable=False),
        sa.Column("validation_json", sa.JSON(), nullable=False),
        sa.Column("stop_condition", sa.Text(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["plan_revision_id"], ["task_plan_revisions.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("plan_revision_id", "node_key"),
    )

    op.create_table(
        "action_items",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=True),
        sa.Column("work_item_id", sa.String(length=36), nullable=True),
        sa.Column("plan_node_id", sa.String(length=36), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("assignee_kind", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("evidence_json", sa.JSON(), nullable=False),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["plan_node_id"], ["plan_nodes.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["project_id"], ["product_projects.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["work_item_id"], ["work_items.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_action_items_work_status", "action_items", ["work_item_id", "status"])

    op.create_table(
        "knowledge_notes",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=220), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("current_revision_id", sa.String(length=36), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_knowledge_notes_scope_status", "knowledge_notes", ["scope_id", "status", "updated_at"])

    op.create_table(
        "knowledge_note_revisions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("note_id", sa.String(length=36), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("previous_revision_id", sa.String(length=36), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source_refs_json", sa.JSON(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["note_id"], ["knowledge_notes.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["previous_revision_id"], ["knowledge_note_revisions.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("note_id", "revision"),
    )

    op.create_table(
        "memory_candidates",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("scope_kind", sa.String(length=32), nullable=False),
        sa.Column("scope_ref_id", sa.String(length=100), nullable=True),
        sa.Column("memory_kind", sa.String(length=32), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("source_refs_json", sa.JSON(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("proposed_by", sa.String(length=100), nullable=False),
        sa.Column("decision_record_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["decision_record_id"], ["decision_records.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_memory_candidates_scope_status", "memory_candidates", ["scope_id", "status", "created_at"])

    op.create_table(
        "accepted_memories",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("scope_kind", sa.String(length=32), nullable=False),
        sa.Column("scope_ref_id", sa.String(length=100), nullable=True),
        sa.Column("memory_kind", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("current_revision_id", sa.String(length=36), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_accepted_memories_scope_status", "accepted_memories", ["scope_id", "status", "updated_at"])

    op.create_table(
        "memory_revisions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("memory_id", sa.String(length=36), nullable=False),
        sa.Column("candidate_id", sa.String(length=36), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("previous_revision_id", sa.String(length=36), nullable=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("source_refs_json", sa.JSON(), nullable=False),
        sa.Column("decision_record_id", sa.String(length=36), nullable=True),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["candidate_id"], ["memory_candidates.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["decision_record_id"], ["decision_records.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["memory_id"], ["accepted_memories.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["previous_revision_id"], ["memory_revisions.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("memory_id", "revision"),
    )

    op.create_table(
        "resource_session_links",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("resource_kind", sa.String(length=40), nullable=False),
        sa.Column("resource_id", sa.String(length=100), nullable=False),
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("source_kind", sa.String(length=40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["product_sessions.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("resource_kind", "resource_id", "session_id"),
    )
    op.create_table(
        "resource_message_links",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("resource_kind", sa.String(length=40), nullable=False),
        sa.Column("resource_id", sa.String(length=100), nullable=False),
        sa.Column("message_id", sa.String(length=36), nullable=False),
        sa.Column("relation", sa.String(length=40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["message_id"], ["product_messages.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("resource_kind", "resource_id", "message_id", "relation"),
    )
    op.create_table(
        "project_work_links",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("work_item_id", sa.String(length=36), nullable=False),
        sa.Column("relation", sa.String(length=40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["product_projects.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["work_item_id"], ["work_items.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "work_item_id", "relation"),
    )
    op.create_table(
        "note_resource_links",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("note_id", sa.String(length=36), nullable=False),
        sa.Column("resource_kind", sa.String(length=40), nullable=False),
        sa.Column("resource_id", sa.String(length=100), nullable=False),
        sa.Column("relation", sa.String(length=40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["note_id"], ["knowledge_notes.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("note_id", "resource_kind", "resource_id", "relation"),
    )
    op.create_table(
        "memory_source_links",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("memory_revision_id", sa.String(length=36), nullable=False),
        sa.Column("source_kind", sa.String(length=40), nullable=False),
        sa.Column("source_id", sa.String(length=100), nullable=False),
        sa.Column("source_revision", sa.String(length=100), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["memory_revision_id"], ["memory_revisions.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("memory_revision_id", "source_kind", "source_id"),
    )

    op.create_table(
        "context_packages",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("interaction_id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("stage", sa.String(length=20), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("selected_project_id", sa.String(length=36), nullable=True),
        sa.Column("selected_work_item_id", sa.String(length=36), nullable=True),
        sa.Column("token_budget", sa.Integer(), nullable=False),
        sa.Column("estimated_tokens", sa.Integer(), nullable=False),
        sa.Column("package_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["interaction_id"], ["interactions.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["run_id"], ["product_runs.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["selected_project_id"], ["product_projects.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["selected_work_item_id"], ["work_items.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["session_id"], ["product_sessions.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", "stage", "revision"),
    )
    op.create_index("ix_context_packages_session_created", "context_packages", ["session_id", "created_at"])

    op.create_table(
        "context_adoption_records",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("context_package_id", sa.String(length=36), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("source_kind", sa.String(length=40), nullable=False),
        sa.Column("source_id", sa.String(length=100), nullable=False),
        sa.Column("source_revision", sa.String(length=100), nullable=True),
        sa.Column("title", sa.String(length=240), nullable=False),
        sa.Column("content_text", sa.Text(), nullable=False),
        sa.Column("adopted", sa.Boolean(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("token_estimate", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["context_package_id"], ["context_packages.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("context_package_id", "ordinal"),
    )

    op.create_table(
        "harness_commands",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("command_id", sa.String(length=160), nullable=False),
        sa.Column("command_kind", sa.String(length=80), nullable=False),
        sa.Column("principal_id", sa.String(length=100), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("result_json", sa.JSON(), nullable=False),
        sa.Column("decision_record_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["decision_record_id"], ["decision_records.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scope_id", "command_id"),
    )
    op.create_table(
        "harness_trace_events",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("command_id", sa.String(length=160), nullable=False),
        sa.Column("event_type", sa.String(length=80), nullable=False),
        sa.Column("resource_kind", sa.String(length=40), nullable=False),
        sa.Column("resource_id", sa.String(length=100), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_harness_trace_scope_created", "harness_trace_events", ["scope_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_harness_trace_scope_created", table_name="harness_trace_events")
    op.drop_table("harness_trace_events")
    op.drop_table("harness_commands")
    op.drop_table("context_adoption_records")
    op.drop_index("ix_context_packages_session_created", table_name="context_packages")
    op.drop_table("context_packages")
    op.drop_table("memory_source_links")
    op.drop_table("note_resource_links")
    op.drop_table("project_work_links")
    op.drop_table("resource_message_links")
    op.drop_table("resource_session_links")
    op.drop_table("memory_revisions")
    op.drop_index("ix_accepted_memories_scope_status", table_name="accepted_memories")
    op.drop_table("accepted_memories")
    op.drop_index("ix_memory_candidates_scope_status", table_name="memory_candidates")
    op.drop_table("memory_candidates")
    op.drop_table("knowledge_note_revisions")
    op.drop_index("ix_knowledge_notes_scope_status", table_name="knowledge_notes")
    op.drop_table("knowledge_notes")
    op.drop_index("ix_action_items_work_status", table_name="action_items")
    op.drop_table("action_items")
    op.drop_table("plan_nodes")
    op.drop_table("task_plan_revisions")
    op.drop_index("ix_task_plans_work_status", table_name="task_plans")
    op.drop_table("task_plans")
    op.drop_index("ix_work_items_scope_status", table_name="work_items")
    op.drop_index("ix_work_items_project_status", table_name="work_items")
    op.drop_table("work_items")
    op.drop_index("ix_product_projects_scope_status", table_name="product_projects")
    op.drop_index("ix_product_projects_scope_kind", table_name="product_projects")
    op.drop_table("product_projects")
