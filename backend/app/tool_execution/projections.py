"""Read-only public projections for durable Tool Operation records."""

from __future__ import annotations

from typing import Any

from .contracts import PreparedToolOperation
from .models import (
    ToolOperationAttemptRecord,
    ToolOperationReconciliationRecord,
    ToolOperationRecord,
)


def prepared_operation(value: ToolOperationRecord) -> PreparedToolOperation:
    return PreparedToolOperation(
        operation_id=value.id,
        operation_hash=value.operation_hash,
        arguments_hash=value.arguments_hash,
        workspace_id=value.workspace_id,
        target_path=value.target_path,
        expected_preimage_hash=value.expected_preimage_hash,
        expected_postimage_hash=value.expected_postimage_hash,
        diff_preview=value.diff_preview,
        status=value.status,
    )


def operation_view(
    value: ToolOperationRecord,
    *,
    attempts: list[ToolOperationAttemptRecord] | None = None,
    reconciliations: list[ToolOperationReconciliationRecord] | None = None,
) -> dict[str, Any]:
    return {
        "id": value.id,
        "session_id": value.session_id,
        "product_run_id": value.product_run_id,
        "run_attempt_id": value.run_attempt_id,
        "runtime_job_id": value.runtime_job_id,
        "tool_execution_id": value.tool_execution_id,
        "workspace_id": value.workspace_id,
        "authorization_consumption_id": value.authorization_consumption_id,
        "provider_tool_call_id": value.provider_tool_call_id,
        "tool_name": value.tool_name,
        "tool_definition_revision": value.tool_definition_revision,
        "operation_ordinal": value.operation_ordinal,
        "operation_kind": value.operation_kind,
        "side_effect_class": value.side_effect_class,
        "arguments": dict(value.arguments_json or {}),
        "arguments_hash": value.arguments_hash,
        "operation_hash": value.operation_hash,
        "target_path": value.target_path,
        "expected_preimage_hash": value.expected_preimage_hash,
        "expected_postimage_hash": value.expected_postimage_hash,
        "diff_preview": value.diff_preview,
        "status": value.status,
        "dispatch_epoch": value.dispatch_epoch,
        "observed_hash": value.observed_hash,
        "result": dict(value.result_json or {}) if value.result_json else None,
        "result_hash": value.result_hash,
        "failure_code": value.failure_code,
        "resolution_code": value.resolution_code,
        "row_version": value.row_version,
        "created_at": value.created_at.isoformat(),
        "authorized_at": value.authorized_at.isoformat() if value.authorized_at else None,
        "dispatch_started_at": (value.dispatch_started_at.isoformat() if value.dispatch_started_at else None),
        "finished_at": value.finished_at.isoformat() if value.finished_at else None,
        "attempts": [attempt_view(attempt) for attempt in (attempts or [])],
        "reconciliations": [
            reconciliation_view(reconciliation) for reconciliation in (reconciliations or [])
        ],
    }


def attempt_view(value: ToolOperationAttemptRecord) -> dict[str, Any]:
    return {
        "id": value.id,
        "attempt_number": value.attempt_number,
        "worker_id": value.worker_id,
        "lease_epoch": value.lease_epoch,
        "dispatch_epoch": value.dispatch_epoch,
        "status": value.status,
        "request_hash": value.request_hash,
        "result_hash": value.result_hash,
        "failure_code": value.failure_code,
        "started_at": value.started_at.isoformat(),
        "dispatch_started_at": (value.dispatch_started_at.isoformat() if value.dispatch_started_at else None),
        "finished_at": value.finished_at.isoformat() if value.finished_at else None,
    }


def reconciliation_view(value: ToolOperationReconciliationRecord) -> dict[str, Any]:
    return {
        "id": value.id,
        "sequence": value.sequence,
        "trigger": value.trigger,
        "strategy": value.strategy,
        "status": value.status,
        "expected_preimage_hash": value.expected_preimage_hash,
        "expected_postimage_hash": value.expected_postimage_hash,
        "observed_hash": value.observed_hash,
        "resolution_code": value.resolution_code,
        "safe_detail": value.safe_detail,
        "started_at": value.started_at.isoformat(),
        "finished_at": value.finished_at.isoformat() if value.finished_at else None,
    }
