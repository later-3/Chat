"""Add Context revision lineage and persisted step input projections.

Revision ID: c8d14a7e2f90
Revises: f4a2b9c7d811
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c8d14a7e2f90"
down_revision: Union[str, Sequence[str], None] = "f4a2b9c7d811"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("context_packages") as batch:
        batch.add_column(sa.Column("previous_package_id", sa.String(length=36), nullable=True))
        batch.add_column(
            sa.Column(
                "revision_reason",
                sa.Text(),
                nullable=False,
                server_default="Workflow确定性装配",
            )
        )
        batch.add_column(
            sa.Column(
                "created_by",
                sa.String(length=100),
                nullable=False,
                server_default="workflow",
            )
        )
        batch.create_foreign_key(
            "fk_context_packages_previous_package_id",
            "context_packages",
            ["previous_package_id"],
            ["id"],
            ondelete="RESTRICT",
        )

    with op.batch_alter_table("context_adoption_records") as batch:
        batch.add_column(
            sa.Column(
                "locked",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )
        batch.add_column(
            sa.Column(
                "selection_origin",
                sa.String(length=32),
                nullable=False,
                server_default="system",
            )
        )

    op.create_table(
        "step_input_projections",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("workflow_definition_id", sa.String(length=100), nullable=False),
        sa.Column("workflow_version", sa.String(length=40), nullable=False),
        sa.Column("node_id", sa.String(length=120), nullable=False),
        sa.Column("projection_revision", sa.Integer(), nullable=False),
        sa.Column("agent_profile_key", sa.String(length=100), nullable=True),
        sa.Column("context_package_id", sa.String(length=36), nullable=True),
        sa.Column("protocol_definition_id", sa.String(length=36), nullable=True),
        sa.Column("protocol_binding_id", sa.String(length=36), nullable=True),
        sa.Column("run_spec_id", sa.String(length=36), nullable=True),
        sa.Column("input_json", sa.JSON(), nullable=False),
        sa.Column("capability_allowlist_json", sa.JSON(), nullable=False),
        sa.Column("budget_json", sa.JSON(), nullable=False),
        sa.Column("output_contract_json", sa.JSON(), nullable=False),
        sa.Column("stop_conditions_json", sa.JSON(), nullable=False),
        sa.Column("projection_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["product_runs.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["context_package_id"],
            ["context_packages.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["protocol_definition_id"],
            ["collaboration_protocol_definitions.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["protocol_binding_id"],
            ["collaboration_protocol_bindings.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["run_spec_id"],
            ["run_specs.id"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "run_id",
            "node_id",
            "projection_revision",
            name="uq_step_input_projection_run_node_revision",
        ),
    )
    op.create_index(
        "ix_step_input_projection_run_created",
        "step_input_projections",
        ["run_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_step_input_projection_hash",
        "step_input_projections",
        ["projection_hash"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_step_input_projection_hash",
        table_name="step_input_projections",
    )
    op.drop_index(
        "ix_step_input_projection_run_created",
        table_name="step_input_projections",
    )
    op.drop_table("step_input_projections")
    with op.batch_alter_table("context_adoption_records") as batch:
        batch.drop_column("selection_origin")
        batch.drop_column("locked")
    with op.batch_alter_table("context_packages") as batch:
        batch.drop_constraint(
            "fk_context_packages_previous_package_id",
            type_="foreignkey",
        )
        batch.drop_column("created_by")
        batch.drop_column("revision_reason")
        batch.drop_column("previous_package_id")
