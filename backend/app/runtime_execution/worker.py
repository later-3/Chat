"""Generic leased Execution Worker for registered MAF AG-UI runners."""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import socket
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import suppress
from typing import Any, Protocol

from sqlalchemy import select

from ..observability.context import bind_context
from ..observability.metrics import metrics
from ..observability.tracing import tracer
from ..product_sessions.database import ProductDatabase, RunRecord, utc_now
from ..product_sessions.service import ProductSessionService
from .models import ExecutionWorkerRecord
from .service import ClaimedRuntime, RuntimeExecutionService, RuntimeLeaseLost

logger = logging.getLogger(__name__)


class RuntimeRunner(Protocol):
    def run(self, input_data: dict[str, Any]) -> AsyncIterator[Any]: ...


class RuntimeRunnerRegistry:
    """Composition-root registry; durable Jobs store only versioned keys."""

    def __init__(self) -> None:
        self._runners: dict[str, RuntimeRunner] = {}

    def register(self, endpoint_key: str, runner: RuntimeRunner) -> None:
        existing = self._runners.get(endpoint_key)
        if existing is not None and existing is not runner:
            raise ValueError(f"Runtime endpoint重复注册: {endpoint_key}")
        self._runners[endpoint_key] = runner

    def require(self, endpoint_key: str) -> RuntimeRunner:
        try:
            return self._runners[endpoint_key]
        except KeyError as error:
            raise RuntimeError(f"Execution Worker不支持Runtime endpoint: {endpoint_key}") from error

    @property
    def capabilities(self) -> tuple[str, ...]:
        return tuple(sorted(self._runners))


class ExecutionWorker:
    """Claim one Job at a time and fence every durable write by Lease Epoch."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        runtime: RuntimeExecutionService,
        registry: RuntimeRunnerRegistry,
        worker_id: str,
        lease_seconds: int = 30,
        sessions: ProductSessionService | None = None,
    ) -> None:
        if lease_seconds < 3:
            raise ValueError("Execution Worker lease_seconds必须至少为3")
        self.database = database
        self.runtime = runtime
        self.registry = registry
        self.worker_id = worker_id
        self.lease_seconds = lease_seconds
        self.sessions = sessions or ProductSessionService(database)
        self.boot_id = str(uuid.uuid4())
        self._next_maintenance_at = 0.0

    async def register(self) -> None:
        async with self.database.sessions.begin() as transaction:
            record = await transaction.get(ExecutionWorkerRecord, self.worker_id)
            values = {
                "boot_id": self.boot_id,
                "host": socket.gethostname(),
                "pid": os.getpid(),
                "version": "1.0.0",
                "capabilities_json": {
                    "endpoints": list(self.registry.capabilities),
                    "python": platform.python_version(),
                },
                "status": "ready",
                "started_at": utc_now(),
                "heartbeat_at": utc_now(),
                "stopped_at": None,
            }
            if record is None:
                transaction.add(ExecutionWorkerRecord(id=self.worker_id, **values))
            else:
                for key, value in values.items():
                    setattr(record, key, value)

    async def stop(self) -> None:
        async with self.database.sessions.begin() as transaction:
            record = await transaction.get(ExecutionWorkerRecord, self.worker_id)
            if record is not None and record.boot_id == self.boot_id:
                record.status = "stopped"
                record.heartbeat_at = utc_now()
                record.stopped_at = utc_now()

    async def run_once(self) -> bool:
        await self._maintain_runtime()
        claim = await self.runtime.claim_one(
            worker_id=self.worker_id,
            lease_seconds=self.lease_seconds,
        )
        if claim is None:
            return False
        await self._execute(claim)
        return True

    async def drain(self, *, limit: int = 100) -> int:
        processed = 0
        while processed < limit and await self.run_once():
            processed += 1
        return processed

    async def _execute(self, claim: ClaimedRuntime) -> None:
        started = time.perf_counter()
        metrics.increment("runtime.jobs.claimed")
        with bind_context(
            worker_id=self.worker_id,
            job_id=claim.job_id,
            session_id=str(claim.input_data.get("thread_id") or claim.input_data.get("threadId") or "")
            or None,
            product_run_id=claim.product_run_id,
            attempt_id=claim.run_attempt_id,
            workflow_id=claim.workflow_definition_id,
        ):
            with tracer().start_as_current_span(
                "runtime.job",
                attributes={
                    "runtime.job.id": claim.job_id,
                    "runtime.endpoint": claim.endpoint_key,
                    "runtime.lease.epoch": claim.lease_epoch,
                },
            ) as span:
                try:
                    await self._execute_claim(claim)
                except Exception as error:
                    span.set_attribute("error.type", type(error).__name__)
                    metrics.increment("runtime.jobs.errors")
                    raise
                finally:
                    metrics.observe(
                        "runtime.job.duration_seconds",
                        time.perf_counter() - started,
                    )

    async def _execute_claim(self, claim: ClaimedRuntime) -> None:
        heartbeat_task: asyncio.Task[None] | None = None
        terminal_seen = False
        last_control_check = 0.0
        try:
            runner = self.registry.require(claim.endpoint_key)
            await self.runtime.start(
                claim,
                worker_id=self.worker_id,
                lease_seconds=self.lease_seconds,
            )
            heartbeat_task = asyncio.create_task(
                self._heartbeat_loop(claim),
                name=f"runtime-heartbeat-{claim.job_id}",
            )
            async for event in runner.run(claim.input_data):
                payload = self._public_payload(event)
                event_type = str(payload.get("type") or "")
                monotonic_now = time.monotonic()
                if monotonic_now - last_control_check >= 0.1 or event_type in {"RUN_FINISHED", "RUN_ERROR"}:
                    last_control_check = monotonic_now
                    cancel_command_id = await self.runtime.pending_cancel_command(claim)
                    if cancel_command_id is not None:
                        product_status = await self.runtime.product_status(claim)
                        runtime_status = "cancelled" if product_status == "cancelled" else "outcome_unknown"
                        message = (
                            "用户已取消本次Run。"
                            if runtime_status == "cancelled"
                            else "用户已停止等待；外部请求结果未知，系统不会自动重试。"
                        )
                        await self.runtime.append_terminal_and_settle(
                            claim,
                            worker_id=self.worker_id,
                            payload={
                                "type": "RUN_ERROR",
                                "code": "USER_CANCELLED"
                                if runtime_status == "cancelled"
                                else "USER_CANCELLED_OUTCOME_UNKNOWN",
                                "message": message,
                            },
                            status=runtime_status,
                            is_terminal=True,
                            failure_code="user_cancelled",
                            failure_summary=message,
                            control_command_ids=(cancel_command_id,),
                        )
                        terminal_seen = True
                        return
                if event_type == "RUN_STARTED":
                    await self.runtime.mark_external_dispatch(claim, worker_id=self.worker_id)
                interrupt = event_type == "RUN_FINISHED" and self._is_interrupt(payload)
                is_terminal = event_type == "RUN_ERROR" or (event_type == "RUN_FINISHED" and not interrupt)
                product_terminal_status: str | None = None
                if is_terminal and event_type == "RUN_FINISHED":
                    product_terminal_status = await self._require_product_terminal(claim)
                if event_type == "RUN_ERROR":
                    terminal_seen = True
                    await self.runtime.append_terminal_and_settle(
                        claim,
                        worker_id=self.worker_id,
                        payload=payload,
                        status="failed",
                        is_terminal=True,
                        failure_code=str(payload.get("code") or "runtime_run_error")[:100],
                        failure_summary=str(payload.get("message") or "MAF Run失败")[:500],
                    )
                elif event_type == "RUN_FINISHED":
                    terminal_seen = True
                    await self.runtime.append_terminal_and_settle(
                        claim,
                        worker_id=self.worker_id,
                        payload=payload,
                        status=(
                            "waiting_human"
                            if interrupt
                            else "cancelled"
                            if product_terminal_status == "abandoned"
                            else "succeeded"
                        ),
                        is_terminal=not interrupt,
                    )
                else:
                    await self.runtime.append_event(
                        claim,
                        worker_id=self.worker_id,
                        payload=payload,
                        is_terminal=False,
                    )
            if not terminal_seen:
                raise RuntimeError("MAF Runtime没有产生RUN_FINISHED或RUN_ERROR")
        except RuntimeLeaseLost:
            logger.warning(
                "execution_worker_lease_lost worker_id=%s job_id=%s epoch=%d",
                self.worker_id,
                claim.job_id,
                claim.lease_epoch,
            )
        except asyncio.CancelledError:
            # The lease expires naturally. Reconciler classifies it using the
            # last persisted external-dispatch state; cancellation is not
            # silently converted into a safe retry.
            raise
        except Exception as error:
            logger.exception(
                "execution_worker_job_failed worker_id=%s job_id=%s",
                self.worker_id,
                claim.job_id,
            )
            await self.runtime.fail_lost_execution(
                claim,
                worker_id=self.worker_id,
                error=error,
            )
        finally:
            if heartbeat_task is not None:
                heartbeat_task.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat_task

    async def _heartbeat_loop(self, claim: ClaimedRuntime) -> None:
        interval = max(1.0, self.lease_seconds / 3)
        while True:
            await asyncio.sleep(interval)
            alive = await self.runtime.heartbeat(
                claim,
                worker_id=self.worker_id,
                lease_seconds=self.lease_seconds,
            )
            if not alive:
                raise RuntimeLeaseLost("Execution Worker续租失败")
            await self._maintain_runtime()

    async def _maintain_runtime(self) -> None:
        now = time.monotonic()
        if now < self._next_maintenance_at:
            return
        self._next_maintenance_at = now + max(1.0, min(10.0, self.lease_seconds / 2))
        summary = await self.runtime.reconcile_expired_leases()
        product_reconciled = await self.sessions.reconcile_terminal_runtime_jobs()
        async with self.database.sessions.begin() as transaction:
            record = await transaction.scalar(
                select(ExecutionWorkerRecord).where(
                    ExecutionWorkerRecord.id == self.worker_id,
                    ExecutionWorkerRecord.boot_id == self.boot_id,
                )
            )
            if record is not None:
                record.heartbeat_at = utc_now()
        if any(summary.values()) or product_reconciled:
            logger.warning(
                "runtime_reconciled worker_id=%s safe_requeued=%d outcome_unknown=%d "
                "product_terminal_recovered=%d product_runs_reconciled=%d",
                self.worker_id,
                summary["safe_requeued"],
                summary["outcome_unknown"],
                summary["product_terminal_recovered"],
                product_reconciled,
            )

    @staticmethod
    def _public_payload(event: Any) -> dict[str, Any]:
        if hasattr(event, "model_dump"):
            value = event.model_dump(mode="json", by_alias=True, exclude_none=True)
        elif isinstance(event, dict):
            value = dict(event)
        else:
            raise TypeError(f"Runtime事件不可序列化: {type(event).__name__}")
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            raise TypeError("Runtime事件缺少AG-UI type")
        return value

    @staticmethod
    def _is_interrupt(payload: dict[str, Any]) -> bool:
        outcome = payload.get("outcome")
        return isinstance(outcome, dict) and outcome.get("type") == "interrupt"

    async def _require_product_terminal(self, claim: ClaimedRuntime) -> str:
        async with self.database.sessions() as transaction:
            run = await transaction.get(RunRecord, claim.product_run_id)
            if run is None or run.status not in {"succeeded", "abandoned"}:
                raise RuntimeError("Product Run尚未提交可公开终态，禁止发布RUN_FINISHED")
            return run.status
