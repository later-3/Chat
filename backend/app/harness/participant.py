"""Harness transition participant for use inside a caller-owned transaction.

The Application Service methods in ``service.py`` own their own transactions and
command idempotency.  Operations that must be atomic with another aggregate
(for example a ResultCommit that also advances an ActionItem) need a participant
that accepts the existing ``AsyncSession`` and performs only the state change,
validation and trace recording.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Awaitable, Callable, Mapping, Sequence

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..product_sessions.database import affected_row_count
from .commands import HarnessCommandRecorder
from .contracts import (
    ACTION_TRANSITIONS,
    WORK_TRANSITIONS,
    HarnessConflict,
    HarnessNotFound,
    HarnessValidationError,
    action_view,
    content_hash,
    normalized_text,
    work_view,
)
from .models import ActionItemRecord, PlanNodeRecord, WorkItemRecord

# Reserved legacy-projection shape written only by the Result Commit Gate
# (F02 D12).  Any evidence item touching these keys is treated as a gate
# reference and must pass the injected chain validator; without a validator
# the write fails closed so the public completion path cannot fabricate it.
_RESULT_COMMIT_PROJECTION_KEYS = frozenset({"result_commit_id", "claim_id"})

# Signature of the validator the Result Commit Gate injects.  It runs inside
# the caller's transaction before the subject row is mutated and raises on
# any broken chain link.
CompletionReferenceValidator = Callable[
    [AsyncSession, str, str, str, int, str, str | None, Mapping[str, Any]],
    Awaitable[None],
]


class HarnessTransitionParticipant:
    """Participant that mutates WorkItem/ActionItem inside a caller-owned session.

    This class deliberately does not open or commit transactions.  The caller
    must provide the ``AsyncSession`` and commit itself.  Command idempotency is
    also the caller's responsibility; this participant only records trace and
    command rows for the single state change.
    """

    def __init__(
        self,
        *,
        scope_id: str,
        principal_id: str,
        clock: Callable[[], datetime],
        command_recorder: HarnessCommandRecorder,
        completion_reference_validator: CompletionReferenceValidator | None = None,
    ) -> None:
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock
        self._recorder = command_recorder
        self._completion_reference_validator = completion_reference_validator

    async def _check_completion_projection(
        self,
        transaction: AsyncSession,
        *,
        subject_kind: str,
        subject_id: str,
        subject_status: str,
        subject_row_version: int,
        target_status: str,
        expected_row_version: int | None,
        decision_record_id: str | None,
        evidence: Sequence[Mapping[str, Any]],
    ) -> None:
        """Allow completion only through one gate-validated ResultCommit projection.

        Legacy completion evidence remains readable on existing records, but
        it is no longer an authorized write path.  Every new transition to
        ``completed`` must carry exactly one ResultCommit/Claim reference and
        pass the validator injected by ``ResultCommitCoordinator``.
        """
        if target_status != "completed":
            return
        if (
            len(evidence) != 1
            or not isinstance(evidence[0], Mapping)
            or set(evidence[0]) != _RESULT_COMMIT_PROJECTION_KEYS
        ):
            raise HarnessValidationError(
                "完成状态只能由Result Commit Gate写入唯一result_commit_id/claim_id引用投影"
            )
        if expected_row_version is None:
            raise HarnessValidationError("ResultCommit引用投影必须携带expected_row_version")
        if self._completion_reference_validator is None:
            raise HarnessValidationError("ResultCommit引用投影只能由Result Commit Gate写入")
        await self._completion_reference_validator(
            transaction,
            subject_kind,
            subject_id,
            subject_status,
            subject_row_version,
            target_status,
            decision_record_id,
            evidence[0],
        )

    async def transition_work_item(
        self,
        transaction: AsyncSession,
        *,
        work_item_id: str,
        command_id: str,
        request_hash: str,
        target_status: str,
        reason: str,
        evidence: Sequence[Mapping[str, Any]] = (),
        completion_waiver_reason: str | None = None,
        decision_record_id: str | None = None,
        expected_row_version: int | None = None,
    ) -> dict[str, Any]:
        """Transition a WorkItem inside the caller's session.

        The caller must have already verified command idempotency if needed.
        """
        reason = normalized_text(reason, field="状态变更原因")
        value = await transaction.get(WorkItemRecord, work_item_id)
        if value is None or value.scope_id != self.scope_id:
            raise HarnessNotFound("WorkItem不存在")
        if expected_row_version is not None and value.row_version != expected_row_version:
            raise HarnessConflict("WorkItem版本冲突")
        if target_status not in WORK_TRANSITIONS.get(value.status, set()):
            raise HarnessValidationError(f"WorkItem不能从{value.status}变为{target_status}")
        if value.status == "completed" and target_status == "in_progress" and not reason:
            raise HarnessValidationError("重新打开WorkItem必须提供原因")
        if target_status == "completed" and (completion_waiver_reason or "").strip():
            raise HarnessValidationError(
                "旧completion_waiver_reason不能继续写入完成事实，请使用Result Commit Gate"
            )
        await self._check_completion_projection(
            transaction,
            subject_kind="work_item",
            subject_id=value.id,
            subject_status=value.status,
            subject_row_version=value.row_version,
            target_status=target_status,
            expected_row_version=expected_row_version,
            decision_record_id=decision_record_id,
            evidence=evidence,
        )
        previous = value.status
        normalized_evidence = [dict(item) for item in evidence]
        waiver_reason = (completion_waiver_reason or "").strip() or None
        now = self._clock()
        if expected_row_version is None:
            value.status = target_status
            value.completion_evidence_json = normalized_evidence
            value.completion_waiver_reason = waiver_reason
            value.row_version += 1
            value.updated_at = now
        else:
            changed = await transaction.execute(
                update(WorkItemRecord)
                .where(
                    WorkItemRecord.id == value.id,
                    WorkItemRecord.scope_id == self.scope_id,
                    WorkItemRecord.status == previous,
                    WorkItemRecord.row_version == expected_row_version,
                )
                .values(
                    status=target_status,
                    completion_evidence_json=normalized_evidence,
                    completion_waiver_reason=waiver_reason,
                    row_version=expected_row_version + 1,
                    updated_at=now,
                )
                .execution_options(synchronize_session=False)
            )
            if affected_row_count(changed) != 1:
                raise HarnessConflict("WorkItem版本冲突")
            await transaction.refresh(value)
        result = work_view(value)
        self._recorder.record(
            transaction,
            command_id=command_id,
            command_kind="transition_work_item",
            request_hash=request_hash,
            result=result,
            resource_kind="work_item",
            resource_id=value.id,
            event_type="harness.work.transitioned",
            trace_payload={
                "from": previous,
                "to": target_status,
                "reason": reason,
                "evidence_count": len(evidence),
            },
            decision_record_id=decision_record_id,
        )
        return result

    async def transition_action_item(
        self,
        transaction: AsyncSession,
        *,
        action_item_id: str,
        command_id: str,
        request_hash: str,
        target_status: str,
        reason: str,
        evidence: Sequence[Mapping[str, Any]] = (),
        dependency_override_reason: str | None = None,
        decision_record_id: str | None = None,
        expected_row_version: int | None = None,
    ) -> dict[str, Any]:
        """Transition an ActionItem inside the caller's session.

        The caller must have already verified command idempotency if needed.
        """
        reason = normalized_text(reason, field="状态变更原因")
        value = await transaction.get(ActionItemRecord, action_item_id)
        if value is None or value.scope_id != self.scope_id:
            raise HarnessNotFound("ActionItem不存在")
        if expected_row_version is not None and value.row_version != expected_row_version:
            raise HarnessConflict("ActionItem版本冲突")
        if target_status not in ACTION_TRANSITIONS.get(value.status, set()):
            raise HarnessValidationError(f"ActionItem不能从{value.status}变为{target_status}")
        if target_status == "completed" and not evidence:
            raise HarnessValidationError("完成ActionItem必须提供Evidence")
        if target_status == "ready" and value.plan_node_id:
            node = await transaction.get(PlanNodeRecord, value.plan_node_id)
            dependencies = list(node.dependency_keys_json or []) if node else []
            if dependencies and node is not None:
                dependency_nodes = (
                    await transaction.scalars(
                        select(PlanNodeRecord).where(
                            PlanNodeRecord.plan_revision_id == node.plan_revision_id,
                            PlanNodeRecord.node_key.in_(tuple(dependencies)),
                        )
                    )
                ).all()
                dependency_ids = tuple(item.id for item in dependency_nodes)
                complete_ids: set[str] = set()
                if dependency_ids:
                    complete_ids = {
                        plan_node_id
                        for plan_node_id in (
                            await transaction.scalars(
                                select(ActionItemRecord.plan_node_id).where(
                                    ActionItemRecord.scope_id == self.scope_id,
                                    ActionItemRecord.plan_node_id.in_(dependency_ids),
                                    ActionItemRecord.status == "completed",
                                )
                            )
                        ).all()
                        if plan_node_id is not None
                    }
                unresolved = [item.node_key for item in dependency_nodes if item.id not in complete_ids]
                if unresolved and not dependency_override_reason:
                    raise HarnessValidationError(f"依赖未完成，不能进入ready: {sorted(unresolved)}")
                if unresolved and not decision_record_id:
                    raise HarnessValidationError("依赖override必须绑定Decision Record")
        await self._check_completion_projection(
            transaction,
            subject_kind="action_item",
            subject_id=value.id,
            subject_status=value.status,
            subject_row_version=value.row_version,
            target_status=target_status,
            expected_row_version=expected_row_version,
            decision_record_id=decision_record_id,
            evidence=evidence,
        )
        previous = value.status
        normalized_evidence = [dict(item) for item in evidence]
        now = self._clock()
        if expected_row_version is None:
            value.status = target_status
            value.evidence_json = normalized_evidence
            value.row_version += 1
            value.updated_at = now
        else:
            changed = await transaction.execute(
                update(ActionItemRecord)
                .where(
                    ActionItemRecord.id == value.id,
                    ActionItemRecord.scope_id == self.scope_id,
                    ActionItemRecord.status == previous,
                    ActionItemRecord.row_version == expected_row_version,
                )
                .values(
                    status=target_status,
                    evidence_json=normalized_evidence,
                    row_version=expected_row_version + 1,
                    updated_at=now,
                )
                .execution_options(synchronize_session=False)
            )
            if affected_row_count(changed) != 1:
                raise HarnessConflict("ActionItem版本冲突")
            await transaction.refresh(value)
        result = action_view(value)
        self._recorder.record(
            transaction,
            command_id=command_id,
            command_kind="transition_action_item",
            request_hash=request_hash,
            result=result,
            resource_kind="action_item",
            resource_id=value.id,
            event_type="harness.action.transitioned",
            trace_payload={
                "from": previous,
                "to": target_status,
                "reason": reason,
                "dependency_override_reason": (dependency_override_reason or "").strip() or None,
            },
            decision_record_id=decision_record_id,
        )
        return result

    def build_work_request_hash(
        self,
        *,
        work_item_id: str,
        expected_row_version: int,
        target_status: str,
        reason: str,
        evidence: Sequence[Mapping[str, Any]] = (),
        completion_waiver_reason: str | None = None,
    ) -> str:
        """Canonical hash for a WorkItem transition command."""
        request = {
            "work_item_id": work_item_id,
            "expected_row_version": expected_row_version,
            "target_status": target_status,
            "reason": normalized_text(reason, field="状态变更原因"),
            "evidence": list(evidence),
            "completion_waiver_reason": completion_waiver_reason,
        }
        return content_hash(request)

    def build_action_request_hash(
        self,
        *,
        action_item_id: str,
        expected_row_version: int,
        target_status: str,
        reason: str,
        evidence: Sequence[Mapping[str, Any]] = (),
        dependency_override_reason: str | None = None,
    ) -> str:
        """Canonical hash for an ActionItem transition command."""
        request = {
            "action_item_id": action_item_id,
            "expected_row_version": expected_row_version,
            "target_status": target_status,
            "reason": normalized_text(reason, field="状态变更原因"),
            "evidence": [dict(value) for value in evidence],
            "dependency_override_reason": (dependency_override_reason or "").strip() or None,
        }
        return content_hash(request)
