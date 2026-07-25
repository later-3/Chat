"""Application coordinator for exact, durable workspace side effects."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Callable, Mapping
from typing import Any
from uuid import uuid4

from sqlalchemy import func, select

from ..execution_workspaces.models import ExecutionWorkspaceRecord
from ..execution_workspaces.service import ExecutionWorkspaceService
from ..harness.contracts import content_hash
from ..product_sessions.database import ProductDatabase, ToolExecutionRecord, utc_now
from .contracts import (
    TOOL_DEFINITION_REVISION,
    PreparedToolOperation,
    ToolOperationError,
)
from .exact_edit import (
    apply_exact_edit,
    diff_preview,
    normalize_arguments,
    read_utf8,
    resolve_target,
    safe_file_hash,
    text_hash,
)
from .models import (
    ToolOperationAttemptRecord,
    ToolOperationReconciliationRecord,
    ToolOperationRecord,
)
from .projections import operation_view, prepared_operation

logger = logging.getLogger(__name__)

_TERMINAL_STATUSES = frozenset({"succeeded", "failed", "denied", "failed_not_applied", "manual"})


class ToolOperationService:
    """Own side-effect state transitions; filesystem code never owns Product transactions."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        workspaces: ExecutionWorkspaceService,
        fault_hook: Callable[[str, str], None] | None = None,
    ) -> None:
        self.database = database
        self._workspaces = workspaces
        self._fault_hook = fault_hook

    async def propose_exact_edit(
        self,
        *,
        tool_execution_id: str,
        provider_tool_call_id: str,
        arguments: Mapping[str, Any],
    ) -> PreparedToolOperation:
        """Preflight an exact edit and persist the immutable approval subject."""

        normalized = normalize_arguments(arguments)
        async with self.database.sessions() as transaction:
            execution = await transaction.get(ToolExecutionRecord, tool_execution_id)
            workspace = await transaction.scalar(
                select(ExecutionWorkspaceRecord).where(
                    ExecutionWorkspaceRecord.tool_execution_id == tool_execution_id
                )
            )
            if execution is None or workspace is None:
                raise ToolOperationError(
                    "写Tool缺少ToolExecution或Execution Workspace",
                    code="TOOL_OPERATION_OWNER_MISSING",
                )
            existing = await transaction.scalar(
                select(ToolOperationRecord).where(
                    ToolOperationRecord.tool_execution_id == tool_execution_id,
                    ToolOperationRecord.provider_tool_call_id == provider_tool_call_id,
                )
            )
        if workspace.status not in {"ready", "running"}:
            raise ToolOperationError(
                "Execution Workspace当前不可写",
                code="TOOL_OPERATION_WORKSPACE_UNAVAILABLE",
            )
        if existing is not None:
            if dict(existing.arguments_json or {}) != normalized:
                raise ToolOperationError(
                    "同一Tool Call ID携带了不同参数",
                    code="TOOL_OPERATION_ARGUMENT_CONFLICT",
                )
            return prepared_operation(existing)

        root = await self._workspaces.private_path(workspace.id)
        target = resolve_target(root, normalized["path"])
        preimage = await asyncio.to_thread(read_utf8, target)
        old_text = normalized["old_text"]
        if preimage.count(old_text) != 1:
            raise ToolOperationError(
                "edit的old_text必须在目标文件中恰好出现一次",
                code="TOOL_OPERATION_MATCH_COUNT_INVALID",
            )
        postimage = preimage.replace(old_text, normalized["new_text"], 1)
        preimage_hash = text_hash(preimage)
        postimage_hash = text_hash(postimage)
        arguments_hash = content_hash(normalized)
        operation_hash = content_hash(
            {
                "tool_execution_id": tool_execution_id,
                "provider_tool_call_id": provider_tool_call_id,
                "workspace_id": workspace.id,
                "repository_snapshot_id": workspace.repository_snapshot_id,
                "tool_definition_revision": TOOL_DEFINITION_REVISION,
                "arguments_hash": arguments_hash,
                "preimage_hash": preimage_hash,
                "postimage_hash": postimage_hash,
            }
        )
        diff = diff_preview(
            normalized["path"],
            preimage,
            postimage,
        )
        operation_id = str(uuid4())
        async with self.database.sessions.begin() as transaction:
            ordinal = (
                int(
                    await transaction.scalar(
                        select(func.max(ToolOperationRecord.operation_ordinal)).where(
                            ToolOperationRecord.tool_execution_id == tool_execution_id
                        )
                    )
                    or 0
                )
                + 1
            )
            value = ToolOperationRecord(
                id=operation_id,
                scope_id=workspace.scope_id,
                session_id=execution.session_id,
                product_run_id=execution.run_id,
                run_attempt_id=str(execution.run_attempt_id),
                runtime_job_id=str(execution.runtime_job_id),
                tool_execution_id=tool_execution_id,
                workspace_id=workspace.id,
                provider_tool_call_id=provider_tool_call_id,
                tool_name="edit",
                tool_definition_revision=TOOL_DEFINITION_REVISION,
                operation_ordinal=ordinal,
                operation_kind="exact_text_edit",
                side_effect_class="workspace_write",
                arguments_json=normalized,
                arguments_hash=arguments_hash,
                operation_hash=operation_hash,
                idempotency_key=f"tool-operation:{operation_hash}",
                target_path=normalized["path"],
                expected_preimage_hash=preimage_hash,
                expected_postimage_hash=postimage_hash,
                diff_preview=diff,
                status="proposed",
            )
            transaction.add(value)
        logger.info(
            "tool_operation_proposed operation_id=%s tool_execution_id=%s workspace_id=%s "
            "target_hash=%s operation_hash=%s",
            operation_id,
            tool_execution_id,
            workspace.id,
            hashlib.sha256(normalized["path"].encode()).hexdigest()[:12],
            operation_hash[:12],
        )
        return PreparedToolOperation(
            operation_id=operation_id,
            operation_hash=operation_hash,
            arguments_hash=arguments_hash,
            workspace_id=workspace.id,
            target_path=normalized["path"],
            expected_preimage_hash=preimage_hash,
            expected_postimage_hash=postimage_hash,
            diff_preview=diff,
            status="proposed",
        )

    async def mark_waiting_authorization(self, operation_id: str) -> None:
        await self._transition(
            operation_id,
            expected={"proposed", "waiting_authorization"},
            target="waiting_authorization",
        )

    async def authorize(self, operation_id: str, *, consumption_id: str) -> None:
        if not consumption_id:
            raise ToolOperationError(
                "写Tool批准缺少Authorization Consumption",
                code="TOOL_OPERATION_CONSUMPTION_REQUIRED",
            )
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolOperationRecord, operation_id)
            if value is None:
                raise ToolOperationError(
                    "Tool Operation不存在",
                    code="TOOL_OPERATION_NOT_FOUND",
                )
            if value.status not in {"proposed", "waiting_authorization", "authorized"}:
                raise ToolOperationError(
                    "Tool Operation当前不能授权",
                    code="TOOL_OPERATION_STATE_CONFLICT",
                )
            if value.status == "authorized":
                if value.authorization_consumption_id != consumption_id:
                    raise ToolOperationError(
                        "Tool Operation已经绑定其他授权消费",
                        code="TOOL_OPERATION_AUTHORIZATION_CONFLICT",
                    )
                return
            value.status = "authorized"
            value.authorization_consumption_id = consumption_id
            value.authorized_at = utc_now()
            value.row_version += 1
        logger.info("tool_operation_authorized operation_id=%s", operation_id)

    async def deny(self, operation_id: str) -> None:
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolOperationRecord, operation_id)
            if value is None:
                return
            if value.status in _TERMINAL_STATUSES:
                return
            if value.status not in {"proposed", "waiting_authorization"}:
                raise ToolOperationError(
                    "已经开始执行的Tool Operation不能改为拒绝",
                    code="TOOL_OPERATION_STATE_CONFLICT",
                )
            value.status = "denied"
            value.failure_code = "user_denied"
            value.finished_at = utc_now()
            value.row_version += 1

    async def cancel_pending_for_run(self, run_id: str, *, reason_code: str) -> int:
        """Deny exact edits that never crossed the filesystem dispatch boundary."""

        now = utc_now()
        async with self.database.sessions.begin() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(ToolOperationRecord).where(
                            ToolOperationRecord.product_run_id == run_id,
                            ToolOperationRecord.status.in_(
                                {"proposed", "waiting_authorization", "authorized"}
                            ),
                        )
                    )
                ).all()
            )
            for value in values:
                value.status = "denied"
                value.failure_code = reason_code[:100]
                value.finished_at = now
                value.row_version += 1
        if values:
            logger.info(
                "tool_operations_cancelled_before_dispatch run_id=%s count=%d reason_code=%s",
                run_id,
                len(values),
                reason_code,
            )
        return len(values)

    async def execute_exact_edit(
        self,
        *,
        tool_execution_id: str,
        provider_tool_call_id: str,
        arguments: Mapping[str, Any],
        worker_id: str,
        lease_epoch: int = 0,
    ) -> dict[str, Any]:
        """Execute exactly once or return an already committed result."""

        normalized = normalize_arguments(arguments)
        async with self.database.sessions.begin() as transaction:
            operation = await transaction.scalar(
                select(ToolOperationRecord).where(
                    ToolOperationRecord.tool_execution_id == tool_execution_id,
                    ToolOperationRecord.provider_tool_call_id == provider_tool_call_id,
                )
            )
            if operation is None:
                raise ToolOperationError(
                    "Tool Gateway没有找到已批准Operation",
                    code="TOOL_OPERATION_NOT_FOUND",
                )
            if dict(operation.arguments_json or {}) != normalized:
                raise ToolOperationError(
                    "Tool Gateway参数与已批准Operation不一致",
                    code="TOOL_OPERATION_ARGUMENT_CONFLICT",
                )
            if operation.status == "succeeded":
                return dict(operation.result_json or {})
            if operation.status in {"dispatching", "outcome_unknown", "reconciling"}:
                raise ToolOperationError(
                    "Tool Operation结果尚不确定，禁止重复执行",
                    code="TOOL_OPERATION_OUTCOME_UNKNOWN",
                )
            if operation.status != "authorized":
                raise ToolOperationError(
                    "Tool Operation尚未获得当前版本授权",
                    code="TOOL_OPERATION_NOT_AUTHORIZED",
                )
            if not operation.authorization_consumption_id:
                raise ToolOperationError(
                    "Tool Operation没有绑定一次性授权消费",
                    code="TOOL_OPERATION_CONSUMPTION_REQUIRED",
                )
            dispatch_epoch = operation.dispatch_epoch + 1
            attempt_number = (
                int(
                    await transaction.scalar(
                        select(func.max(ToolOperationAttemptRecord.attempt_number)).where(
                            ToolOperationAttemptRecord.operation_id == operation.id
                        )
                    )
                    or 0
                )
                + 1
            )
            attempt = ToolOperationAttemptRecord(
                id=str(uuid4()),
                operation_id=operation.id,
                attempt_number=attempt_number,
                worker_id=worker_id,
                lease_epoch=lease_epoch,
                dispatch_epoch=dispatch_epoch,
                status="dispatching",
                request_hash=operation.operation_hash,
                dispatch_started_at=utc_now(),
            )
            transaction.add(attempt)
            operation.status = "dispatching"
            operation.dispatch_epoch = dispatch_epoch
            operation.dispatch_started_at = attempt.dispatch_started_at
            operation.row_version += 1
            operation_id = operation.id
            workspace_id = operation.workspace_id
            expected_preimage_hash = operation.expected_preimage_hash
            expected_postimage_hash = operation.expected_postimage_hash
            target_path = operation.target_path
            attempt_id = attempt.id

        self._call_fault_hook("after_dispatch_persisted", operation_id)
        root = await self._workspaces.private_path(workspace_id)
        target = resolve_target(root, target_path)
        try:
            await asyncio.to_thread(
                apply_exact_edit,
                target,
                normalized,
                expected_preimage_hash,
                expected_postimage_hash,
            )
            self._call_fault_hook("after_replace", operation_id)
        except BaseException as error:
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            observed = await asyncio.to_thread(safe_file_hash, target)
            await self._mark_outcome_unknown(
                operation_id,
                attempt_id=attempt_id,
                observed_hash=observed,
                failure_code=str(getattr(error, "code", "tool_operation_dispatch_failed")),
            )
            raise

        result = {
            "operation_id": operation_id,
            "status": "succeeded",
            "tool": "edit",
            "workspace_id": workspace_id,
            "path": target_path,
            "preimage_hash": expected_preimage_hash,
            "postimage_hash": expected_postimage_hash,
            "changed": True,
        }
        result_hash = content_hash(result)
        async with self.database.sessions.begin() as transaction:
            operation = await transaction.get(ToolOperationRecord, operation_id)
            attempt = await transaction.get(ToolOperationAttemptRecord, attempt_id)
            if operation is None or attempt is None or operation.status != "dispatching":
                raise ToolOperationError(
                    "Tool Operation提交状态冲突",
                    code="TOOL_OPERATION_COMMIT_CONFLICT",
                )
            operation.status = "succeeded"
            operation.observed_hash = expected_postimage_hash
            operation.result_json = result
            operation.result_hash = result_hash
            operation.resolution_code = "dispatch_confirmed"
            operation.finished_at = utc_now()
            operation.row_version += 1
            attempt.status = "succeeded"
            attempt.result_hash = result_hash
            attempt.finished_at = operation.finished_at
        try:
            await self._workspaces.refresh_diff(workspace_id)
        except Exception as error:
            logger.warning(
                "tool_operation_diff_projection_failed operation_id=%s error_type=%s",
                operation_id,
                type(error).__name__,
            )
        logger.info(
            "tool_operation_succeeded operation_id=%s workspace_id=%s result_hash=%s",
            operation_id,
            workspace_id,
            result_hash[:12],
        )
        return result

    async def reconcile(self, operation_id: str, *, trigger: str) -> dict[str, Any]:
        """Settle one uncertain edit by comparing the actual file content Hash."""

        async with self.database.sessions.begin() as transaction:
            operation = await transaction.get(ToolOperationRecord, operation_id)
            if operation is None:
                raise ToolOperationError(
                    "Tool Operation不存在",
                    code="TOOL_OPERATION_NOT_FOUND",
                )
            if operation.status == "succeeded":
                return operation_view(operation)
            if operation.status not in {"dispatching", "outcome_unknown", "reconciling"}:
                raise ToolOperationError(
                    "Tool Operation当前不需要对账",
                    code="TOOL_OPERATION_RECONCILIATION_NOT_ALLOWED",
                )
            sequence = (
                int(
                    await transaction.scalar(
                        select(func.max(ToolOperationReconciliationRecord.sequence)).where(
                            ToolOperationReconciliationRecord.operation_id == operation_id
                        )
                    )
                    or 0
                )
                + 1
            )
            reconciliation = ToolOperationReconciliationRecord(
                id=str(uuid4()),
                operation_id=operation_id,
                sequence=sequence,
                trigger=trigger[:40],
                strategy="file_content_hash_v1",
                status="running",
                expected_preimage_hash=operation.expected_preimage_hash,
                expected_postimage_hash=operation.expected_postimage_hash,
            )
            transaction.add(reconciliation)
            operation.status = "reconciling"
            operation.row_version += 1
            workspace_id = operation.workspace_id
            target_path = operation.target_path
            preimage_hash = operation.expected_preimage_hash
            postimage_hash = operation.expected_postimage_hash
            reconciliation_id = reconciliation.id

        try:
            root = await self._workspaces.private_path(workspace_id)
            target = resolve_target(root, target_path, require_existing=False)
            observed = await asyncio.to_thread(safe_file_hash, target)
        except Exception as error:
            logger.warning(
                "tool_operation_reconciliation_observation_failed operation_id=%s error_type=%s",
                operation_id,
                type(error).__name__,
            )
            observed = None
        if observed == postimage_hash:
            status = "succeeded"
            resolution = "confirmed_succeeded"
        elif observed == preimage_hash:
            status = "failed_not_applied"
            resolution = "confirmed_not_applied"
        else:
            status = "manual"
            resolution = "manual_required"
        result = {
            "operation_id": operation_id,
            "status": status,
            "workspace_id": workspace_id,
            "path": target_path,
            "observed_hash": observed,
            "resolution_code": resolution,
        }
        result_hash = content_hash(result)
        async with self.database.sessions.begin() as transaction:
            operation = await transaction.get(ToolOperationRecord, operation_id)
            reconciliation = await transaction.get(
                ToolOperationReconciliationRecord,
                reconciliation_id,
            )
            if operation is None or reconciliation is None:
                raise ToolOperationError(
                    "Tool Operation对账引用丢失",
                    code="TOOL_OPERATION_RECONCILIATION_MISSING",
                )
            operation.status = status
            operation.observed_hash = observed
            operation.resolution_code = resolution
            operation.result_json = result
            operation.result_hash = result_hash
            operation.failure_code = None if status == "succeeded" else resolution
            operation.finished_at = utc_now()
            operation.row_version += 1
            reconciliation.status = "manual" if status == "manual" else "resolved"
            reconciliation.observed_hash = observed
            reconciliation.resolution_code = resolution
            reconciliation.finished_at = operation.finished_at
            attempt = await transaction.scalar(
                select(ToolOperationAttemptRecord)
                .where(ToolOperationAttemptRecord.operation_id == operation_id)
                .order_by(ToolOperationAttemptRecord.attempt_number.desc())
                .limit(1)
            )
            if attempt is not None and attempt.status in {"claimed", "dispatching", "outcome_unknown"}:
                attempt.status = "succeeded" if status == "succeeded" else "failed"
                attempt.result_hash = result_hash
                attempt.failure_code = None if status == "succeeded" else resolution
                attempt.finished_at = operation.finished_at
        logger.info(
            "tool_operation_reconciled operation_id=%s resolution=%s",
            operation_id,
            resolution,
        )
        return await self.get(operation_id)

    async def reconcile_orphans(self) -> int:
        async with self.database.sessions() as transaction:
            ids = list(
                (
                    await transaction.scalars(
                        select(ToolOperationRecord.id).where(
                            ToolOperationRecord.status.in_(("dispatching", "outcome_unknown"))
                        )
                    )
                ).all()
            )
        for operation_id in ids:
            await self.reconcile(operation_id, trigger="startup")
        return len(ids)

    async def get(self, operation_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            operation = await transaction.get(ToolOperationRecord, operation_id)
            if operation is None:
                raise ToolOperationError(
                    "Tool Operation不存在",
                    code="TOOL_OPERATION_NOT_FOUND",
                )
            attempts = list(
                (
                    await transaction.scalars(
                        select(ToolOperationAttemptRecord)
                        .where(ToolOperationAttemptRecord.operation_id == operation_id)
                        .order_by(ToolOperationAttemptRecord.attempt_number)
                    )
                ).all()
            )
            reconciliations = list(
                (
                    await transaction.scalars(
                        select(ToolOperationReconciliationRecord)
                        .where(ToolOperationReconciliationRecord.operation_id == operation_id)
                        .order_by(ToolOperationReconciliationRecord.sequence)
                    )
                ).all()
            )
            return operation_view(
                operation,
                attempts=attempts,
                reconciliations=reconciliations,
            )

    async def prepared(self, operation_id: str) -> PreparedToolOperation:
        """Restore the immutable operation binding needed by a pending HITL."""

        async with self.database.sessions() as transaction:
            operation = await transaction.get(ToolOperationRecord, operation_id)
            if operation is None:
                raise ToolOperationError(
                    "Tool Operation不存在",
                    code="TOOL_OPERATION_NOT_FOUND",
                )
            if operation.status not in {"proposed", "waiting_authorization"}:
                raise ToolOperationError(
                    "Tool Operation已经不再等待本次授权",
                    code="TOOL_OPERATION_STATE_CONFLICT",
                )
            return prepared_operation(operation)

    async def list_for_tool_execution(self, tool_execution_id: str) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(ToolOperationRecord)
                        .where(ToolOperationRecord.tool_execution_id == tool_execution_id)
                        .order_by(ToolOperationRecord.operation_ordinal)
                    )
                ).all()
            )
            operation_ids = [value.id for value in values]
            attempts = (
                list(
                    (
                        await transaction.scalars(
                            select(ToolOperationAttemptRecord)
                            .where(ToolOperationAttemptRecord.operation_id.in_(operation_ids))
                            .order_by(
                                ToolOperationAttemptRecord.operation_id,
                                ToolOperationAttemptRecord.attempt_number,
                            )
                        )
                    ).all()
                )
                if operation_ids
                else []
            )
            reconciliations = (
                list(
                    (
                        await transaction.scalars(
                            select(ToolOperationReconciliationRecord)
                            .where(ToolOperationReconciliationRecord.operation_id.in_(operation_ids))
                            .order_by(
                                ToolOperationReconciliationRecord.operation_id,
                                ToolOperationReconciliationRecord.sequence,
                            )
                        )
                    ).all()
                )
                if operation_ids
                else []
            )
        attempts_by_operation: dict[str, list[ToolOperationAttemptRecord]] = {}
        for attempt in attempts:
            attempts_by_operation.setdefault(attempt.operation_id, []).append(attempt)
        reconciliations_by_operation: dict[str, list[ToolOperationReconciliationRecord]] = {}
        for reconciliation in reconciliations:
            reconciliations_by_operation.setdefault(
                reconciliation.operation_id,
                [],
            ).append(reconciliation)
        return [
            operation_view(
                value,
                attempts=attempts_by_operation.get(value.id, []),
                reconciliations=reconciliations_by_operation.get(value.id, []),
            )
            for value in values
        ]

    async def _transition(
        self,
        operation_id: str,
        *,
        expected: set[str],
        target: str,
    ) -> None:
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolOperationRecord, operation_id)
            if value is None:
                raise ToolOperationError(
                    "Tool Operation不存在",
                    code="TOOL_OPERATION_NOT_FOUND",
                )
            if value.status not in expected:
                raise ToolOperationError(
                    f"Tool Operation不能从{value.status}进入{target}",
                    code="TOOL_OPERATION_STATE_CONFLICT",
                )
            if value.status != target:
                value.status = target
                value.row_version += 1

    async def _mark_outcome_unknown(
        self,
        operation_id: str,
        *,
        attempt_id: str,
        observed_hash: str | None,
        failure_code: str,
    ) -> None:
        async with self.database.sessions.begin() as transaction:
            operation = await transaction.get(ToolOperationRecord, operation_id)
            attempt = await transaction.get(ToolOperationAttemptRecord, attempt_id)
            if operation is not None and operation.status == "dispatching":
                operation.status = "outcome_unknown"
                operation.observed_hash = observed_hash
                operation.failure_code = failure_code[:100]
                operation.row_version += 1
            if attempt is not None and attempt.status == "dispatching":
                attempt.status = "outcome_unknown"
                attempt.failure_code = failure_code[:100]
                attempt.finished_at = utc_now()

    def _call_fault_hook(self, stage: str, operation_id: str) -> None:
        if self._fault_hook is not None:
            self._fault_hook(stage, operation_id)
