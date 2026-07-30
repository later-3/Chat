"""后端进程生命周期，以及内嵌 Worker 的启停所有权。

FastAPI 在开始服务前进入 lifespan，在进程退出时离开 lifespan。这样数据库
初始化、启动对账和后台循环不会散落在 Router 中，也不会随每次请求重复执行。
"""

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
    """为“内嵌 Worker”或“外置 Worker”部署方式创建同一套生命周期。

    ``yield`` 之前是启动阶段，``yield`` 期间 Uvicorn 可以分发请求，
    ``finally`` 是关停阶段。内存数据库不启动后台轮询，因为它不能被另一个
    进程可靠共享。
    """

    durable_store = ":memory:" not in components.settings.database_url
    outbox_loop_enabled = start_outbox_worker and durable_store
    execution_loop_enabled = start_execution_worker and durable_store

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        # 1. 建立Schema/种子数据，并在对外服务前修复可安全自动修复的中断状态。
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
        # 2. 本地单进程模式可内嵌轮询；生产可用 create_api_app 把它们拆出去。
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
            # 3. 控制权交回 FastAPI/Uvicorn；从此刻起请求才进入各个 Router。
            yield
        finally:
            # 4. 先停止后台任务和外部 Runtime，再关闭共享数据库连接。
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
