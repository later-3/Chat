"""Caller-transaction mutation rules for the Project repository aggregate."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..harness.models import ProductProjectRecord
from ..product_sessions.database import affected_row_count
from .contracts import (
    ProjectResourceConflict,
    ProjectResourceNotFound,
    ProjectResourceValidationError,
)
from .models import ProjectRepositoryBindingRecord


class ProjectResourceMutationRules:
    """Enforce aggregate invariants without opening or committing transactions."""

    def __init__(self, *, scope_id: str) -> None:
        self._scope_id = scope_id

    async def project(
        self,
        transaction: AsyncSession,
        project_id: str,
    ) -> ProductProjectRecord:
        project = await transaction.get(ProductProjectRecord, project_id)
        if project is None or project.scope_id != self._scope_id:
            raise ProjectResourceNotFound("Project不存在", code="PROJECT_NOT_FOUND")
        if project.status in {"archived", "cancelled"}:
            raise ProjectResourceValidationError(
                "已结束的Project不能变更Repository",
                code="PROJECT_NOT_MUTABLE",
            )
        return project

    async def binding(
        self,
        transaction: AsyncSession,
        binding_id: str,
    ) -> ProjectRepositoryBindingRecord:
        binding = await transaction.get(ProjectRepositoryBindingRecord, binding_id)
        if binding is None or binding.scope_id != self._scope_id:
            raise ProjectResourceNotFound("Repository Binding不存在")
        return binding

    async def fence_project(
        self,
        transaction: AsyncSession,
        *,
        project: ProductProjectRecord,
        expected_version: int,
        now: datetime,
    ) -> None:
        result = await transaction.execute(
            update(ProductProjectRecord)
            .where(
                ProductProjectRecord.id == project.id,
                ProductProjectRecord.scope_id == self._scope_id,
                ProductProjectRecord.row_version == expected_version,
                ProductProjectRecord.status.not_in(("archived", "cancelled")),
            )
            .values(
                row_version=ProductProjectRecord.row_version + 1,
                updated_at=now,
            )
        )
        if affected_row_count(result) != 1:
            raise ProjectResourceConflict("Project版本冲突")
        project.row_version = expected_version + 1
        project.updated_at = now

    async def assert_member_invariants(
        self,
        transaction: AsyncSession,
        *,
        project_id: str,
        alias: str,
        role: str,
        locator_hash: str,
        exclude_binding_id: str | None = None,
        check_alias: bool = True,
    ) -> None:
        exclusions = (ProjectRepositoryBindingRecord.id != exclude_binding_id,) if exclude_binding_id else ()
        if check_alias:
            alias_count = await transaction.scalar(
                select(func.count())
                .select_from(ProjectRepositoryBindingRecord)
                .where(
                    ProjectRepositoryBindingRecord.scope_id == self._scope_id,
                    ProjectRepositoryBindingRecord.project_id == project_id,
                    ProjectRepositoryBindingRecord.alias == alias,
                    *exclusions,
                )
            )
            if alias_count:
                raise ProjectResourceConflict(
                    "Project内Repository alias已存在，请使用rebind",
                    code="REPOSITORY_ALIAS_CONFLICT",
                )
        locator_count = await transaction.scalar(
            select(func.count())
            .select_from(ProjectRepositoryBindingRecord)
            .where(
                ProjectRepositoryBindingRecord.scope_id == self._scope_id,
                ProjectRepositoryBindingRecord.project_id == project_id,
                ProjectRepositoryBindingRecord.locator_hash == locator_hash,
                ProjectRepositoryBindingRecord.status != "detached",
                *exclusions,
            )
        )
        if locator_count:
            raise ProjectResourceConflict(
                "Project已经绑定该Repository位置",
                code="REPOSITORY_LOCATOR_CONFLICT",
            )
        if role == "primary":
            primary_count = await transaction.scalar(
                select(func.count())
                .select_from(ProjectRepositoryBindingRecord)
                .where(
                    ProjectRepositoryBindingRecord.scope_id == self._scope_id,
                    ProjectRepositoryBindingRecord.project_id == project_id,
                    ProjectRepositoryBindingRecord.role == "primary",
                    ProjectRepositoryBindingRecord.status != "detached",
                    *exclusions,
                )
            )
            if primary_count:
                raise ProjectResourceConflict(
                    "Project只能有一个活动的primary Repository",
                    code="REPOSITORY_PRIMARY_CONFLICT",
                )
