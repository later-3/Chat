"""Durable Tool Operation, Attempt and reconciliation records."""

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


class ToolOperationRecord(Base):
    """One exact side-effect request proposed by an Agent Tool call."""

    __tablename__ = "tool_operations"
    __table_args__ = (
        UniqueConstraint(
            "tool_execution_id",
            "provider_tool_call_id",
            name="uq_tool_operation_provider_call",
        ),
        UniqueConstraint("idempotency_key", name="uq_tool_operation_idempotency"),
        UniqueConstraint(
            "tool_execution_id",
            "operation_ordinal",
            name="uq_tool_operation_ordinal",
        ),
        Index("ix_tool_operation_run_status", "product_run_id", "status", "created_at"),
        Index("ix_tool_operation_workspace_status", "workspace_id", "status"),
        CheckConstraint("operation_ordinal >= 1", name="ck_tool_operation_ordinal"),
        CheckConstraint("dispatch_epoch >= 0", name="ck_tool_operation_dispatch_epoch"),
        CheckConstraint("row_version >= 1", name="ck_tool_operation_row_version"),
        CheckConstraint(
            "status IN ("
            "'proposed','waiting_authorization','authorized','dispatching',"
            "'succeeded','failed','denied','outcome_unknown','reconciling',"
            "'failed_not_applied','manual'"
            ")",
            name="ck_tool_operation_status",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="CASCADE"),
        nullable=False,
    )
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
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("execution_workspaces.id", ondelete="RESTRICT"),
        nullable=False,
    )
    authorization_consumption_id: Mapped[str | None] = mapped_column(
        ForeignKey("authorization_consumptions.id", ondelete="RESTRICT"),
        nullable=True,
    )
    provider_tool_call_id: Mapped[str] = mapped_column(String(160), nullable=False)
    tool_name: Mapped[str] = mapped_column(String(80), nullable=False)
    tool_definition_revision: Mapped[str] = mapped_column(String(80), nullable=False)
    operation_ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    operation_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    side_effect_class: Mapped[str] = mapped_column(String(40), nullable=False)
    arguments_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    arguments_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    operation_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(96), nullable=False)
    target_path: Mapped[str] = mapped_column(Text, nullable=False)
    expected_preimage_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expected_postimage_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    diff_preview: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    dispatch_epoch: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    observed_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    result_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    result_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    failure_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    resolution_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    authorized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dispatch_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ToolOperationAttemptRecord(Base):
    """One actual claim/dispatch attempt for a Tool Operation."""

    __tablename__ = "tool_operation_attempts"
    __table_args__ = (
        UniqueConstraint("operation_id", "attempt_number", name="uq_tool_operation_attempt"),
        Index("ix_tool_operation_attempt_status", "status", "started_at"),
        CheckConstraint("attempt_number >= 1", name="ck_tool_operation_attempt_number"),
        CheckConstraint("dispatch_epoch >= 1", name="ck_tool_operation_attempt_epoch"),
        CheckConstraint(
            "status IN ('claimed','dispatching','succeeded','failed','outcome_unknown')",
            name="ck_tool_operation_attempt_status",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    operation_id: Mapped[str] = mapped_column(
        ForeignKey("tool_operations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    worker_id: Mapped[str] = mapped_column(String(160), nullable=False)
    lease_epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    dispatch_epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    result_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    failure_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    dispatch_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ToolOperationReconciliationRecord(Base):
    """One immutable observation used to settle an uncertain operation."""

    __tablename__ = "tool_operation_reconciliations"
    __table_args__ = (
        UniqueConstraint(
            "operation_id",
            "sequence",
            name="uq_tool_operation_reconciliation_sequence",
        ),
        CheckConstraint("sequence >= 1", name="ck_tool_reconciliation_sequence"),
        CheckConstraint(
            "status IN ('running','resolved','manual')",
            name="ck_tool_reconciliation_status",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    operation_id: Mapped[str] = mapped_column(
        ForeignKey("tool_operations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    trigger: Mapped[str] = mapped_column(String(40), nullable=False)
    strategy: Mapped[str] = mapped_column(String(60), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    expected_preimage_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expected_postimage_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    observed_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    resolution_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    safe_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
