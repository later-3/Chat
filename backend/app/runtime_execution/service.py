"""Transactional runtime job, lease, event journal, cursor and control service."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select, update

from ..product_sessions.database import (
    ProductDatabase,
    RunAttemptRecord,
    RunRecord,
    affected_row_count,
    utc_now,
)
from ..product_sessions.service import AcceptedRun
from .models import RuntimeControlCommandRecord, RuntimeEventRecord, RuntimeJobRecord

TERMINAL_JOB_STATUSES = {"succeeded", "failed", "cancelled", "outcome_unknown"}


class RuntimeExecutionError(RuntimeError):
    code = "RUNTIME_EXECUTION_ERROR"


class RuntimeLeaseLost(RuntimeExecutionError):
    code = "RUNTIME_LEASE_LOST"


class RuntimeCursorInvalid(RuntimeExecutionError):
    code = "RUNTIME_CURSOR_INVALID"


class RuntimeCursorExpired(RuntimeExecutionError):
    code = "RUNTIME_CURSOR_EXPIRED"


@dataclass(frozen=True, slots=True)
class EnqueuedRuntime:
    job_id: str
    product_run_id: str
    run_attempt_id: str
    start_sequence: int
    cursor: str


@dataclass(frozen=True, slots=True)
class ClaimedRuntime:
    job_id: str
    product_run_id: str
    run_attempt_id: str
    endpoint_key: str
    workflow_definition_id: str
    input_data: dict[str, Any]
    lease_owner: str
    lease_epoch: int
    command_id: str | None


def _uuid() -> str:
    return str(uuid.uuid4())


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _hash(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


class RuntimeExecutionService:
    """Own durable runtime state without becoming the Product fact source."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        scope_id: str = "local-user",
        cursor_signing_key: str = "chat-local-cursor-v1",
    ) -> None:
        self.database = database
        self.scope_id = scope_id
        self._cursor_key = cursor_signing_key.encode("utf-8")

    async def initialize(self) -> None:
        await self.database.initialize()

    async def enqueue(
        self,
        *,
        accepted: AcceptedRun,
        endpoint_key: str,
        workflow_definition_id: str,
        workflow_version: str,
        input_data: dict[str, Any],
    ) -> EnqueuedRuntime:
        """Create the one Job for an Attempt or queue one version-bound resume."""

        async with self.database.sessions.begin() as transaction:
            attempt = await transaction.scalar(
                select(RunAttemptRecord)
                .where(RunAttemptRecord.run_id == accepted.product_run_id)
                .order_by(RunAttemptRecord.attempt_number.desc())
                .limit(1)
            )
            if attempt is None:
                raise RuntimeExecutionError("Product Run缺少Run Attempt")
            job = await transaction.scalar(
                select(RuntimeJobRecord).where(RuntimeJobRecord.run_attempt_id == attempt.id)
            )
            if job is None:
                if accepted.is_resume:
                    raise RuntimeExecutionError("恢复请求没有对应Runtime Job")
                job = RuntimeJobRecord(
                    id=_uuid(),
                    scope_id=self.scope_id,
                    product_run_id=accepted.product_run_id,
                    run_attempt_id=attempt.id,
                    endpoint_key=endpoint_key,
                    workflow_definition_id=workflow_definition_id,
                    workflow_version=workflow_version,
                    status="queued",
                    recoverability="safe_requeue",
                    input_payload_json=input_data,
                    input_hash=_hash(input_data),
                    external_dispatch_state="not_started",
                    available_at=utc_now(),
                )
                transaction.add(job)
                attempt.runtime_kind = "execution_worker"
                attempt.status = "accepted"
                await transaction.flush()
                start_sequence = 0
            elif accepted.is_resume:
                if job.status != "waiting_human":
                    raise RuntimeExecutionError(f"Runtime Job状态{job.status}不允许Checkpoint恢复")
                request_key = f"resume:{accepted.agui_run_id}"
                existing = await transaction.scalar(
                    select(RuntimeControlCommandRecord).where(
                        RuntimeControlCommandRecord.scope_id == self.scope_id,
                        RuntimeControlCommandRecord.request_key == request_key,
                    )
                )
                if existing is None:
                    transaction.add(
                        RuntimeControlCommandRecord(
                            id=_uuid(),
                            runtime_job_id=job.id,
                            run_attempt_id=attempt.id,
                            command_kind="resume_checkpoint",
                            request_key=request_key,
                            expected_status="waiting_human",
                            checkpoint_id=job.checkpoint_id,
                            payload_json=input_data,
                            requested_by="local-user",
                            scope_id=self.scope_id,
                            status="pending",
                        )
                    )
                job.status = "queued"
                job.recoverability = "checkpoint_only"
                # Recoverability is evaluated per execution segment.  The
                # previous segment recorded an interrupt result; this new
                # continuation has not crossed its Provider/Tool boundary yet.
                job.external_dispatch_state = "not_started"
                job.available_at = utc_now()
                job.updated_at = utc_now()
                start_sequence = job.last_event_sequence
            else:
                if job.input_hash != _hash(input_data):
                    raise RuntimeExecutionError("相同Attempt不能替换Runtime输入")
                start_sequence = 0
            job_id = job.id
            attempt_id = attempt.id
        return EnqueuedRuntime(
            job_id=job_id,
            product_run_id=accepted.product_run_id,
            run_attempt_id=attempt_id,
            start_sequence=start_sequence,
            cursor=self.encode_cursor(job_id, attempt_id, start_sequence),
        )

    async def claim_one(self, *, worker_id: str, lease_seconds: int) -> ClaimedRuntime | None:
        now = utc_now()
        lease_until = now + timedelta(seconds=lease_seconds)
        async with self.database.sessions.begin() as transaction:
            candidate = await transaction.scalar(
                select(RuntimeJobRecord)
                .where(RuntimeJobRecord.status == "queued", RuntimeJobRecord.available_at <= now)
                .order_by(RuntimeJobRecord.available_at, RuntimeJobRecord.created_at, RuntimeJobRecord.id)
                .limit(1)
            )
            if candidate is None:
                return None
            claimed = await transaction.execute(
                update(RuntimeJobRecord)
                .where(RuntimeJobRecord.id == candidate.id, RuntimeJobRecord.status == "queued")
                .values(
                    status="leased",
                    lease_owner=worker_id,
                    lease_epoch=RuntimeJobRecord.lease_epoch + 1,
                    lease_expires_at=lease_until,
                    heartbeat_at=now,
                    updated_at=now,
                )
            )
            if affected_row_count(claimed) != 1:
                return None
            await transaction.refresh(candidate)
            command = await transaction.scalar(
                select(RuntimeControlCommandRecord)
                .where(
                    RuntimeControlCommandRecord.runtime_job_id == candidate.id,
                    RuntimeControlCommandRecord.status == "pending",
                )
                .order_by(RuntimeControlCommandRecord.created_at)
                .limit(1)
            )
            input_data = dict(candidate.input_payload_json)
            command_id: str | None = None
            if command is not None:
                if command.command_kind == "resume_checkpoint":
                    input_data = dict(command.payload_json)
                command.status = "claimed"
                command.claimed_by = worker_id
                command.claimed_at = now
                command_id = command.id
            return ClaimedRuntime(
                job_id=candidate.id,
                product_run_id=candidate.product_run_id,
                run_attempt_id=candidate.run_attempt_id,
                endpoint_key=candidate.endpoint_key,
                workflow_definition_id=candidate.workflow_definition_id,
                input_data=input_data,
                lease_owner=worker_id,
                lease_epoch=candidate.lease_epoch,
                command_id=command_id,
            )

    async def start(self, claim: ClaimedRuntime, *, worker_id: str, lease_seconds: int) -> None:
        now = utc_now()
        changed = await self._lease_update(
            claim,
            worker_id=worker_id,
            values={
                "status": "running",
                "recoverability": "safe_requeue",
                "lease_expires_at": now + timedelta(seconds=lease_seconds),
                "heartbeat_at": now,
                "updated_at": now,
            },
        )
        if not changed:
            raise RuntimeLeaseLost("Runtime Job启动前Lease已失效")

    async def mark_external_dispatch(self, claim: ClaimedRuntime, *, worker_id: str) -> None:
        changed = await self._lease_update(
            claim,
            worker_id=worker_id,
            values={
                "external_dispatch_state": "dispatching",
                "recoverability": "outcome_unknown",
                "updated_at": utc_now(),
            },
        )
        if not changed:
            raise RuntimeLeaseLost("外发状态写入时Lease已失效")

    async def heartbeat(self, claim: ClaimedRuntime, *, worker_id: str, lease_seconds: int) -> bool:
        now = utc_now()
        return await self._lease_update(
            claim,
            worker_id=worker_id,
            values={"heartbeat_at": now, "lease_expires_at": now + timedelta(seconds=lease_seconds)},
        )

    async def append_event(
        self,
        claim: ClaimedRuntime,
        *,
        worker_id: str,
        payload: dict[str, Any],
        is_terminal: bool,
    ) -> dict[str, Any]:
        encoded = _canonical(payload)
        payload_hash = hashlib.sha256(encoded).hexdigest()
        event_type = str(payload.get("type") or "UNKNOWN")
        async with self.database.sessions.begin() as transaction:
            sequence = await transaction.scalar(
                update(RuntimeJobRecord)
                .where(
                    RuntimeJobRecord.id == claim.job_id,
                    RuntimeJobRecord.run_attempt_id == claim.run_attempt_id,
                    RuntimeJobRecord.lease_owner == worker_id,
                    RuntimeJobRecord.lease_epoch == claim.lease_epoch,
                    RuntimeJobRecord.status.in_({"leased", "running"}),
                )
                .values(
                    last_event_sequence=RuntimeJobRecord.last_event_sequence + 1,
                    updated_at=utc_now(),
                )
                .returning(RuntimeJobRecord.last_event_sequence)
                .execution_options(synchronize_session=False)
            )
            if sequence is None:
                raise RuntimeLeaseLost("旧Worker不能写入Runtime Event")
            record = RuntimeEventRecord(
                id=_uuid(),
                runtime_job_id=claim.job_id,
                run_attempt_id=claim.run_attempt_id,
                sequence=int(sequence),
                agui_event_type=event_type,
                public_payload_json=payload,
                payload_hash=payload_hash,
                is_terminal=is_terminal,
                size_bytes=len(encoded),
            )
            transaction.add(record)
        return self._event_view(record)

    async def settle(
        self,
        claim: ClaimedRuntime,
        *,
        worker_id: str,
        status: str,
        failure_code: str | None = None,
        failure_summary: str | None = None,
    ) -> None:
        if status not in TERMINAL_JOB_STATUSES | {"waiting_human"}:
            raise ValueError(f"不支持的Runtime终结状态: {status}")
        now = utc_now()
        values: dict[str, Any] = {
            "status": status,
            "recoverability": "checkpoint_only" if status == "waiting_human" else "terminal",
            "lease_owner": None,
            "lease_expires_at": None,
            "heartbeat_at": now,
            "failure_code": failure_code,
            "failure_summary": failure_summary,
            "updated_at": now,
            "finished_at": None if status == "waiting_human" else now,
        }
        if status in {"succeeded", "waiting_human"}:
            values["external_dispatch_state"] = "result_recorded"
        changed = await self._lease_update(claim, worker_id=worker_id, values=values)
        if not changed:
            raise RuntimeLeaseLost("旧Worker不能提交Runtime终态")
        if claim.command_id is not None:
            async with self.database.sessions.begin() as transaction:
                await transaction.execute(
                    update(RuntimeControlCommandRecord)
                    .where(
                        RuntimeControlCommandRecord.id == claim.command_id,
                        RuntimeControlCommandRecord.claimed_by == worker_id,
                        RuntimeControlCommandRecord.status == "claimed",
                    )
                    .values(status="applied", result_code="applied", finished_at=utc_now())
                )

    async def append_terminal_and_settle(
        self,
        claim: ClaimedRuntime,
        *,
        worker_id: str,
        payload: dict[str, Any],
        status: str,
        is_terminal: bool,
        failure_code: str | None = None,
        failure_summary: str | None = None,
        control_command_ids: tuple[str, ...] = (),
    ) -> dict[str, Any]:
        """Make the last public frame and Runtime segment state one fact."""

        if status not in TERMINAL_JOB_STATUSES | {"waiting_human"}:
            raise ValueError(f"不支持的Runtime终结状态: {status}")
        encoded = _canonical(payload)
        payload_hash = hashlib.sha256(encoded).hexdigest()
        now = utc_now()
        values: dict[str, Any] = {
            "last_event_sequence": RuntimeJobRecord.last_event_sequence + 1,
            "status": status,
            "recoverability": "checkpoint_only" if status == "waiting_human" else "terminal",
            "lease_owner": None,
            "lease_expires_at": None,
            "heartbeat_at": now,
            "failure_code": failure_code,
            "failure_summary": failure_summary,
            "updated_at": now,
            "finished_at": None if status == "waiting_human" else now,
        }
        if status in {"succeeded", "waiting_human"}:
            values["external_dispatch_state"] = "result_recorded"
        async with self.database.sessions.begin() as transaction:
            sequence = await transaction.scalar(
                update(RuntimeJobRecord)
                .where(
                    RuntimeJobRecord.id == claim.job_id,
                    RuntimeJobRecord.run_attempt_id == claim.run_attempt_id,
                    RuntimeJobRecord.lease_owner == worker_id,
                    RuntimeJobRecord.lease_epoch == claim.lease_epoch,
                    RuntimeJobRecord.status.in_({"leased", "running"}),
                )
                .values(**values)
                .returning(RuntimeJobRecord.last_event_sequence)
                .execution_options(synchronize_session=False)
            )
            if sequence is None:
                raise RuntimeLeaseLost("旧Worker不能提交Runtime终态事件")
            record = RuntimeEventRecord(
                id=_uuid(),
                runtime_job_id=claim.job_id,
                run_attempt_id=claim.run_attempt_id,
                sequence=int(sequence),
                agui_event_type=str(payload.get("type") or "UNKNOWN"),
                public_payload_json=payload,
                payload_hash=payload_hash,
                is_terminal=is_terminal,
                size_bytes=len(encoded),
            )
            transaction.add(record)
            completed_commands = tuple(
                value for value in (claim.command_id, *control_command_ids) if value is not None
            )
            if completed_commands:
                await transaction.execute(
                    update(RuntimeControlCommandRecord)
                    .where(
                        RuntimeControlCommandRecord.id.in_(completed_commands),
                        RuntimeControlCommandRecord.status.in_({"pending", "claimed"}),
                    )
                    .values(status="applied", result_code="applied", finished_at=now)
                )
        return self._event_view(record)

    async def pending_cancel_command(self, claim: ClaimedRuntime) -> str | None:
        """Return the durable cancel addressed to this exact Attempt, if any."""

        async with self.database.sessions() as transaction:
            command = await transaction.scalar(
                select(RuntimeControlCommandRecord)
                .where(
                    RuntimeControlCommandRecord.runtime_job_id == claim.job_id,
                    RuntimeControlCommandRecord.run_attempt_id == claim.run_attempt_id,
                    RuntimeControlCommandRecord.command_kind == "cancel",
                    RuntimeControlCommandRecord.status == "pending",
                )
                .order_by(RuntimeControlCommandRecord.created_at)
                .limit(1)
            )
            return command.id if command is not None else None

    async def product_status(self, claim: ClaimedRuntime) -> str | None:
        async with self.database.sessions() as transaction:
            run = await transaction.get(RunRecord, claim.product_run_id)
            return run.status if run is not None else None

    async def fail_lost_execution(
        self,
        claim: ClaimedRuntime,
        *,
        worker_id: str,
        error: Exception,
    ) -> None:
        async with self.database.sessions() as transaction:
            job = await transaction.get(RuntimeJobRecord, claim.job_id)
            dispatch_state = job.external_dispatch_state if job is not None else "dispatching"
        status = "failed" if dispatch_state == "not_started" else "outcome_unknown"
        try:
            await self.settle(
                claim,
                worker_id=worker_id,
                status=status,
                failure_code="execution_worker_failed",
                failure_summary=str(error)[:500] or "Execution Worker异常结束",
            )
        except RuntimeLeaseLost:
            return

    async def request_cancel(
        self,
        *,
        product_run_id: str,
        request_key: str,
        requested_by: str = "local-user",
    ) -> dict[str, Any] | None:
        async with self.database.sessions.begin() as transaction:
            job = await transaction.scalar(
                select(RuntimeJobRecord).where(
                    RuntimeJobRecord.product_run_id == product_run_id,
                    RuntimeJobRecord.scope_id == self.scope_id,
                )
            )
            if job is None:
                return None
            existing = await transaction.scalar(
                select(RuntimeControlCommandRecord).where(
                    RuntimeControlCommandRecord.scope_id == self.scope_id,
                    RuntimeControlCommandRecord.request_key == request_key,
                )
            )
            if existing is None:
                existing = RuntimeControlCommandRecord(
                    id=_uuid(),
                    runtime_job_id=job.id,
                    run_attempt_id=job.run_attempt_id,
                    command_kind="cancel",
                    request_key=request_key,
                    expected_status=job.status,
                    payload_json={},
                    requested_by=requested_by,
                    scope_id=self.scope_id,
                    status="pending",
                )
                transaction.add(existing)
            if job.status in {"queued", "waiting_human", "leased"}:
                previous_status = job.status
                job.status = "cancelled"
                job.recoverability = "terminal"
                job.finished_at = utc_now()
                job.updated_at = utc_now()
                job.lease_owner = None
                job.lease_expires_at = None
                existing.status = "applied"
                existing.result_code = "cancelled_before_dispatch"
                existing.finished_at = utc_now()
                self._append_system_terminal(
                    transaction,
                    job,
                    payload={
                        "type": "RUN_ERROR",
                        "code": "USER_CANCELLED_BEFORE_DISPATCH",
                        "message": "用户在外部请求发送前取消了Run。",
                    },
                )
                existing.result_summary = f"Runtime Job从{previous_status}取消"
            return {"job_id": job.id, "status": job.status, "command_id": existing.id}

    async def queue_checkpoint_resume(
        self,
        *,
        product_run_id: str,
        input_data: dict[str, Any],
        request_key: str,
        checkpoint_id: str | None,
        requested_by: str,
    ) -> dict[str, Any]:
        """Idempotently turn a committed decision into Worker-owned resume work."""

        async with self.database.sessions.begin() as transaction:
            job = await transaction.scalar(
                select(RuntimeJobRecord).where(
                    RuntimeJobRecord.product_run_id == product_run_id,
                    RuntimeJobRecord.scope_id == self.scope_id,
                )
            )
            if job is None:
                raise RuntimeExecutionError("Product Run没有对应Runtime Job")
            existing = await transaction.scalar(
                select(RuntimeControlCommandRecord).where(
                    RuntimeControlCommandRecord.scope_id == self.scope_id,
                    RuntimeControlCommandRecord.request_key == request_key,
                )
            )
            if existing is None:
                if job.status != "waiting_human":
                    raise RuntimeExecutionError(f"Runtime Job状态{job.status}不允许Checkpoint恢复")
                existing = RuntimeControlCommandRecord(
                    id=_uuid(),
                    runtime_job_id=job.id,
                    run_attempt_id=job.run_attempt_id,
                    command_kind="resume_checkpoint",
                    request_key=request_key,
                    expected_status="waiting_human",
                    checkpoint_id=checkpoint_id,
                    payload_json=input_data,
                    requested_by=requested_by,
                    scope_id=self.scope_id,
                    status="pending",
                )
                transaction.add(existing)
            if job.status == "waiting_human":
                job.status = "queued"
                job.recoverability = "checkpoint_only"
                job.checkpoint_id = checkpoint_id
                job.external_dispatch_state = "not_started"
                job.available_at = utc_now()
                job.updated_at = utc_now()
            return {"job_id": job.id, "command_id": existing.id, "status": job.status}

    async def reconcile_expired_leases(self) -> dict[str, int]:
        """Fence and settle expired Jobs exactly once across Worker processes."""

        now = utc_now()
        async with self.database.sessions() as transaction:
            job_ids = list(
                (
                    await transaction.scalars(
                        select(RuntimeJobRecord.id).where(
                            RuntimeJobRecord.scope_id == self.scope_id,
                            RuntimeJobRecord.status.in_({"leased", "running", "cancelling"}),
                            RuntimeJobRecord.lease_expires_at < now,
                        )
                    )
                ).all()
            )
        results = [
            value
            for job_id in job_ids
            if (value := await self._reconcile_expired_job(job_id=job_id, expired_before=now)) is not None
        ]
        return {
            "safe_requeued": results.count("safe_requeued"),
            "outcome_unknown": results.count("outcome_unknown"),
            "product_terminal_recovered": results.count("product_terminal_recovered"),
        }

    async def _reconcile_expired_job(
        self,
        *,
        job_id: str,
        expired_before: datetime,
    ) -> str | None:
        """Acquire a fresh Epoch before changing one expired Job.

        The compare-and-swap is the multi-process fence.  A competing
        reconciler sees a non-active status after this transaction commits and
        therefore cannot append a second terminal event or requeue twice.
        """

        now = utc_now()
        reconciler_id = f"reconciler:{_uuid()}"
        async with self.database.sessions.begin() as transaction:
            acquired = await transaction.scalar(
                update(RuntimeJobRecord)
                .where(
                    RuntimeJobRecord.id == job_id,
                    RuntimeJobRecord.scope_id == self.scope_id,
                    RuntimeJobRecord.status.in_({"leased", "running", "cancelling"}),
                    RuntimeJobRecord.lease_expires_at < expired_before,
                )
                .values(
                    lease_owner=reconciler_id,
                    lease_epoch=RuntimeJobRecord.lease_epoch + 1,
                    heartbeat_at=now,
                    updated_at=now,
                )
                .returning(RuntimeJobRecord.id)
                .execution_options(synchronize_session=False)
            )
            if acquired is None:
                return None
            job = await transaction.get(RuntimeJobRecord, job_id)
            if job is None:
                return None
            product_run = await transaction.get(RunRecord, job.product_run_id)
            if product_run is not None and product_run.status in {
                "succeeded",
                "abandoned",
                "cancelled",
                "failed",
                "interrupted",
                "outcome_unknown",
            }:
                product_status = product_run.status
                if product_status in {"succeeded", "abandoned"}:
                    self._append_system_terminal(
                        transaction,
                        job,
                        payload={
                            "type": "RUN_FINISHED",
                            "threadId": product_run.session_id,
                            "runId": product_run.initial_agui_run_id,
                            "recoveredBy": "runtime_reconciler",
                        },
                    )
                    job.status = "succeeded" if product_status == "succeeded" else "cancelled"
                    job.external_dispatch_state = "result_recorded"
                else:
                    recovered_status = (
                        "cancelled"
                        if product_status == "cancelled"
                        else "outcome_unknown"
                        if product_status == "outcome_unknown"
                        else "failed"
                    )
                    self._append_system_terminal(
                        transaction,
                        job,
                        payload={
                            "type": "RUN_ERROR",
                            "code": f"PRODUCT_RUN_{product_status.upper()}",
                            "message": "执行进程失联后已按Product Run权威终态收敛。",
                        },
                    )
                    job.status = recovered_status
                    job.failure_code = f"product_run_{product_status}"
                    job.failure_summary = "Worker失联；Runtime已按Product Run权威终态修复。"
                job.recoverability = "terminal"
                job.finished_at = now
                result = "product_terminal_recovered"
            elif job.recoverability in {"safe_requeue", "checkpoint_only"} and (
                job.external_dispatch_state == "not_started" or job.checkpoint_id is not None
            ):
                job.status = "queued"
                job.available_at = now
                result = "safe_requeued"
            else:
                job.status = "outcome_unknown"
                job.recoverability = "terminal"
                job.failure_code = "worker_lease_expired_after_dispatch"
                job.failure_summary = "Worker失联且外部请求可能已经发出，系统不会自动重试。"
                job.finished_at = now
                self._append_system_terminal(
                    transaction,
                    job,
                    payload={
                        "type": "RUN_ERROR",
                        "code": "WORKER_LEASE_EXPIRED_AFTER_DISPATCH",
                        "message": job.failure_summary,
                    },
                )
                result = "outcome_unknown"
            job.lease_owner = None
            job.lease_expires_at = None
            job.updated_at = now
            return result

    def _append_system_terminal(
        self,
        transaction: Any,
        job: RuntimeJobRecord,
        *,
        payload: dict[str, Any],
    ) -> None:
        """Append a terminal public fact while a control/reconcile transaction owns the Job."""

        job.last_event_sequence += 1
        encoded = _canonical(payload)
        transaction.add(
            RuntimeEventRecord(
                id=_uuid(),
                runtime_job_id=job.id,
                run_attempt_id=job.run_attempt_id,
                sequence=job.last_event_sequence,
                agui_event_type=str(payload.get("type") or "RUN_ERROR"),
                public_payload_json=payload,
                payload_hash=hashlib.sha256(encoded).hexdigest(),
                is_terminal=True,
                size_bytes=len(encoded),
            )
        )

    async def events_after(
        self,
        *,
        job_id: str,
        after_sequence: int,
        limit: int = 500,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        async with self.database.sessions() as transaction:
            job = await transaction.scalar(
                select(RuntimeJobRecord).where(
                    RuntimeJobRecord.id == job_id,
                    RuntimeJobRecord.scope_id == self.scope_id,
                )
            )
            if job is None:
                raise RuntimeExecutionError("Runtime Job不存在或不属于当前Scope")
            if after_sequence + 1 < job.earliest_retained_sequence:
                raise RuntimeCursorExpired("Runtime Cursor早于事件保留边界")
            records = list(
                (
                    await transaction.scalars(
                        select(RuntimeEventRecord)
                        .where(
                            RuntimeEventRecord.runtime_job_id == job_id,
                            RuntimeEventRecord.sequence > after_sequence,
                        )
                        .order_by(RuntimeEventRecord.sequence)
                        .limit(limit)
                    )
                ).all()
            )
            job_view = self._job_view(job)
        return [self._event_view(value) for value in records], job_view

    async def job_for_product_run(self, product_run_id: str) -> dict[str, Any] | None:
        async with self.database.sessions() as transaction:
            job = await transaction.scalar(
                select(RuntimeJobRecord).where(
                    RuntimeJobRecord.product_run_id == product_run_id,
                    RuntimeJobRecord.scope_id == self.scope_id,
                )
            )
            return self._job_view(job) if job is not None else None

    async def _lease_update(
        self,
        claim: ClaimedRuntime,
        *,
        worker_id: str,
        values: dict[str, Any],
    ) -> bool:
        async with self.database.sessions.begin() as transaction:
            changed = await transaction.execute(
                update(RuntimeJobRecord)
                .where(
                    RuntimeJobRecord.id == claim.job_id,
                    RuntimeJobRecord.run_attempt_id == claim.run_attempt_id,
                    RuntimeJobRecord.lease_owner == worker_id,
                    RuntimeJobRecord.lease_epoch == claim.lease_epoch,
                    RuntimeJobRecord.status.not_in(TERMINAL_JOB_STATUSES),
                )
                .values(**values)
            )
            return affected_row_count(changed) == 1

    def encode_cursor(self, job_id: str, attempt_id: str, sequence: int) -> str:
        payload = {
            "runtime_job_id": job_id,
            "run_attempt_id": attempt_id,
            "last_applied_sequence": sequence,
            "scope_fingerprint": hashlib.sha256(self.scope_id.encode("utf-8")).hexdigest()[:20],
            "version": 1,
        }
        body = base64.urlsafe_b64encode(_canonical(payload)).rstrip(b"=")
        signature = hmac.new(self._cursor_key, body, hashlib.sha256).digest()
        return f"{body.decode()}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"

    def decode_cursor(self, cursor: str) -> dict[str, Any]:
        try:
            body_text, signature_text = cursor.split(".", 1)
            body = body_text.encode("ascii")
            signature = base64.urlsafe_b64decode(signature_text + "=" * (-len(signature_text) % 4))
            expected = hmac.new(self._cursor_key, body, hashlib.sha256).digest()
            if not hmac.compare_digest(signature, expected):
                raise RuntimeCursorInvalid("Runtime Cursor签名无效")
            decoded = base64.urlsafe_b64decode(body_text + "=" * (-len(body_text) % 4))
            payload = json.loads(decoded)
        except RuntimeCursorInvalid:
            raise
        except Exception as error:
            raise RuntimeCursorInvalid("Runtime Cursor格式无效") from error
        expected_scope = hashlib.sha256(self.scope_id.encode("utf-8")).hexdigest()[:20]
        if payload.get("version") != 1 or payload.get("scope_fingerprint") != expected_scope:
            raise RuntimeCursorInvalid("Runtime Cursor版本或Scope无效")
        return payload

    def _job_view(self, value: RuntimeJobRecord) -> dict[str, Any]:
        return {
            "id": value.id,
            "product_run_id": value.product_run_id,
            "run_attempt_id": value.run_attempt_id,
            "endpoint_key": value.endpoint_key,
            "workflow_definition_id": value.workflow_definition_id,
            "workflow_version": value.workflow_version,
            "status": value.status,
            "recoverability": value.recoverability,
            "checkpoint_id": value.checkpoint_id,
            "lease_owner": value.lease_owner,
            "lease_epoch": value.lease_epoch,
            "lease_expires_at": _iso(value.lease_expires_at),
            "heartbeat_at": _iso(value.heartbeat_at),
            "last_event_sequence": value.last_event_sequence,
            "earliest_retained_sequence": value.earliest_retained_sequence,
            "external_dispatch_state": value.external_dispatch_state,
            "failure_code": value.failure_code,
            "failure_summary": value.failure_summary,
            "created_at": _iso(value.created_at),
            "updated_at": _iso(value.updated_at),
            "finished_at": _iso(value.finished_at),
            "cursor": self.encode_cursor(value.id, value.run_attempt_id, value.last_event_sequence),
        }

    def _event_view(self, value: RuntimeEventRecord) -> dict[str, Any]:
        return {
            "id": value.id,
            "runtime_job_id": value.runtime_job_id,
            "run_attempt_id": value.run_attempt_id,
            "sequence": value.sequence,
            "event_type": value.agui_event_type,
            "payload": value.public_payload_json,
            "payload_hash": value.payload_hash,
            "is_terminal": value.is_terminal,
            "size_bytes": value.size_bytes,
            "created_at": _iso(value.created_at),
            "cursor": self.encode_cursor(value.runtime_job_id, value.run_attempt_id, value.sequence),
        }
