"""add F01 Tool Operation ledger and SD3 execution workspaces

Revision ID: f01d3a7c9e25
Revises: e71b3c5d9a02
Create Date: 2026-07-25
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "f01d3a7c9e25"
down_revision = "e71b3c5d9a02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "execution_workspaces",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("product_run_id", sa.String(length=36), nullable=False),
        sa.Column("run_attempt_id", sa.String(length=36), nullable=False),
        sa.Column("runtime_job_id", sa.String(length=36), nullable=False),
        sa.Column("tool_execution_id", sa.String(length=36), nullable=False),
        sa.Column("repository_binding_id", sa.String(length=36), nullable=False),
        sa.Column("repository_snapshot_id", sa.String(length=36), nullable=False),
        sa.Column("workspace_key", sa.String(length=80), nullable=False),
        sa.Column("workspace_kind", sa.String(length=32), nullable=False),
        sa.Column("root_key", sa.String(length=64), nullable=False),
        sa.Column("source_relative_path", sa.Text(), nullable=False),
        sa.Column("base_revision", sa.String(length=64), nullable=False),
        sa.Column("observed_head_oid", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("diff_hash", sa.String(length=64), nullable=True),
        sa.Column("changed_paths_json", sa.JSON(), nullable=False),
        sa.Column("failure_code", sa.String(length=100), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("retained_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "workspace_kind = 'managed_git_worktree'",
            name="ck_execution_workspace_kind",
        ),
        sa.CheckConstraint(
            "row_version >= 1",
            name="ck_execution_workspace_row_version",
        ),
        sa.CheckConstraint(
            "status IN ("
            "'preparing','ready','running','validating','retained',"
            "'integrated','discarded','failed'"
            ")",
            name="ck_execution_workspace_status",
        ),
        sa.ForeignKeyConstraint(
            ["product_run_id"],
            ["product_runs.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_attempt_id"],
            ["run_attempts.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["runtime_job_id"],
            ["runtime_jobs.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["tool_execution_id"],
            ["tool_executions.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["repository_binding_id"],
            ["project_repository_bindings.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["repository_snapshot_id"],
            ["repository_snapshots.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tool_execution_id",
            name="uq_execution_workspace_tool_execution",
        ),
        sa.UniqueConstraint(
            "workspace_key",
            name="uq_execution_workspace_key",
        ),
    )
    op.create_index(
        "ix_execution_workspaces_scope_id",
        "execution_workspaces",
        ["scope_id"],
        unique=False,
    )
    op.create_index(
        "ix_execution_workspaces_status",
        "execution_workspaces",
        ["status"],
        unique=False,
    )
    op.create_index(
        "ix_execution_workspace_run_status",
        "execution_workspaces",
        ["product_run_id", "status", "created_at"],
        unique=False,
    )

    op.create_table(
        "tool_operations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("session_id", sa.String(length=36), nullable=False),
        sa.Column("product_run_id", sa.String(length=36), nullable=False),
        sa.Column("run_attempt_id", sa.String(length=36), nullable=False),
        sa.Column("runtime_job_id", sa.String(length=36), nullable=False),
        sa.Column("tool_execution_id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("authorization_consumption_id", sa.String(length=36), nullable=True),
        sa.Column("provider_tool_call_id", sa.String(length=160), nullable=False),
        sa.Column("tool_name", sa.String(length=80), nullable=False),
        sa.Column("tool_definition_revision", sa.String(length=80), nullable=False),
        sa.Column("operation_ordinal", sa.Integer(), nullable=False),
        sa.Column("operation_kind", sa.String(length=40), nullable=False),
        sa.Column("side_effect_class", sa.String(length=40), nullable=False),
        sa.Column("arguments_json", sa.JSON(), nullable=False),
        sa.Column("arguments_hash", sa.String(length=64), nullable=False),
        sa.Column("operation_hash", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.String(length=96), nullable=False),
        sa.Column("target_path", sa.Text(), nullable=False),
        sa.Column("expected_preimage_hash", sa.String(length=64), nullable=False),
        sa.Column("expected_postimage_hash", sa.String(length=64), nullable=False),
        sa.Column("diff_preview", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("dispatch_epoch", sa.Integer(), nullable=False),
        sa.Column("observed_hash", sa.String(length=64), nullable=True),
        sa.Column("result_json", sa.JSON(), nullable=True),
        sa.Column("result_hash", sa.String(length=64), nullable=True),
        sa.Column("failure_code", sa.String(length=100), nullable=True),
        sa.Column("resolution_code", sa.String(length=100), nullable=True),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("authorized_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dispatch_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "dispatch_epoch >= 0",
            name="ck_tool_operation_dispatch_epoch",
        ),
        sa.CheckConstraint(
            "operation_ordinal >= 1",
            name="ck_tool_operation_ordinal",
        ),
        sa.CheckConstraint(
            "row_version >= 1",
            name="ck_tool_operation_row_version",
        ),
        sa.CheckConstraint(
            "status IN ("
            "'proposed','waiting_authorization','authorized','dispatching',"
            "'succeeded','failed','denied','outcome_unknown','reconciling',"
            "'failed_not_applied','manual'"
            ")",
            name="ck_tool_operation_status",
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["product_sessions.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["product_run_id"],
            ["product_runs.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_attempt_id"],
            ["run_attempts.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["runtime_job_id"],
            ["runtime_jobs.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["tool_execution_id"],
            ["tool_executions.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["execution_workspaces.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["authorization_consumption_id"],
            ["authorization_consumptions.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tool_execution_id",
            "provider_tool_call_id",
            name="uq_tool_operation_provider_call",
        ),
        sa.UniqueConstraint(
            "idempotency_key",
            name="uq_tool_operation_idempotency",
        ),
        sa.UniqueConstraint(
            "tool_execution_id",
            "operation_ordinal",
            name="uq_tool_operation_ordinal",
        ),
    )
    op.create_index(
        "ix_tool_operations_scope_id",
        "tool_operations",
        ["scope_id"],
        unique=False,
    )
    op.create_index(
        "ix_tool_operations_status",
        "tool_operations",
        ["status"],
        unique=False,
    )
    op.create_index(
        "ix_tool_operation_run_status",
        "tool_operations",
        ["product_run_id", "status", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_tool_operation_workspace_status",
        "tool_operations",
        ["workspace_id", "status"],
        unique=False,
    )

    op.create_table(
        "tool_operation_attempts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("operation_id", sa.String(length=36), nullable=False),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column("worker_id", sa.String(length=160), nullable=False),
        sa.Column("lease_epoch", sa.Integer(), nullable=False),
        sa.Column("dispatch_epoch", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("result_hash", sa.String(length=64), nullable=True),
        sa.Column("failure_code", sa.String(length=100), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("dispatch_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "attempt_number >= 1",
            name="ck_tool_operation_attempt_number",
        ),
        sa.CheckConstraint(
            "dispatch_epoch >= 1",
            name="ck_tool_operation_attempt_epoch",
        ),
        sa.CheckConstraint(
            "status IN ('claimed','dispatching','succeeded','failed','outcome_unknown')",
            name="ck_tool_operation_attempt_status",
        ),
        sa.ForeignKeyConstraint(
            ["operation_id"],
            ["tool_operations.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "operation_id",
            "attempt_number",
            name="uq_tool_operation_attempt",
        ),
    )
    op.create_index(
        "ix_tool_operation_attempts_operation_id",
        "tool_operation_attempts",
        ["operation_id"],
        unique=False,
    )
    op.create_index(
        "ix_tool_operation_attempt_status",
        "tool_operation_attempts",
        ["status", "started_at"],
        unique=False,
    )

    op.create_table(
        "tool_operation_reconciliations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("operation_id", sa.String(length=36), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("trigger", sa.String(length=40), nullable=False),
        sa.Column("strategy", sa.String(length=60), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("expected_preimage_hash", sa.String(length=64), nullable=False),
        sa.Column("expected_postimage_hash", sa.String(length=64), nullable=False),
        sa.Column("observed_hash", sa.String(length=64), nullable=True),
        sa.Column("resolution_code", sa.String(length=100), nullable=True),
        sa.Column("safe_detail", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "sequence >= 1",
            name="ck_tool_reconciliation_sequence",
        ),
        sa.CheckConstraint(
            "status IN ('running','resolved','manual')",
            name="ck_tool_reconciliation_status",
        ),
        sa.ForeignKeyConstraint(
            ["operation_id"],
            ["tool_operations.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "operation_id",
            "sequence",
            name="uq_tool_operation_reconciliation_sequence",
        ),
    )
    op.create_index(
        "ix_tool_operation_reconciliations_operation_id",
        "tool_operation_reconciliations",
        ["operation_id"],
        unique=False,
    )
    _enable_exact_edit_for_the_sd2_default()


def downgrade() -> None:
    _remove_exact_edit_from_the_sd3_default()
    op.drop_index(
        "ix_tool_operation_reconciliations_operation_id",
        table_name="tool_operation_reconciliations",
    )
    op.drop_table("tool_operation_reconciliations")
    op.drop_index(
        "ix_tool_operation_attempt_status",
        table_name="tool_operation_attempts",
    )
    op.drop_index(
        "ix_tool_operation_attempts_operation_id",
        table_name="tool_operation_attempts",
    )
    op.drop_table("tool_operation_attempts")
    op.drop_index(
        "ix_tool_operation_workspace_status",
        table_name="tool_operations",
    )
    op.drop_index(
        "ix_tool_operation_run_status",
        table_name="tool_operations",
    )
    op.drop_index(
        "ix_tool_operations_status",
        table_name="tool_operations",
    )
    op.drop_index(
        "ix_tool_operations_scope_id",
        table_name="tool_operations",
    )
    op.drop_table("tool_operations")
    op.drop_index(
        "ix_execution_workspace_run_status",
        table_name="execution_workspaces",
    )
    op.drop_index(
        "ix_execution_workspaces_status",
        table_name="execution_workspaces",
    )
    op.drop_index(
        "ix_execution_workspaces_scope_id",
        table_name="execution_workspaces",
    )
    op.drop_table("execution_workspaces")


def _enable_exact_edit_for_the_sd2_default() -> None:
    """Advance only the untouched SD2 default; preserve user-customized configs."""

    connection = op.get_bind()
    configurations = _tool_configuration_table()
    row = (
        connection.execute(
            sa.select(configurations.c.allowed_tools, configurations.c.revision).where(
                configurations.c.id == "pi_agent"
            )
        )
        .mappings()
        .first()
    )
    if row is None:
        return
    tools = _json_array(row["allowed_tools"])
    if tools != ["read", "grep", "find", "ls"]:
        return
    connection.execute(
        sa.update(configurations)
        .where(configurations.c.id == "pi_agent")
        .values(
            allowed_tools=[*tools, "edit"],
            revision=int(row["revision"]) + 1,
        )
    )


def _remove_exact_edit_from_the_sd3_default() -> None:
    """Keep downgrade safe when the user customized the config after upgrade."""

    connection = op.get_bind()
    configurations = _tool_configuration_table()
    row = (
        connection.execute(
            sa.select(configurations.c.allowed_tools, configurations.c.revision).where(
                configurations.c.id == "pi_agent"
            )
        )
        .mappings()
        .first()
    )
    if row is None:
        return
    tools = _json_array(row["allowed_tools"])
    if tools != ["read", "grep", "find", "ls", "edit"]:
        return
    connection.execute(
        sa.update(configurations)
        .where(configurations.c.id == "pi_agent")
        .values(
            allowed_tools=["read", "grep", "find", "ls"],
            revision=int(row["revision"]) + 1,
        )
    )


def _json_array(value: object) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        return []
    return value


def _tool_configuration_table() -> sa.Table:
    return sa.table(
        "tool_configurations",
        sa.column("id", sa.String()),
        sa.column("allowed_tools", sa.JSON()),
        sa.column("revision", sa.Integer()),
    )
