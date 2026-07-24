"""REST management boundary for Project repository resources."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from ..api import http_problem
from ..harness.contracts import HarnessError
from .contracts import (
    ProjectResourceConflict,
    ProjectResourceNotFound,
)
from .directories import WorkspaceDirectoryBrowser
from .service import ProjectResourceService


class BindRepositoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: str = Field(min_length=1, max_length=160)
    expected_project_row_version: int = Field(ge=1)
    alias: str = Field(pattern=r"^[a-z][a-z0-9-]{0,63}$")
    display_name: str = Field(min_length=1, max_length=120)
    role: str
    root_key: str = Field(min_length=1, max_length=64)
    relative_path: str = Field(default=".", max_length=4096)
    decision_record_id: str | None = None


class RefreshRepositoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: str = Field(min_length=1, max_length=160)
    expected_binding_row_version: int = Field(ge=1)
    decision_record_id: str | None = None


class RebindRepositoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: str = Field(min_length=1, max_length=160)
    expected_project_row_version: int = Field(ge=1)
    expected_binding_row_version: int = Field(ge=1)
    display_name: str = Field(min_length=1, max_length=120)
    role: str
    root_key: str = Field(min_length=1, max_length=64)
    relative_path: str = Field(default=".", max_length=4096)
    decision_record_id: str | None = None


class DetachRepositoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: str = Field(min_length=1, max_length=160)
    expected_project_row_version: int = Field(ge=1)
    expected_binding_row_version: int = Field(ge=1)
    decision_record_id: str | None = None


def create_project_resource_router(service: ProjectResourceService) -> APIRouter:
    """Translate Product-safe failures without owning a transaction."""

    router = APIRouter(prefix="/api/harness", tags=["project-repositories"])
    directories = WorkspaceDirectoryBrowser(service.catalog)

    def translate(error: HarnessError) -> HTTPException:
        if isinstance(error, ProjectResourceNotFound) or error.code in {
            "REPOSITORY_NOT_FOUND",
            "REPOSITORY_ROOT_NOT_FOUND",
        }:
            status_code = 404
        elif isinstance(error, ProjectResourceConflict) or error.code in {
            "REPOSITORY_DETACHED",
            "REPOSITORY_ALREADY_DETACHED",
        }:
            status_code = 409
        elif error.code == "REPOSITORY_INSPECTION_TIMEOUT":
            status_code = 504
        elif error.code == "REPOSITORY_GIT_UNAVAILABLE":
            status_code = 503
        else:
            status_code = 422
        return http_problem(status_code=status_code, error=error)

    def root_label(root_key: str) -> str:
        root = service.catalog.get(root_key)
        return root.label if root else "未配置的Workspace Root"

    def binding_payload(value: dict[str, Any]) -> dict[str, Any]:
        return {
            **value,
            "root_label": root_label(str(value.get("root_key") or "")),
        }

    def result_payload(value: dict[str, Any]) -> dict[str, Any]:
        return {
            **value,
            "binding": binding_payload(dict(value["binding"])),
        }

    @router.get("/repository-roots")
    async def list_repository_roots() -> dict[str, Any]:
        return {
            "catalog_revision": service.catalog.revision,
            "roots": service.catalog.list_public(),
        }

    @router.get("/repository-roots/{root_key}/directories")
    async def list_repository_directories(
        root_key: str,
        relative_path: str = ".",
        cursor: str | None = None,
        limit: int = Query(default=50, ge=1, le=100),
    ) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(
                directories.list_directories,
                root_key=root_key,
                relative_path=relative_path,
                cursor=cursor,
                limit=limit,
            )
        except HarnessError as error:
            raise translate(error) from error

    @router.get("/projects/{project_id}/repositories")
    async def list_project_repositories(project_id: str) -> dict[str, Any]:
        try:
            values = await service.list_summaries(project_id=project_id)
            return {
                "repositories": [
                    {
                        **value,
                        "binding": binding_payload(value["binding"]),
                    }
                    for value in values
                ]
            }
        except HarnessError as error:
            raise translate(error) from error

    @router.post("/projects/{project_id}/repositories", status_code=201)
    async def bind_project_repository(
        project_id: str,
        command: BindRepositoryRequest,
    ) -> dict[str, Any]:
        try:
            return result_payload(
                await service.bind_repository(
                    project_id=project_id,
                    **command.model_dump(),
                )
            )
        except HarnessError as error:
            raise translate(error) from error

    @router.get("/repositories/{binding_id}")
    async def get_repository(binding_id: str) -> dict[str, Any]:
        try:
            result = await service.get_binding(binding_id)
            return {
                **result,
                "binding": binding_payload(result["binding"]),
            }
        except HarnessError as error:
            raise translate(error) from error

    @router.post("/repositories/{binding_id}/refresh")
    async def refresh_repository(
        binding_id: str,
        command: RefreshRepositoryRequest,
    ) -> dict[str, Any]:
        try:
            return result_payload(
                await service.refresh_repository(
                    binding_id=binding_id,
                    **command.model_dump(),
                )
            )
        except HarnessError as error:
            raise translate(error) from error

    @router.post("/repositories/{binding_id}/rebind")
    async def rebind_repository(
        binding_id: str,
        command: RebindRepositoryRequest,
    ) -> dict[str, Any]:
        try:
            current = await service.get_binding(binding_id)
            return result_payload(
                await service.rebind_repository(
                    project_id=current["binding"]["project_id"],
                    binding_id=binding_id,
                    **command.model_dump(),
                )
            )
        except HarnessError as error:
            raise translate(error) from error

    @router.post("/repositories/{binding_id}/detach")
    async def detach_repository(
        binding_id: str,
        command: DetachRepositoryRequest,
    ) -> dict[str, Any]:
        try:
            current = await service.get_binding(binding_id)
            return result_payload(
                await service.detach_repository(
                    project_id=current["binding"]["project_id"],
                    binding_id=binding_id,
                    **command.model_dump(),
                )
            )
        except HarnessError as error:
            raise translate(error) from error

    @router.get("/repositories/{binding_id}/snapshots")
    async def list_repository_snapshots(
        binding_id: str,
        cursor: str | None = None,
        limit: int = Query(default=50, ge=1, le=100),
    ) -> dict[str, Any]:
        try:
            return await service.page_snapshots(
                binding_id=binding_id,
                cursor=cursor,
                limit=limit,
            )
        except HarnessError as error:
            raise translate(error) from error

    return router
