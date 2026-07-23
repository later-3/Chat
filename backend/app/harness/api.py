"""REST management surface for Product Harness resources."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .service import HarnessConflict, HarnessNotFound, HarnessService, HarnessValidationError


class CreateProjectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    kind: str
    title: str
    goal: str
    status: str = "proposed"
    session_id: str | None = None
    decision_record_id: str | None = None


class TransitionProjectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    expected_row_version: int
    target_status: str
    reason: str
    decision_record_id: str | None = None


class CreateWorkItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    kind: str
    title: str
    objective: str
    project_id: str | None = None
    parent_work_item_id: str | None = None
    priority: str = "normal"
    status: str = "draft"
    decision_record_id: str | None = None


class TransitionWorkItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    expected_row_version: int
    target_status: str
    reason: str
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    completion_waiver_reason: str | None = None
    decision_record_id: str | None = None


class CreateActionItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    title: str
    assignee_kind: str
    project_id: str | None = None
    work_item_id: str | None = None
    plan_node_id: str | None = None
    status: str = "pending"
    due_at: datetime | None = None
    decision_record_id: str | None = None


class TransitionActionItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    expected_row_version: int
    target_status: str
    reason: str
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    dependency_override_reason: str | None = None
    decision_record_id: str | None = None


class PlanNodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str
    title: str
    objective: str
    assignee_kind: str = "agent"
    dependencies: list[str] = Field(default_factory=list)
    validation: dict[str, Any] = Field(default_factory=dict)
    stop_condition: str = ""


class CreatePlanRevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    expected_work_row_version: int
    summary: str
    nodes: list[PlanNodeRequest]
    validation_contract: dict[str, Any] = Field(default_factory=dict)
    accept: bool = False
    decision_record_id: str | None = None


class CaptureNoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    kind: str
    title: str
    content: str
    source_refs: list[dict[str, Any]] = Field(default_factory=list)
    links: list[dict[str, str]] = Field(default_factory=list)
    status: str = "active"
    decision_record_id: str | None = None


class ReviseNoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    expected_row_version: int
    title: str
    content: str
    source_refs: list[dict[str, Any]] = Field(default_factory=list)
    decision_record_id: str | None = None


class TransitionNoteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    expected_row_version: int
    target_status: str
    reason: str
    decision_record_id: str | None = None


class ProposeMemoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    scope_kind: str
    scope_ref_id: str | None = None
    memory_kind: str
    content: str
    source_refs: list[dict[str, Any]] = Field(default_factory=list)
    decision_record_id: str | None = None


class ResolveMemoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    decision: str
    decision_record_id: str | None = None


class ReviseMemoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    expected_row_version: int
    content: str
    source_refs: list[dict[str, Any]] = Field(default_factory=list)
    reason: str
    decision_record_id: str | None = None


class TransitionMemoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command_id: str
    expected_row_version: int
    target_status: str
    reason: str
    decision_record_id: str | None = None


def create_harness_router(service: HarnessService) -> APIRouter:
    router = APIRouter(prefix="/api/harness", tags=["product-harness"])

    def translate(error: Exception) -> HTTPException:
        if isinstance(error, HarnessNotFound):
            return HTTPException(status_code=404, detail=str(error))
        if isinstance(error, HarnessConflict):
            return HTTPException(status_code=409, detail=str(error))
        return HTTPException(status_code=422, detail=str(error))

    @router.get("/projects")
    async def list_projects(status: str | None = None, kind: str | None = None) -> dict[str, Any]:
        statuses = tuple(value for value in (status or "").split(",") if value) or None
        return {"projects": await service.list_projects(statuses=statuses, kind=kind)}

    @router.post("/projects", status_code=201)
    async def create_project(command: CreateProjectRequest) -> dict[str, Any]:
        try:
            return await service.create_project(**command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.get("/projects/{project_id}")
    async def project_context(project_id: str) -> dict[str, Any]:
        try:
            return await service.project_context(project_id)
        except HarnessNotFound as error:
            raise translate(error) from error

    @router.post("/projects/{project_id}/transition")
    async def transition_project(project_id: str, command: TransitionProjectRequest) -> dict[str, Any]:
        try:
            return await service.transition_project(project_id=project_id, **command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.get("/work-items")
    async def list_work_items(project_id: str | None = None, status: str | None = None) -> dict[str, Any]:
        statuses = tuple(value for value in (status or "").split(",") if value) or None
        return {"work_items": await service.list_work(project_id=project_id, statuses=statuses)}

    @router.post("/work-items", status_code=201)
    async def create_work_item(command: CreateWorkItemRequest) -> dict[str, Any]:
        try:
            return await service.create_work_item(**command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.get("/work-items/{work_item_id}")
    async def get_work_item(work_item_id: str) -> dict[str, Any]:
        try:
            return await service.get_work_item(work_item_id)
        except HarnessNotFound as error:
            raise translate(error) from error

    @router.post("/work-items/{work_item_id}/transition")
    async def transition_work_item(work_item_id: str, command: TransitionWorkItemRequest) -> dict[str, Any]:
        try:
            return await service.transition_work_item(work_item_id=work_item_id, **command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.post("/work-items/{work_item_id}/plan-revisions", status_code=201)
    async def create_plan_revision(work_item_id: str, command: CreatePlanRevisionRequest) -> dict[str, Any]:
        try:
            payload = command.model_dump()
            payload["nodes"] = [value.model_dump() for value in command.nodes]
            return await service.create_plan_revision(work_item_id=work_item_id, **payload)
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.get("/action-items")
    async def list_action_items(
        project_id: str | None = None,
        work_item_id: str | None = None,
        status: str | None = None,
    ) -> dict[str, Any]:
        statuses = tuple(value for value in (status or "").split(",") if value) or None
        return {"action_items": await service.list_action_items(
            project_id=project_id,
            work_item_id=work_item_id,
            statuses=statuses,
        )}

    @router.post("/action-items", status_code=201)
    async def create_action_item(command: CreateActionItemRequest) -> dict[str, Any]:
        try:
            return await service.create_action_item(**command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.post("/action-items/{action_item_id}/transition")
    async def transition_action_item(
        action_item_id: str,
        command: TransitionActionItemRequest,
    ) -> dict[str, Any]:
        try:
            return await service.transition_action_item(
                action_item_id=action_item_id,
                **command.model_dump(),
            )
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.get("/notes")
    async def list_notes(project_id: str | None = None) -> dict[str, Any]:
        return {"notes": await service.list_notes(project_id=project_id)}

    @router.post("/notes", status_code=201)
    async def capture_note(command: CaptureNoteRequest) -> dict[str, Any]:
        try:
            return await service.capture_note(**command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.put("/notes/{note_id}")
    async def revise_note(note_id: str, command: ReviseNoteRequest) -> dict[str, Any]:
        try:
            return await service.revise_note(note_id=note_id, **command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.post("/notes/{note_id}/transition")
    async def transition_note(note_id: str, command: TransitionNoteRequest) -> dict[str, Any]:
        try:
            return await service.transition_note(note_id=note_id, **command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.get("/memory")
    async def list_memory(scope_kind: str | None = None, scope_ref_id: str | None = None) -> dict[str, Any]:
        return await service.list_memory(scope_kind=scope_kind, scope_ref_id=scope_ref_id)

    @router.post("/memory-candidates", status_code=201)
    async def propose_memory(command: ProposeMemoryRequest) -> dict[str, Any]:
        try:
            return await service.propose_memory(**command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.post("/memory-candidates/{candidate_id}/resolve")
    async def resolve_memory(candidate_id: str, command: ResolveMemoryRequest) -> dict[str, Any]:
        try:
            return await service.resolve_memory_candidate(candidate_id=candidate_id, **command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.put("/memory/{memory_id}")
    async def revise_memory(memory_id: str, command: ReviseMemoryRequest) -> dict[str, Any]:
        try:
            return await service.revise_memory(memory_id=memory_id, **command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.post("/memory/{memory_id}/transition")
    async def transition_memory(memory_id: str, command: TransitionMemoryRequest) -> dict[str, Any]:
        try:
            return await service.transition_memory(memory_id=memory_id, **command.model_dump())
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.get("/learning-tracks")
    async def learning_tracks() -> dict[str, Any]:
        return {"learning_tracks": await service.learning_tracks()}

    @router.get("/search")
    async def search_resources(q: str, limit: int = 30) -> dict[str, Any]:
        try:
            return {"resources": await service.search_resources(q, limit=limit)}
        except HarnessValidationError as error:
            raise translate(error) from error

    @router.get("/sessions/{session_id}/context/latest")
    async def latest_context(session_id: str) -> dict[str, Any]:
        return {"context_package": await service.latest_context_package(session_id)}

    return router
