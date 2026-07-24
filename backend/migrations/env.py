"""Alembic environment for the Product Store."""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from backend.app.collaboration_intents import models as collaboration_intent_models  # noqa: F401
from backend.app.collaboration_protocols import models as collaboration_protocol_models  # noqa: F401
from backend.app.execution_workspaces import models as execution_workspace_models  # noqa: F401
from backend.app.governance import models as governance_models  # noqa: F401
from backend.app.harness import models as harness_models  # noqa: F401
from backend.app.product_sessions.database import Base
from backend.app.project_resources import models as project_resource_models  # noqa: F401
from backend.app.runtime_execution import (
    models as runtime_execution_models,  # noqa: F401
)
from backend.app.step_inputs import models as step_input_models  # noqa: F401
from backend.app.tool_execution import models as tool_execution_models  # noqa: F401

config = context.config
extra_arguments = context.get_x_argument(as_dictionary=True)
if database_url := extra_arguments.get("database_url"):
    # Verification passes an isolated temporary database explicitly. Runtime
    # startup still uses the URL from the application-owned configuration.
    config.set_main_option("sqlalchemy.url", database_url)
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name)
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    configuration = config.get_section(config.config_ini_section, {})
    engine = async_engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with engine.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_async_migrations())
