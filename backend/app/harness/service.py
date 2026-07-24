"""Application service for the Product Harness.

All durable writes are explicit commands.  A command is idempotent within a
scope, uses optimistic concurrency where it mutates an existing aggregate,
and commits its product fact, audit trace and Outbox notification in one local
database transaction.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Mapping, Sequence

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..product_sessions.database import ProductDatabase, RunRecord, utc_now
from ..product_sessions.service import DEFAULT_SCOPE_ID
from .commands import HarnessCommandRecorder
from .contracts import (
    ACTION_TRANSITIONS,
    MEMORY_KINDS,
    MEMORY_SCOPE_KINDS,
    MEMORY_TRANSITIONS,
    NOTE_KINDS,
    NOTE_TRANSITIONS,
    PROJECT_KINDS,
    PROJECT_TRANSITIONS,
    WORK_KINDS,
    WORK_PRIORITIES,
    WORK_TRANSITIONS,
    HarnessConflict,
    HarnessNotFound,
    HarnessValidationError,
    context_package_hash,
)
from .contracts import (
    action_view as _action_view,
)
from .contracts import (
    content_hash as _hash,
)
from .contracts import (
    iso_timestamp as _iso,
)
from .contracts import (
    memory_view as _memory_view,
)
from .contracts import (
    new_id as _uuid,
)
from .contracts import (
    normalized_text as _text,
)
from .contracts import (
    note_view as _note_view,
)
from .contracts import (
    project_view as _project_view,
)
from .contracts import (
    work_view as _work_view,
)
from .models import (
    AcceptedMemoryRecord,
    ActionItemRecord,
    ContextAdoptionRecord,
    ContextPackageRecord,
    MemoryCandidateRecord,
    MemoryRevisionRecord,
    MemorySourceLinkRecord,
    NoteRecord,
    NoteResourceLinkRecord,
    NoteRevisionRecord,
    PlanNodeRecord,
    ProductProjectRecord,
    ProjectWorkLinkRecord,
    ResourceSessionLinkRecord,
    TaskPlanRecord,
    TaskPlanRevisionRecord,
    WorkItemRecord,
)
from .queries import HarnessContextQueryService


class HarnessService:
    """Own Product Harness commands, queries and ContextPackage assembly."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        scope_id: str = DEFAULT_SCOPE_ID,
        principal_id: str = "local-user",
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.database = database
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock
        self.command_recorder = HarnessCommandRecorder(
            scope_id=scope_id,
            principal_id=principal_id,
            clock=clock,
        )
        self.context_queries = HarnessContextQueryService(
            database,
            scope_id=scope_id,
            resources=self,
        )

    async def initialize(self) -> None:
        """Schema lifecycle is owned by ProductDatabase/Alembic."""

    async def _existing_command(
        self,
        transaction: AsyncSession,
        command_id: str,
        request_hash: str,
    ) -> dict[str, Any] | None:
        return await self.command_recorder.existing(transaction, command_id, request_hash)

    def _record_command(
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
        self.command_recorder.record(
            transaction,
            command_id=command_id,
            command_kind=command_kind,
            request_hash=request_hash,
            result=result,
            resource_kind=resource_kind,
            resource_id=resource_id,
            event_type=event_type,
            trace_payload=trace_payload,
            decision_record_id=decision_record_id,
        )

    async def list_projects(
        self,
        *,
        statuses: Sequence[str] | None = None,
        kind: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        query = select(ProductProjectRecord).where(ProductProjectRecord.scope_id == self.scope_id)
        if statuses:
            query = query.where(ProductProjectRecord.status.in_(tuple(statuses)))
        if kind:
            query = query.where(ProductProjectRecord.kind == kind)
        query = query.order_by(ProductProjectRecord.updated_at.desc()).limit(min(max(limit, 1), 200))
        async with self.database.sessions() as transaction:
            return [_project_view(value) for value in (await transaction.scalars(query)).all()]

    async def get_project(self, project_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            value = await transaction.get(ProductProjectRecord, project_id)
            if value is None or value.scope_id != self.scope_id:
                raise HarnessNotFound("Project不存在")
            return _project_view(value)

    async def create_project(
        self,
        *,
        command_id: str,
        kind: str,
        title: str,
        goal: str,
        status: str = "proposed",
        session_id: str | None = None,
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        if kind not in PROJECT_KINDS:
            raise HarnessValidationError("Project kind无效")
        if status not in {"proposed", "active"}:
            raise HarnessValidationError("Project只能以proposed或active创建")
        payload = {
            "kind": kind,
            "title": _text(title, field="Project标题", max_length=180),
            "goal": _text(goal, field="Project目标"),
            "status": status,
            "session_id": session_id,
        }
        request_hash = _hash(payload)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            value = ProductProjectRecord(
                id=_uuid(),
                scope_id=self.scope_id,
                kind=kind,
                title=payload["title"],
                goal=payload["goal"],
                status=status,
                row_version=1,
                created_by=self.principal_id,
                created_at=self._clock(),
                updated_at=self._clock(),
            )
            transaction.add(value)
            if session_id:
                transaction.add(
                    ResourceSessionLinkRecord(
                        id=_uuid(),
                        resource_kind="project",
                        resource_id=value.id,
                        session_id=session_id,
                        reason="创建Project时关联的Product Session",
                        source_kind="explicit_user_command",
                    )
                )
            result = _project_view(value)
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="create_project",
                request_hash=request_hash,
                result=result,
                resource_kind="project",
                resource_id=value.id,
                event_type="harness.project.created",
                trace_payload={"status": status, "kind": kind},
                decision_record_id=decision_record_id,
            )
            return result

    async def transition_project(
        self,
        *,
        project_id: str,
        command_id: str,
        expected_row_version: int,
        target_status: str,
        reason: str,
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        reason = _text(reason, field="状态变更原因")
        request = {
            "project_id": project_id,
            "expected_row_version": expected_row_version,
            "target_status": target_status,
            "reason": reason,
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            value = await transaction.get(ProductProjectRecord, project_id)
            if value is None or value.scope_id != self.scope_id:
                raise HarnessNotFound("Project不存在")
            if value.row_version != expected_row_version:
                raise HarnessConflict("Project版本冲突")
            if target_status not in PROJECT_TRANSITIONS.get(value.status, set()):
                raise HarnessValidationError(f"Project不能从{value.status}变为{target_status}")
            if target_status == "completed":
                open_count = await transaction.scalar(
                    select(func.count())
                    .select_from(WorkItemRecord)
                    .where(
                        WorkItemRecord.project_id == project_id,
                        WorkItemRecord.status.not_in(("completed", "cancelled", "archived")),
                    )
                )
                if open_count:
                    raise HarnessValidationError("仍有未结束WorkItem，Project不能完成")
            previous = value.status
            value.status = target_status
            value.row_version += 1
            value.updated_at = self._clock()
            result = _project_view(value)
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="transition_project",
                request_hash=request_hash,
                result=result,
                resource_kind="project",
                resource_id=value.id,
                event_type="harness.project.transitioned",
                trace_payload={"from": previous, "to": target_status, "reason": reason},
                decision_record_id=decision_record_id,
            )
            return result

    async def list_work(
        self,
        *,
        project_id: str | None = None,
        statuses: Sequence[str] | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        query = select(WorkItemRecord).where(WorkItemRecord.scope_id == self.scope_id)
        if project_id is not None:
            query = query.where(WorkItemRecord.project_id == project_id)
        if statuses:
            query = query.where(WorkItemRecord.status.in_(tuple(statuses)))
        query = query.order_by(WorkItemRecord.updated_at.desc()).limit(min(max(limit, 1), 500))
        async with self.database.sessions() as transaction:
            return [_work_view(value) for value in (await transaction.scalars(query)).all()]

    async def create_work_item(
        self,
        *,
        command_id: str,
        kind: str,
        title: str,
        objective: str,
        project_id: str | None = None,
        parent_work_item_id: str | None = None,
        priority: str = "normal",
        status: str = "draft",
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        if kind not in WORK_KINDS:
            raise HarnessValidationError("WorkItem kind无效")
        if priority not in WORK_PRIORITIES:
            raise HarnessValidationError("WorkItem priority无效")
        if status not in {"draft", "planned", "ready"}:
            raise HarnessValidationError("WorkItem初始状态无效")
        payload = {
            "kind": kind,
            "title": _text(title, field="Work标题", max_length=200),
            "objective": _text(objective, field="Work目标"),
            "project_id": project_id,
            "parent_work_item_id": parent_work_item_id,
            "priority": priority,
            "status": status,
        }
        request_hash = _hash(payload)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            if project_id:
                project = await transaction.get(ProductProjectRecord, project_id)
                if project is None or project.scope_id != self.scope_id:
                    raise HarnessNotFound("关联Project不存在")
            if parent_work_item_id:
                parent = await transaction.get(WorkItemRecord, parent_work_item_id)
                if parent is None or parent.scope_id != self.scope_id:
                    raise HarnessNotFound("父WorkItem不存在")
                if project_id != parent.project_id:
                    raise HarnessValidationError("父子WorkItem必须属于同一Project")
            value = WorkItemRecord(
                id=_uuid(),
                scope_id=self.scope_id,
                project_id=project_id,
                parent_work_item_id=parent_work_item_id,
                kind=kind,
                title=payload["title"],
                objective=payload["objective"],
                status=status,
                priority=priority,
                completion_evidence_json=[],
                row_version=1,
                created_by=self.principal_id,
                created_at=self._clock(),
                updated_at=self._clock(),
            )
            transaction.add(value)
            if project_id:
                # These mappers deliberately do not expose ORM relationships:
                # the application service owns aggregate writes explicitly.
                # Flush the aggregate root before inserting an association row
                # so SQLite foreign-key enforcement cannot observe a child
                # before its parent.
                await transaction.flush()
                transaction.add(
                    ProjectWorkLinkRecord(
                        id=_uuid(),
                        project_id=project_id,
                        work_item_id=value.id,
                        relation="contains",
                        created_at=self._clock(),
                    )
                )
            result = _work_view(value)
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="create_work_item",
                request_hash=request_hash,
                result=result,
                resource_kind="work_item",
                resource_id=value.id,
                event_type="harness.work.created",
                trace_payload={"status": status, "kind": kind, "project_id": project_id},
                decision_record_id=decision_record_id,
            )
            return result

    async def transition_work_item(
        self,
        *,
        work_item_id: str,
        command_id: str,
        expected_row_version: int,
        target_status: str,
        reason: str,
        evidence: Sequence[Mapping[str, Any]] = (),
        completion_waiver_reason: str | None = None,
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        reason = _text(reason, field="状态变更原因")
        request = {
            "work_item_id": work_item_id,
            "expected_row_version": expected_row_version,
            "target_status": target_status,
            "reason": reason,
            "evidence": list(evidence),
            "completion_waiver_reason": completion_waiver_reason,
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            value = await transaction.get(WorkItemRecord, work_item_id)
            if value is None or value.scope_id != self.scope_id:
                raise HarnessNotFound("WorkItem不存在")
            if value.row_version != expected_row_version:
                raise HarnessConflict("WorkItem版本冲突")
            if target_status not in WORK_TRANSITIONS.get(value.status, set()):
                raise HarnessValidationError(f"WorkItem不能从{value.status}变为{target_status}")
            if value.status == "completed" and target_status == "in_progress" and not reason:
                raise HarnessValidationError("重新打开WorkItem必须提供原因")
            if target_status == "completed" and not evidence and not (completion_waiver_reason or "").strip():
                raise HarnessValidationError("完成WorkItem必须提供Evidence或明确豁免原因")
            previous = value.status
            value.status = target_status
            value.completion_evidence_json = [dict(item) for item in evidence]
            value.completion_waiver_reason = (completion_waiver_reason or "").strip() or None
            value.row_version += 1
            value.updated_at = self._clock()
            result = _work_view(value)
            self._record_command(
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

    async def create_plan_revision(
        self,
        *,
        command_id: str,
        work_item_id: str,
        expected_work_row_version: int,
        summary: str,
        nodes: Sequence[Mapping[str, Any]],
        validation_contract: Mapping[str, Any] | None = None,
        accept: bool = False,
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        if not nodes:
            raise HarnessValidationError("Plan至少需要一个节点")
        normalized_nodes: list[dict[str, Any]] = []
        keys: set[str] = set()
        for ordinal, raw in enumerate(nodes):
            key = _text(str(raw.get("key") or f"step-{ordinal + 1}"), field="Plan节点Key", max_length=80)
            if key in keys:
                raise HarnessValidationError("Plan节点Key不能重复")
            keys.add(key)
            normalized_nodes.append(
                {
                    "key": key,
                    "title": _text(str(raw.get("title") or ""), field="Plan节点标题", max_length=200),
                    "objective": _text(
                        str(raw.get("objective") or raw.get("title") or ""), field="Plan节点目标"
                    ),
                    "assignee_kind": str(raw.get("assignee_kind") or "agent"),
                    "dependencies": list(raw.get("dependencies") or []),
                    "validation": dict(raw.get("validation") or {}),
                    "stop_condition": str(raw.get("stop_condition") or ""),
                }
            )
        for node in normalized_nodes:
            if node["assignee_kind"] not in {"user", "agent", "external"}:
                raise HarnessValidationError("Plan节点责任主体无效")
            unknown = set(node["dependencies"]) - keys
            if unknown:
                raise HarnessValidationError(f"Plan依赖不存在: {sorted(unknown)}")
        dependencies_by_key = {
            str(node["key"]): tuple(str(value) for value in node["dependencies"]) for node in normalized_nodes
        }
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(node_key: str) -> None:
            if node_key in visiting:
                raise HarnessValidationError("Plan依赖不能形成环")
            if node_key in visited:
                return
            visiting.add(node_key)
            for dependency_key in dependencies_by_key[node_key]:
                visit(dependency_key)
            visiting.remove(node_key)
            visited.add(node_key)

        for node_key in dependencies_by_key:
            visit(node_key)
        request = {
            "work_item_id": work_item_id,
            "expected_work_row_version": expected_work_row_version,
            "summary": _text(summary, field="Plan摘要"),
            "nodes": normalized_nodes,
            "validation_contract": dict(validation_contract or {}),
            "accept": accept,
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            work = await transaction.get(WorkItemRecord, work_item_id)
            if work is None or work.scope_id != self.scope_id:
                raise HarnessNotFound("WorkItem不存在")
            if work.row_version != expected_work_row_version:
                raise HarnessConflict("WorkItem版本冲突")
            plan = await transaction.scalar(
                select(TaskPlanRecord).where(TaskPlanRecord.work_item_id == work_item_id)
            )
            if plan is None:
                plan = TaskPlanRecord(
                    id=_uuid(),
                    scope_id=self.scope_id,
                    project_id=work.project_id,
                    work_item_id=work.id,
                    status="draft",
                    row_version=1,
                    created_by=self.principal_id,
                    created_at=self._clock(),
                    updated_at=self._clock(),
                )
                transaction.add(plan)
                await transaction.flush()
                revision_no = 1
                previous_revision_id = None
            else:
                revision_no = (
                    int(
                        await transaction.scalar(
                            select(func.max(TaskPlanRevisionRecord.revision)).where(
                                TaskPlanRevisionRecord.task_plan_id == plan.id
                            )
                        )
                        or 0
                    )
                    + 1
                )
                previous_revision_id = plan.current_revision_id
            revision = TaskPlanRevisionRecord(
                id=_uuid(),
                task_plan_id=plan.id,
                revision=revision_no,
                previous_revision_id=previous_revision_id,
                summary=request["summary"],
                validation_contract_json=request["validation_contract"],
                status="accepted" if accept else "candidate",
                created_by=self.principal_id,
                created_at=self._clock(),
            )
            transaction.add(revision)
            await transaction.flush()
            result_nodes: list[dict[str, Any]] = []
            for ordinal, node in enumerate(normalized_nodes):
                record = PlanNodeRecord(
                    id=_uuid(),
                    plan_revision_id=revision.id,
                    node_key=node["key"],
                    title=node["title"],
                    objective=node["objective"],
                    status="pending",
                    assignee_kind=node["assignee_kind"],
                    dependency_keys_json=node["dependencies"],
                    validation_json=node["validation"],
                    stop_condition=node["stop_condition"],
                    ordinal=ordinal,
                )
                transaction.add(record)
                result_nodes.append(
                    {
                        "id": record.id,
                        "key": record.node_key,
                        "title": record.title,
                        "objective": record.objective,
                        "status": record.status,
                        "assignee_kind": record.assignee_kind,
                        "dependencies": list(record.dependency_keys_json),
                        "validation": dict(record.validation_json),
                        "stop_condition": record.stop_condition,
                        "ordinal": record.ordinal,
                    }
                )
            if accept:
                if previous_revision_id:
                    previous = await transaction.get(TaskPlanRevisionRecord, previous_revision_id)
                    if previous is not None and previous.status == "accepted":
                        previous.status = "superseded"
                plan.current_revision_id = revision.id
                plan.status = "accepted"
                plan.row_version += 1
                plan.updated_at = self._clock()
                work.current_plan_revision_id = revision.id
                if work.status == "draft":
                    work.status = "planned"
                work.row_version += 1
                work.updated_at = self._clock()
            result = {
                "id": plan.id,
                "work_item_id": work.id,
                "status": plan.status,
                "row_version": plan.row_version,
                "revision": {
                    "id": revision.id,
                    "revision": revision.revision,
                    "summary": revision.summary,
                    "status": revision.status,
                    "nodes": result_nodes,
                },
            }
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="create_plan_revision",
                request_hash=request_hash,
                result=result,
                resource_kind="task_plan",
                resource_id=plan.id,
                event_type="harness.plan.revised",
                trace_payload={"revision": revision_no, "accepted": accept, "work_item_id": work.id},
                decision_record_id=decision_record_id,
            )
            return result

    async def get_work_item(self, work_item_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            work = await transaction.get(WorkItemRecord, work_item_id)
            if work is None or work.scope_id != self.scope_id:
                raise HarnessNotFound("WorkItem不存在")
            plan = await transaction.scalar(
                select(TaskPlanRecord).where(TaskPlanRecord.work_item_id == work.id)
            )
            plan_view: dict[str, Any] | None = None
            if plan is not None and plan.current_revision_id:
                revision = await transaction.get(TaskPlanRevisionRecord, plan.current_revision_id)
                nodes = (
                    await transaction.scalars(
                        select(PlanNodeRecord)
                        .where(PlanNodeRecord.plan_revision_id == plan.current_revision_id)
                        .order_by(PlanNodeRecord.ordinal)
                    )
                ).all()
                plan_view = {
                    "id": plan.id,
                    "status": plan.status,
                    "row_version": plan.row_version,
                    "revision": None
                    if revision is None
                    else {
                        "id": revision.id,
                        "revision": revision.revision,
                        "summary": revision.summary,
                        "status": revision.status,
                        "validation_contract": dict(revision.validation_contract_json or {}),
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
                            for node in nodes
                        ],
                    },
                }
            actions = (
                await transaction.scalars(
                    select(ActionItemRecord)
                    .where(
                        ActionItemRecord.scope_id == self.scope_id,
                        ActionItemRecord.work_item_id == work.id,
                    )
                    .order_by(ActionItemRecord.created_at)
                )
            ).all()
            return {
                "work_item": _work_view(work),
                "plan": plan_view,
                "action_items": [_action_view(value) for value in actions],
            }

    async def list_action_items(
        self,
        *,
        project_id: str | None = None,
        work_item_id: str | None = None,
        statuses: Sequence[str] | None = None,
        limit: int = 300,
    ) -> list[dict[str, Any]]:
        query = select(ActionItemRecord).where(ActionItemRecord.scope_id == self.scope_id)
        if project_id is not None:
            query = query.where(ActionItemRecord.project_id == project_id)
        if work_item_id is not None:
            query = query.where(ActionItemRecord.work_item_id == work_item_id)
        if statuses:
            query = query.where(ActionItemRecord.status.in_(tuple(statuses)))
        query = query.order_by(ActionItemRecord.updated_at.desc()).limit(min(max(limit, 1), 500))
        async with self.database.sessions() as transaction:
            return [_action_view(value) for value in (await transaction.scalars(query)).all()]

    async def create_action_item(
        self,
        *,
        command_id: str,
        title: str,
        assignee_kind: str,
        project_id: str | None = None,
        work_item_id: str | None = None,
        plan_node_id: str | None = None,
        status: str = "pending",
        due_at: datetime | None = None,
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        if assignee_kind not in {"user", "agent", "external"}:
            raise HarnessValidationError("ActionItem责任主体无效")
        if status not in {"pending", "ready"}:
            raise HarnessValidationError("ActionItem初始状态无效")
        request = {
            "title": _text(title, field="ActionItem标题", max_length=200),
            "assignee_kind": assignee_kind,
            "project_id": project_id,
            "work_item_id": work_item_id,
            "plan_node_id": plan_node_id,
            "status": status,
            "due_at": _iso(due_at),
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            project = await transaction.get(ProductProjectRecord, project_id) if project_id else None
            if project_id and (project is None or project.scope_id != self.scope_id):
                raise HarnessNotFound("关联Project不存在")
            work = await transaction.get(WorkItemRecord, work_item_id) if work_item_id else None
            if work_item_id and (work is None or work.scope_id != self.scope_id):
                raise HarnessNotFound("关联WorkItem不存在")
            if work is not None and project_id is not None and work.project_id != project_id:
                raise HarnessValidationError("ActionItem的Project与WorkItem不一致")
            if plan_node_id:
                node = await transaction.get(PlanNodeRecord, plan_node_id)
                if node is None:
                    raise HarnessNotFound("PlanNode不存在")
                revision = await transaction.get(TaskPlanRevisionRecord, node.plan_revision_id)
                plan = await transaction.get(TaskPlanRecord, revision.task_plan_id) if revision else None
                if plan is None or plan.scope_id != self.scope_id:
                    raise HarnessNotFound("PlanNode所属TaskPlan不存在")
                if work_item_id is not None and plan.work_item_id != work_item_id:
                    raise HarnessValidationError("ActionItem的PlanNode与WorkItem不一致")
            now = self._clock()
            value = ActionItemRecord(
                id=_uuid(),
                scope_id=self.scope_id,
                project_id=project_id,
                work_item_id=work_item_id,
                plan_node_id=plan_node_id,
                title=request["title"],
                assignee_kind=assignee_kind,
                status=status,
                due_at=due_at,
                evidence_json=[],
                row_version=1,
                created_at=now,
                updated_at=now,
            )
            transaction.add(value)
            result = _action_view(value)
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="create_action_item",
                request_hash=request_hash,
                result=result,
                resource_kind="action_item",
                resource_id=value.id,
                event_type="harness.action.created",
                trace_payload={
                    "status": status,
                    "assignee_kind": assignee_kind,
                    "work_item_id": work_item_id,
                },
                decision_record_id=decision_record_id,
            )
            return result

    async def transition_action_item(
        self,
        *,
        action_item_id: str,
        command_id: str,
        expected_row_version: int,
        target_status: str,
        reason: str,
        evidence: Sequence[Mapping[str, Any]] = (),
        dependency_override_reason: str | None = None,
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        reason = _text(reason, field="状态变更原因")
        request = {
            "action_item_id": action_item_id,
            "expected_row_version": expected_row_version,
            "target_status": target_status,
            "reason": reason,
            "evidence": [dict(value) for value in evidence],
            "dependency_override_reason": (dependency_override_reason or "").strip() or None,
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            value = await transaction.get(ActionItemRecord, action_item_id)
            if value is None or value.scope_id != self.scope_id:
                raise HarnessNotFound("ActionItem不存在")
            if value.row_version != expected_row_version:
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
                    if unresolved and not request["dependency_override_reason"]:
                        raise HarnessValidationError(f"依赖未完成，不能进入ready: {sorted(unresolved)}")
                    if unresolved and not decision_record_id:
                        raise HarnessValidationError("依赖override必须绑定Decision Record")
            previous = value.status
            value.status = target_status
            value.evidence_json = [dict(item) for item in evidence]
            value.row_version += 1
            value.updated_at = self._clock()
            result = _action_view(value)
            self._record_command(
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
                    "dependency_override_reason": request["dependency_override_reason"],
                },
                decision_record_id=decision_record_id,
            )
            return result

    async def capture_note(
        self,
        *,
        command_id: str,
        kind: str,
        title: str,
        content: str,
        source_refs: Sequence[Mapping[str, Any]] = (),
        links: Sequence[Mapping[str, str]] = (),
        status: str = "active",
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        if kind not in NOTE_KINDS:
            raise HarnessValidationError("Note kind无效")
        if status not in {"draft", "active"}:
            raise HarnessValidationError("Note初始状态无效")
        request = {
            "kind": kind,
            "title": _text(title, field="Note标题", max_length=220),
            "content": _text(content, field="Note内容"),
            "source_refs": [dict(item) for item in source_refs],
            "links": [dict(item) for item in links],
            "status": status,
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            note = NoteRecord(
                id=_uuid(),
                scope_id=self.scope_id,
                kind=kind,
                title=request["title"],
                status=status,
                row_version=1,
                created_by=self.principal_id,
                created_at=self._clock(),
                updated_at=self._clock(),
            )
            revision = NoteRevisionRecord(
                id=_uuid(),
                note_id=note.id,
                revision=1,
                previous_revision_id=None,
                content=request["content"],
                source_refs_json=request["source_refs"],
                content_hash=_hash(request["content"]),
                created_by=self.principal_id,
                created_at=self._clock(),
            )
            note.current_revision_id = revision.id
            transaction.add(note)
            await transaction.flush()
            transaction.add(revision)
            await transaction.flush()
            for link in request["links"]:
                resource_kind = _text(
                    str(link.get("resource_kind") or ""), field="Note关联资源类型", max_length=40
                )
                resource_id = _text(
                    str(link.get("resource_id") or ""), field="Note关联资源ID", max_length=100
                )
                transaction.add(
                    NoteResourceLinkRecord(
                        id=_uuid(),
                        note_id=note.id,
                        resource_kind=resource_kind,
                        resource_id=resource_id,
                        relation=str(link.get("relation") or "documents"),
                        created_at=self._clock(),
                    )
                )
            result = _note_view(note, revision)
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="capture_note",
                request_hash=request_hash,
                result=result,
                resource_kind="note",
                resource_id=note.id,
                event_type="harness.note.created",
                trace_payload={"kind": kind, "revision": 1, "link_count": len(links)},
                decision_record_id=decision_record_id,
            )
            return result

    async def revise_note(
        self,
        *,
        note_id: str,
        command_id: str,
        expected_row_version: int,
        title: str,
        content: str,
        source_refs: Sequence[Mapping[str, Any]] = (),
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        request = {
            "note_id": note_id,
            "expected_row_version": expected_row_version,
            "title": _text(title, field="Note标题", max_length=220),
            "content": _text(content, field="Note内容"),
            "source_refs": [dict(item) for item in source_refs],
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            note = await transaction.get(NoteRecord, note_id)
            if note is None or note.scope_id != self.scope_id:
                raise HarnessNotFound("Note不存在")
            if note.row_version != expected_row_version:
                raise HarnessConflict("Note版本冲突")
            previous_id = note.current_revision_id
            previous = await transaction.get(NoteRevisionRecord, previous_id) if previous_id else None
            revision_no = (previous.revision if previous else 0) + 1
            revision = NoteRevisionRecord(
                id=_uuid(),
                note_id=note.id,
                revision=revision_no,
                previous_revision_id=previous_id,
                content=request["content"],
                source_refs_json=request["source_refs"],
                content_hash=_hash(request["content"]),
                created_by=self.principal_id,
                created_at=self._clock(),
            )
            transaction.add(revision)
            note.title = request["title"]
            note.current_revision_id = revision.id
            note.row_version += 1
            note.updated_at = self._clock()
            result = _note_view(note, revision)
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="revise_note",
                request_hash=request_hash,
                result=result,
                resource_kind="note",
                resource_id=note.id,
                event_type="harness.note.revised",
                trace_payload={"revision": revision_no, "previous_revision_id": previous_id},
                decision_record_id=decision_record_id,
            )
            return result

    async def transition_note(
        self,
        *,
        note_id: str,
        command_id: str,
        expected_row_version: int,
        target_status: str,
        reason: str,
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        reason = _text(reason, field="状态变更原因")
        request = {
            "note_id": note_id,
            "expected_row_version": expected_row_version,
            "target_status": target_status,
            "reason": reason,
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            note = await transaction.get(NoteRecord, note_id)
            if note is None or note.scope_id != self.scope_id:
                raise HarnessNotFound("Note不存在")
            if note.row_version != expected_row_version:
                raise HarnessConflict("Note版本冲突")
            if target_status not in NOTE_TRANSITIONS.get(note.status, set()):
                raise HarnessValidationError(f"Note不能从{note.status}变为{target_status}")
            previous = note.status
            note.status = target_status
            note.row_version += 1
            note.updated_at = self._clock()
            invalidated_memory_ids: list[str] = []
            invalidated_candidate_ids: list[str] = []
            if target_status in {"superseded", "archived"}:
                # A Memory is reusable only while its declared sources remain
                # valid.  Source withdrawal therefore fails closed: accepted
                # memories become invalid and unresolved candidates leave the
                # review queue.  The immutable revisions remain queryable for
                # provenance and can be re-proposed from a new source.
                memories = (
                    await transaction.scalars(
                        select(AcceptedMemoryRecord)
                        .join(
                            MemoryRevisionRecord,
                            MemoryRevisionRecord.id == AcceptedMemoryRecord.current_revision_id,
                        )
                        .join(
                            MemorySourceLinkRecord,
                            MemorySourceLinkRecord.memory_revision_id == MemoryRevisionRecord.id,
                        )
                        .where(
                            AcceptedMemoryRecord.scope_id == self.scope_id,
                            AcceptedMemoryRecord.status == "accepted",
                            MemorySourceLinkRecord.source_kind == "note",
                            MemorySourceLinkRecord.source_id == note.id,
                        )
                    )
                ).all()
                for memory in memories:
                    memory.status = "invalid"
                    memory.row_version += 1
                    memory.updated_at = self._clock()
                    invalidated_memory_ids.append(memory.id)
                candidates = (
                    await transaction.scalars(
                        select(MemoryCandidateRecord).where(
                            MemoryCandidateRecord.scope_id == self.scope_id,
                            MemoryCandidateRecord.status.in_(("candidate", "pending_review")),
                        )
                    )
                ).all()
                for candidate in candidates:
                    source_matches = any(
                        isinstance(source, Mapping)
                        and str(source.get("kind") or "") == "note"
                        and str(source.get("id") or "") == note.id
                        for source in (candidate.source_refs_json or [])
                    )
                    if source_matches:
                        candidate.status = "source_invalid"
                        candidate.resolved_at = self._clock()
                        invalidated_candidate_ids.append(candidate.id)
            revision = (
                await transaction.get(NoteRevisionRecord, note.current_revision_id)
                if note.current_revision_id
                else None
            )
            result = _note_view(note, revision)
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="transition_note",
                request_hash=request_hash,
                result=result,
                resource_kind="note",
                resource_id=note.id,
                event_type="harness.note.transitioned",
                trace_payload={
                    "from": previous,
                    "to": target_status,
                    "reason": reason,
                    "invalidated_memory_ids": invalidated_memory_ids,
                    "invalidated_memory_candidate_ids": invalidated_candidate_ids,
                },
                decision_record_id=decision_record_id,
            )
            return result

    async def list_notes(self, *, project_id: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            query = select(NoteRecord).where(NoteRecord.scope_id == self.scope_id)
            if project_id:
                query = query.join(NoteResourceLinkRecord).where(
                    NoteResourceLinkRecord.resource_kind == "project",
                    NoteResourceLinkRecord.resource_id == project_id,
                )
            notes = (
                await transaction.scalars(
                    query.order_by(NoteRecord.updated_at.desc()).limit(min(max(limit, 1), 500))
                )
            ).all()
            result: list[dict[str, Any]] = []
            for note in notes:
                revision = (
                    await transaction.get(NoteRevisionRecord, note.current_revision_id)
                    if note.current_revision_id
                    else None
                )
                result.append(_note_view(note, revision))
            return result

    async def propose_memory(
        self,
        *,
        command_id: str,
        scope_kind: str,
        scope_ref_id: str | None,
        memory_kind: str,
        content: str,
        source_refs: Sequence[Mapping[str, Any]],
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        if scope_kind not in MEMORY_SCOPE_KINDS:
            raise HarnessValidationError("Memory scope无效")
        if memory_kind not in MEMORY_KINDS:
            raise HarnessValidationError("Memory kind无效")
        if scope_kind != "user" and not scope_ref_id:
            raise HarnessValidationError("非User Memory必须绑定scope_ref_id")
        request = {
            "scope_kind": scope_kind,
            "scope_ref_id": scope_ref_id,
            "memory_kind": memory_kind,
            "content": _text(content, field="Memory内容"),
            "source_refs": [dict(item) for item in source_refs],
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            candidate = MemoryCandidateRecord(
                id=_uuid(),
                scope_id=self.scope_id,
                scope_kind=scope_kind,
                scope_ref_id=scope_ref_id,
                memory_kind=memory_kind,
                content=request["content"],
                status="pending_review",
                source_refs_json=request["source_refs"],
                content_hash=_hash(request["content"]),
                proposed_by=self.principal_id,
                decision_record_id=decision_record_id,
                created_at=self._clock(),
            )
            transaction.add(candidate)
            result = {
                "id": candidate.id,
                "scope_kind": candidate.scope_kind,
                "scope_ref_id": candidate.scope_ref_id,
                "memory_kind": candidate.memory_kind,
                "content": candidate.content,
                "status": candidate.status,
                "source_refs": candidate.source_refs_json,
                "content_hash": candidate.content_hash,
                "created_at": _iso(candidate.created_at),
            }
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="propose_memory",
                request_hash=request_hash,
                result=result,
                resource_kind="memory_candidate",
                resource_id=candidate.id,
                event_type="harness.memory.proposed",
                trace_payload={"scope_kind": scope_kind, "memory_kind": memory_kind},
                decision_record_id=decision_record_id,
            )
            return result

    async def resolve_memory_candidate(
        self,
        *,
        candidate_id: str,
        command_id: str,
        decision: str,
        decision_record_id: str | None,
    ) -> dict[str, Any]:
        if decision not in {"accept", "reject", "session_only"}:
            raise HarnessValidationError("Memory决定无效")
        request = {
            "candidate_id": candidate_id,
            "decision": decision,
            "decision_record_id": decision_record_id,
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            candidate = await transaction.get(MemoryCandidateRecord, candidate_id)
            if candidate is None or candidate.scope_id != self.scope_id:
                raise HarnessNotFound("Memory Candidate不存在")
            if candidate.status not in {"candidate", "pending_review"}:
                raise HarnessConflict("Memory Candidate已经处理")
            candidate.decision_record_id = decision_record_id
            candidate.resolved_at = self._clock()
            if decision != "accept":
                candidate.status = "rejected" if decision == "reject" else "session_only"
                result = {"candidate_id": candidate.id, "status": candidate.status, "memory": None}
                event_type = (
                    "harness.memory.rejected" if decision == "reject" else "harness.memory.session_only"
                )
                resource_kind = "memory_candidate"
                resource_id = candidate.id
            else:
                candidate.status = "accepted"
                memory = AcceptedMemoryRecord(
                    id=_uuid(),
                    scope_id=self.scope_id,
                    scope_kind=candidate.scope_kind,
                    scope_ref_id=candidate.scope_ref_id,
                    memory_kind=candidate.memory_kind,
                    status="accepted",
                    row_version=1,
                    created_at=self._clock(),
                    updated_at=self._clock(),
                )
                revision = MemoryRevisionRecord(
                    id=_uuid(),
                    memory_id=memory.id,
                    candidate_id=candidate.id,
                    revision=1,
                    previous_revision_id=None,
                    content=candidate.content,
                    content_hash=candidate.content_hash,
                    source_refs_json=candidate.source_refs_json,
                    decision_record_id=decision_record_id,
                    created_by=self.principal_id,
                    created_at=self._clock(),
                )
                memory.current_revision_id = revision.id
                transaction.add(memory)
                await transaction.flush()
                transaction.add(revision)
                await transaction.flush()
                for source in candidate.source_refs_json or []:
                    if not isinstance(source, Mapping) or not source.get("id"):
                        continue
                    transaction.add(
                        MemorySourceLinkRecord(
                            id=_uuid(),
                            memory_revision_id=revision.id,
                            source_kind=str(source.get("kind") or "unknown"),
                            source_id=str(source["id"]),
                            source_revision=str(source.get("revision")) if source.get("revision") else None,
                            created_at=self._clock(),
                        )
                    )
                result = {
                    "candidate_id": candidate.id,
                    "status": candidate.status,
                    "memory": _memory_view(memory, revision),
                }
                event_type = "harness.memory.accepted"
                resource_kind = "accepted_memory"
                resource_id = memory.id
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="resolve_memory_candidate",
                request_hash=request_hash,
                result=result,
                resource_kind=resource_kind,
                resource_id=resource_id,
                event_type=event_type,
                trace_payload={"candidate_id": candidate.id, "decision": decision},
                decision_record_id=decision_record_id,
            )
            return result

    async def revise_memory(
        self,
        *,
        memory_id: str,
        command_id: str,
        expected_row_version: int,
        content: str,
        source_refs: Sequence[Mapping[str, Any]],
        reason: str,
        decision_record_id: str | None,
    ) -> dict[str, Any]:
        request = {
            "memory_id": memory_id,
            "expected_row_version": expected_row_version,
            "content": _text(content, field="Memory内容"),
            "source_refs": [dict(value) for value in source_refs],
            "reason": _text(reason, field="Memory修订原因"),
            "decision_record_id": decision_record_id,
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            memory = await transaction.get(AcceptedMemoryRecord, memory_id)
            if memory is None or memory.scope_id != self.scope_id:
                raise HarnessNotFound("Accepted Memory不存在")
            if memory.row_version != expected_row_version:
                raise HarnessConflict("Memory版本冲突")
            if memory.status != "accepted":
                raise HarnessValidationError("只有accepted Memory可以修订")
            previous = (
                await transaction.get(MemoryRevisionRecord, memory.current_revision_id)
                if memory.current_revision_id
                else None
            )
            revision = MemoryRevisionRecord(
                id=_uuid(),
                memory_id=memory.id,
                candidate_id=None,
                revision=(previous.revision if previous else 0) + 1,
                previous_revision_id=memory.current_revision_id,
                content=request["content"],
                content_hash=_hash(request["content"]),
                source_refs_json=request["source_refs"],
                decision_record_id=decision_record_id,
                created_by=self.principal_id,
                created_at=self._clock(),
            )
            transaction.add(revision)
            await transaction.flush()
            for source in request["source_refs"]:
                if not isinstance(source, Mapping) or not source.get("id"):
                    continue
                transaction.add(
                    MemorySourceLinkRecord(
                        id=_uuid(),
                        memory_revision_id=revision.id,
                        source_kind=str(source.get("kind") or "unknown"),
                        source_id=str(source["id"]),
                        source_revision=(
                            str(source.get("revision")) if source.get("revision") is not None else None
                        ),
                        created_at=self._clock(),
                    )
                )
            memory.current_revision_id = revision.id
            memory.row_version += 1
            memory.updated_at = self._clock()
            result = _memory_view(memory, revision)
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="revise_memory",
                request_hash=request_hash,
                result=result,
                resource_kind="accepted_memory",
                resource_id=memory.id,
                event_type="harness.memory.revised",
                trace_payload={
                    "revision": revision.revision,
                    "reason": request["reason"],
                    "previous_revision_id": revision.previous_revision_id,
                },
                decision_record_id=decision_record_id,
            )
            return result

    async def transition_memory(
        self,
        *,
        memory_id: str,
        command_id: str,
        expected_row_version: int,
        target_status: str,
        reason: str,
        decision_record_id: str | None,
    ) -> dict[str, Any]:
        request = {
            "memory_id": memory_id,
            "expected_row_version": expected_row_version,
            "target_status": target_status,
            "reason": _text(reason, field="Memory状态变更原因"),
            "decision_record_id": decision_record_id,
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            memory = await transaction.get(AcceptedMemoryRecord, memory_id)
            if memory is None or memory.scope_id != self.scope_id:
                raise HarnessNotFound("Accepted Memory不存在")
            if memory.row_version != expected_row_version:
                raise HarnessConflict("Memory版本冲突")
            if target_status not in MEMORY_TRANSITIONS.get(memory.status, set()):
                raise HarnessValidationError(f"Memory不能从{memory.status}变为{target_status}")
            if target_status in {"revoked", "invalid"} and not decision_record_id:
                raise HarnessValidationError("撤销或失效Memory必须绑定Decision Record")
            previous_status = memory.status
            memory.status = target_status
            memory.row_version += 1
            memory.updated_at = self._clock()
            revision = (
                await transaction.get(MemoryRevisionRecord, memory.current_revision_id)
                if memory.current_revision_id
                else None
            )
            result = _memory_view(memory, revision)
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="transition_memory",
                request_hash=request_hash,
                result=result,
                resource_kind="accepted_memory",
                resource_id=memory.id,
                event_type="harness.memory.transitioned",
                trace_payload={"from": previous_status, "to": target_status, "reason": request["reason"]},
                decision_record_id=decision_record_id,
            )
            return result

    async def list_memory(
        self,
        *,
        scope_kind: str | None = None,
        scope_ref_id: str | None = None,
        include_candidates: bool = True,
        statuses: Sequence[str] | None = None,
        limit: int = 200,
    ) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            query = select(AcceptedMemoryRecord).where(AcceptedMemoryRecord.scope_id == self.scope_id)
            if scope_kind:
                query = query.where(AcceptedMemoryRecord.scope_kind == scope_kind)
            if scope_ref_id:
                query = query.where(AcceptedMemoryRecord.scope_ref_id == scope_ref_id)
            if statuses:
                query = query.where(AcceptedMemoryRecord.status.in_(tuple(statuses)))
            memories = (
                await transaction.scalars(
                    query.order_by(AcceptedMemoryRecord.updated_at.desc()).limit(min(max(limit, 1), 500))
                )
            ).all()
            accepted: list[dict[str, Any]] = []
            for memory in memories:
                revision = (
                    await transaction.get(MemoryRevisionRecord, memory.current_revision_id)
                    if memory.current_revision_id
                    else None
                )
                accepted.append(_memory_view(memory, revision))
            candidates: list[dict[str, Any]] = []
            if include_candidates:
                candidate_query = (
                    select(MemoryCandidateRecord)
                    .where(
                        MemoryCandidateRecord.scope_id == self.scope_id,
                        MemoryCandidateRecord.status.in_(("candidate", "pending_review")),
                    )
                    .order_by(MemoryCandidateRecord.created_at.desc())
                    .limit(min(max(limit, 1), 500))
                )
                for value in (await transaction.scalars(candidate_query)).all():
                    candidates.append(
                        {
                            "id": value.id,
                            "scope_kind": value.scope_kind,
                            "scope_ref_id": value.scope_ref_id,
                            "memory_kind": value.memory_kind,
                            "content": value.content,
                            "status": value.status,
                            "source_refs": list(value.source_refs_json or []),
                            "created_at": _iso(value.created_at),
                        }
                    )
            return {"accepted": accepted, "candidates": candidates}

    async def search_resources(self, query: str, *, limit: int = 30) -> list[dict[str, Any]]:
        term = _text(query, field="检索词")
        pattern = f"%{term}%"
        results: list[dict[str, Any]] = []
        async with self.database.sessions() as transaction:
            projects = (
                await transaction.scalars(
                    select(ProductProjectRecord)
                    .where(
                        ProductProjectRecord.scope_id == self.scope_id,
                        or_(
                            ProductProjectRecord.title.ilike(pattern),
                            ProductProjectRecord.goal.ilike(pattern),
                        ),
                    )
                    .limit(limit)
                )
            ).all()
            results.extend(
                {
                    "kind": "project",
                    "id": v.id,
                    "title": v.title,
                    "summary": v.goal,
                    "status": v.status,
                    "revision": v.row_version,
                }
                for v in projects
            )
            work = (
                await transaction.scalars(
                    select(WorkItemRecord)
                    .where(
                        WorkItemRecord.scope_id == self.scope_id,
                        or_(WorkItemRecord.title.ilike(pattern), WorkItemRecord.objective.ilike(pattern)),
                    )
                    .limit(limit)
                )
            ).all()
            results.extend(
                {
                    "kind": "work_item",
                    "id": v.id,
                    "title": v.title,
                    "summary": v.objective,
                    "status": v.status,
                    "revision": v.row_version,
                }
                for v in work
            )
            notes = (
                await transaction.execute(
                    select(NoteRecord, NoteRevisionRecord)
                    .join(NoteRevisionRecord, NoteRevisionRecord.id == NoteRecord.current_revision_id)
                    .where(
                        NoteRecord.scope_id == self.scope_id,
                        or_(NoteRecord.title.ilike(pattern), NoteRevisionRecord.content.ilike(pattern)),
                    )
                    .limit(limit)
                )
            ).all()
            results.extend(
                {
                    "kind": "note",
                    "id": note.id,
                    "title": note.title,
                    "summary": revision.content[:400],
                    "status": note.status,
                    "revision": revision.revision,
                }
                for note, revision in notes
            )
        return results[:limit]

    async def project_context(self, project_id: str) -> dict[str, Any]:
        """Return one Project working set without opening a write transaction."""

        return await self.context_queries.project_context(project_id)

    async def create_context_package(
        self,
        *,
        session_id: str,
        run_id: str,
        stage: str,
        items: Sequence[Mapping[str, Any]],
        command_id: str | None = None,
        selected_project_id: str | None = None,
        selected_work_item_id: str | None = None,
        token_budget: int = 6000,
        status: str = "candidate",
    ) -> dict[str, Any]:
        if stage not in {"directory", "detail"}:
            raise HarnessValidationError("ContextPackage stage无效")
        async with self.database.sessions.begin() as transaction:
            run = await transaction.get(RunRecord, run_id)
            if run is None or run.session_id != session_id:
                raise HarnessNotFound("Product Run不存在")
            normalized: list[dict[str, Any]] = []
            total = 0
            for ordinal, raw in enumerate(items):
                content = str(raw.get("content") or "")
                estimate = int(raw.get("token_estimate") or max(1, len(content) // 3))
                adopted = bool(raw.get("adopted", True)) and total + estimate <= token_budget
                reason = str(raw.get("reason") or ("与本轮目标相关" if adopted else "超出本轮Token预算"))
                if adopted:
                    total += estimate
                normalized.append(
                    {
                        "ordinal": ordinal,
                        "source_kind": str(raw.get("source_kind") or "unknown"),
                        "source_id": str(raw.get("source_id") or "unknown"),
                        "source_revision": str(raw.get("source_revision"))
                        if raw.get("source_revision") is not None
                        else None,
                        "title": str(raw.get("title") or raw.get("source_kind") or "未命名来源"),
                        "content": content,
                        "adopted": adopted,
                        "locked": False,
                        "selection_origin": "system",
                        "reason": reason,
                        "token_estimate": estimate,
                    }
                )
            request = {
                "session_id": session_id,
                "run_id": run_id,
                "stage": stage,
                "selected_project_id": selected_project_id,
                "selected_work_item_id": selected_work_item_id,
                "token_budget": token_budget,
                "status": status,
                "items": normalized,
            }
            request_hash = _hash(request)
            effective_command_id = command_id or f"context:{run_id}:{stage}:{request_hash[:24]}"
            existing = await self._existing_command(
                transaction,
                effective_command_id,
                request_hash,
            )
            if existing is not None:
                return existing
            revision = (
                int(
                    await transaction.scalar(
                        select(func.max(ContextPackageRecord.revision)).where(
                            ContextPackageRecord.run_id == run_id,
                            ContextPackageRecord.stage == stage,
                        )
                    )
                    or 0
                )
                + 1
            )
            package_hash = context_package_hash(
                stage=stage,
                selected_project_id=selected_project_id,
                selected_work_item_id=selected_work_item_id,
                token_budget=token_budget,
                items=normalized,
            )
            now = self._clock()
            package = ContextPackageRecord(
                id=_uuid(),
                scope_id=self.scope_id,
                session_id=session_id,
                interaction_id=run.interaction_id,
                run_id=run_id,
                stage=stage,
                revision=revision,
                selected_project_id=selected_project_id,
                selected_work_item_id=selected_work_item_id,
                token_budget=token_budget,
                estimated_tokens=total,
                package_hash=package_hash,
                status=status,
                previous_package_id=None,
                revision_reason="Workflow确定性装配",
                created_by="workflow",
                created_at=now,
            )
            transaction.add(package)
            await transaction.flush()
            for item in normalized:
                transaction.add(
                    ContextAdoptionRecord(
                        id=_uuid(),
                        context_package_id=package.id,
                        ordinal=item["ordinal"],
                        source_kind=item["source_kind"],
                        source_id=item["source_id"],
                        source_revision=item["source_revision"],
                        title=item["title"],
                        content_text=item["content"],
                        adopted=item["adopted"],
                        locked=item["locked"],
                        selection_origin=item["selection_origin"],
                        reason=item["reason"],
                        token_estimate=item["token_estimate"],
                    )
                )
            result = {
                "id": package.id,
                "session_id": session_id,
                "run_id": run_id,
                "stage": stage,
                "revision": revision,
                "selected_project_id": selected_project_id,
                "selected_work_item_id": selected_work_item_id,
                "token_budget": token_budget,
                "estimated_tokens": total,
                "package_hash": package_hash,
                "status": status,
                "items": normalized,
            }
            self._record_command(
                transaction,
                command_id=effective_command_id,
                command_kind="create_context_package",
                request_hash=request_hash,
                result=result,
                resource_kind="context_package",
                resource_id=package.id,
                event_type="harness.context.created",
                trace_payload={
                    "stage": stage,
                    "revision": revision,
                    "selected_project_id": selected_project_id,
                    "adopted_count": sum(value["adopted"] for value in normalized),
                    "excluded_count": sum(not value["adopted"] for value in normalized),
                    "estimated_tokens": total,
                    "token_budget": token_budget,
                },
            )
            return result

    async def latest_context_package(self, session_id: str) -> dict[str, Any] | None:
        return await self.context_queries.latest_context_package(session_id)

    async def directory_context_items(
        self,
        *,
        prompt: str,
        summaries: Sequence[Mapping[str, Any]],
        max_projects: int = 20,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        return await self.context_queries.directory_context_items(
            prompt=prompt,
            summaries=summaries,
            max_projects=max_projects,
        )

    async def detailed_context_items(self, project_id: str) -> list[dict[str, Any]]:
        return await self.context_queries.detailed_context_items(project_id)

    async def learning_tracks(self) -> list[dict[str, Any]]:
        return await self.context_queries.learning_tracks()

    async def commit_turn_candidates(
        self,
        *,
        command_id: str,
        session_id: str,
        run_id: str,
        project_id: str | None,
        work_candidates: Sequence[Any],
        memory_candidates: Sequence[Any],
        decision_record_ids: Sequence[str],
    ) -> dict[str, Any]:
        """Commit candidates that already passed their Product decision points.

        Candidate text remains conservative: a completion claim without
        evidence is stored as blocked/in-progress work, never as completed.
        """

        request = {
            "session_id": session_id,
            "run_id": run_id,
            "project_id": project_id,
            "work_candidates": list(work_candidates),
            "memory_candidates": list(memory_candidates),
            "decision_record_ids": list(decision_record_ids),
        }
        request_hash = _hash(request)
        async with self.database.sessions.begin() as transaction:
            existing = await self._existing_command(transaction, command_id, request_hash)
            if existing is not None:
                return existing
            run = await transaction.get(RunRecord, run_id)
            if run is None or run.session_id != session_id:
                raise HarnessNotFound("Product Run不存在")
            if project_id:
                project = await transaction.get(ProductProjectRecord, project_id)
                if project is None or project.scope_id != self.scope_id:
                    raise HarnessNotFound("绑定Project不存在")
            committed_work: list[dict[str, Any]] = []
            committed_memory: list[dict[str, Any]] = []
            for raw in work_candidates:
                candidate = dict(raw) if isinstance(raw, Mapping) else {"title": str(raw)}
                title = str(candidate.get("title") or candidate.get("summary") or "").strip()
                if not title:
                    continue
                requested_status = str(candidate.get("status") or candidate.get("target_status") or "draft")
                evidence = candidate.get("evidence")
                has_evidence = isinstance(evidence, list) and bool(evidence)
                if requested_status == "completed" and not has_evidence:
                    requested_status = "blocked" if candidate.get("blocked_reason") else "in_progress"
                if requested_status not in {"draft", "planned", "ready", "in_progress", "blocked"}:
                    requested_status = "draft"
                kind = str(candidate.get("kind") or "task")
                if kind not in WORK_KINDS:
                    kind = "task"
                work = WorkItemRecord(
                    id=_uuid(),
                    scope_id=self.scope_id,
                    project_id=project_id,
                    parent_work_item_id=None,
                    kind=kind,
                    title=title[:200],
                    objective=str(candidate.get("objective") or title),
                    status=requested_status,
                    priority=str(candidate.get("priority") or "normal")
                    if str(candidate.get("priority") or "normal") in WORK_PRIORITIES
                    else "normal",
                    completion_evidence_json=list(evidence or []),
                    row_version=1,
                    created_by="workflow-candidate-commit",
                    created_at=self._clock(),
                    updated_at=self._clock(),
                )
                transaction.add(work)
                await transaction.flush()
                if project_id:
                    transaction.add(
                        ProjectWorkLinkRecord(
                            id=_uuid(),
                            project_id=project_id,
                            work_item_id=work.id,
                            relation="contains",
                            created_at=self._clock(),
                        )
                    )
                transaction.add(
                    ResourceSessionLinkRecord(
                        id=_uuid(),
                        resource_kind="work_item",
                        resource_id=work.id,
                        session_id=session_id,
                        reason="本轮Work候选经决定点提交",
                        source_kind="turn_summary_candidate",
                    )
                )
                committed_work.append(_work_view(work))
            for raw in memory_candidates:
                candidate_data = dict(raw) if isinstance(raw, Mapping) else {"content": str(raw)}
                content = str(candidate_data.get("content") or candidate_data.get("text") or "").strip()
                if not content:
                    continue
                memory_kind = str(
                    candidate_data.get("memory_kind") or candidate_data.get("kind") or "stable_fact"
                )
                if memory_kind not in MEMORY_KINDS:
                    memory_kind = "stable_fact"
                scope_kind = "project" if project_id else "user"
                source_refs = [
                    {"kind": "product_run", "id": run_id},
                    {"kind": "product_session", "id": session_id},
                ]
                candidate = MemoryCandidateRecord(
                    id=_uuid(),
                    scope_id=self.scope_id,
                    scope_kind=scope_kind,
                    scope_ref_id=project_id,
                    memory_kind=memory_kind,
                    content=content,
                    status="accepted",
                    source_refs_json=source_refs,
                    content_hash=_hash(content),
                    proposed_by="turn_summary_agent",
                    decision_record_id=decision_record_ids[-1] if decision_record_ids else None,
                    created_at=self._clock(),
                    resolved_at=self._clock(),
                )
                memory = AcceptedMemoryRecord(
                    id=_uuid(),
                    scope_id=self.scope_id,
                    scope_kind=scope_kind,
                    scope_ref_id=project_id,
                    memory_kind=memory_kind,
                    status="accepted",
                    row_version=1,
                    created_at=self._clock(),
                    updated_at=self._clock(),
                )
                revision = MemoryRevisionRecord(
                    id=_uuid(),
                    memory_id=memory.id,
                    candidate_id=candidate.id,
                    revision=1,
                    previous_revision_id=None,
                    content=content,
                    content_hash=candidate.content_hash,
                    source_refs_json=source_refs,
                    decision_record_id=candidate.decision_record_id,
                    created_by=self.principal_id,
                    created_at=self._clock(),
                )
                memory.current_revision_id = revision.id
                transaction.add(candidate)
                await transaction.flush()
                transaction.add(memory)
                await transaction.flush()
                transaction.add(revision)
                await transaction.flush()
                for source in source_refs:
                    transaction.add(
                        MemorySourceLinkRecord(
                            id=_uuid(),
                            memory_revision_id=revision.id,
                            source_kind=source["kind"],
                            source_id=source["id"],
                            source_revision=None,
                            created_at=self._clock(),
                        )
                    )
                committed_memory.append(_memory_view(memory, revision))
            result = {
                "work_items": committed_work,
                "accepted_memory": committed_memory,
                "work_count": len(committed_work),
                "memory_count": len(committed_memory),
            }
            self._record_command(
                transaction,
                command_id=command_id,
                command_kind="commit_turn_candidates",
                request_hash=request_hash,
                result=result,
                resource_kind="product_run",
                resource_id=run_id,
                event_type="harness.turn_candidates.committed",
                trace_payload={
                    "work_count": len(committed_work),
                    "memory_count": len(committed_memory),
                    "project_id": project_id,
                },
                decision_record_id=decision_record_ids[-1] if decision_record_ids else None,
            )
            return result
