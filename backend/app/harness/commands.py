"""Shared command ledger writes for Product Harness application coordinators."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Callable, Mapping

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..governance.models import GovernanceOutboxRecord
from ..observability.context import bind_context
from .contracts import HarnessConflict
from .contracts import new_id as _uuid
from .models import HarnessCommandRecord, HarnessTraceRecord

logger = logging.getLogger(__name__)


class HarnessCommandRecorder:
    """Record idempotency, Trace and Outbox inside a caller-owned transaction.

    This collaborator deliberately cannot open or commit a transaction. The
    command Application Service must add the domain fact and call ``record``
    using the same ``AsyncSession`` so partial product state cannot escape.
    """

    def __init__(
        self,
        *,
        scope_id: str,
        principal_id: str,
        clock: Callable[[], datetime],
    ) -> None:
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock

    async def existing(
        self,
        transaction: AsyncSession,
        command_id: str,
        request_hash: str,
    ) -> dict[str, Any] | None:
        existing = await transaction.scalar(
            select(HarnessCommandRecord).where(
                HarnessCommandRecord.scope_id == self.scope_id,
                HarnessCommandRecord.command_id == command_id,
            )
        )
        if existing is None:
            return None
        if existing.request_hash != request_hash:
            raise HarnessConflict("相同command_id已绑定不同请求")
        return dict(existing.result_json)

    def record(
        self,
        transaction: AsyncSession,
        *,
        command_id: str,
        command_kind: str,
        request_hash: str,
        result: Mapping[str, Any],
        resource_kind: str,
        resource_id: str,
        event_type: str,
        trace_payload: Mapping[str, Any],
        decision_record_id: str | None = None,
    ) -> None:
        now = self._clock()
        transaction.add(
            HarnessCommandRecord(
                id=_uuid(),
                scope_id=self.scope_id,
                command_id=command_id,
                command_kind=command_kind,
                principal_id=self.principal_id,
                request_hash=request_hash,
                result_json=dict(result),
                decision_record_id=decision_record_id,
                created_at=now,
            )
        )
        transaction.add(
            HarnessTraceRecord(
                id=_uuid(),
                scope_id=self.scope_id,
                command_id=command_id,
                event_type=event_type,
                resource_kind=resource_kind,
                resource_id=resource_id,
                payload_json=dict(trace_payload),
                created_at=now,
            )
        )
        transaction.add(
            GovernanceOutboxRecord(
                id=_uuid(),
                aggregate_kind=resource_kind,
                aggregate_id=resource_id,
                event_type=event_type,
                payload_json={
                    "scope_id": self.scope_id,
                    "command_id": command_id,
                    **dict(trace_payload),
                },
                dedupe_key=f"harness:{self.scope_id}:{command_id}",
                status="pending",
                available_at=now,
                attempt_count=0,
                created_at=now,
            )
        )
        # The wording is intentional: the surrounding Application Service owns
        # commit/rollback, so this boundary may only claim that facts were staged.
        with bind_context(command_id=command_id, resource_id=resource_id):
            logger.info(
                "harness_command_staged command_kind=%s resource_kind=%s event_type=%s",
                command_kind,
                resource_kind,
                event_type,
            )
