"""HTTP translation for the read-only Home projection."""

from __future__ import annotations

from fastapi import APIRouter, Query

from ..api import http_problem
from .service import HomeProjectionError, HomeProjectionService


def create_home_router(service: HomeProjectionService) -> APIRouter:
    router = APIRouter(prefix="/api/home", tags=["home"])

    @router.get("/overview")
    async def home_overview(
        year: int = Query(ge=2000, le=2100),
        utc_offset_minutes: int = Query(ge=-840, le=840),
    ) -> dict:
        try:
            return await service.overview(
                year=year,
                utc_offset_minutes=utc_offset_minutes,
            )
        except HomeProjectionError as error:
            raise http_problem(
                status_code=422,
                code="home_projection_invalid",
                message=str(error),
            ) from error

    return router
