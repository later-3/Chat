"""Add visible Session title provenance and durable model transport audit.

Revision ID: e6a11c9f3b72
Revises: d84f39e71b20
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e6a11c9f3b72"
down_revision: Union[str, Sequence[str], None] = "d84f39e71b20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # SQLite DDL is non-transactional. Conditional additions let startup
    # recover if a prior process stopped after one ALTER TABLE but before
    # Alembic could advance the revision marker.
    inspector = sa.inspect(op.get_bind())
    session_columns = {value["name"] for value in inspector.get_columns("product_sessions")}
    missing_session_columns = {"title_origin", "title_source_message_id"} - session_columns
    if missing_session_columns:
        with op.batch_alter_table("product_sessions") as batch:
            if "title_origin" in missing_session_columns:
                batch.add_column(
                    sa.Column(
                        "title_origin",
                        sa.String(length=20),
                        nullable=False,
                        server_default="default",
                    )
                )
            if "title_source_message_id" in missing_session_columns:
                batch.add_column(sa.Column("title_source_message_id", sa.String(length=36), nullable=True))

    # Preserve manual titles while recognizing the legacy automatic-title
    # pattern. This lets withdrawal reconciliation repair existing sessions
    # without blindly rewriting user-authored names.
    op.execute(
        """
        UPDATE product_sessions
        SET title_origin = CASE WHEN title = '新会话' THEN 'default' ELSE 'manual' END
        """
    )
    op.execute(
        """
        UPDATE product_sessions
        SET title_origin = 'auto',
            title_source_message_id = (
                SELECT product_messages.id
                FROM product_messages
                WHERE product_messages.session_id = product_sessions.id
                  AND product_messages.role = 'user'
                  AND substr(
                    replace(json_extract(product_messages.content, '$'), char(10), ' '),
                    1,
                    40
                  ) = product_sessions.title
                ORDER BY product_messages.ordinal
                LIMIT 1
            )
        WHERE EXISTS (
            SELECT 1
            FROM product_messages
            WHERE product_messages.session_id = product_sessions.id
              AND product_messages.role = 'user'
              AND substr(
                replace(json_extract(product_messages.content, '$'), char(10), ' '),
                1,
                40
              ) = product_sessions.title
        )
        """
    )
    # A previously withdrawn first prompt could still be shown as the Session
    # title because older code did not track title provenance. Reconcile that
    # legacy state during the migration instead of waiting for another Run.
    op.execute(
        """
        UPDATE product_sessions
        SET title = COALESCE(
                (
                    SELECT substr(
                        replace(json_extract(replacement.content, '$'), char(10), ' '),
                        1,
                        40
                    )
                    FROM product_messages AS replacement
                    WHERE replacement.session_id = product_sessions.id
                      AND replacement.role = 'user'
                      AND replacement.status = 'committed'
                      AND replacement.context_eligible = 1
                    ORDER BY replacement.ordinal
                    LIMIT 1
                ),
                '新会话'
            ),
            title_origin = CASE
                WHEN EXISTS (
                    SELECT 1
                    FROM product_messages AS replacement
                    WHERE replacement.session_id = product_sessions.id
                      AND replacement.role = 'user'
                      AND replacement.status = 'committed'
                      AND replacement.context_eligible = 1
                ) THEN 'auto'
                ELSE 'default'
            END,
            title_source_message_id = (
                SELECT replacement.id
                FROM product_messages AS replacement
                WHERE replacement.session_id = product_sessions.id
                  AND replacement.role = 'user'
                  AND replacement.status = 'committed'
                  AND replacement.context_eligible = 1
                ORDER BY replacement.ordinal
                LIMIT 1
            )
        WHERE title_origin = 'auto'
          AND EXISTS (
              SELECT 1
              FROM product_messages AS source
              WHERE source.id = product_sessions.title_source_message_id
                AND (
                    source.status != 'committed'
                    OR source.context_eligible != 1
                )
          )
        """
    )

    inspector = sa.inspect(op.get_bind())
    attempt_columns = {value["name"] for value in inspector.get_columns("model_call_attempts")}
    attempt_additions = {
        "provider_request_id": sa.Column("provider_request_id", sa.String(length=180), nullable=True),
        "response_metadata_json": sa.Column(
            "response_metadata_json",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        "output_text": sa.Column("output_text", sa.Text(), nullable=True),
        "output_text_sha256": sa.Column("output_text_sha256", sa.String(length=64), nullable=True),
        "output_disposition": sa.Column("output_disposition", sa.String(length=64), nullable=True),
        "output_disposition_reason": sa.Column(
            "output_disposition_reason", sa.String(length=240), nullable=True
        ),
        "transport_event_sequence": sa.Column(
            "transport_event_sequence", sa.Integer(), nullable=False, server_default="0"
        ),
    }
    missing_attempt_columns = set(attempt_additions) - attempt_columns
    if missing_attempt_columns:
        with op.batch_alter_table("model_call_attempts") as batch:
            for name, column in attempt_additions.items():
                if name in missing_attempt_columns:
                    batch.add_column(column)

    inspector = sa.inspect(op.get_bind())
    if "model_call_transport_events" not in inspector.get_table_names():
        op.create_table(
            "model_call_transport_events",
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column("model_call_attempt_id", sa.String(length=36), nullable=False),
            sa.Column("sequence", sa.Integer(), nullable=False),
            sa.Column("stage", sa.String(length=80), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("details_json", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(
                ["model_call_attempt_id"],
                ["model_call_attempts.id"],
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("model_call_attempt_id", "sequence"),
        )
    inspector = sa.inspect(op.get_bind())
    indexes = {value["name"] for value in inspector.get_indexes("model_call_transport_events")}
    if "ix_model_transport_event_attempt" not in indexes:
        op.create_index(
            "ix_model_transport_event_attempt",
            "model_call_transport_events",
            ["model_call_attempt_id", "sequence"],
            unique=False,
        )


def downgrade() -> None:
    op.drop_index("ix_model_transport_event_attempt", table_name="model_call_transport_events")
    op.drop_table("model_call_transport_events")
    with op.batch_alter_table("model_call_attempts") as batch:
        batch.drop_column("transport_event_sequence")
        batch.drop_column("output_disposition_reason")
        batch.drop_column("output_disposition")
        batch.drop_column("output_text_sha256")
        batch.drop_column("output_text")
        batch.drop_column("response_metadata_json")
        batch.drop_column("provider_request_id")
    with op.batch_alter_table("product_sessions") as batch:
        batch.drop_column("title_source_message_id")
        batch.drop_column("title_origin")
