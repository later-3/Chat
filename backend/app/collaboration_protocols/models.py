"""Persistent collaboration protocol definitions, rules and scope bindings."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..product_sessions.database import Base, utc_now


class CollaborationProtocolDefinitionRecord(Base):
    """One immutable, hash-addressed revision of a collaboration method."""

    __tablename__ = "collaboration_protocol_definitions"
    __table_args__ = (
        UniqueConstraint("protocol_key", "revision"),
        Index("ix_protocol_definitions_status_key", "status", "protocol_key"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    protocol_key: Mapped[str] = mapped_column(String(80), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="active")
    scenario_kinds_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    phases_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    context_policy_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    hitl_policy_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    execution_policy_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    validation_policy_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    writeback_policy_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    ui_schema_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    definition_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class CollaborationProtocolRuleRecord(Base):
    """A user-visible rule with an explicit enforcement and failure contract."""

    __tablename__ = "collaboration_protocol_rules"
    __table_args__ = (
        UniqueConstraint("definition_id", "rule_key"),
        Index("ix_protocol_rules_definition_ordinal", "definition_id", "ordinal"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    definition_id: Mapped[str] = mapped_column(
        ForeignKey("collaboration_protocol_definitions.id", ondelete="CASCADE"),
        nullable=False,
    )
    rule_key: Mapped[str] = mapped_column(String(100), nullable=False)
    name: Mapped[str] = mapped_column(String(180), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(40), nullable=False)
    enforcement: Mapped[str] = mapped_column(String(24), nullable=False)
    severity: Mapped[str] = mapped_column(String(24), nullable=False)
    overridable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    condition_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    validator_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    failure_action: Mapped[str] = mapped_column(String(24), nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)


class CollaborationProtocolBindingRecord(Base):
    """Select one protocol revision for a scope and scenario using CAS."""

    __tablename__ = "collaboration_protocol_bindings"
    __table_args__ = (
        UniqueConstraint(
            "scope_id",
            "scope_kind",
            "scope_ref_id",
            "scenario_kind",
            name="uq_protocol_binding_scope_scenario",
        ),
        Index(
            "ix_protocol_bindings_resolution",
            "scope_id",
            "scenario_kind",
            "status",
            "scope_kind",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False)
    scope_kind: Mapped[str] = mapped_column(String(24), nullable=False)
    scope_ref_id: Mapped[str] = mapped_column(String(100), nullable=False)
    scenario_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    protocol_definition_id: Mapped[str] = mapped_column(
        ForeignKey("collaboration_protocol_definitions.id", ondelete="RESTRICT"),
        nullable=False,
    )
    parameter_overrides_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    disabled_rule_keys_json: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="active")
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
