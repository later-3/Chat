"""Product records for isolated execution workspaces."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
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


class ExecutionWorkspaceRecord(Base):
    """One Chat-managed Git worktree bound to an approved repository snapshot."""

    __tablename__ = "execution_workspaces"
    __table_args__ = (
        UniqueConstraint("tool_execution_id", name="uq_execution_workspace_tool_execution"),
        UniqueConstraint("workspace_key", name="uq_execution_workspace_key"),
        Index(
            "ix_execution_workspace_run_status",
            "product_run_id",
            "status",
            "created_at",
        ),
        CheckConstraint("row_version >= 1", name="ck_execution_workspace_row_version"),
        CheckConstraint(
            "workspace_kind = 'managed_git_worktree'",
            name="ck_execution_workspace_kind",
        ),
        CheckConstraint(
            "status IN ("
            "'preparing','ready','running','validating','retained',"
            "'integrated','discarded','failed'"
            ")",
            name="ck_execution_workspace_status",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    product_run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    run_attempt_id: Mapped[str] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="RESTRICT"),
        nullable=False,
    )
    runtime_job_id: Mapped[str] = mapped_column(
        ForeignKey("runtime_jobs.id", ondelete="RESTRICT"),
        nullable=False,
    )
    tool_execution_id: Mapped[str] = mapped_column(
        ForeignKey("tool_executions.id", ondelete="RESTRICT"),
        nullable=False,
    )
    repository_binding_id: Mapped[str] = mapped_column(
        ForeignKey("project_repository_bindings.id", ondelete="RESTRICT"),
        nullable=False,
    )
    repository_snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("repository_snapshots.id", ondelete="RESTRICT"),
        nullable=False,
    )
    workspace_key: Mapped[str] = mapped_column(String(80), nullable=False)
    workspace_kind: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="managed_git_worktree",
    )
    root_key: Mapped[str] = mapped_column(String(64), nullable=False)
    source_relative_path: Mapped[str] = mapped_column(Text, nullable=False)
    base_revision: Mapped[str] = mapped_column(String(64), nullable=False)
    observed_head_oid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    diff_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    changed_paths_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    failure_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    retained_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
