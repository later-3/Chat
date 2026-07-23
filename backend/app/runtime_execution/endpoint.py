"""FastAPI admission and cursor subscription endpoints for durable AG-UI runs."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator, Sequence
from typing import Any

from agent_framework_ag_ui._types import AGUIRequest
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..product_sessions.service import ProductSessionError, ProductSessionService
from .service import (
    RuntimeCursorExpired,
    RuntimeCursorInvalid,
    RuntimeExecutionError,
    RuntimeExecutionService,
)
from .worker import RuntimeRunner, RuntimeRunnerRegistry


def _sse(payload: dict[str, Any], *, sequence: int | None = None) -> bytes:
    prefix = f"id: {sequence}\n" if sequence is not None else ""
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"{prefix}data: {data}\n\n".encode("utf-8")


def add_durable_agui_endpoint(
    app: FastAPI,
    runner: RuntimeRunner,
    path: str,
    *,
    sessions: ProductSessionService,
    runtime: RuntimeExecutionService,
    registry: RuntimeRunnerRegistry,
    workflow_definition_id: str,
    workflow_version: str,
    tags: list[str] | None = None,
    dependencies: Sequence[Depends] | None = None,
    poll_interval_seconds: float = 0.08,
) -> None:
    """Register one AG-UI runner without tying execution to the HTTP stream."""

    endpoint_key = path
    registry.register(endpoint_key, runner)

    @app.post(path, tags=tags or ["AG-UI"], dependencies=dependencies, response_model=None)  # type: ignore[arg-type]
    async def durable_agent_endpoint(request_body: AGUIRequest) -> StreamingResponse:
        input_data = request_body.model_dump(mode="json", exclude_none=True)
        try:
            accepted = await sessions.prepare_agui_run(input_data)
            enqueued = await runtime.enqueue(
                accepted=accepted,
                endpoint_key=endpoint_key,
                workflow_definition_id=workflow_definition_id,
                workflow_version=workflow_version,
                input_data=input_data,
            )
            if runtime.database.is_memory:
                # In-memory SQLite is a deterministic test profile with one
                # process-local connection. Execute before opening the stream
                # instead of racing a background transaction on StaticPool.
                await app.state.execution_worker.run_once()
        except ProductSessionError as error:
            return _agui_error_response(input_data, code=error.code, message=str(error))
        except RuntimeExecutionError as error:
            return _agui_error_response(input_data, code=error.code, message=str(error))

        async def event_stream() -> AsyncGenerator[bytes]:
            sequence = enqueued.start_sequence
            idle_cycles = 0
            while True:
                events, job = await runtime.events_after(
                    job_id=enqueued.job_id,
                    after_sequence=sequence,
                )
                if not events:
                    if job["status"] in {"failed", "cancelled", "outcome_unknown"}:
                        # Worker failures that occur outside the MAF event loop
                        # still terminate the AG-UI segment with a public error.
                        yield _sse(
                            {
                                "type": "RUN_ERROR",
                                "message": job.get("failure_summary") or "Execution Worker未能完成本次Run。",
                                "code": job.get("failure_code") or "EXECUTION_WORKER_FAILED",
                            }
                        )
                        return
                    idle_cycles += 1
                    if idle_cycles % 150 == 0:
                        yield b": runtime-keepalive\n\n"
                    await asyncio.sleep(poll_interval_seconds)
                    continue
                idle_cycles = 0
                for event in events:
                    sequence = int(event["sequence"])
                    payload = dict(event["payload"])
                    yield _sse(payload, sequence=sequence)
                    # Resume admission snapshots the Job's prior sequence, so
                    # any terminal frame after that boundary belongs to this
                    # HTTP segment even when an adapter generates its own AG-UI
                    # run id.
                    if payload.get("type") in {"RUN_FINISHED", "RUN_ERROR"}:
                        return

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
                "X-Runtime-Job-Id": enqueued.job_id,
                "X-Runtime-Cursor": enqueued.cursor,
            },
        )


def _agui_error_response(input_data: dict[str, Any], *, code: str, message: str) -> StreamingResponse:
    thread_id = str(input_data.get("thread_id") or input_data.get("threadId") or "")
    run_id = str(input_data.get("run_id") or input_data.get("runId") or "")

    async def error_stream() -> AsyncGenerator[bytes]:
        yield _sse({"type": "RUN_STARTED", "threadId": thread_id, "runId": run_id})
        yield _sse({"type": "RUN_ERROR", "message": message, "code": code})

    return StreamingResponse(error_stream(), media_type="text/event-stream")


def add_runtime_management_endpoints(
    app: FastAPI,
    *,
    runtime: RuntimeExecutionService,
) -> None:
    @app.get("/api/runtime/product-runs/{product_run_id}")
    async def runtime_job_for_run(product_run_id: str) -> dict[str, Any]:
        job = await runtime.job_for_product_run(product_run_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Product Run没有Runtime Job")
        return {"job": job}

    @app.get("/api/runtime/jobs/{job_id}/events")
    async def runtime_events(
        job_id: str,
        cursor: str | None = Query(default=None),
        after_sequence: int = Query(default=0, ge=0),
        limit: int = Query(default=500, ge=1, le=2000),
    ) -> dict[str, Any]:
        if cursor is not None:
            try:
                decoded = runtime.decode_cursor(cursor)
            except RuntimeCursorInvalid as error:
                raise HTTPException(status_code=400, detail={"code": error.code, "message": str(error)}) from error
            if decoded["runtime_job_id"] != job_id:
                raise HTTPException(status_code=400, detail={"code": "RUNTIME_CURSOR_JOB_MISMATCH"})
            after_sequence = int(decoded["last_applied_sequence"])
        try:
            events, job = await runtime.events_after(
                job_id=job_id,
                after_sequence=after_sequence,
                limit=limit,
            )
        except RuntimeCursorExpired as error:
            raise HTTPException(status_code=410, detail={"code": error.code, "message": str(error)}) from error
        except RuntimeExecutionError as error:
            raise HTTPException(status_code=404, detail={"code": error.code, "message": str(error)}) from error
        next_cursor = events[-1]["cursor"] if events else job["cursor"]
        return {"job": job, "events": events, "next_cursor": next_cursor}
