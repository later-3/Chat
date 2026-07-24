"""add atomic trace sequence

Revision ID: b64b0ea569a7
Revises: 5e8d126ed503
Create Date: 2026-07-21
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b64b0ea569a7"
down_revision: Union[str, Sequence[str], None] = "5e8d126ed503"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "product_runs",
        sa.Column("trace_sequence", sa.Integer(), nullable=False, server_default="0"),
    )
    connection = op.get_bind()
    connection.execute(
        sa.text(
            """
            UPDATE product_runs
            SET trace_sequence = COALESCE(
                (
                    SELECT MAX(trace_events.sequence)
                    FROM trace_events
                    WHERE trace_events.run_id = product_runs.id
                ),
                0
            )
            """
        )
    )


def downgrade() -> None:
    op.drop_column("product_runs", "trace_sequence")
