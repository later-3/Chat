"""Outbox projection handler for Product Harness facts."""

from __future__ import annotations

import logging

from ..governance.outbox import ClaimedOutboxEvent, OutboxDispatchError, OutboxEventHandler


logger = logging.getLogger(__name__)


class ProductOutboxRouter:
    """Route durable runtime and Harness events without sharing domain state."""

    def __init__(self, runtime_handler: OutboxEventHandler | None) -> None:
        self.runtime_handler = runtime_handler

    async def __call__(self, event: ClaimedOutboxEvent) -> None:
        if event.event_type == "runtime.resume_requested":
            if self.runtime_handler is None:
                raise OutboxDispatchError(
                    "当前部署角色没有Runtime Resume处理器",
                    code="runtime_resume_unavailable",
                )
            await self.runtime_handler(event)
            return
        if event.event_type.startswith("harness."):
            # Product queries currently read authoritative relational facts, so
            # there is no external index to update. Consuming the event is the
            # explicit projection boundary; a future search adapter can replace
            # this branch without changing domain transactions.
            logger.info(
                "harness_outbox_projected event_id=%s event_type=%s aggregate=%s:%s",
                event.id,
                event.event_type,
                event.aggregate_kind,
                event.aggregate_id,
            )
            return
        raise OutboxDispatchError(
            f"未注册Outbox事件类型: {event.event_type}",
            code="outbox_event_unsupported",
        )
