"""backfill first run attempt

Revision ID: c38437c3c341
Revises: 71bc91f4c96a
Create Date: 2026-07-21
"""

import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c38437c3c341"
down_revision: Union[str, Sequence[str], None] = "71bc91f4c96a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    connection = op.get_bind()
    runs = connection.execute(
        sa.text(
            """
            SELECT id, status, failure_code, failure_message, started_at, finished_at
            FROM product_runs
            WHERE NOT EXISTS (
                SELECT 1 FROM run_attempts WHERE run_attempts.run_id = product_runs.id
            )
            """
        )
    ).mappings()
    for run in runs:
        connection.execute(
            sa.text(
                """
                INSERT INTO run_attempts (
                    id, run_id, attempt_number, runtime_kind, status,
                    failure_code, failure_message, started_at, finished_at
                ) VALUES (
                    :id, :run_id, 1, 'in_process', :status,
                    :failure_code, :failure_message, :started_at, :finished_at
                )
                """
            ),
            {
                "id": str(uuid.uuid4()),
                "run_id": run["id"],
                "status": run["status"],
                "failure_code": run["failure_code"],
                "failure_message": run["failure_message"],
                "started_at": run["started_at"],
                "finished_at": run["finished_at"],
            },
        )


def downgrade() -> None:
    # The table is owned by the preceding migration. Removing inferred rows
    # would also delete legitimate first attempts created after deployment.
    pass
