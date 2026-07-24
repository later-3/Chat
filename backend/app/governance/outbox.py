"""Leased transactional-outbox worker for governance side effects."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import or_, select, update

from ..observability.context import bind_context
from ..observability.metrics import metrics
from ..observability.tracing import tracer
from ..product_sessions.database import ProductDatabase, affected_row_count, utc_now
from .models import GovernanceOutboxRecord

logger = logging.getLogger(__name__)


class OutboxDispatchError(RuntimeError):
    """A retryable outbox handler failure with a stable public error code."""

    def __init__(self, message: str, *, code: str = "outbox_dispatch_failed") -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class ClaimedOutboxEvent:
    id: str
    aggregate_kind: str
    aggregate_id: str
    event_type: str
    payload: dict
    dedupe_key: str
    attempt_count: int


OutboxEventHandler = Callable[[ClaimedOutboxEvent], Awaitable[None]]


class GovernanceOutboxWorker:
    """Claim, dispatch and settle outbox rows with an expiring database lease.

    Handlers must be idempotent by ``dedupe_key``.  The worker never holds a
    database transaction while calling MAF, a Provider or another external
    runtime.
    """

    def __init__(
        self,
        database: ProductDatabase,
        *,
        worker_id: str,
        handler: OutboxEventHandler,
        lease_seconds: int = 30,
        max_attempts: int = 8,
    ) -> None:
        if lease_seconds < 1:
            raise ValueError("Outbox lease_seconds必须大于0")
        if max_attempts < 1:
            raise ValueError("Outbox max_attempts必须大于0")
        self.database = database
        self.worker_id = worker_id
        self.handler = handler
        self.lease_seconds = lease_seconds
        self.max_attempts = max_attempts

    async def claim_one(self) -> ClaimedOutboxEvent | None:
        now = utc_now()
        lease_until = now + timedelta(seconds=self.lease_seconds)
        async with self.database.sessions.begin() as transaction:
            candidate = await transaction.scalar(
                select(GovernanceOutboxRecord)
                .where(
                    GovernanceOutboxRecord.available_at <= now,
                    or_(
                        GovernanceOutboxRecord.status == "pending",
                        (
                            (GovernanceOutboxRecord.status == "processing")
                            & (GovernanceOutboxRecord.locked_until < now)
                        ),
                    ),
                )
                .order_by(GovernanceOutboxRecord.created_at, GovernanceOutboxRecord.id)
                .limit(1)
            )
            if candidate is None:
                return None
            claimed = await transaction.execute(
                update(GovernanceOutboxRecord)
                .where(
                    GovernanceOutboxRecord.id == candidate.id,
                    or_(
                        GovernanceOutboxRecord.status == "pending",
                        (
                            (GovernanceOutboxRecord.status == "processing")
                            & (GovernanceOutboxRecord.locked_until < now)
                        ),
                    ),
                )
                .values(
                    status="processing",
                    locked_by=self.worker_id,
                    locked_until=lease_until,
                    attempt_count=GovernanceOutboxRecord.attempt_count + 1,
                )
            )
            if affected_row_count(claimed) != 1:
                return None
            await transaction.refresh(candidate)
            return ClaimedOutboxEvent(
                id=candidate.id,
                aggregate_kind=candidate.aggregate_kind,
                aggregate_id=candidate.aggregate_id,
                event_type=candidate.event_type,
                payload=dict(candidate.payload_json),
                dedupe_key=candidate.dedupe_key,
                attempt_count=candidate.attempt_count,
            )

    async def run_once(self) -> bool:
        event = await self.claim_one()
        if event is None:
            return False
        started = time.perf_counter()
        metrics.increment("outbox.events.claimed")
        with bind_context(
            worker_id=self.worker_id,
            execution_request_id=event.aggregate_id,
        ):
            with tracer().start_as_current_span(
                "outbox.dispatch",
                attributes={
                    "outbox.event.id": event.id,
                    "outbox.event.type": event.event_type,
                    "outbox.attempt": event.attempt_count,
                },
            ) as span:
                try:
                    return await self._dispatch_event(event)
                except Exception as error:
                    span.set_attribute("error.type", type(error).__name__)
                    metrics.increment("outbox.events.errors")
                    raise
                finally:
                    metrics.observe(
                        "outbox.dispatch.duration_seconds",
                        time.perf_counter() - started,
                    )

    async def _dispatch_event(self, event: ClaimedOutboxEvent) -> bool:
        try:
            await self.handler(event)
        except asyncio.CancelledError:
            await self._release(event, code="worker_cancelled", immediate=True)
            raise
        except Exception as error:
            code = str(getattr(error, "code", "outbox_dispatch_failed"))[:100]
            await self._release(event, code=code, immediate=False)
            metrics.increment("outbox.events.failed")
            logger.exception(
                "governance_outbox_failed event_id=%s event_type=%s attempt=%d code=%s",
                event.id,
                event.event_type,
                event.attempt_count,
                code,
            )
            return True
        await self._publish(event)
        metrics.increment("outbox.events.published")
        logger.info(
            "governance_outbox_published event_id=%s event_type=%s attempt=%d",
            event.id,
            event.event_type,
            event.attempt_count,
        )
        return True

    async def drain(self, *, limit: int = 100) -> int:
        processed = 0
        while processed < limit and await self.run_once():
            processed += 1
        return processed

    async def _publish(self, event: ClaimedOutboxEvent) -> None:
        async with self.database.sessions.begin() as transaction:
            settled = await transaction.execute(
                update(GovernanceOutboxRecord)
                .where(
                    GovernanceOutboxRecord.id == event.id,
                    GovernanceOutboxRecord.status == "processing",
                    GovernanceOutboxRecord.locked_by == self.worker_id,
                )
                .values(
                    status="published",
                    locked_by=None,
                    locked_until=None,
                    last_error_code=None,
                    published_at=utc_now(),
                )
            )
            if affected_row_count(settled) != 1:
                raise OutboxDispatchError("Outbox Lease已失效", code="outbox_lease_lost")

    async def _release(
        self,
        event: ClaimedOutboxEvent,
        *,
        code: str,
        immediate: bool,
    ) -> None:
        dead_letter = event.attempt_count >= self.max_attempts
        delay_seconds = 0 if immediate else min(300, 2 ** min(event.attempt_count, 8))
        async with self.database.sessions.begin() as transaction:
            await transaction.execute(
                update(GovernanceOutboxRecord)
                .where(
                    GovernanceOutboxRecord.id == event.id,
                    GovernanceOutboxRecord.status == "processing",
                    GovernanceOutboxRecord.locked_by == self.worker_id,
                )
                .values(
                    status="dead_letter" if dead_letter else "pending",
                    available_at=utc_now() + timedelta(seconds=delay_seconds),
                    locked_by=None,
                    locked_until=None,
                    last_error_code=code,
                )
            )
