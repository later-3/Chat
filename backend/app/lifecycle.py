"""Application process lifecycle and embedded worker ownership."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .composition import ApplicationComponents

logger = logging.getLogger(__name__)


def create_lifespan(
    components: ApplicationComponents,
    *,
    start_outbox_worker: bool,
    start_execution_worker: bool,
):
    """Build the lifespan for either an embedded or external-worker profile."""

    durable_store = ":memory:" not in components.settings.database_url
    outbox_loop_enabled = start_outbox_worker and durable_store
    execution_loop_enabled = start_execution_worker and durable_store

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await components.product_sessions.initialize()
        await components.governance.initialize()
        await components.harness.initialize()
        await components.project_resources.initialize()
        await components.collaboration_protocols.initialize()
        await components.agent_profiles.initialize()
        await components.tool_configurations.initialize()
        validation_capabilities_seeded = await components.validation_capabilities.seed(
            components.product_sessions.database
        )
        artifact_reconcile = (
            await components.artifact_reconciler.reconcile()
            if components.artifact_reconciler is not None
            else None
        )
        await components.runtime_execution.reconcile_expired_leases()
        await components.product_sessions.reconcile_terminal_runtime_jobs()
        terminal_decisions_closed = await components.governance.reconcile_terminal_run_decisions()
        workspace_reconciled = await components.execution_workspaces.reconcile_preparing()
        operation_reconciled = await components.tool_operations.reconcile_orphans()
        orphan_workspaces_retained = await components.execution_workspaces.reconcile_orphans()
        if (
            terminal_decisions_closed
            or workspace_reconciled
            or operation_reconciled
            or orphan_workspaces_retained
            or validation_capabilities_seeded
            or artifact_reconcile is not None
        ):
            logger.info(
                "execution_side_effect_startup_reconciled terminal_decisions=%d "
                "workspaces=%d operations=%d orphan_workspaces=%d "
                "validation_capabilities=%d artifact_staging_removed=%d "
                "artifact_physical_orphans_removed=%d artifact_rows_deleted=%d",
                terminal_decisions_closed,
                workspace_reconciled,
                operation_reconciled,
                orphan_workspaces_retained,
                validation_capabilities_seeded,
                artifact_reconcile.staged_removed if artifact_reconcile is not None else 0,
                artifact_reconcile.physical_orphans_removed if artifact_reconcile is not None else 0,
                artifact_reconcile.rows_deleted if artifact_reconcile is not None else 0,
            )

        outbox_task: asyncio.Task[None] | None = None
        execution_task: asyncio.Task[None] | None = None
        outbox_worker = components.governance_outbox_worker
        if outbox_loop_enabled and outbox_worker is not None:

            async def outbox_loop() -> None:
                while True:
                    try:
                        processed = await outbox_worker.run_once()
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        logger.exception("governance_outbox_loop_failed")
                        processed = False
                    if not processed:
                        await asyncio.sleep(0.2)

            outbox_task = asyncio.create_task(
                outbox_loop(),
                name="governance-outbox-worker",
            )

        if execution_loop_enabled:
            await components.execution_worker.register()

            async def execution_loop() -> None:
                while True:
                    try:
                        processed = await components.execution_worker.run_once()
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        logger.exception("execution_worker_loop_failed")
                        processed = False
                    if not processed:
                        await asyncio.sleep(0.08)

            execution_task = asyncio.create_task(
                execution_loop(),
                name="runtime-execution-worker",
            )

        try:
            yield
        finally:
            if execution_task is not None:
                execution_task.cancel()
                try:
                    await execution_task
                except asyncio.CancelledError:
                    pass
                await components.execution_worker.stop()
            if outbox_task is not None:
                outbox_task.cancel()
                try:
                    await outbox_task
                except asyncio.CancelledError:
                    pass
            if components.pi_runtime is not None:
                await components.pi_runtime.close_all()
            await components.product_sessions.database.close()

    return lifespan
