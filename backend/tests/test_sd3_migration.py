"""SD3 data-migration compatibility for the installed pi configuration."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from alembic import command
from alembic.config import Config


def test_sd3_migration_enables_edit_only_for_the_untouched_sd2_default(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "sd3-migration.db"
    configuration = Config("alembic.ini")
    configuration.set_main_option(
        "sqlalchemy.url",
        f"sqlite+aiosqlite:///{database_path}",
    )
    command.upgrade(configuration, "e71b3c5d9a02")
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            INSERT INTO tool_configurations (
                id, enabled, provider_id, model, working_directory,
                allowed_tools, thinking_level, max_model_calls,
                timeout_seconds, system_prompt, revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (
                "pi_agent",
                1,
                "provider",
                "model",
                "/safe/root",
                json.dumps(["read", "grep", "find", "ls"]),
                "medium",
                6,
                600,
                "governed",
                1,
            ),
        )

    command.upgrade(configuration, "head")
    with sqlite3.connect(database_path) as connection:
        tools, revision = connection.execute(
            "SELECT allowed_tools, revision FROM tool_configurations WHERE id = 'pi_agent'"
        ).fetchone()
    assert json.loads(tools) == ["read", "grep", "find", "ls", "edit"]
    assert revision == 2

    command.downgrade(configuration, "e71b3c5d9a02")
    with sqlite3.connect(database_path) as connection:
        tools, revision = connection.execute(
            "SELECT allowed_tools, revision FROM tool_configurations WHERE id = 'pi_agent'"
        ).fetchone()
    assert json.loads(tools) == ["read", "grep", "find", "ls"]
    assert revision == 3


def test_sd3_migration_preserves_a_user_customized_tool_selection(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "sd3-custom-migration.db"
    configuration = Config("alembic.ini")
    configuration.set_main_option(
        "sqlalchemy.url",
        f"sqlite+aiosqlite:///{database_path}",
    )
    command.upgrade(configuration, "e71b3c5d9a02")
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            INSERT INTO tool_configurations (
                id, enabled, provider_id, model, working_directory,
                allowed_tools, thinking_level, max_model_calls,
                timeout_seconds, system_prompt, revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (
                "pi_agent",
                1,
                "provider",
                "model",
                "/safe/root",
                json.dumps(["read", "grep"]),
                "medium",
                6,
                600,
                "user-customized",
                7,
            ),
        )

    command.upgrade(configuration, "head")
    with sqlite3.connect(database_path) as connection:
        tools, revision = connection.execute(
            "SELECT allowed_tools, revision FROM tool_configurations WHERE id = 'pi_agent'"
        ).fetchone()
    assert json.loads(tools) == ["read", "grep"]
    assert revision == 7
