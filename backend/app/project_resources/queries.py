"""Read-only Product Store queries for repository resources."""

from __future__ import annotations

from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.orm import aliased

from ..harness.models import ProductProjectRecord
from ..product_sessions.database import ProductDatabase
from .contracts import (
    ProjectResourceNotFound,
    ProjectResourceValidationError,
    binding_view,
    snapshot_view,
)
from .models import ProjectRepositoryBindingRecord, RepositorySnapshotRecord
from .pagination import decode_cursor, encode_cursor


class ProjectResourceQueryService:
    """Project repository projections without mutation or transaction ownership."""

    def __init__(self, database: ProductDatabase, *, scope_id: str) -> None:
        self._database = database
        self._scope_id = scope_id

    async def list_bindings(self, *, project_id: str) -> list[dict[str, Any]]:
        query = (
            select(ProjectRepositoryBindingRecord)
            .where(
                ProjectRepositoryBindingRecord.scope_id == self._scope_id,
                ProjectRepositoryBindingRecord.project_id == project_id,
            )
            .order_by(
                ProjectRepositoryBindingRecord.role,
                ProjectRepositoryBindingRecord.created_at,
            )
        )
        async with self._database.sessions() as transaction:
            return [binding_view(value) for value in (await transaction.scalars(query)).all()]

    async def list_summaries(self, *, project_id: str) -> list[dict[str, Any]]:
        latest_snapshot = aliased(RepositorySnapshotRecord)
        last_available_snapshot = aliased(RepositorySnapshotRecord)
        last_available_sequence = (
            select(func.max(RepositorySnapshotRecord.sequence))
            .where(
                RepositorySnapshotRecord.binding_id == ProjectRepositoryBindingRecord.id,
                RepositorySnapshotRecord.capture_status == "available",
            )
            .correlate(ProjectRepositoryBindingRecord)
            .scalar_subquery()
        )
        query = (
            select(
                ProjectRepositoryBindingRecord,
                latest_snapshot,
                last_available_snapshot,
            )
            .outerjoin(
                latest_snapshot,
                and_(
                    latest_snapshot.binding_id == ProjectRepositoryBindingRecord.id,
                    latest_snapshot.sequence == ProjectRepositoryBindingRecord.latest_snapshot_sequence,
                ),
            )
            .outerjoin(
                last_available_snapshot,
                and_(
                    last_available_snapshot.binding_id == ProjectRepositoryBindingRecord.id,
                    last_available_snapshot.sequence == last_available_sequence,
                ),
            )
            .where(
                ProjectRepositoryBindingRecord.scope_id == self._scope_id,
                ProjectRepositoryBindingRecord.project_id == project_id,
            )
            .order_by(
                ProjectRepositoryBindingRecord.role,
                ProjectRepositoryBindingRecord.created_at,
            )
        )
        async with self._database.sessions() as transaction:
            project = await transaction.get(ProductProjectRecord, project_id)
            if project is None or project.scope_id != self._scope_id:
                raise ProjectResourceNotFound(
                    "Project不存在",
                    code="PROJECT_NOT_FOUND",
                )
            rows = (await transaction.execute(query)).all()
        return [
            {
                "binding": binding_view(binding),
                "latest_snapshot": snapshot_view(snapshot) if snapshot else None,
                "last_available_snapshot": (
                    snapshot_view(available_snapshot) if available_snapshot else None
                ),
            }
            for binding, snapshot, available_snapshot in rows
        ]

    async def get_binding(self, binding_id: str) -> dict[str, Any]:
        async with self._database.sessions() as transaction:
            binding = await transaction.get(ProjectRepositoryBindingRecord, binding_id)
            if binding is None or binding.scope_id != self._scope_id:
                raise ProjectResourceNotFound("Repository Binding不存在")
            snapshot = await transaction.scalar(
                select(RepositorySnapshotRecord)
                .where(
                    RepositorySnapshotRecord.binding_id == binding.id,
                    RepositorySnapshotRecord.sequence == binding.latest_snapshot_sequence,
                )
                .limit(1)
            )
            return {
                "binding": binding_view(binding),
                "latest_snapshot": snapshot_view(snapshot) if snapshot else None,
            }

    async def list_snapshots(
        self,
        *,
        binding_id: str,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        return (
            await self.page_snapshots(
                binding_id=binding_id,
                cursor=None,
                limit=limit,
            )
        )["snapshots"]

    async def page_snapshots(
        self,
        *,
        binding_id: str,
        cursor: str | None,
        limit: int,
    ) -> dict[str, Any]:
        bounded_limit = min(max(limit, 1), 100)
        cursor_payload = decode_cursor(cursor, kind="repository-snapshot")
        before_sequence: int | None = None
        if cursor_payload is not None:
            if (
                cursor_payload.get("binding_id") != binding_id
                or not isinstance(cursor_payload.get("before_sequence"), int)
                or cursor_payload["before_sequence"] < 1
            ):
                raise ProjectResourceValidationError(
                    "Repository Snapshot游标与Binding不匹配",
                    code="REPOSITORY_CURSOR_INVALID",
                )
            before_sequence = cursor_payload["before_sequence"]
        async with self._database.sessions() as transaction:
            binding = await transaction.get(ProjectRepositoryBindingRecord, binding_id)
            if binding is None or binding.scope_id != self._scope_id:
                raise ProjectResourceNotFound("Repository Binding不存在")
            query = select(RepositorySnapshotRecord).where(
                RepositorySnapshotRecord.scope_id == self._scope_id,
                RepositorySnapshotRecord.binding_id == binding_id,
            )
            if before_sequence is not None:
                query = query.where(RepositorySnapshotRecord.sequence < before_sequence)
            values = list(
                (
                    await transaction.scalars(
                        query.order_by(RepositorySnapshotRecord.sequence.desc()).limit(bounded_limit + 1)
                    )
                ).all()
            )
        page = values[:bounded_limit]
        next_cursor = None
        if len(values) > bounded_limit and page:
            next_cursor = encode_cursor(
                {
                    "kind": "repository-snapshot",
                    "binding_id": binding_id,
                    "before_sequence": page[-1].sequence,
                }
            )
        return {
            "snapshots": [snapshot_view(value) for value in page],
            "next_cursor": next_cursor,
        }
