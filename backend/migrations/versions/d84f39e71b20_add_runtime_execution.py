"""add durable runtime execution jobs and event journal

Revision ID: d84f39e71b20
Revises: c3f84a1d92e7
Create Date: 2026-07-23 17:00:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d84f39e71b20"
down_revision: Union[str, Sequence[str], None] = "c3f84a1d92e7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "runtime_jobs",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("scope_id", sa.String(100), nullable=False),
        sa.Column("product_run_id", sa.String(36), nullable=False),
        sa.Column("run_attempt_id", sa.String(36), nullable=False),
        sa.Column("endpoint_key", sa.String(180), nullable=False),
        sa.Column("workflow_definition_id", sa.String(100), nullable=False),
        sa.Column("workflow_version", sa.String(40), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("recoverability", sa.String(32), nullable=False),
        sa.Column("checkpoint_id", sa.String(160), nullable=True),
        sa.Column("input_payload_json", sa.JSON(), nullable=False),
        sa.Column("input_hash", sa.String(64), nullable=False),
        sa.Column("lease_owner", sa.String(160), nullable=True),
        sa.Column("lease_epoch", sa.Integer(), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_event_sequence", sa.Integer(), nullable=False),
        sa.Column("earliest_retained_sequence", sa.Integer(), nullable=False),
        sa.Column("external_dispatch_state", sa.String(32), nullable=False),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("failure_code", sa.String(100), nullable=True),
        sa.Column("failure_summary", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["product_run_id"], ["product_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_attempt_id"], ["run_attempts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_attempt_id"),
    )
    op.create_index("ix_runtime_jobs_scope_id", "runtime_jobs", ["scope_id"])
    op.create_index("ix_runtime_jobs_status", "runtime_jobs", ["status"])
    op.create_index("ix_runtime_jobs_claim", "runtime_jobs", ["status", "available_at", "lease_expires_at"])
    op.create_index("ix_runtime_jobs_product_run", "runtime_jobs", ["product_run_id", "created_at"])

    op.create_table(
        "runtime_event_records",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("runtime_job_id", sa.String(36), nullable=False),
        sa.Column("run_attempt_id", sa.String(36), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("agui_event_type", sa.String(80), nullable=False),
        sa.Column("public_payload_json", sa.JSON(), nullable=False),
        sa.Column("payload_hash", sa.String(64), nullable=False),
        sa.Column("is_terminal", sa.Boolean(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["runtime_job_id"], ["runtime_jobs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_attempt_id"], ["run_attempts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("runtime_job_id", "sequence"),
    )
    op.create_index("ix_runtime_event_records_runtime_job_id", "runtime_event_records", ["runtime_job_id"])
    op.create_index("ix_runtime_events_attempt_sequence", "runtime_event_records", ["run_attempt_id", "sequence"])
    op.create_index(
        "uq_runtime_events_terminal",
        "runtime_event_records",
        ["runtime_job_id"],
        unique=True,
        sqlite_where=sa.text("is_terminal = 1"),
    )

    op.create_table(
        "runtime_control_commands",
        sa.Column("id", sa.String(36), nullable=False),
        sa.Column("runtime_job_id", sa.String(36), nullable=False),
        sa.Column("run_attempt_id", sa.String(36), nullable=False),
        sa.Column("command_kind", sa.String(32), nullable=False),
        sa.Column("request_key", sa.String(160), nullable=False),
        sa.Column("expected_status", sa.String(32), nullable=True),
        sa.Column("checkpoint_id", sa.String(160), nullable=True),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("requested_by", sa.String(100), nullable=False),
        sa.Column("scope_id", sa.String(100), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("claimed_by", sa.String(160), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result_code", sa.String(100), nullable=True),
        sa.Column("result_summary", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["runtime_job_id"], ["runtime_jobs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_attempt_id"], ["run_attempts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scope_id", "request_key"),
    )
    op.create_index("ix_runtime_commands_job_status", "runtime_control_commands", ["runtime_job_id", "status", "created_at"])

    op.create_table(
        "execution_workers",
        sa.Column("id", sa.String(160), nullable=False),
        sa.Column("boot_id", sa.String(36), nullable=False),
        sa.Column("host", sa.String(200), nullable=False),
        sa.Column("pid", sa.Integer(), nullable=False),
        sa.Column("version", sa.String(40), nullable=False),
        sa.Column("capabilities_json", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("stopped_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("execution_workers")
    op.drop_index("ix_runtime_commands_job_status", table_name="runtime_control_commands")
    op.drop_table("runtime_control_commands")
    op.drop_index("uq_runtime_events_terminal", table_name="runtime_event_records")
    op.drop_index("ix_runtime_events_attempt_sequence", table_name="runtime_event_records")
    op.drop_index("ix_runtime_event_records_runtime_job_id", table_name="runtime_event_records")
    op.drop_table("runtime_event_records")
    op.drop_index("ix_runtime_jobs_product_run", table_name="runtime_jobs")
    op.drop_index("ix_runtime_jobs_claim", table_name="runtime_jobs")
    op.drop_index("ix_runtime_jobs_status", table_name="runtime_jobs")
    op.drop_index("ix_runtime_jobs_scope_id", table_name="runtime_jobs")
    op.drop_table("runtime_jobs")
