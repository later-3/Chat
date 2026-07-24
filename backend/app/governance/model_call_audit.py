"""Durable, payload-safe observability for governed Provider calls."""

from __future__ import annotations

import hashlib
import logging
from typing import Any, Mapping
from uuid import uuid4

from ..observability.context import bind_context
from ..product_sessions.database import ProductDatabase, utc_now
from .errors import GovernanceValidationError
from .models import (
    AuthorizationConsumptionRecord,
    ModelCallAttemptRecord,
    ModelCallTransportEventRecord,
)

logger = logging.getLogger(__name__)

_STAGES = {"provider.dispatch", "provider.receive", "provider.decode"}
_STATUSES = {"in_progress", "completed", "failed"}
_DETAIL_KEYS = {
    "content_type",
    "empty",
    "http_status",
    "milestone",
    "protocol",
    "provider_request_id",
    "provider_response_id",
    "response_bytes",
    "transport",
    "usage",
}


def _safe_usage(value: object) -> dict[str, int | float]:
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, int | float] = {}
    for key, item in value.items():
        if not isinstance(key, str) or len(key) > 80:
            continue
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            continue
        result[key] = item
    return result


def _safe_details(value: Mapping[str, Any]) -> dict[str, Any]:
    """Allow only bounded transport facts; never accept arbitrary Provider data."""

    result: dict[str, Any] = {}
    for key in _DETAIL_KEYS:
        item = value.get(key)
        if item is None:
            continue
        if key == "usage":
            result[key] = _safe_usage(item)
        elif key in {"http_status", "response_bytes"}:
            if isinstance(item, int) and not isinstance(item, bool) and item >= 0:
                result[key] = item
        elif key == "empty":
            if isinstance(item, bool):
                result[key] = item
        elif isinstance(item, str):
            result[key] = item[:240]
    return result


class ModelCallAuditService:
    """Own transport evidence and decoded-output disposition for model attempts."""

    def __init__(self, database: ProductDatabase) -> None:
        self.database = database

    async def record_transport_event(
        self,
        *,
        attempt_id: str,
        stage: str,
        status: str,
        details: Mapping[str, Any],
    ) -> ModelCallTransportEventRecord:
        if stage not in _STAGES or status not in _STATUSES:
            raise GovernanceValidationError("ModelCall Transport事件类型无效")
        safe = _safe_details(details)
        occurred_at = utc_now()
        async with self.database.sessions.begin() as transaction:
            attempt = await transaction.get(ModelCallAttemptRecord, attempt_id)
            if attempt is None:
                raise GovernanceValidationError("ModelCall Attempt不存在")
            attempt.transport_event_sequence += 1
            event = ModelCallTransportEventRecord(
                id=str(uuid4()),
                model_call_attempt_id=attempt.id,
                sequence=attempt.transport_event_sequence,
                stage=stage,
                status=status,
                details_json=safe,
                created_at=occurred_at,
            )
            transaction.add(event)
            if stage == "provider.dispatch" and status == "completed":
                if isinstance(safe.get("http_status"), int):
                    attempt.http_status = int(safe["http_status"])
                if safe.get("provider_request_id"):
                    attempt.provider_request_id = str(safe["provider_request_id"])
            if stage == "provider.receive" and status == "completed":
                attempt.first_byte_at = attempt.first_byte_at or occurred_at
                attempt.response_metadata_json = {
                    **dict(attempt.response_metadata_json or {}),
                    **{
                        key: safe[key]
                        for key in ("content_type", "transport", "response_bytes", "empty")
                        if key in safe
                    },
                }
            if stage == "provider.decode" and status == "completed":
                if safe.get("provider_response_id"):
                    attempt.provider_response_id = str(safe["provider_response_id"])
                if isinstance(safe.get("usage"), Mapping):
                    attempt.usage_json = dict(safe["usage"])
                attempt.response_metadata_json = {
                    **dict(attempt.response_metadata_json or {}),
                    **{key: safe[key] for key in ("protocol", "empty") if key in safe},
                }
        with bind_context(
            product_run_id=attempt.run_id,
            attempt_id=attempt.run_attempt_id,
            execution_request_id=attempt.model_call_draft_revision_id,
        ):
            logger.info(
                "model_call_transport_event attempt_id=%s sequence=%d stage=%s status=%s",
                attempt.id,
                event.sequence,
                stage,
                status,
            )
        return event

    async def finish_attempt(
        self,
        *,
        attempt_id: str,
        status: str,
        failure_code: str | None = None,
        output_text: str | None = None,
    ) -> None:
        async with self.database.sessions.begin() as transaction:
            attempt = await transaction.get(ModelCallAttemptRecord, attempt_id)
            if attempt is None:
                raise GovernanceValidationError("ModelCall Attempt不存在")
            consumption = await transaction.get(
                AuthorizationConsumptionRecord,
                attempt.authorization_consumption_id,
            )
            attempt.status = status
            attempt.failure_code = failure_code
            attempt.finished_at = utc_now()
            if output_text is not None:
                attempt.output_text = output_text
                attempt.output_text_sha256 = hashlib.sha256(output_text.encode("utf-8")).hexdigest()
                attempt.output_disposition = "candidate"
                attempt.output_disposition_reason = "Provider解码文本等待Workflow节点处理"
            if consumption is not None:
                consumption.status = status
                consumption.error_code = failure_code
                consumption.finished_at = utc_now()
        with bind_context(
            product_run_id=attempt.run_id,
            attempt_id=attempt.run_attempt_id,
            execution_request_id=attempt.model_call_draft_revision_id,
        ):
            logger.info(
                "model_call_attempt_finished model_call_attempt_id=%s status=%s failure_code=%s",
                attempt.id,
                status,
                failure_code,
            )

    async def record_output_disposition(
        self,
        *,
        attempt_id: str,
        disposition: str,
        reason: str,
    ) -> None:
        if not disposition or len(disposition) > 64:
            raise GovernanceValidationError("ModelCall输出处理状态无效")
        async with self.database.sessions.begin() as transaction:
            attempt = await transaction.get(ModelCallAttemptRecord, attempt_id)
            if attempt is None:
                raise GovernanceValidationError("ModelCall Attempt不存在")
            if attempt.output_text is None:
                raise GovernanceValidationError("ModelCall Attempt没有可处理的解码输出")
            attempt.output_disposition = disposition
            attempt.output_disposition_reason = reason[:240]
        with bind_context(
            product_run_id=attempt.run_id,
            attempt_id=attempt.run_attempt_id,
            execution_request_id=attempt.model_call_draft_revision_id,
        ):
            logger.info(
                "model_call_output_disposition attempt_id=%s disposition=%s",
                attempt.id,
                disposition,
            )
