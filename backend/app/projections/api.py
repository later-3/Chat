"""REST adapters for stable product Read Models and Obsidian snapshots."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from ..api import http_problem
from .contracts import ProjectionNotFound, ProjectionValidationError
from .obsidian import render_obsidian_project_tree
from .service import ProjectionService


class SourceRevisionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    owner: str
    resource_kind: str
    resource_id: str
    revision: str
    updated_at: str | None


class ProjectionSectionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: Literal["available", "partial", "empty", "unknown", "forbidden", "error"]
    reason_code: str | None
    detail: str | None
    source_owner: str | None


class ProjectionFreshnessResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["fresh", "stale", "unknown"]
    as_of: str
    source_updated_at: str | None
    consistency: str
    reason_code: str | None


class ProjectionPermissionsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    authorization_mode: str
    audience: str
    principal_id: str
    allowed: list[str]
    denied: list[dict[str, str]]


class ProjectionEnvelopeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str
    view_schema: str
    view_type: str
    subject: dict[str, Any]
    projection_revision: str
    generated_at: str
    source_snapshot_at: str | None
    freshness: ProjectionFreshnessResponse
    source_revisions: list[SourceRevisionResponse]
    sections: dict[str, ProjectionSectionResponse]
    permissions: ProjectionPermissionsResponse
    data: dict[str, Any]


class ObsidianFileResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    media_type: str
    sha256: str
    size_bytes: int
    content: str


class ObsidianTreeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str
    adapter: str
    read_only: bool
    project_id: str
    projection_revision: str
    source_snapshot_at: str | None
    root_directory: str
    tree_hash: str
    archive_name: str
    file_count: int
    total_bytes: int
    files: list[ObsidianFileResponse]


def create_projection_router(service: ProjectionService) -> APIRouter:
    router = APIRouter(prefix="/api/projections", tags=["projections"])

    def translate(error: Exception) -> HTTPException:
        if isinstance(error, ProjectionNotFound):
            return http_problem(status_code=404, error=error)
        return http_problem(status_code=422, error=error)

    @router.get("/workspace", response_model=ProjectionEnvelopeResponse)
    async def workspace(response: Response, domain: str = "all") -> dict[str, Any]:
        try:
            projection = await service.workspace(domain=domain)
        except ProjectionValidationError as error:
            raise translate(error) from error
        response.headers.update(_projection_headers(projection["projection_revision"]))
        return projection

    @router.get(
        "/projects/{project_id}/dossier",
        response_model=ProjectionEnvelopeResponse,
    )
    async def project_dossier(project_id: str, response: Response) -> dict[str, Any]:
        try:
            projection = await service.project_dossier(project_id)
        except (ProjectionNotFound, ProjectionValidationError) as error:
            raise translate(error) from error
        response.headers.update(_projection_headers(projection["projection_revision"]))
        return projection

    @router.get(
        "/projects/{project_id}/obsidian/tree",
        response_model=ObsidianTreeResponse,
    )
    async def obsidian_tree(project_id: str, request: Request) -> Response:
        try:
            dossier = await service.project_dossier(project_id)
            tree = render_obsidian_project_tree(dossier)
        except (ProjectionNotFound, ProjectionValidationError) as error:
            raise translate(error) from error
        headers = _projection_headers(tree.projection_revision)
        if _etag_matches(request, tree.projection_revision):
            return Response(status_code=304, headers=headers)
        return JSONResponse(tree.view(include_content=True), headers=headers)

    @router.get("/projects/{project_id}/obsidian.zip")
    async def obsidian_archive(project_id: str, request: Request) -> Response:
        try:
            dossier = await service.project_dossier(project_id)
            tree = render_obsidian_project_tree(dossier)
        except (ProjectionNotFound, ProjectionValidationError) as error:
            raise translate(error) from error
        headers = {
            **_projection_headers(tree.projection_revision),
            "Content-Disposition": f'attachment; filename="{tree.archive_name}"',
            "X-Obsidian-Tree-Hash": tree.tree_hash,
        }
        if _etag_matches(request, tree.projection_revision):
            return Response(status_code=304, headers=headers)
        return Response(
            content=tree.zip_bytes(),
            media_type="application/zip",
            headers=headers,
        )

    return router


def _projection_headers(revision: str) -> dict[str, str]:
    return {
        "ETag": f'"{revision}"',
        "Cache-Control": "private, max-age=0, must-revalidate",
        "X-Projection-Revision": revision,
        "X-Projection-Schema-Version": "1.0",
    }


def _etag_matches(request: Request, revision: str) -> bool:
    candidates = {
        value.strip().removeprefix("W/").strip('"')
        for value in request.headers.get("if-none-match", "").split(",")
        if value.strip()
    }
    return revision in candidates or "*" in candidates
