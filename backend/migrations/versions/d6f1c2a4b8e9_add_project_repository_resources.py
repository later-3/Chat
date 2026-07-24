"""add Project repository bindings and immutable snapshots

Revision ID: d6f1c2a4b8e9
Revises: a7b4c9d2e601
Create Date: 2026-07-24
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "d6f1c2a4b8e9"
down_revision = "a7b4c9d2e601"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "project_repository_bindings",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("alias", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=False),
        sa.Column("role", sa.String(length=24), nullable=False),
        sa.Column("root_key", sa.String(length=64), nullable=False),
        sa.Column("root_identity_hash", sa.String(length=64), nullable=False),
        sa.Column("relative_path", sa.Text(), nullable=False),
        sa.Column("locator_hash", sa.String(length=64), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("status_reason_code", sa.String(length=80), nullable=True),
        sa.Column("latest_snapshot_sequence", sa.Integer(), nullable=False),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("updated_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("detached_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "generation >= 1",
            name="ck_repository_binding_generation",
        ),
        sa.CheckConstraint(
            "latest_snapshot_sequence >= 1",
            name="ck_repository_binding_snapshot_sequence",
        ),
        sa.CheckConstraint(
            "role IN ('primary', 'supporting', 'documentation')",
            name="ck_repository_binding_role",
        ),
        sa.CheckConstraint(
            "row_version >= 1",
            name="ck_repository_binding_row_version",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'unavailable', 'detached')",
            name="ck_repository_binding_status",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["product_projects.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "scope_id",
            "project_id",
            "alias",
            name="uq_project_repository_binding_alias",
        ),
    )
    op.create_index(
        "ix_project_repository_binding_locator",
        "project_repository_bindings",
        ["scope_id", "locator_hash"],
        unique=False,
    )
    op.create_index(
        "ix_project_repository_binding_project_status",
        "project_repository_bindings",
        ["scope_id", "project_id", "status"],
        unique=False,
    )
    op.create_table(
        "repository_snapshots",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("binding_id", sa.String(length=36), nullable=False),
        sa.Column("binding_generation", sa.Integer(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("capture_status", sa.String(length=24), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("root_identity_hash", sa.String(length=64), nullable=False),
        sa.Column("relative_path", sa.Text(), nullable=False),
        sa.Column("locator_hash", sa.String(length=64), nullable=False),
        sa.Column("head_oid", sa.String(length=64), nullable=True),
        sa.Column("head_ref", sa.String(length=255), nullable=True),
        sa.Column("upstream_ref", sa.String(length=255), nullable=True),
        sa.Column("detached_head", sa.Boolean(), nullable=False),
        sa.Column("ahead_count", sa.Integer(), nullable=False),
        sa.Column("behind_count", sa.Integer(), nullable=False),
        sa.Column("dirty", sa.Boolean(), nullable=False),
        sa.Column("staged_count", sa.Integer(), nullable=False),
        sa.Column("unstaged_count", sa.Integer(), nullable=False),
        sa.Column("untracked_count", sa.Integer(), nullable=False),
        sa.Column("change_count", sa.Integer(), nullable=False),
        sa.Column("changes_truncated", sa.Boolean(), nullable=False),
        sa.Column("change_summary_json", sa.JSON(), nullable=False),
        sa.Column("fingerprint_complete", sa.Boolean(), nullable=False),
        sa.Column("worktree_fingerprint", sa.String(length=64), nullable=True),
        sa.Column("governance_manifest_json", sa.JSON(), nullable=False),
        sa.Column("governance_manifest_hash", sa.String(length=64), nullable=False),
        sa.Column("semantic_hash", sa.String(length=64), nullable=True),
        sa.Column("error_code", sa.String(length=80), nullable=True),
        sa.Column("error_detail_safe", sa.Text(), nullable=True),
        sa.Column("inspector_version", sa.String(length=32), nullable=False),
        sa.CheckConstraint(
            "ahead_count >= 0",
            name="ck_repository_snapshot_ahead",
        ),
        sa.CheckConstraint(
            "behind_count >= 0",
            name="ck_repository_snapshot_behind",
        ),
        sa.CheckConstraint(
            "binding_generation >= 1",
            name="ck_repository_snapshot_generation",
        ),
        sa.CheckConstraint(
            "capture_status IN ('available', 'unavailable')",
            name="ck_repository_snapshot_capture_status",
        ),
        sa.CheckConstraint(
            "change_count >= 0",
            name="ck_repository_snapshot_changes",
        ),
        sa.CheckConstraint(
            "(capture_status = 'available' AND semantic_hash IS NOT NULL "
            "AND error_code IS NULL) OR "
            "(capture_status = 'unavailable' AND semantic_hash IS NULL "
            "AND error_code IS NOT NULL)",
            name="ck_repository_snapshot_result",
        ),
        sa.CheckConstraint(
            "sequence >= 1",
            name="ck_repository_snapshot_sequence",
        ),
        sa.CheckConstraint(
            "staged_count >= 0",
            name="ck_repository_snapshot_staged",
        ),
        sa.CheckConstraint(
            "unstaged_count >= 0",
            name="ck_repository_snapshot_unstaged",
        ),
        sa.CheckConstraint(
            "untracked_count >= 0",
            name="ck_repository_snapshot_untracked",
        ),
        sa.ForeignKeyConstraint(
            ["binding_id"],
            ["project_repository_bindings.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "binding_id",
            "sequence",
            name="uq_repository_snapshot_sequence",
        ),
    )
    op.create_index(
        "ix_repository_snapshot_binding_observed",
        "repository_snapshots",
        ["scope_id", "binding_id", "observed_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_repository_snapshot_binding_observed",
        table_name="repository_snapshots",
    )
    op.drop_table("repository_snapshots")
    op.drop_index(
        "ix_project_repository_binding_project_status",
        table_name="project_repository_bindings",
    )
    op.drop_index(
        "ix_project_repository_binding_locator",
        table_name="project_repository_bindings",
    )
    op.drop_table("project_repository_bindings")
