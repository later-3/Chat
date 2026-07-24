"""Application coordinator for Project repository membership and snapshots."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from ..harness.commands import HarnessCommandRecorder
from ..harness.contracts import HarnessConflict, content_hash, new_id
from ..harness.models import ProductProjectRecord
from ..product_sessions.database import (
    ProductDatabase,
    affected_row_count,
    utc_now,
)
from ..product_sessions.service import DEFAULT_SCOPE_ID
from .catalog import WorkspaceRootCatalog
from .contracts import (
    ProjectResourceConflict,
    ProjectResourceNotFound,
    ProjectResourceValidationError,
    RepositoryInspection,
    RepositoryInspectionError,
    validate_alias,
    validate_display_name,
    validate_role,
)
from .git_inspector import ReadOnlyGitInspector
from .models import ProjectRepositoryBindingRecord, RepositorySnapshotRecord
from .mutations import ProjectResourceMutationRules
from .paths import SafeRepositoryPath, normalize_relative_path, resolve_repository_path
from .queries import ProjectResourceQueryService
from .snapshots import (
    available_snapshot,
    command_result,
    trace_payload,
    unavailable_snapshot,
)

logger = logging.getLogger(__name__)


class ProjectResourceService:
    """Own repository Binding mutations and immutable Snapshot transactions.

    Filesystem and Git observation happens between two short database
    transactions. The final transaction owns every domain fact, command,
    Product Trace and Outbox event, so a failed commit cannot leave a partial
    Project resource.
    """

    def __init__(
        self,
        database: ProductDatabase,
        *,
        catalog: WorkspaceRootCatalog,
        inspector: ReadOnlyGitInspector,
        scope_id: str = DEFAULT_SCOPE_ID,
        principal_id: str = "local-user",
        clock=utc_now,
    ) -> None:
        self.database = database
        self.catalog = catalog
        self.inspector = inspector
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock
        self._commands = HarnessCommandRecorder(
            scope_id=scope_id,
            principal_id=principal_id,
            clock=clock,
        )
        self.queries = ProjectResourceQueryService(database, scope_id=scope_id)
        self._mutations = ProjectResourceMutationRules(scope_id=scope_id)

    async def initialize(self) -> None:
        """Reconcile configured root identities without touching Git."""

        await self.reconcile_catalog()

    async def list_bindings(self, *, project_id: str) -> list[dict[str, Any]]:
        return await self.queries.list_bindings(project_id=project_id)

    async def list_summaries(self, *, project_id: str) -> list[dict[str, Any]]:
        return await self.queries.list_summaries(project_id=project_id)

    async def get_binding(self, binding_id: str) -> dict[str, Any]:
        return await self.queries.get_binding(binding_id)

    async def list_snapshots(
        self,
        *,
        binding_id: str,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        return await self.queries.list_snapshots(binding_id=binding_id, limit=limit)

    async def page_snapshots(
        self,
        *,
        binding_id: str,
        cursor: str | None,
        limit: int,
    ) -> dict[str, Any]:
        return await self.queries.page_snapshots(
            binding_id=binding_id,
            cursor=cursor,
            limit=limit,
        )

    async def bind_repository(
        self,
        *,
        command_id: str,
        project_id: str,
        expected_project_row_version: int,
        alias: str,
        display_name: str,
        role: str,
        root_key: str,
        relative_path: str,
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        alias = validate_alias(alias)
        display_name = validate_display_name(display_name)
        role = validate_role(role)
        root_key = root_key.strip()
        relative_path = normalize_relative_path(relative_path)
        request = {
            "project_id": project_id,
            "expected_project_row_version": expected_project_row_version,
            "alias": alias,
            "display_name": display_name,
            "role": role,
            "root_key": root_key,
            "relative_path": relative_path,
        }
        request_hash = content_hash(request)
        if existing := await self._preflight(command_id, request_hash):
            return existing
        await self._require_project_version(project_id, expected_project_row_version)
        repository = self._resolve(root_key, relative_path)
        inspection = await self.inspector.inspect(repository, binding_generation=1)
        binding_id = new_id()
        now = self._clock()
        try:
            async with self.database.sessions.begin() as transaction:
                if existing := await self._commands.existing(
                    transaction,
                    command_id,
                    request_hash,
                ):
                    return existing
                project = await self._mutations.project(transaction, project_id)
                await self._mutations.fence_project(
                    transaction,
                    project=project,
                    expected_version=expected_project_row_version,
                    now=now,
                )
                await self._mutations.assert_member_invariants(
                    transaction,
                    project_id=project_id,
                    alias=alias,
                    role=role,
                    locator_hash=repository.locator_hash,
                )
                binding = ProjectRepositoryBindingRecord(
                    id=binding_id,
                    scope_id=self.scope_id,
                    project_id=project_id,
                    alias=alias,
                    display_name=display_name,
                    role=role,
                    root_key=repository.root_key,
                    root_identity_hash=repository.root_identity_hash,
                    relative_path=repository.relative_path,
                    locator_hash=repository.locator_hash,
                    generation=1,
                    status="active",
                    status_reason_code=None,
                    latest_snapshot_sequence=1,
                    row_version=1,
                    created_by=self.principal_id,
                    updated_by=self.principal_id,
                    created_at=now,
                    updated_at=now,
                )
                snapshot = available_snapshot(
                    scope_id=self.scope_id,
                    binding_id=binding.id,
                    generation=1,
                    sequence=1,
                    repository=repository,
                    inspection=inspection,
                )
                transaction.add(binding)
                transaction.add(snapshot)
                result = command_result(
                    binding=binding,
                    snapshot=snapshot,
                    project_row_version=expected_project_row_version + 1,
                )
                self._commands.record(
                    transaction,
                    command_id=command_id,
                    command_kind="bind_project_repository",
                    request_hash=request_hash,
                    result=result,
                    resource_kind="repository_binding",
                    resource_id=binding.id,
                    event_type="harness.repository.bound",
                    trace_payload=trace_payload(binding, snapshot),
                    decision_record_id=decision_record_id,
                )
            logger.info(
                "project_repository_command_finished command_kind=bind result=active "
                "command_id=%s project_id=%s repository_binding_id=%s",
                command_id,
                project_id,
                binding_id,
            )
            return result
        except (ProjectResourceConflict, IntegrityError) as error:
            if existing := await self._preflight(command_id, request_hash):
                return existing
            raise ProjectResourceConflict("Project资源并发冲突，请刷新后重试") from error

    async def refresh_repository(
        self,
        *,
        command_id: str,
        binding_id: str,
        expected_binding_row_version: int,
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        request = {
            "binding_id": binding_id,
            "expected_binding_row_version": expected_binding_row_version,
        }
        request_hash = content_hash(request)
        if existing := await self._preflight(command_id, request_hash):
            return existing
        baseline = await self._binding_baseline(
            binding_id,
            expected_binding_row_version=expected_binding_row_version,
            allow_detached=False,
        )
        inspection: RepositoryInspection | None = None
        inspection_error: RepositoryInspectionError | ProjectResourceValidationError | None = None
        repository: SafeRepositoryPath | None = None
        try:
            repository = self._resolve(baseline.root_key, baseline.relative_path)
            if repository.root_identity_hash != baseline.root_identity_hash:
                raise ProjectResourceValidationError(
                    "Workspace Root身份已变化，需要重新绑定",
                    code="REPOSITORY_ROOT_IDENTITY_CHANGED",
                )
            inspection = await self.inspector.inspect(
                repository,
                binding_generation=baseline.generation,
            )
        except (RepositoryInspectionError, ProjectResourceValidationError) as error:
            inspection_error = error

        now = self._clock()
        try:
            async with self.database.sessions.begin() as transaction:
                if existing := await self._commands.existing(
                    transaction,
                    command_id,
                    request_hash,
                ):
                    return existing
                binding = await self._mutations.binding(transaction, binding_id)
                if binding.status == "detached":
                    raise ProjectResourceValidationError(
                        "已解除的Repository不能刷新",
                        code="REPOSITORY_DETACHED",
                    )
                sequence = binding.latest_snapshot_sequence + 1
                previous_sequence = binding.latest_snapshot_sequence
                status = "active" if inspection is not None else "unavailable"
                reason_code = inspection_error.code if inspection_error else None
                result_update = await transaction.execute(
                    update(ProjectRepositoryBindingRecord)
                    .where(
                        ProjectRepositoryBindingRecord.id == binding.id,
                        ProjectRepositoryBindingRecord.scope_id == self.scope_id,
                        ProjectRepositoryBindingRecord.row_version == expected_binding_row_version,
                        ProjectRepositoryBindingRecord.generation == baseline.generation,
                        ProjectRepositoryBindingRecord.locator_hash == baseline.locator_hash,
                    )
                    .values(
                        status=status,
                        status_reason_code=reason_code,
                        latest_snapshot_sequence=sequence,
                        row_version=ProjectRepositoryBindingRecord.row_version + 1,
                        updated_by=self.principal_id,
                        updated_at=now,
                        detached_at=None,
                    )
                )
                if affected_row_count(result_update) != 1:
                    raise ProjectResourceConflict("Repository Binding版本冲突")
                previous_snapshot = await transaction.scalar(
                    select(RepositorySnapshotRecord).where(
                        RepositorySnapshotRecord.binding_id == binding.id,
                        RepositorySnapshotRecord.sequence == previous_sequence,
                    )
                )
                snapshot = (
                    available_snapshot(
                        scope_id=self.scope_id,
                        binding_id=binding.id,
                        generation=binding.generation,
                        sequence=sequence,
                        repository=repository,
                        inspection=inspection,
                    )
                    if inspection is not None and repository is not None
                    else unavailable_snapshot(
                        scope_id=self.scope_id,
                        binding=binding,
                        sequence=sequence,
                        error=inspection_error,
                        clock=self._clock,
                    )
                )
                transaction.add(snapshot)
                binding.status = status
                binding.status_reason_code = reason_code
                binding.latest_snapshot_sequence = sequence
                binding.row_version = expected_binding_row_version + 1
                binding.updated_by = self.principal_id
                binding.updated_at = now
                binding.detached_at = None
                result = command_result(binding=binding, snapshot=snapshot)
                event_type = (
                    "harness.repository.refreshed"
                    if inspection is not None
                    else "harness.repository.unavailable"
                )
                trace = trace_payload(binding, snapshot)
                trace["previous_semantic_hash"] = (
                    previous_snapshot.semantic_hash if previous_snapshot else None
                )
                self._commands.record(
                    transaction,
                    command_id=command_id,
                    command_kind="refresh_project_repository",
                    request_hash=request_hash,
                    result=result,
                    resource_kind="repository_binding",
                    resource_id=binding.id,
                    event_type=event_type,
                    trace_payload=trace,
                    decision_record_id=decision_record_id,
                )
            logger.info(
                "project_repository_command_finished command_kind=refresh result=%s "
                "command_id=%s repository_binding_id=%s",
                status,
                command_id,
                binding_id,
            )
            return result
        except (ProjectResourceConflict, IntegrityError) as error:
            if existing := await self._preflight(command_id, request_hash):
                return existing
            raise ProjectResourceConflict("Repository Binding并发冲突，请刷新后重试") from error

    async def rebind_repository(
        self,
        *,
        command_id: str,
        project_id: str,
        binding_id: str,
        expected_project_row_version: int,
        expected_binding_row_version: int,
        display_name: str,
        role: str,
        root_key: str,
        relative_path: str,
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        display_name = validate_display_name(display_name)
        role = validate_role(role)
        root_key = root_key.strip()
        relative_path = normalize_relative_path(relative_path)
        request = {
            "project_id": project_id,
            "binding_id": binding_id,
            "expected_project_row_version": expected_project_row_version,
            "expected_binding_row_version": expected_binding_row_version,
            "display_name": display_name,
            "role": role,
            "root_key": root_key,
            "relative_path": relative_path,
        }
        request_hash = content_hash(request)
        if existing := await self._preflight(command_id, request_hash):
            return existing
        await self._require_project_version(project_id, expected_project_row_version)
        baseline = await self._binding_baseline(
            binding_id,
            expected_binding_row_version=expected_binding_row_version,
            project_id=project_id,
            allow_detached=True,
        )
        repository = self._resolve(root_key, relative_path)
        generation = baseline.generation + 1
        inspection = await self.inspector.inspect(
            repository,
            binding_generation=generation,
        )
        now = self._clock()
        try:
            async with self.database.sessions.begin() as transaction:
                if existing := await self._commands.existing(
                    transaction,
                    command_id,
                    request_hash,
                ):
                    return existing
                project = await self._mutations.project(transaction, project_id)
                binding = await self._mutations.binding(transaction, binding_id)
                if binding.project_id != project_id:
                    raise ProjectResourceNotFound("Repository Binding不属于当前Project")
                await self._mutations.fence_project(
                    transaction,
                    project=project,
                    expected_version=expected_project_row_version,
                    now=now,
                )
                await self._mutations.assert_member_invariants(
                    transaction,
                    project_id=project_id,
                    alias=binding.alias,
                    role=role,
                    locator_hash=repository.locator_hash,
                    exclude_binding_id=binding.id,
                    check_alias=False,
                )
                sequence = binding.latest_snapshot_sequence + 1
                result_update = await transaction.execute(
                    update(ProjectRepositoryBindingRecord)
                    .where(
                        ProjectRepositoryBindingRecord.id == binding.id,
                        ProjectRepositoryBindingRecord.scope_id == self.scope_id,
                        ProjectRepositoryBindingRecord.row_version == expected_binding_row_version,
                        ProjectRepositoryBindingRecord.generation == baseline.generation,
                    )
                    .values(
                        display_name=display_name,
                        role=role,
                        root_key=repository.root_key,
                        root_identity_hash=repository.root_identity_hash,
                        relative_path=repository.relative_path,
                        locator_hash=repository.locator_hash,
                        generation=generation,
                        status="active",
                        status_reason_code=None,
                        latest_snapshot_sequence=sequence,
                        row_version=ProjectRepositoryBindingRecord.row_version + 1,
                        updated_by=self.principal_id,
                        updated_at=now,
                        detached_at=None,
                    )
                )
                if affected_row_count(result_update) != 1:
                    raise ProjectResourceConflict("Repository Binding版本冲突")
                snapshot = available_snapshot(
                    scope_id=self.scope_id,
                    binding_id=binding.id,
                    generation=generation,
                    sequence=sequence,
                    repository=repository,
                    inspection=inspection,
                )
                transaction.add(snapshot)
                binding.display_name = display_name
                binding.role = role
                binding.root_key = repository.root_key
                binding.root_identity_hash = repository.root_identity_hash
                binding.relative_path = repository.relative_path
                binding.locator_hash = repository.locator_hash
                binding.generation = generation
                binding.status = "active"
                binding.status_reason_code = None
                binding.latest_snapshot_sequence = sequence
                binding.row_version = expected_binding_row_version + 1
                binding.updated_by = self.principal_id
                binding.updated_at = now
                binding.detached_at = None
                result = command_result(
                    binding=binding,
                    snapshot=snapshot,
                    project_row_version=expected_project_row_version + 1,
                )
                self._commands.record(
                    transaction,
                    command_id=command_id,
                    command_kind="rebind_project_repository",
                    request_hash=request_hash,
                    result=result,
                    resource_kind="repository_binding",
                    resource_id=binding.id,
                    event_type="harness.repository.rebound",
                    trace_payload=trace_payload(binding, snapshot),
                    decision_record_id=decision_record_id,
                )
            logger.info(
                "project_repository_command_finished command_kind=rebind result=active "
                "command_id=%s project_id=%s repository_binding_id=%s",
                command_id,
                project_id,
                binding_id,
            )
            return result
        except (ProjectResourceConflict, IntegrityError) as error:
            if existing := await self._preflight(command_id, request_hash):
                return existing
            raise ProjectResourceConflict("Project资源并发冲突，请刷新后重试") from error

    async def detach_repository(
        self,
        *,
        command_id: str,
        project_id: str,
        binding_id: str,
        expected_project_row_version: int,
        expected_binding_row_version: int,
        decision_record_id: str | None = None,
    ) -> dict[str, Any]:
        request = {
            "project_id": project_id,
            "binding_id": binding_id,
            "expected_project_row_version": expected_project_row_version,
            "expected_binding_row_version": expected_binding_row_version,
        }
        request_hash = content_hash(request)
        if existing := await self._preflight(command_id, request_hash):
            return existing
        now = self._clock()
        try:
            async with self.database.sessions.begin() as transaction:
                if existing := await self._commands.existing(
                    transaction,
                    command_id,
                    request_hash,
                ):
                    return existing
                project = await self._mutations.project(transaction, project_id)
                binding = await self._mutations.binding(transaction, binding_id)
                if binding.project_id != project_id:
                    raise ProjectResourceNotFound("Repository Binding不属于当前Project")
                if binding.status == "detached":
                    raise ProjectResourceValidationError(
                        "Repository Binding已经解除",
                        code="REPOSITORY_ALREADY_DETACHED",
                    )
                await self._mutations.fence_project(
                    transaction,
                    project=project,
                    expected_version=expected_project_row_version,
                    now=now,
                )
                result_update = await transaction.execute(
                    update(ProjectRepositoryBindingRecord)
                    .where(
                        ProjectRepositoryBindingRecord.id == binding.id,
                        ProjectRepositoryBindingRecord.scope_id == self.scope_id,
                        ProjectRepositoryBindingRecord.row_version == expected_binding_row_version,
                    )
                    .values(
                        status="detached",
                        status_reason_code="REPOSITORY_DETACHED",
                        row_version=ProjectRepositoryBindingRecord.row_version + 1,
                        updated_by=self.principal_id,
                        updated_at=now,
                        detached_at=now,
                    )
                )
                if affected_row_count(result_update) != 1:
                    raise ProjectResourceConflict("Repository Binding版本冲突")
                binding.status = "detached"
                binding.status_reason_code = "REPOSITORY_DETACHED"
                binding.row_version = expected_binding_row_version + 1
                binding.updated_by = self.principal_id
                binding.updated_at = now
                binding.detached_at = now
                result = command_result(
                    binding=binding,
                    snapshot=None,
                    project_row_version=expected_project_row_version + 1,
                )
                self._commands.record(
                    transaction,
                    command_id=command_id,
                    command_kind="detach_project_repository",
                    request_hash=request_hash,
                    result=result,
                    resource_kind="repository_binding",
                    resource_id=binding.id,
                    event_type="harness.repository.detached",
                    trace_payload={
                        "status": "detached",
                        "generation": binding.generation,
                        "sequence": binding.latest_snapshot_sequence,
                    },
                    decision_record_id=decision_record_id,
                )
            logger.info(
                "project_repository_command_finished command_kind=detach result=detached "
                "command_id=%s project_id=%s repository_binding_id=%s",
                command_id,
                project_id,
                binding_id,
            )
            return result
        except (ProjectResourceConflict, IntegrityError) as error:
            if existing := await self._preflight(command_id, request_hash):
                return existing
            raise ProjectResourceConflict("Project资源并发冲突，请刷新后重试") from error

    async def reconcile_catalog(self) -> int:
        """Invalidate bindings whose configured Root identity disappeared."""

        async with self.database.sessions() as transaction:
            baselines = list(
                (
                    await transaction.scalars(
                        select(ProjectRepositoryBindingRecord).where(
                            ProjectRepositoryBindingRecord.scope_id == self.scope_id,
                            ProjectRepositoryBindingRecord.status != "detached",
                        )
                    )
                ).all()
            )
        changed = 0
        for baseline in baselines:
            identity = self.catalog.identity_for(baseline.root_key)
            if identity == baseline.root_identity_hash:
                continue
            command_id = f"catalog-reconcile:{self.catalog.revision}:{baseline.id}"
            request_hash = content_hash(
                {
                    "catalog_revision": self.catalog.revision,
                    "binding_id": baseline.id,
                }
            )
            async with self.database.sessions.begin() as transaction:
                if await self._commands.existing(transaction, command_id, request_hash):
                    continue
                result_update = await transaction.execute(
                    update(ProjectRepositoryBindingRecord)
                    .where(
                        ProjectRepositoryBindingRecord.id == baseline.id,
                        ProjectRepositoryBindingRecord.scope_id == self.scope_id,
                        ProjectRepositoryBindingRecord.row_version == baseline.row_version,
                        ProjectRepositoryBindingRecord.status != "detached",
                    )
                    .values(
                        status="unavailable",
                        status_reason_code="REPOSITORY_ROOT_IDENTITY_CHANGED",
                        row_version=ProjectRepositoryBindingRecord.row_version + 1,
                        updated_by="system",
                        updated_at=self._clock(),
                    )
                )
                if affected_row_count(result_update) != 1:
                    continue
                baseline.status = "unavailable"
                baseline.status_reason_code = "REPOSITORY_ROOT_IDENTITY_CHANGED"
                baseline.row_version += 1
                baseline.updated_by = "system"
                baseline.updated_at = self._clock()
                result = command_result(binding=baseline, snapshot=None)
                self._commands.record(
                    transaction,
                    command_id=command_id,
                    command_kind="reconcile_repository_catalog",
                    request_hash=request_hash,
                    result=result,
                    resource_kind="repository_binding",
                    resource_id=baseline.id,
                    event_type="harness.repository.catalog_invalidated",
                    trace_payload={
                        "status": "unavailable",
                        "generation": baseline.generation,
                        "sequence": baseline.latest_snapshot_sequence,
                        "error_code": "REPOSITORY_ROOT_IDENTITY_CHANGED",
                    },
                )
                changed += 1
        if changed:
            logger.warning(
                "project_repository_catalog_reconciled result=invalidated count=%d",
                changed,
            )
        return changed

    async def _preflight(
        self,
        command_id: str,
        request_hash: str,
    ) -> dict[str, Any] | None:
        async with self.database.sessions.begin() as transaction:
            try:
                return await self._commands.existing(
                    transaction,
                    command_id,
                    request_hash,
                )
            except HarnessConflict as error:
                raise ProjectResourceConflict(
                    str(error),
                    code="REPOSITORY_COMMAND_ID_CONFLICT",
                ) from error

    async def _require_project_version(
        self,
        project_id: str,
        expected_version: int,
    ) -> None:
        async with self.database.sessions() as transaction:
            project = await transaction.get(ProductProjectRecord, project_id)
            if project is None or project.scope_id != self.scope_id:
                raise ProjectResourceNotFound("Project不存在", code="PROJECT_NOT_FOUND")
            if project.status in {"archived", "cancelled"}:
                raise ProjectResourceValidationError(
                    "已结束的Project不能变更Repository",
                    code="PROJECT_NOT_MUTABLE",
                )
            if project.row_version != expected_version:
                raise ProjectResourceConflict("Project版本冲突")

    async def _binding_baseline(
        self,
        binding_id: str,
        *,
        expected_binding_row_version: int,
        project_id: str | None = None,
        allow_detached: bool,
    ) -> ProjectRepositoryBindingRecord:
        async with self.database.sessions() as transaction:
            binding = await transaction.get(ProjectRepositoryBindingRecord, binding_id)
            if binding is None or binding.scope_id != self.scope_id:
                raise ProjectResourceNotFound("Repository Binding不存在")
            if project_id is not None and binding.project_id != project_id:
                raise ProjectResourceNotFound("Repository Binding不属于当前Project")
            if binding.row_version != expected_binding_row_version:
                raise ProjectResourceConflict("Repository Binding版本冲突")
            if not allow_detached and binding.status == "detached":
                raise ProjectResourceValidationError(
                    "已解除的Repository不能执行此操作",
                    code="REPOSITORY_DETACHED",
                )
            transaction.expunge(binding)
            return binding

    def _resolve(self, root_key: str, relative_path: str) -> SafeRepositoryPath:
        return resolve_repository_path(
            self.catalog.require_available(root_key),
            relative_path,
        )
