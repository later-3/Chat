"""Stable read snapshots exported by the current Work/Knowledge package.

The physical ``harness`` package still contains several approved logical state
owners.  APP-PROJECTION must not reach through that package into ORM tables, so
this query service is their explicit read boundary.  Each method reads one
module-local SQLite snapshot and never opens a write transaction.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Sequence

from sqlalchemy import or_, select

from ..product_sessions.database import ProductDatabase
from .contracts import action_view, iso_timestamp, memory_view, note_view, project_view, work_view
from .models import (
    AcceptedMemoryRecord,
    ActionItemRecord,
    HarnessTraceRecord,
    MemoryRevisionRecord,
    NoteRecord,
    NoteResourceLinkRecord,
    NoteRevisionRecord,
    PlanNodeRecord,
    ProductProjectRecord,
    TaskPlanRecord,
    TaskPlanRevisionRecord,
    WorkItemRecord,
)


class HarnessProjectionQueryService:
    """Publish coherent Harness snapshots for presentation composition.

    The returned dictionaries are application contracts, not ORM projections.
    Cross-owner consistency is represented later by a source revision vector;
    this service guarantees only that its own Work/Knowledge snapshot came from
    one read transaction.
    """

    def __init__(self, database: ProductDatabase, *, scope_id: str = "local-user") -> None:
        self.database = database
        self.scope_id = scope_id

    async def list_project_ids(
        self,
        *,
        statuses: Sequence[str] | None = None,
        limit: int = 100,
    ) -> list[str]:
        query = select(ProductProjectRecord.id).where(ProductProjectRecord.scope_id == self.scope_id)
        if statuses:
            query = query.where(ProductProjectRecord.status.in_(tuple(statuses)))
        query = query.order_by(ProductProjectRecord.updated_at.desc(), ProductProjectRecord.id).limit(
            min(max(limit, 1), 200)
        )
        async with self.database.sessions() as transaction:
            return list((await transaction.scalars(query)).all())

    async def project_snapshot(self, project_id: str) -> dict[str, Any] | None:
        async with self.database.sessions() as transaction:
            project = await transaction.get(ProductProjectRecord, project_id)
            if project is None or project.scope_id != self.scope_id:
                return None

            work_records = list(
                (
                    await transaction.scalars(
                        select(WorkItemRecord)
                        .where(
                            WorkItemRecord.scope_id == self.scope_id,
                            WorkItemRecord.project_id == project_id,
                        )
                        .order_by(WorkItemRecord.updated_at.desc(), WorkItemRecord.id)
                    )
                ).all()
            )
            work_ids = [value.id for value in work_records]

            plans: list[TaskPlanRecord] = []
            if work_ids:
                plans = list(
                    (
                        await transaction.scalars(
                            select(TaskPlanRecord).where(TaskPlanRecord.work_item_id.in_(work_ids))
                        )
                    ).all()
                )
            revision_ids = [value.current_revision_id for value in plans if value.current_revision_id]
            revisions = (
                list(
                    (
                        await transaction.scalars(
                            select(TaskPlanRevisionRecord).where(TaskPlanRevisionRecord.id.in_(revision_ids))
                        )
                    ).all()
                )
                if revision_ids
                else []
            )
            revision_by_id = {value.id: value for value in revisions}
            nodes = (
                list(
                    (
                        await transaction.scalars(
                            select(PlanNodeRecord)
                            .where(PlanNodeRecord.plan_revision_id.in_(revision_ids))
                            .order_by(PlanNodeRecord.plan_revision_id, PlanNodeRecord.ordinal)
                        )
                    ).all()
                )
                if revision_ids
                else []
            )
            nodes_by_revision: defaultdict[str, list[PlanNodeRecord]] = defaultdict(list)
            for node in nodes:
                nodes_by_revision[node.plan_revision_id].append(node)
            plan_by_work_id = {value.work_item_id: value for value in plans}

            action_filter = ActionItemRecord.project_id == project_id
            if work_ids:
                action_filter = or_(action_filter, ActionItemRecord.work_item_id.in_(work_ids))
            action_records = list(
                (
                    await transaction.scalars(
                        select(ActionItemRecord)
                        .where(ActionItemRecord.scope_id == self.scope_id, action_filter)
                        .order_by(ActionItemRecord.updated_at.desc(), ActionItemRecord.id)
                    )
                ).all()
            )

            note_link_filter = (NoteResourceLinkRecord.resource_kind == "project") & (
                NoteResourceLinkRecord.resource_id == project_id
            )
            if work_ids:
                note_link_filter = or_(
                    note_link_filter,
                    (NoteResourceLinkRecord.resource_kind == "work_item")
                    & NoteResourceLinkRecord.resource_id.in_(work_ids),
                )
            note_links = list(
                (await transaction.scalars(select(NoteResourceLinkRecord).where(note_link_filter))).all()
            )
            note_ids = sorted({value.note_id for value in note_links})
            note_records = (
                list(
                    (
                        await transaction.scalars(
                            select(NoteRecord)
                            .where(
                                NoteRecord.scope_id == self.scope_id,
                                NoteRecord.id.in_(note_ids),
                            )
                            .order_by(NoteRecord.updated_at.desc(), NoteRecord.id)
                        )
                    ).all()
                )
                if note_ids
                else []
            )
            note_revision_ids = [
                value.current_revision_id for value in note_records if value.current_revision_id
            ]
            note_revisions = (
                list(
                    (
                        await transaction.scalars(
                            select(NoteRevisionRecord).where(NoteRevisionRecord.id.in_(note_revision_ids))
                        )
                    ).all()
                )
                if note_revision_ids
                else []
            )
            note_revision_by_id = {value.id: value for value in note_revisions}

            memory_records = list(
                (
                    await transaction.scalars(
                        select(AcceptedMemoryRecord)
                        .where(
                            AcceptedMemoryRecord.scope_id == self.scope_id,
                            AcceptedMemoryRecord.scope_kind == "project",
                            AcceptedMemoryRecord.scope_ref_id == project_id,
                            AcceptedMemoryRecord.status == "accepted",
                        )
                        .order_by(AcceptedMemoryRecord.updated_at.desc(), AcceptedMemoryRecord.id)
                    )
                ).all()
            )
            memory_revision_ids = [
                value.current_revision_id for value in memory_records if value.current_revision_id
            ]
            memory_revisions = (
                list(
                    (
                        await transaction.scalars(
                            select(MemoryRevisionRecord).where(
                                MemoryRevisionRecord.id.in_(memory_revision_ids)
                            )
                        )
                    ).all()
                )
                if memory_revision_ids
                else []
            )
            memory_revision_by_id = {value.id: value for value in memory_revisions}

            resource_filters = [
                (HarnessTraceRecord.resource_kind == "project")
                & (HarnessTraceRecord.resource_id == project_id)
            ]
            if work_ids:
                resource_filters.append(
                    (HarnessTraceRecord.resource_kind == "work_item")
                    & HarnessTraceRecord.resource_id.in_(work_ids)
                )
            action_ids = [value.id for value in action_records]
            if action_ids:
                resource_filters.append(
                    (HarnessTraceRecord.resource_kind == "action_item")
                    & HarnessTraceRecord.resource_id.in_(action_ids)
                )
            if note_ids:
                resource_filters.append(
                    (HarnessTraceRecord.resource_kind == "note")
                    & HarnessTraceRecord.resource_id.in_(note_ids)
                )
            traces = list(
                (
                    await transaction.scalars(
                        select(HarnessTraceRecord)
                        .where(
                            HarnessTraceRecord.scope_id == self.scope_id,
                            or_(*resource_filters),
                        )
                        .order_by(HarnessTraceRecord.created_at.desc(), HarnessTraceRecord.id)
                        .limit(30)
                    )
                ).all()
            )

            work_details: list[dict[str, Any]] = []
            for work in work_records:
                plan = plan_by_work_id.get(work.id)
                revision = (
                    revision_by_id.get(plan.current_revision_id)
                    if plan is not None and plan.current_revision_id is not None
                    else None
                )
                plan_payload = None
                if plan is not None:
                    plan_payload = {
                        "id": plan.id,
                        "status": plan.status,
                        "row_version": plan.row_version,
                        "updated_at": iso_timestamp(plan.updated_at),
                        "revision": None
                        if revision is None
                        else {
                            "id": revision.id,
                            "revision": revision.revision,
                            "summary": revision.summary,
                            "status": revision.status,
                            "validation_contract": dict(revision.validation_contract_json or {}),
                            "created_at": iso_timestamp(revision.created_at),
                            "nodes": [
                                {
                                    "id": node.id,
                                    "key": node.node_key,
                                    "title": node.title,
                                    "objective": node.objective,
                                    "status": node.status,
                                    "assignee_kind": node.assignee_kind,
                                    "dependencies": list(node.dependency_keys_json or []),
                                    "validation": dict(node.validation_json or {}),
                                    "stop_condition": node.stop_condition,
                                    "ordinal": node.ordinal,
                                }
                                for node in nodes_by_revision.get(revision.id, [])
                            ],
                        },
                    }
                work_details.append({"work_item": work_view(work), "plan": plan_payload})

            return {
                "project": project_view(project),
                "work_details": work_details,
                "action_items": [action_view(value) for value in action_records],
                "notes": [
                    note_view(
                        value,
                        note_revision_by_id.get(value.current_revision_id)
                        if value.current_revision_id is not None
                        else None,
                    )
                    for value in note_records
                ],
                "accepted_memory": [
                    memory_view(
                        value,
                        memory_revision_by_id.get(value.current_revision_id)
                        if value.current_revision_id is not None
                        else None,
                    )
                    for value in memory_records
                ],
                "activity": [
                    {
                        "id": value.id,
                        "event_type": value.event_type,
                        "resource_kind": value.resource_kind,
                        "resource_id": value.resource_id,
                        "payload": dict(value.payload_json or {}),
                        "created_at": iso_timestamp(value.created_at),
                    }
                    for value in traces
                ],
            }

    async def independent_work_snapshot(self, *, limit: int = 100) -> dict[str, Any]:
        """Return Work and Action facts that intentionally have no Project."""

        async with self.database.sessions() as transaction:
            work_records = list(
                (
                    await transaction.scalars(
                        select(WorkItemRecord)
                        .where(
                            WorkItemRecord.scope_id == self.scope_id,
                            WorkItemRecord.project_id.is_(None),
                            WorkItemRecord.status.not_in(("archived", "cancelled")),
                        )
                        .order_by(WorkItemRecord.updated_at.desc(), WorkItemRecord.id)
                        .limit(min(max(limit, 1), 200))
                    )
                ).all()
            )
            work_ids = [value.id for value in work_records]
            action_filter = ActionItemRecord.project_id.is_(None) & (
                ActionItemRecord.work_item_id.is_(None)
                if not work_ids
                else or_(
                    ActionItemRecord.work_item_id.is_(None),
                    ActionItemRecord.work_item_id.in_(work_ids),
                )
            )
            action_records = list(
                (
                    await transaction.scalars(
                        select(ActionItemRecord)
                        .where(
                            ActionItemRecord.scope_id == self.scope_id,
                            action_filter,
                            ActionItemRecord.status.not_in(("completed", "cancelled", "skipped")),
                        )
                        .order_by(ActionItemRecord.updated_at.desc(), ActionItemRecord.id)
                        .limit(min(max(limit, 1), 300))
                    )
                ).all()
            )
            return {
                "work_items": [work_view(value) for value in work_records],
                "action_items": [action_view(value) for value in action_records],
            }
