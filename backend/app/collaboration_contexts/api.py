"""REST editing surface for immutable ContextPackage revisions."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..api import CommandId, http_problem
from ..harness.contracts import (
    HarnessConflict,
    HarnessNotFound,
    HarnessValidationError,
)
from .service import CollaborationContextService


class ContextItemChange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ordinal: int
    adopted: bool | None = None
    locked: bool | None = None
    content: str | None = None
    reason: str | None = None
    materialize: bool = False


class AddedContextSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_kind: str
    source_id: str
    adopted: bool = True
    locked: bool = False
    reason: str | None = None


class ReviseContextPackageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: CommandId
    expected_package_hash: str
    reason: str
    item_changes: list[ContextItemChange] = Field(default_factory=list)
    added_source_refs: list[AddedContextSource] = Field(default_factory=list)
    token_budget: int | None = None


def create_collaboration_context_router(
    service: CollaborationContextService,
) -> APIRouter:
    router = APIRouter(prefix="/api/harness/context-packages", tags=["collaboration-context"])

    def translate(error: Exception) -> HTTPException:
        if isinstance(error, HarnessNotFound):
            return http_problem(status_code=404, error=error)
        if isinstance(error, HarnessConflict):
            return http_problem(status_code=409, error=error)
        return http_problem(status_code=422, error=error)

    @router.post("/{package_id}/revisions", status_code=201)
    async def revise_package(
        package_id: str,
        command: ReviseContextPackageRequest,
    ) -> dict[str, Any]:
        try:
            payload = command.model_dump(exclude_none=True)
            payload["item_changes"] = [value.model_dump(exclude_none=True) for value in command.item_changes]
            payload["added_source_refs"] = [
                value.model_dump(exclude_none=True) for value in command.added_source_refs
            ]
            return await service.revise_package(
                package_id=package_id,
                **payload,
            )
        except (HarnessNotFound, HarnessConflict, HarnessValidationError) as error:
            raise translate(error) from error

    return router
