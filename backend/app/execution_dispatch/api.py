"""REST projections for governed ToolExecution records."""

from __future__ import annotations

from fastapi import APIRouter

from ..api.errors import http_problem
from .service import ExecutionDispatchError, ExecutionDispatchService


def create_execution_dispatch_router(
    service: ExecutionDispatchService,
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/runs/{run_id}/tool-executions")
    async def list_tool_executions(run_id: str) -> dict[str, object]:
        return {"tool_executions": await service.list_for_run(run_id)}

    @router.get("/api/tool-executions/{execution_id}")
    async def get_tool_execution(execution_id: str) -> dict[str, object]:
        try:
            return await service.get(execution_id)
        except ExecutionDispatchError as error:
            raise http_problem(status_code=404, error=error) from error

    return router
