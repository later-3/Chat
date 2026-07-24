"""Persistence model for public, hash-bound runtime step inputs."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..product_sessions.database import Base, utc_now


class StepInputProjectionRecord(Base):
    """One immutable public input contract for a concrete Workflow node."""

    __tablename__ = "step_input_projections"
    __table_args__ = (
        UniqueConstraint(
            "run_id",
            "node_id",
            "projection_revision",
            name="uq_step_input_projection_run_node_revision",
        ),
        Index("ix_step_input_projection_run_created", "run_id", "created_at"),
        Index("ix_step_input_projection_hash", "projection_hash"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="RESTRICT"),
        nullable=False,
    )
    workflow_definition_id: Mapped[str] = mapped_column(String(100), nullable=False)
    workflow_version: Mapped[str] = mapped_column(String(40), nullable=False)
    node_id: Mapped[str] = mapped_column(String(120), nullable=False)
    projection_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    agent_profile_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    context_package_id: Mapped[str | None] = mapped_column(
        ForeignKey("context_packages.id", ondelete="RESTRICT"),
        nullable=True,
    )
    protocol_definition_id: Mapped[str | None] = mapped_column(
        ForeignKey("collaboration_protocol_definitions.id", ondelete="RESTRICT"),
        nullable=True,
    )
    protocol_binding_id: Mapped[str | None] = mapped_column(
        ForeignKey("collaboration_protocol_bindings.id", ondelete="RESTRICT"),
        nullable=True,
    )
    run_spec_id: Mapped[str | None] = mapped_column(
        ForeignKey("run_specs.id", ondelete="RESTRICT"),
        nullable=True,
    )
    input_json: Mapped[Any] = mapped_column(JSON, nullable=False)
    capability_allowlist_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    budget_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    output_contract_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    stop_conditions_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    projection_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
