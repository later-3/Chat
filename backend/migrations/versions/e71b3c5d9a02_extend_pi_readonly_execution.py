"""extend ToolExecution for governed pi read-only dispatch

Revision ID: e71b3c5d9a02
Revises: d6f1c2a4b8e9
Create Date: 2026-07-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "e71b3c5d9a02"
down_revision = "d6f1c2a4b8e9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("tool_executions") as batch:
        batch.add_column(sa.Column("run_attempt_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("runtime_job_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("run_spec_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("step_input_projection_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("repository_binding_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("repository_snapshot_id", sa.String(length=36), nullable=True))
        batch.add_column(sa.Column("execution_ordinal", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("mode", sa.String(length=32), nullable=True))
        batch.add_column(sa.Column("input_hash", sa.String(length=64), nullable=True))
        batch.add_column(sa.Column("capability_hash", sa.String(length=64), nullable=True))
        batch.add_column(
            sa.Column(
                "last_activity_sequence",
                sa.Integer(),
                nullable=False,
                server_default="0",
            )
        )
        batch.add_column(
            sa.Column(
                "process_dispatch_state",
                sa.String(length=32),
                nullable=False,
                server_default="not_started",
            )
        )
        batch.add_column(sa.Column("terminal_reason_code", sa.String(length=100), nullable=True))
        batch.add_column(sa.Column("result_json", sa.JSON(), nullable=True))
        batch.add_column(sa.Column("result_hash", sa.String(length=64), nullable=True))
        batch.add_column(
            sa.Column(
                "row_version",
                sa.Integer(),
                nullable=False,
                server_default="1",
            )
        )
        batch.create_foreign_key(
            "fk_tool_execution_run_attempt",
            "run_attempts",
            ["run_attempt_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        batch.create_foreign_key(
            "fk_tool_execution_runtime_job",
            "runtime_jobs",
            ["runtime_job_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        batch.create_foreign_key(
            "fk_tool_execution_run_spec",
            "run_specs",
            ["run_spec_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        batch.create_foreign_key(
            "fk_tool_execution_step_input",
            "step_input_projections",
            ["step_input_projection_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        batch.create_foreign_key(
            "fk_tool_execution_repository_binding",
            "project_repository_bindings",
            ["repository_binding_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        batch.create_foreign_key(
            "fk_tool_execution_repository_snapshot",
            "repository_snapshots",
            ["repository_snapshot_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        batch.create_unique_constraint(
            "uq_tool_execution_run_tool_ordinal",
            ["run_id", "tool_id", "execution_ordinal"],
        )
    op.create_index(
        "ix_tool_executions_run_attempt_id",
        "tool_executions",
        ["run_attempt_id"],
        unique=False,
    )
    op.create_index(
        "ix_tool_execution_runtime_job_status",
        "tool_executions",
        ["runtime_job_id", "status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_tool_execution_runtime_job_status",
        table_name="tool_executions",
    )
    op.drop_index(
        "ix_tool_executions_run_attempt_id",
        table_name="tool_executions",
    )
    with op.batch_alter_table("tool_executions") as batch:
        batch.drop_constraint(
            "uq_tool_execution_run_tool_ordinal",
            type_="unique",
        )
        batch.drop_constraint(
            "fk_tool_execution_repository_snapshot",
            type_="foreignkey",
        )
        batch.drop_constraint(
            "fk_tool_execution_repository_binding",
            type_="foreignkey",
        )
        batch.drop_constraint("fk_tool_execution_step_input", type_="foreignkey")
        batch.drop_constraint("fk_tool_execution_run_spec", type_="foreignkey")
        batch.drop_constraint("fk_tool_execution_runtime_job", type_="foreignkey")
        batch.drop_constraint("fk_tool_execution_run_attempt", type_="foreignkey")
        batch.drop_column("row_version")
        batch.drop_column("result_hash")
        batch.drop_column("result_json")
        batch.drop_column("terminal_reason_code")
        batch.drop_column("process_dispatch_state")
        batch.drop_column("last_activity_sequence")
        batch.drop_column("capability_hash")
        batch.drop_column("input_hash")
        batch.drop_column("mode")
        batch.drop_column("execution_ordinal")
        batch.drop_column("repository_snapshot_id")
        batch.drop_column("repository_binding_id")
        batch.drop_column("step_input_projection_id")
        batch.drop_column("run_spec_id")
        batch.drop_column("runtime_job_id")
        batch.drop_column("run_attempt_id")
