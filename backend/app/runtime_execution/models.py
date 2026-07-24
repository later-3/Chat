"""Durable execution ownership and public AG-UI event journal models."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..product_sessions.database import Base, utc_now


class RuntimeJobRecord(Base):
    """Short-lived execution projection for exactly one Run Attempt."""

    __tablename__ = "runtime_jobs"
    __table_args__ = (
        UniqueConstraint("run_attempt_id"),
        Index("ix_runtime_jobs_claim", "status", "available_at", "lease_expires_at"),
        Index("ix_runtime_jobs_product_run", "product_run_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    product_run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="CASCADE"), nullable=False
    )
    run_attempt_id: Mapped[str] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="CASCADE"), nullable=False
    )
    endpoint_key: Mapped[str] = mapped_column(String(180), nullable=False)
    workflow_definition_id: Mapped[str] = mapped_column(String(100), nullable=False)
    workflow_version: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    recoverability: Mapped[str] = mapped_column(String(32), nullable=False)
    checkpoint_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    input_payload_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    lease_owner: Mapped[str | None] = mapped_column(String(160), nullable=True)
    lease_epoch: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_event_sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    earliest_retained_sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    external_dispatch_state: Mapped[str] = mapped_column(String(32), nullable=False, default="not_started")
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    failure_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    failure_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RuntimeEventRecord(Base):
    """One sanitized event that is durable before any subscriber sees it."""

    __tablename__ = "runtime_event_records"
    __table_args__ = (
        UniqueConstraint("runtime_job_id", "sequence"),
        Index("ix_runtime_events_attempt_sequence", "run_attempt_id", "sequence"),
        Index(
            "uq_runtime_events_terminal",
            "runtime_job_id",
            unique=True,
            sqlite_where=text("is_terminal = 1"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    runtime_job_id: Mapped[str] = mapped_column(
        ForeignKey("runtime_jobs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    run_attempt_id: Mapped[str] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="CASCADE"), nullable=False
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    agui_event_type: Mapped[str] = mapped_column(String(80), nullable=False)
    public_payload_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    is_terminal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class RuntimeControlCommandRecord(Base):
    """Durable control inbox; disconnecting a subscriber never creates one."""

    __tablename__ = "runtime_control_commands"
    __table_args__ = (
        UniqueConstraint("scope_id", "request_key"),
        Index("ix_runtime_commands_job_status", "runtime_job_id", "status", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    runtime_job_id: Mapped[str] = mapped_column(
        ForeignKey("runtime_jobs.id", ondelete="CASCADE"), nullable=False
    )
    run_attempt_id: Mapped[str] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="CASCADE"), nullable=False
    )
    command_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    request_key: Mapped[str] = mapped_column(String(160), nullable=False)
    expected_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    checkpoint_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    payload_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    requested_by: Mapped[str] = mapped_column(String(100), nullable=False)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    claimed_by: Mapped[str | None] = mapped_column(String(160), nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    result_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ExecutionWorkerRecord(Base):
    """Observable worker heartbeat; leases remain the ownership authority."""

    __tablename__ = "execution_workers"

    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    boot_id: Mapped[str] = mapped_column(String(36), nullable=False)
    host: Mapped[str] = mapped_column(String(200), nullable=False)
    pid: Mapped[int] = mapped_column(Integer, nullable=False)
    version: Mapped[str] = mapped_column(String(40), nullable=False)
    capabilities_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    heartbeat_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
