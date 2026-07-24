"""Read-only projections for execution governance.

Queries never create product facts or commit a caller-owned transaction. The
command service remains the only owner of governance state transitions.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select

from ..product_sessions.database import ProductDatabase, RunRecord
from .errors import GovernanceValidationError
from .models import (
    DecisionPointDefinitionRecord,
    DecisionSubjectRecord,
    ExecutionDraftRevisionRecord,
    GovernanceOutboxRecord,
    HumanDecisionRequestRecord,
    MafWorkflowCheckpointRecord,
    ModelCallAttemptRecord,
    ModelCallDraftRecord,
    ModelCallDraftRevisionRecord,
    ModelCallTransportEventRecord,
    PolicyEvaluationRecord,
    RunSpecRecord,
    RuntimeInterruptLinkRecord,
    TurnSummaryRecord,
)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


class RunGovernanceQueryService:
    """Build the designer-facing governance projection for one Product Run."""

    def __init__(self, database: ProductDatabase) -> None:
        self.database = database

    async def governance_for_run(self, run_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            run = await transaction.get(RunRecord, run_id)
            if run is None:
                raise GovernanceValidationError("Product Run不存在")
            draft = (
                await transaction.get(ExecutionDraftRevisionRecord, run.execution_draft_revision_id)
                if run.execution_draft_revision_id
                else None
            )
            spec = await transaction.get(RunSpecRecord, run.run_spec_id) if run.run_spec_id else None
            requests = list(
                (
                    await transaction.scalars(
                        select(HumanDecisionRequestRecord)
                        .where(HumanDecisionRequestRecord.run_id == run.id)
                        .order_by(HumanDecisionRequestRecord.created_at)
                    )
                ).all()
            )
            evaluations = list(
                (
                    await transaction.scalars(
                        select(PolicyEvaluationRecord)
                        .join(
                            DecisionSubjectRecord,
                            DecisionSubjectRecord.id == PolicyEvaluationRecord.subject_id,
                        )
                        .where(DecisionSubjectRecord.run_id == run.id)
                        .order_by(PolicyEvaluationRecord.evaluated_at)
                    )
                ).all()
            )
            evaluation_subject_ids = [value.subject_id for value in evaluations]
            evaluation_definition_ids = [value.decision_point_definition_id for value in evaluations]
            evaluation_subjects = (
                list(
                    (
                        await transaction.scalars(
                            select(DecisionSubjectRecord).where(
                                DecisionSubjectRecord.id.in_(evaluation_subject_ids)
                            )
                        )
                    ).all()
                )
                if evaluation_subject_ids
                else []
            )
            evaluation_definitions = (
                list(
                    (
                        await transaction.scalars(
                            select(DecisionPointDefinitionRecord).where(
                                DecisionPointDefinitionRecord.id.in_(evaluation_definition_ids)
                            )
                        )
                    ).all()
                )
                if evaluation_definition_ids
                else []
            )
            model_slots = list(
                (
                    await transaction.scalars(
                        select(ModelCallDraftRecord)
                        .where(ModelCallDraftRecord.run_id == run.id)
                        .order_by(ModelCallDraftRecord.call_ordinal)
                    )
                ).all()
            )
            slot_ids = [value.id for value in model_slots]
            model_revisions = (
                list(
                    (
                        await transaction.scalars(
                            select(ModelCallDraftRevisionRecord)
                            .where(ModelCallDraftRevisionRecord.model_call_draft_id.in_(slot_ids))
                            .order_by(
                                ModelCallDraftRevisionRecord.model_call_draft_id,
                                ModelCallDraftRevisionRecord.revision,
                            )
                        )
                    ).all()
                )
                if slot_ids
                else []
            )
            revision_ids = [value.id for value in model_revisions]
            model_attempts = (
                list(
                    (
                        await transaction.scalars(
                            select(ModelCallAttemptRecord)
                            .where(ModelCallAttemptRecord.model_call_draft_revision_id.in_(revision_ids))
                            .order_by(ModelCallAttemptRecord.started_at)
                        )
                    ).all()
                )
                if revision_ids
                else []
            )
            attempt_ids = [value.id for value in model_attempts]
            transport_events = (
                list(
                    (
                        await transaction.scalars(
                            select(ModelCallTransportEventRecord)
                            .where(ModelCallTransportEventRecord.model_call_attempt_id.in_(attempt_ids))
                            .order_by(
                                ModelCallTransportEventRecord.model_call_attempt_id,
                                ModelCallTransportEventRecord.sequence,
                            )
                        )
                    ).all()
                )
                if attempt_ids
                else []
            )
            turn_summary = await transaction.scalar(
                select(TurnSummaryRecord).where(TurnSummaryRecord.run_id == run.id)
            )
            interrupt_links = list(
                (
                    await transaction.scalars(
                        select(RuntimeInterruptLinkRecord)
                        .where(RuntimeInterruptLinkRecord.product_run_id == run.id)
                        .order_by(RuntimeInterruptLinkRecord.created_at)
                    )
                ).all()
            )
            checkpoints = list(
                (
                    await transaction.scalars(
                        select(MafWorkflowCheckpointRecord)
                        .where(MafWorkflowCheckpointRecord.product_run_id == run.id)
                        .order_by(MafWorkflowCheckpointRecord.created_at)
                    )
                ).all()
            )
            request_ids = [value.id for value in requests]
            outbox_events = (
                list(
                    (
                        await transaction.scalars(
                            select(GovernanceOutboxRecord)
                            .where(
                                GovernanceOutboxRecord.aggregate_kind == "human_decision_request",
                                GovernanceOutboxRecord.aggregate_id.in_(request_ids),
                            )
                            .order_by(GovernanceOutboxRecord.created_at)
                        )
                    ).all()
                )
                if request_ids
                else []
            )

        revisions_by_slot: dict[str, list[ModelCallDraftRevisionRecord]] = {}
        for value in model_revisions:
            revisions_by_slot.setdefault(value.model_call_draft_id, []).append(value)
        attempts_by_revision: dict[str, list[ModelCallAttemptRecord]] = {}
        for value in model_attempts:
            attempts_by_revision.setdefault(value.model_call_draft_revision_id, []).append(value)
        transport_events_by_attempt: dict[str, list[ModelCallTransportEventRecord]] = {}
        for value in transport_events:
            transport_events_by_attempt.setdefault(value.model_call_attempt_id, []).append(value)
        subjects_by_id = {value.id: value for value in evaluation_subjects}
        definitions_by_id = {value.id: value for value in evaluation_definitions}
        return {
            "run_id": run.id,
            "execution_draft": None
            if draft is None
            else {
                "id": draft.draft_id,
                "revision_id": draft.id,
                "revision": draft.revision,
                "status": draft.status,
                "draft_hash": draft.draft_hash,
                "execution_brief": draft.execution_brief_text,
                "payload": draft.payload_json,
            },
            "run_spec": None
            if spec is None
            else {
                "id": spec.id,
                "status": spec.status,
                "run_spec_hash": spec.run_spec_hash,
                "compiler_version": spec.compiler_version,
                "spec": spec.spec_json,
            },
            "turn_summary": None
            if turn_summary is None
            else {
                "id": turn_summary.id,
                "topic": turn_summary.topic,
                "summary": turn_summary.summary_json,
                "project_hint": turn_summary.project_hint,
                "status": turn_summary.extraction_status,
                "summary_hash": turn_summary.summary_hash,
                "source_model_call_revision_id": turn_summary.source_model_call_revision_id,
                "created_at": _iso(turn_summary.created_at),
            },
            "policy_evaluations": [
                {
                    "id": value.id,
                    "subject_id": value.subject_id,
                    "subject_kind": subjects_by_id[value.subject_id].subject_kind,
                    "workflow_node_id": subjects_by_id[value.subject_id].node_id,
                    "decision_point_key": definitions_by_id[value.decision_point_definition_id].key,
                    "applicability_status": value.applicability_status,
                    "floor_action": value.floor_action,
                    "preference_action": value.preference_action,
                    "final_action": value.final_action,
                    "result_status": value.result_status,
                    "reason_codes": value.reason_codes_json,
                    "evaluated_at": _iso(value.evaluated_at),
                }
                for value in evaluations
            ],
            "model_calls": [
                {
                    "id": slot.id,
                    "workflow_node_id": slot.workflow_node_id,
                    "call_ordinal": slot.call_ordinal,
                    "status": slot.status,
                    "current_revision_id": slot.current_revision_id,
                    "revisions": [
                        {
                            "id": revision.id,
                            "revision": revision.revision,
                            "status": revision.status,
                            "provider_id": revision.provider_id,
                            "model": revision.model,
                            "provider_body_sha256": revision.provider_body_sha256,
                            "binding_hash": revision.binding_hash,
                            "attempts": [
                                {
                                    "id": attempt.id,
                                    "attempt_number": attempt.attempt_number,
                                    "status": attempt.status,
                                    "failure_code": attempt.failure_code,
                                    "http_status": attempt.http_status,
                                    "provider_request_id": attempt.provider_request_id,
                                    "provider_response_id": attempt.provider_response_id,
                                    "usage": attempt.usage_json,
                                    "response_metadata": attempt.response_metadata_json,
                                    "output_text": attempt.output_text,
                                    "output_text_sha256": attempt.output_text_sha256,
                                    "output_disposition": attempt.output_disposition,
                                    "output_disposition_reason": attempt.output_disposition_reason,
                                    "started_at": _iso(attempt.started_at),
                                    "first_byte_at": _iso(attempt.first_byte_at),
                                    "finished_at": _iso(attempt.finished_at),
                                    "transport_events": [
                                        {
                                            "id": event.id,
                                            "sequence": event.sequence,
                                            "stage": event.stage,
                                            "status": event.status,
                                            "details": event.details_json,
                                            "created_at": _iso(event.created_at),
                                        }
                                        for event in transport_events_by_attempt.get(attempt.id, [])
                                    ],
                                }
                                for attempt in attempts_by_revision.get(revision.id, [])
                            ],
                        }
                        for revision in revisions_by_slot.get(slot.id, [])
                    ],
                }
                for slot in model_slots
            ],
            "decision_requests": [
                {
                    "id": value.id,
                    "decision_point_key": value.decision_point_key,
                    "request_hash": value.request_hash,
                    "title": value.title,
                    "reason_summary": value.reason_summary,
                    "visible_evidence": value.visible_evidence_json,
                    "consequence": value.consequence_json,
                    "status": value.status,
                    "row_version": value.row_version,
                    "created_at": _iso(value.created_at),
                }
                for value in requests
            ],
            "runtime_interrupts": [
                {
                    "id": value.id,
                    "decision_request_id": value.decision_request_id,
                    "checkpoint_id": value.maf_checkpoint_id,
                    "maf_request_id": value.maf_request_id,
                    "executor_id": value.maf_executor_id,
                    "status": value.status,
                    "resume_attempts": value.resume_attempts,
                    "last_error_code": value.last_error_code,
                    "created_at": _iso(value.created_at),
                    "updated_at": _iso(value.updated_at),
                }
                for value in interrupt_links
            ],
            "workflow_checkpoints": [
                {
                    "checkpoint_id": value.checkpoint_id,
                    "workflow_definition_id": value.workflow_definition_id,
                    "workflow_version": value.workflow_version,
                    "workflow_name": value.workflow_name,
                    "graph_signature_hash": value.graph_signature_hash,
                    "iteration_count": value.iteration_count,
                    "pending_request_count": len(value.pending_request_ids_json or ()),
                    "encoding_version": value.encoding_version,
                    "status": value.status,
                    "created_at": _iso(value.created_at),
                }
                for value in checkpoints
            ],
            "outbox_events": [
                {
                    "id": value.id,
                    "aggregate_id": value.aggregate_id,
                    "event_type": value.event_type,
                    "dedupe_key": value.dedupe_key,
                    "status": value.status,
                    "attempt_count": value.attempt_count,
                    "last_error_code": value.last_error_code,
                    "available_at": _iso(value.available_at),
                    "published_at": _iso(value.published_at),
                }
                for value in outbox_events
            ],
        }

    async def recent_turn_summaries(
        self,
        session_id: str,
        *,
        limit: int = 8,
    ) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(TurnSummaryRecord)
                        .where(TurnSummaryRecord.session_id == session_id)
                        .order_by(TurnSummaryRecord.created_at.desc())
                        .limit(max(1, min(limit, 20)))
                    )
                ).all()
            )
        return [
            {
                "id": value.id,
                "interaction_id": value.interaction_id,
                "run_id": value.run_id,
                "topic": value.topic,
                "summary": value.summary_json,
                "project_hint": value.project_hint,
                "status": value.extraction_status,
                "summary_hash": value.summary_hash,
                "created_at": _iso(value.created_at),
            }
            for value in values
        ]
