"""REST query and revision surface for Product-owned Intent Sets."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from ..api import http_problem
from ..harness.contracts import HarnessConflict, HarnessNotFound, HarnessValidationError
from .service import CollaborationIntentService


class ReviseIntentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_set_revision_hash: str
    reason: str
    changes: dict[str, Any] = Field(default_factory=dict)


class AcceptIntentSetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision_hash: str


def create_collaboration_intent_router(service: CollaborationIntentService) -> APIRouter:
    router = APIRouter(prefix="/api/harness/intents", tags=["collaboration-intents"])

    def translate(error: Exception) -> HTTPException:
        if isinstance(error, HarnessNotFound):
            return http_problem(status_code=404, error=error)
        if isinstance(error, HarnessConflict):
            return http_problem(status_code=409, error=error)
        return http_problem(status_code=422, error=error)

    @router.get("")
    async def list_intents(
        session_id: str | None = Query(default=None),
        run_id: str | None = Query(default=None),
        limit: int = Query(default=20, ge=1, le=100),
    ) -> Any:
        if bool(session_id) == bool(run_id):
            raise http_problem(
                status_code=422,
                code="INTENT_FILTER_VALIDATION_FAILED",
                message="必须且只能提供session_id或run_id",
                details={"field": "session_id|run_id"},
            )
        try:
            if run_id:
                return await service.get_for_run(run_id)
            return await service.list_for_session(str(session_id), limit=limit)
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.post("/{intent_set_id}/accept")
    async def accept_intent_set(
        intent_set_id: str,
        command: AcceptIntentSetRequest,
    ) -> dict[str, Any]:
        try:
            return await service.accept_current(
                intent_set_id=intent_set_id,
                expected_revision_hash=command.expected_revision_hash,
            )
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    @router.post("/items/{intent_id}/revisions", status_code=201)
    async def revise_intent(
        intent_id: str,
        command: ReviseIntentRequest,
    ) -> dict[str, Any]:
        try:
            return await service.revise_intent(
                intent_id=intent_id,
                expected_set_revision_hash=command.expected_set_revision_hash,
                changes=command.changes,
                reason=command.reason,
            )
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    return router
