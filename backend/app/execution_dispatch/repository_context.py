"""Resolve and revalidate repository snapshot fences for governed execution."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import select

from ..product_sessions.database import ProductDatabase
from ..project_resources.catalog import WorkspaceRootCatalog
from ..project_resources.contracts import ProjectResourceConflict, ProjectResourceValidationError
from ..project_resources.models import (
    ProjectRepositoryBindingRecord,
    RepositorySnapshotRecord,
)
from ..project_resources.paths import resolve_repository_path
from .contracts import RepositoryFence


class RepositoryExecutionContextService:
    """Own the boundary between public repository identity and local filesystem paths."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        catalog: WorkspaceRootCatalog,
    ) -> None:
        self.database = database
        self._catalog = catalog

    async def resolve_fence(
        self,
        *,
        project_id: str,
        binding_id: str,
        expected_semantic_hash: str | None = None,
    ) -> RepositoryFence:
        """Resolve the current available snapshot and bind every mutable identity."""

        async with self.database.sessions() as transaction:
            binding = await transaction.get(ProjectRepositoryBindingRecord, binding_id)
            if binding is None or binding.project_id != project_id or binding.status != "active":
                raise ProjectResourceValidationError(
                    "Project Repository绑定不存在或不可用",
                    code="REPOSITORY_BINDING_UNAVAILABLE",
                )
            snapshot = await transaction.scalar(
                select(RepositorySnapshotRecord).where(
                    RepositorySnapshotRecord.binding_id == binding.id,
                    RepositorySnapshotRecord.sequence == binding.latest_snapshot_sequence,
                )
            )
            if snapshot is None or snapshot.capture_status != "available" or snapshot.semantic_hash is None:
                raise ProjectResourceValidationError(
                    "Repository最新Snapshot不可用于执行",
                    code="REPOSITORY_SNAPSHOT_UNAVAILABLE",
                )
            if expected_semantic_hash and snapshot.semantic_hash != expected_semantic_hash:
                raise ProjectResourceConflict(
                    "Repository Context已过期，需要重新生成ExecutionDraft",
                    code="REPOSITORY_CONTEXT_STALE",
                )
            return RepositoryFence(
                project_id=binding.project_id,
                binding_id=binding.id,
                snapshot_id=snapshot.id,
                binding_generation=binding.generation,
                snapshot_sequence=snapshot.sequence,
                semantic_hash=snapshot.semantic_hash,
                governance_manifest_hash=snapshot.governance_manifest_hash,
                head_oid=snapshot.head_oid,
                worktree_fingerprint=snapshot.worktree_fingerprint,
                root_key=binding.root_key,
                relative_path=binding.relative_path,
            )

    async def assert_fresh(self, fence: RepositoryFence) -> None:
        """Fail before process dispatch when any bound repository fact advanced."""

        current = await self.resolve_fence(
            project_id=fence.project_id,
            binding_id=fence.binding_id,
        )
        if current != fence:
            raise ProjectResourceConflict(
                "Repository Snapshot已变化，需要重新审核ExecutionDraft",
                code="REPOSITORY_SNAPSHOT_STALE",
            )

    async def resolve_private_path(self, fence: RepositoryFence) -> Path:
        """Resolve the local path only inside the adapter boundary after freshness checks."""

        await self.assert_fresh(fence)
        safe = resolve_repository_path(
            self._catalog.require_available(fence.root_key),
            fence.relative_path,
        )
        return safe.absolute_path
