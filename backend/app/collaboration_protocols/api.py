"""REST resource surface for Chat Harness collaboration methods."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..api import http_problem
from .contracts import (
    ProtocolConflict,
    ProtocolNotFound,
    ProtocolValidationError,
)
from .service import CollaborationProtocolService


class UpsertProtocolBindingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: str
    scope_kind: str
    scope_ref_id: str
    scenario_kind: str
    protocol_definition_id: str
    parameter_overrides: dict[str, Any] = Field(default_factory=dict)
    disabled_rule_keys: list[str] = Field(default_factory=list)
    status: str = "active"
    expected_row_version: int | None = None


def create_collaboration_protocol_router(
    service: CollaborationProtocolService,
) -> APIRouter:
    router = APIRouter(prefix="/api/harness/protocols", tags=["collaboration-protocols"])

    def translate(error: Exception) -> HTTPException:
        if isinstance(error, ProtocolNotFound):
            return http_problem(status_code=404, error=error)
        if isinstance(error, ProtocolConflict):
            return http_problem(status_code=409, error=error)
        return http_problem(status_code=422, error=error)

    @router.get("")
    async def list_definitions(include_inactive: bool = False) -> dict[str, Any]:
        return {
            "protocols": await service.list_definitions(
                include_inactive=include_inactive,
            )
        }

    @router.get("/bindings")
    async def list_bindings(
        scope_kind: str | None = None,
        scope_ref_id: str | None = None,
        scenario_kind: str | None = None,
    ) -> dict[str, Any]:
        return {
            "bindings": await service.list_bindings(
                scope_kind=scope_kind,
                scope_ref_id=scope_ref_id,
                scenario_kind=scenario_kind,
            )
        }

    @router.get("/configuration")
    async def configuration() -> dict[str, Any]:
        return await service.configuration()

    @router.put("/bindings")
    async def upsert_binding(command: UpsertProtocolBindingRequest) -> dict[str, Any]:
        try:
            return await service.upsert_binding(**command.model_dump())
        except (ProtocolNotFound, ProtocolConflict, ProtocolValidationError) as error:
            raise translate(error) from error

    @router.get("/{definition_id}")
    async def get_definition(definition_id: str) -> dict[str, Any]:
        try:
            return await service.get_definition(definition_id)
        except ProtocolNotFound as error:
            raise translate(error) from error

    return router
