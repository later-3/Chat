"""Product Store records for Project repository resources.

Bindings are mutable membership facts owned by a Project. Snapshots are
append-only observations: refreshing a repository always inserts a new row so
an older Context source remains explainable.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..product_sessions.database import Base, utc_now


class ProjectRepositoryBindingRecord(Base):
    """One stable Project member whose location may advance by generation."""

    __tablename__ = "project_repository_bindings"
    __table_args__ = (
        UniqueConstraint(
            "scope_id",
            "project_id",
            "alias",
            name="uq_project_repository_binding_alias",
        ),
        Index(
            "ix_project_repository_binding_project_status",
            "scope_id",
            "project_id",
            "status",
        ),
        Index(
            "ix_project_repository_binding_locator",
            "scope_id",
            "locator_hash",
        ),
        CheckConstraint("generation >= 1", name="ck_repository_binding_generation"),
        CheckConstraint("row_version >= 1", name="ck_repository_binding_row_version"),
        CheckConstraint(
            "latest_snapshot_sequence >= 1",
            name="ck_repository_binding_snapshot_sequence",
        ),
        CheckConstraint(
            "status IN ('active', 'unavailable', 'detached')",
            name="ck_repository_binding_status",
        ),
        CheckConstraint(
            "role IN ('primary', 'supporting', 'documentation')",
            name="ck_repository_binding_role",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("product_projects.id", ondelete="RESTRICT"),
        nullable=False,
    )
    alias: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[str] = mapped_column(String(24), nullable=False)
    root_key: Mapped[str] = mapped_column(String(64), nullable=False)
    root_identity_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    relative_path: Mapped[str] = mapped_column(Text, nullable=False)
    locator_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    generation: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="active")
    status_reason_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    latest_snapshot_sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    updated_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    detached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RepositorySnapshotRecord(Base):
    """Immutable read-only Git and governance-document observation."""

    __tablename__ = "repository_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "binding_id",
            "sequence",
            name="uq_repository_snapshot_sequence",
        ),
        Index(
            "ix_repository_snapshot_binding_observed",
            "scope_id",
            "binding_id",
            "observed_at",
        ),
        CheckConstraint("binding_generation >= 1", name="ck_repository_snapshot_generation"),
        CheckConstraint("sequence >= 1", name="ck_repository_snapshot_sequence"),
        CheckConstraint(
            "capture_status IN ('available', 'unavailable')",
            name="ck_repository_snapshot_capture_status",
        ),
        CheckConstraint("ahead_count >= 0", name="ck_repository_snapshot_ahead"),
        CheckConstraint("behind_count >= 0", name="ck_repository_snapshot_behind"),
        CheckConstraint("staged_count >= 0", name="ck_repository_snapshot_staged"),
        CheckConstraint("unstaged_count >= 0", name="ck_repository_snapshot_unstaged"),
        CheckConstraint("untracked_count >= 0", name="ck_repository_snapshot_untracked"),
        CheckConstraint("change_count >= 0", name="ck_repository_snapshot_changes"),
        CheckConstraint(
            "(capture_status = 'available' AND semantic_hash IS NOT NULL "
            "AND error_code IS NULL) OR "
            "(capture_status = 'unavailable' AND semantic_hash IS NULL "
            "AND error_code IS NOT NULL)",
            name="ck_repository_snapshot_result",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    binding_id: Mapped[str] = mapped_column(
        ForeignKey("project_repository_bindings.id", ondelete="RESTRICT"),
        nullable=False,
    )
    binding_generation: Mapped[int] = mapped_column(Integer, nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    capture_status: Mapped[str] = mapped_column(String(24), nullable=False)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    root_identity_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    relative_path: Mapped[str] = mapped_column(Text, nullable=False)
    locator_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    head_oid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    head_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    upstream_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    detached_head: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    ahead_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    behind_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    dirty: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    staged_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unstaged_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    untracked_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    change_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    changes_truncated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    change_summary_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    fingerprint_complete: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    worktree_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    governance_manifest_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    governance_manifest_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    semantic_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)
    error_detail_safe: Mapped[str | None] = mapped_column(Text, nullable=True)
    inspector_version: Mapped[str] = mapped_column(String(32), nullable=False)
