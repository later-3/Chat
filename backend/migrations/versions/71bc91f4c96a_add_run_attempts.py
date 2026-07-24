"""add run attempts

Revision ID: 71bc91f4c96a
Revises: 8c84fc794c2b
Create Date: 2026-07-21
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "71bc91f4c96a"
down_revision: Union[str, Sequence[str], None] = "8c84fc794c2b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "run_attempts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column("runtime_kind", sa.String(length=50), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("failure_code", sa.String(length=100), nullable=True),
        sa.Column("failure_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["run_id"], ["product_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", "attempt_number"),
    )
    op.create_index(op.f("ix_run_attempts_run_id"), "run_attempts", ["run_id"], unique=False)
    op.create_index(op.f("ix_run_attempts_status"), "run_attempts", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_run_attempts_status"), table_name="run_attempts")
    op.drop_index(op.f("ix_run_attempts_run_id"), table_name="run_attempts")
    op.drop_table("run_attempts")
