"""Add versioned collaboration protocols, rules and scope bindings.

Revision ID: f4a2b9c7d811
Revises: e6a11c9f3b72
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f4a2b9c7d811"
down_revision: Union[str, Sequence[str], None] = "e6a11c9f3b72"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "collaboration_protocol_definitions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("protocol_key", sa.String(length=80), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("scenario_kinds_json", sa.JSON(), nullable=False),
        sa.Column("phases_json", sa.JSON(), nullable=False),
        sa.Column("context_policy_json", sa.JSON(), nullable=False),
        sa.Column("hitl_policy_json", sa.JSON(), nullable=False),
        sa.Column("execution_policy_json", sa.JSON(), nullable=False),
        sa.Column("validation_policy_json", sa.JSON(), nullable=False),
        sa.Column("writeback_policy_json", sa.JSON(), nullable=False),
        sa.Column("ui_schema_json", sa.JSON(), nullable=False),
        sa.Column("definition_hash", sa.String(length=64), nullable=False),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("protocol_key", "revision"),
    )
    op.create_index(
        "ix_protocol_definitions_status_key",
        "collaboration_protocol_definitions",
        ["status", "protocol_key"],
        unique=False,
    )
    op.create_table(
        "collaboration_protocol_rules",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("definition_id", sa.String(length=36), nullable=False),
        sa.Column("rule_key", sa.String(length=100), nullable=False),
        sa.Column("name", sa.String(length=180), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("category", sa.String(length=40), nullable=False),
        sa.Column("enforcement", sa.String(length=24), nullable=False),
        sa.Column("severity", sa.String(length=24), nullable=False),
        sa.Column("overridable", sa.Boolean(), nullable=False),
        sa.Column("condition_json", sa.JSON(), nullable=False),
        sa.Column("validator_json", sa.JSON(), nullable=False),
        sa.Column("failure_action", sa.String(length=24), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["definition_id"],
            ["collaboration_protocol_definitions.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("definition_id", "rule_key"),
    )
    op.create_index(
        "ix_protocol_rules_definition_ordinal",
        "collaboration_protocol_rules",
        ["definition_id", "ordinal"],
        unique=False,
    )
    op.create_table(
        "collaboration_protocol_bindings",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("scope_id", sa.String(length=100), nullable=False),
        sa.Column("scope_kind", sa.String(length=24), nullable=False),
        sa.Column("scope_ref_id", sa.String(length=100), nullable=False),
        sa.Column("scenario_kind", sa.String(length=40), nullable=False),
        sa.Column("protocol_definition_id", sa.String(length=36), nullable=False),
        sa.Column("parameter_overrides_json", sa.JSON(), nullable=False),
        sa.Column("disabled_rule_keys_json", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("row_version", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["protocol_definition_id"],
            ["collaboration_protocol_definitions.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "scope_id",
            "scope_kind",
            "scope_ref_id",
            "scenario_kind",
            name="uq_protocol_binding_scope_scenario",
        ),
    )
    op.create_index(
        "ix_protocol_bindings_resolution",
        "collaboration_protocol_bindings",
        ["scope_id", "scenario_kind", "status", "scope_kind"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_protocol_bindings_resolution",
        table_name="collaboration_protocol_bindings",
    )
    op.drop_table("collaboration_protocol_bindings")
    op.drop_index(
        "ix_protocol_rules_definition_ordinal",
        table_name="collaboration_protocol_rules",
    )
    op.drop_table("collaboration_protocol_rules")
    op.drop_index(
        "ix_protocol_definitions_status_key",
        table_name="collaboration_protocol_definitions",
    )
    op.drop_table("collaboration_protocol_definitions")
