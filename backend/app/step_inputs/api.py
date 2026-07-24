"""Designer read surface for actual Workflow step inputs."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from .service import StepInputProjectionService


def create_step_input_router(service: StepInputProjectionService) -> APIRouter:
    router = APIRouter(prefix="/api/runs", tags=["step-inputs"])

    @router.get("/{run_id}/step-inputs")
    async def list_step_inputs(run_id: str) -> dict[str, Any]:
        return {"step_inputs": await service.list_for_run(run_id)}

    return router
