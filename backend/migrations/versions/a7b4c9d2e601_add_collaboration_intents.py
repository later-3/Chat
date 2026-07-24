"""Add versioned Intent Sets and durable clarification answers.

Revision ID: a7b4c9d2e601
Revises: c8d14a7e2f90
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7b4c9d2e601"
down_revision: Union[str, Sequence[str], None] = "c8d14a7e2f90"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "collaboration_intent_sets",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("interaction_id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("current_revision_id", sa.String(length=36), nullable=True),
        sa.Column("accepted_revision_id", sa.String(length=36), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["product_sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["interaction_id"], ["interactions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_id"], ["product_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", name="uq_collaboration_intent_set_run"),
    )
    op.create_index(
        "ix_collaboration_intent_set_session_created",
        "collaboration_intent_sets",
        ["session_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_collaboration_intent_sets_scope_id",
        "collaboration_intent_sets",
        ["scope_id"],
        unique=False,
    )
    op.create_table(
        "collaboration_intents",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("intent_set_id", sa.String(length=36), nullable=False),
        sa.Column("branch_key", sa.String(length=80), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("current_revision_id", sa.String(length=36), nullable=True),
        sa.Column("accepted_revision_id", sa.String(length=36), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["intent_set_id"], ["collaboration_intent_sets.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("intent_set_id", "branch_key", name="uq_collaboration_intent_branch"),
        sa.UniqueConstraint("intent_set_id", "ordinal", name="uq_collaboration_intent_ordinal"),
    )
    op.create_index(
        "ix_collaboration_intent_set_status",
        "collaboration_intents",
        ["intent_set_id", "status"],
        unique=False,
    )
    op.create_table(
        "collaboration_intent_revisions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("intent_id", sa.String(length=36), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("previous_revision_id", sa.String(length=36), nullable=True),
        sa.Column("scenario", sa.String(length=40), nullable=False),
        sa.Column("query_kind", sa.String(length=60), nullable=True),
        sa.Column("goal", sa.Text(), nullable=False),
        sa.Column("expected_outcome", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("project_hint", sa.String(length=240), nullable=True),
        sa.Column("selected_project_id", sa.String(length=36), nullable=True),
        sa.Column("needs_plan", sa.Boolean(), nullable=False),
        sa.Column("needs_clarification", sa.Boolean(), nullable=False),
        sa.Column("clarification_question", sa.Text(), nullable=True),
        sa.Column("context_keywords_json", sa.JSON(), nullable=False),
        sa.Column("dependency_branch_keys_json", sa.JSON(), nullable=False),
        sa.Column("constraints_json", sa.JSON(), nullable=False),
        sa.Column("reason_summary", sa.Text(), nullable=False),
        sa.Column("source_model_call_revision_id", sa.String(length=36), nullable=True),
        sa.Column("author_kind", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("revision_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["intent_id"], ["collaboration_intents.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["previous_revision_id"],
            ["collaboration_intent_revisions.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["selected_project_id"],
            ["product_projects.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["source_model_call_revision_id"],
            ["model_call_draft_revisions.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("intent_id", "revision", name="uq_collaboration_intent_revision"),
    )
    op.create_index(
        "ix_collaboration_intent_revision_hash",
        "collaboration_intent_revisions",
        ["revision_hash"],
        unique=False,
    )
    op.create_table(
        "collaboration_intent_set_revisions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("intent_set_id", sa.String(length=36), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("previous_revision_id", sa.String(length=36), nullable=True),
        sa.Column("intent_revision_ids_json", sa.JSON(), nullable=False),
        sa.Column("execution_order_json", sa.JSON(), nullable=False),
        sa.Column("combination_policy", sa.String(length=32), nullable=False),
        sa.Column("source_prompt_hash", sa.String(length=64), nullable=False),
        sa.Column("revision_hash", sa.String(length=64), nullable=False),
        sa.Column("author_kind", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["intent_set_id"], ["collaboration_intent_sets.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["previous_revision_id"],
            ["collaboration_intent_set_revisions.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("intent_set_id", "revision", name="uq_collaboration_intent_set_revision"),
    )
    op.create_index(
        "ix_collaboration_intent_set_revision_hash",
        "collaboration_intent_set_revisions",
        ["revision_hash"],
        unique=False,
    )
    op.create_table(
        "clarification_requests",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("originating_run_id", sa.String(length=36), nullable=False),
        sa.Column("intent_revision_id", sa.String(length=36), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer_schema_json", sa.JSON(), nullable=False),
        sa.Column("options_json", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("current_answer_id", sa.String(length=36), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["session_id"], ["product_sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["originating_run_id"], ["product_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["intent_revision_id"],
            ["collaboration_intent_revisions.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("intent_revision_id", name="uq_clarification_intent_revision"),
    )
    op.create_index(
        "ix_clarification_session_status_created",
        "clarification_requests",
        ["session_id", "status", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_clarification_requests_scope_id",
        "clarification_requests",
        ["scope_id"],
        unique=False,
    )
    op.create_table(
        "clarification_answers",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("clarification_request_id", sa.String(length=36), nullable=False),
        sa.Column("answering_run_id", sa.String(length=36), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("answer_text", sa.Text(), nullable=False),
        sa.Column("answer_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["clarification_request_id"],
            ["clarification_requests.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(["answering_run_id"], ["product_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "clarification_request_id",
            "revision",
            name="uq_clarification_answer_revision",
        ),
    )
    op.create_index(
        "ix_clarification_answer_hash",
        "clarification_answers",
        ["answer_hash"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_clarification_answer_hash", table_name="clarification_answers")
    op.drop_table("clarification_answers")
    op.drop_index("ix_clarification_requests_scope_id", table_name="clarification_requests")
    op.drop_index(
        "ix_clarification_session_status_created",
        table_name="clarification_requests",
    )
    op.drop_table("clarification_requests")
    op.drop_index(
        "ix_collaboration_intent_set_revision_hash",
        table_name="collaboration_intent_set_revisions",
    )
    op.drop_table("collaboration_intent_set_revisions")
    op.drop_index(
        "ix_collaboration_intent_revision_hash",
        table_name="collaboration_intent_revisions",
    )
    op.drop_table("collaboration_intent_revisions")
    op.drop_index(
        "ix_collaboration_intent_set_status",
        table_name="collaboration_intents",
    )
    op.drop_table("collaboration_intents")
    op.drop_index(
        "ix_collaboration_intent_sets_scope_id",
        table_name="collaboration_intent_sets",
    )
    op.drop_index(
        "ix_collaboration_intent_set_session_created",
        table_name="collaboration_intent_sets",
    )
    op.drop_table("collaboration_intent_sets")
