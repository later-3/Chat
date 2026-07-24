"""Read-only operational health and backlog diagnostics."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter
from sqlalchemy import func, select, text

from ..api import http_problem
from ..governance.models import (
    GovernanceOutboxRecord,
    MafWorkflowCheckpointRecord,
    ModelCallAttemptRecord,
    ModelCallTransportEventRecord,
)
from ..product_sessions.database import (
    ProductDatabase,
    RunAttemptRecord,
    RunRecord,
    TraceRecord,
)
from ..runtime_execution.models import (
    ExecutionWorkerRecord,
    RuntimeEventRecord,
    RuntimeJobRecord,
)
from .metrics import MetricRegistry, metrics


class DiagnosticsUnavailable(RuntimeError):
    code = "DEPENDENCY_NOT_READY"


class DiagnosticRunNotFound(RuntimeError):
    code = "DIAGNOSTIC_RUN_NOT_FOUND"


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


class DiagnosticsService:
    """Query operational projections without reading payload or secret columns."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        metric_registry: MetricRegistry = metrics,
    ) -> None:
        self.database = database
        self.metric_registry = metric_registry

    async def readiness(self) -> dict[str, Any]:
        try:
            async with self.database.sessions() as session:
                await session.execute(text("SELECT 1"))
        except Exception as error:
            raise DiagnosticsUnavailable("Product Store不可用") from error
        return {"status": "ready", "dependencies": {"product_store": "ready"}}

    async def operations(self) -> dict[str, Any]:
        async with self.database.sessions() as session:
            runtime_rows = (
                await session.execute(
                    select(RuntimeJobRecord.status, func.count(RuntimeJobRecord.id)).group_by(
                        RuntimeJobRecord.status
                    )
                )
            ).all()
            outbox_rows = (
                await session.execute(
                    select(
                        GovernanceOutboxRecord.status,
                        func.count(GovernanceOutboxRecord.id),
                    ).group_by(GovernanceOutboxRecord.status)
                )
            ).all()
            workers = (
                await session.scalars(
                    select(ExecutionWorkerRecord).order_by(ExecutionWorkerRecord.heartbeat_at.desc())
                )
            ).all()

        runtime_counts: defaultdict[str, int] = defaultdict(int)
        runtime_counts.update({str(key): int(value) for key, value in runtime_rows})
        outbox_counts: defaultdict[str, int] = defaultdict(int)
        outbox_counts.update({str(key): int(value) for key, value in outbox_rows})
        return {
            "runtime_jobs": dict(sorted(runtime_counts.items())),
            "outbox_events": dict(sorted(outbox_counts.items())),
            "workers": [
                {
                    "worker_id": worker.id,
                    "boot_id": worker.boot_id,
                    "status": worker.status,
                    "heartbeat_at": _iso(worker.heartbeat_at),
                    "started_at": _iso(worker.started_at),
                    "stopped_at": _iso(worker.stopped_at),
                    "capabilities": worker.capabilities_json,
                }
                for worker in workers
            ],
        }

    async def run_timeline(self, run_id: str) -> dict[str, Any]:
        """Return identifiers and lifecycle facts without payload or message text."""

        async with self.database.sessions() as session:
            run = await session.get(RunRecord, run_id)
            if run is None:
                raise DiagnosticRunNotFound("Product Run不存在")
            attempts = (
                await session.scalars(
                    select(RunAttemptRecord)
                    .where(RunAttemptRecord.run_id == run_id)
                    .order_by(RunAttemptRecord.attempt_number)
                )
            ).all()
            jobs = (
                await session.scalars(
                    select(RuntimeJobRecord)
                    .where(RuntimeJobRecord.product_run_id == run_id)
                    .order_by(RuntimeJobRecord.created_at)
                )
            ).all()
            job_ids = tuple(job.id for job in jobs)
            runtime_events = (
                (
                    await session.scalars(
                        select(RuntimeEventRecord)
                        .where(RuntimeEventRecord.runtime_job_id.in_(job_ids))
                        .order_by(
                            RuntimeEventRecord.runtime_job_id,
                            RuntimeEventRecord.sequence,
                        )
                        .limit(1000)
                    )
                ).all()
                if job_ids
                else []
            )
            trace_events = (
                await session.scalars(
                    select(TraceRecord)
                    .where(TraceRecord.run_id == run_id)
                    .order_by(TraceRecord.sequence)
                    .limit(1000)
                )
            ).all()
            checkpoints = (
                await session.scalars(
                    select(MafWorkflowCheckpointRecord)
                    .where(MafWorkflowCheckpointRecord.product_run_id == run_id)
                    .order_by(MafWorkflowCheckpointRecord.created_at)
                )
            ).all()
            model_attempts = (
                await session.scalars(
                    select(ModelCallAttemptRecord)
                    .where(ModelCallAttemptRecord.run_id == run_id)
                    .order_by(ModelCallAttemptRecord.started_at)
                )
            ).all()
            model_attempt_ids = tuple(value.id for value in model_attempts)
            model_transport_events = (
                (
                    await session.scalars(
                        select(ModelCallTransportEventRecord)
                        .where(ModelCallTransportEventRecord.model_call_attempt_id.in_(model_attempt_ids))
                        .order_by(
                            ModelCallTransportEventRecord.model_call_attempt_id,
                            ModelCallTransportEventRecord.sequence,
                        )
                    )
                ).all()
                if model_attempt_ids
                else []
            )

        return {
            "run": {
                "id": run.id,
                "session_id": run.session_id,
                "interaction_id": run.interaction_id,
                "status": run.status,
                "failure_code": run.failure_code,
                "started_at": _iso(run.started_at),
                "finished_at": _iso(run.finished_at),
            },
            "attempts": [
                {
                    "id": attempt.id,
                    "number": attempt.attempt_number,
                    "runtime_kind": attempt.runtime_kind,
                    "status": attempt.status,
                    "failure_code": attempt.failure_code,
                    "started_at": _iso(attempt.started_at),
                    "finished_at": _iso(attempt.finished_at),
                }
                for attempt in attempts
            ],
            "runtime_jobs": [
                {
                    "id": job.id,
                    "attempt_id": job.run_attempt_id,
                    "endpoint_key": job.endpoint_key,
                    "workflow_definition_id": job.workflow_definition_id,
                    "workflow_version": job.workflow_version,
                    "status": job.status,
                    "recoverability": job.recoverability,
                    "lease_epoch": job.lease_epoch,
                    "external_dispatch_state": job.external_dispatch_state,
                    "last_event_sequence": job.last_event_sequence,
                    "failure_code": job.failure_code,
                    "created_at": _iso(job.created_at),
                    "finished_at": _iso(job.finished_at),
                }
                for job in jobs
            ],
            "runtime_events": [
                {
                    "job_id": event.runtime_job_id,
                    "attempt_id": event.run_attempt_id,
                    "sequence": event.sequence,
                    "event_type": event.agui_event_type,
                    "is_terminal": event.is_terminal,
                    "created_at": _iso(event.created_at),
                }
                for event in runtime_events
            ],
            "product_trace": [
                {
                    "sequence": event.sequence,
                    "event_type": event.event_type,
                    "created_at": _iso(event.created_at),
                }
                for event in trace_events
            ],
            "checkpoints": [
                {
                    "checkpoint_id": checkpoint.checkpoint_id,
                    "attempt_id": checkpoint.run_attempt_id,
                    "workflow_definition_id": checkpoint.workflow_definition_id,
                    "workflow_version": checkpoint.workflow_version,
                    "graph_signature_hash": checkpoint.graph_signature_hash,
                    "encoding_version": checkpoint.encoding_version,
                    "iteration_count": checkpoint.iteration_count,
                    "pending_request_count": len(checkpoint.pending_request_ids_json or []),
                    "status": checkpoint.status,
                    "created_at": _iso(checkpoint.created_at),
                    "superseded_at": _iso(checkpoint.superseded_at),
                }
                for checkpoint in checkpoints
            ],
            "model_attempts": [
                {
                    "id": attempt.id,
                    "run_attempt_id": attempt.run_attempt_id,
                    "attempt_number": attempt.attempt_number,
                    "status": attempt.status,
                    "http_status": attempt.http_status,
                    "provider_request_id": attempt.provider_request_id,
                    "provider_response_id": attempt.provider_response_id,
                    "usage": attempt.usage_json,
                    "response_metadata": attempt.response_metadata_json,
                    "output_text_sha256": attempt.output_text_sha256,
                    "output_disposition": attempt.output_disposition,
                    "output_disposition_reason": attempt.output_disposition_reason,
                    "started_at": _iso(attempt.started_at),
                    "first_byte_at": _iso(attempt.first_byte_at),
                    "finished_at": _iso(attempt.finished_at),
                    "failure_code": attempt.failure_code,
                }
                for attempt in model_attempts
            ],
            "model_transport_events": [
                {
                    "attempt_id": event.model_call_attempt_id,
                    "sequence": event.sequence,
                    "stage": event.stage,
                    "status": event.status,
                    "details": event.details_json,
                    "created_at": _iso(event.created_at),
                }
                for event in model_transport_events
            ],
        }


def create_diagnostics_router(service: DiagnosticsService) -> APIRouter:
    router = APIRouter(tags=["diagnostics"])

    @router.get("/api/live")
    async def live() -> dict[str, str]:
        return {"status": "live"}

    @router.get("/api/ready")
    async def ready() -> dict[str, Any]:
        try:
            return await service.readiness()
        except DiagnosticsUnavailable as error:
            raise http_problem(status_code=503, error=error) from error

    @router.get("/api/diagnostics/operations")
    async def operations() -> dict[str, Any]:
        return await service.operations()

    @router.get("/api/diagnostics/metrics")
    async def metric_snapshot() -> dict[str, object]:
        return service.metric_registry.snapshot()

    @router.get("/api/diagnostics/runs/{run_id}/timeline")
    async def run_timeline(run_id: str) -> dict[str, Any]:
        try:
            return await service.run_timeline(run_id)
        except DiagnosticRunNotFound as error:
            raise http_problem(status_code=404, error=error) from error

    return router
