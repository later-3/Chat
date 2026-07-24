"""add durable MAF workflow checkpoints

Revision ID: 92f617c3a8d1
Revises: 344961dfd573
Create Date: 2026-07-23 10:00:00
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "92f617c3a8d1"
down_revision: Union[str, Sequence[str], None] = "344961dfd573"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "maf_workflow_checkpoints",
        sa.Column("checkpoint_id", sa.String(length=160), nullable=False),
        sa.Column("product_run_id", sa.String(length=36), nullable=False),
        sa.Column("run_attempt_id", sa.String(length=36), nullable=False),
        sa.Column("workflow_definition_id", sa.String(length=100), nullable=False),
        sa.Column("workflow_version", sa.String(length=40), nullable=False),
        sa.Column("workflow_name", sa.String(length=120), nullable=False),
        sa.Column("graph_signature_hash", sa.String(length=64), nullable=False),
        sa.Column("previous_checkpoint_id", sa.String(length=160), nullable=True),
        sa.Column("iteration_count", sa.Integer(), nullable=False),
        sa.Column("pending_request_ids_json", sa.JSON(), nullable=False),
        sa.Column("encoded_checkpoint_json", sa.JSON(), nullable=False),
        sa.Column("encoding_version", sa.String(length=40), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("superseded_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["product_run_id"], ["product_runs.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["run_attempt_id"], ["run_attempts.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("checkpoint_id"),
    )
    op.create_index(
        "ix_maf_checkpoint_run_workflow_created",
        "maf_workflow_checkpoints",
        ["product_run_id", "workflow_name", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_maf_checkpoint_status_created",
        "maf_workflow_checkpoints",
        ["status", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_maf_checkpoint_status_created", table_name="maf_workflow_checkpoints")
    op.drop_index("ix_maf_checkpoint_run_workflow_created", table_name="maf_workflow_checkpoints")
    op.drop_table("maf_workflow_checkpoints")
