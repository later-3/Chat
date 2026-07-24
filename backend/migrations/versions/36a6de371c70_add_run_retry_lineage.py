"""add run retry lineage

Revision ID: 36a6de371c70
Revises: 91e8a33a4b29
Create Date: 2026-07-21
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "36a6de371c70"
down_revision: Union[str, Sequence[str], None] = "91e8a33a4b29"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("product_runs") as batch_op:
        batch_op.add_column(sa.Column("retry_of_run_id", sa.String(length=36), nullable=True))
        batch_op.add_column(sa.Column("retry_mode", sa.String(length=32), nullable=True))
        batch_op.create_foreign_key(
            "fk_product_runs_retry_of_run_id",
            "product_runs",
            ["retry_of_run_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index("ix_product_runs_retry_of_run_id", ["retry_of_run_id"])


def downgrade() -> None:
    with op.batch_alter_table("product_runs") as batch_op:
        batch_op.drop_index("ix_product_runs_retry_of_run_id")
        batch_op.drop_constraint("fk_product_runs_retry_of_run_id", type_="foreignkey")
        batch_op.drop_column("retry_mode")
        batch_op.drop_column("retry_of_run_id")
