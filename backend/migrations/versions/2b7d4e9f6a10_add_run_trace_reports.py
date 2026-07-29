"""add deterministic dual Run Trace reports

Revision ID: 2b7d4e9f6a10
Revises: a1f3c7d9e521
Create Date: 2026-07-28 18:00:00.000000

每个终态Product Run物化两份报告：diagnostic供机器定位，human供用户理解流程。
它们是trace_events的可重建投影，不是新的事实源，也不保存模型隐藏推理。
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "2b7d4e9f6a10"
down_revision: Union[str, Sequence[str], None] = "a1f3c7d9e521"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "run_trace_reports",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("report_kind", sa.String(length=32), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("workflow_definition_id", sa.String(length=100), nullable=True),
        sa.Column("workflow_version", sa.String(length=32), nullable=True),
        sa.Column("source_first_sequence", sa.Integer(), nullable=False),
        sa.Column("source_last_sequence", sa.Integer(), nullable=False),
        sa.Column("source_event_count", sa.Integer(), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("content_json", sa.JSON(), nullable=False),
        sa.Column("content_text", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["product_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["product_sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", "report_kind", name="uq_run_trace_report_kind"),
    )
    op.create_index(
        "ix_run_trace_reports_run_id",
        "run_trace_reports",
        ["run_id"],
        unique=False,
    )
    op.create_index(
        "ix_run_trace_reports_session_id",
        "run_trace_reports",
        ["session_id"],
        unique=False,
    )
    op.create_index(
        "ix_run_trace_reports_session_run",
        "run_trace_reports",
        ["session_id", "run_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_run_trace_reports_session_run", table_name="run_trace_reports")
    op.drop_index("ix_run_trace_reports_session_id", table_name="run_trace_reports")
    op.drop_index("ix_run_trace_reports_run_id", table_name="run_trace_reports")
    op.drop_table("run_trace_reports")
