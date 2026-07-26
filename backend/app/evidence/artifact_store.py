"""Content-addressed Artifact bytes and their Product Store coordinator.

The filesystem and Product Store cannot share an atomic transaction.  This
module therefore makes the crash order explicit: stage and fsync bytes,
publish without clobbering an existing digest, verify the published bytes,
then open the caller-visible Product Store transaction.  A crash before the
database commit leaves an orphan blob that the reconciler can identify; it can
never leave a committed ArtifactRevision pointing at bytes that were not
published first.
"""

from __future__ import annotations

import asyncio
import errno
import hashlib
import hmac
import logging
import os
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Callable

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from ..product_sessions.database import ProductDatabase
from .contracts import (
    ArtifactBlobMissing,
    ArtifactHashMismatch,
    ArtifactStorageConflict,
    ArtifactStoragePathInvalid,
    EvidenceConflict,
    EvidenceNotFound,
)
from .models import ArtifactBlobRecord, ArtifactRecord, ArtifactRevisionRecord
from .service import EvidenceRepository

logger = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


@dataclass(frozen=True, slots=True)
class StagedBlob:
    """One fsynced input and its deterministic final location."""

    scope_id: str
    scope_storage_key: str
    sha256: str
    size_bytes: int
    staging_path: Path
    storage_path: str


@dataclass(frozen=True, slots=True)
class ArtifactWriteResult:
    """Stable product identities returned by an idempotent write command."""

    artifact_id: str
    artifact_revision_id: str
    storage_blob_id: str
    sha256: str
    size_bytes: int
    revision_number: int


@dataclass(frozen=True, slots=True)
class ArtifactReconcileResult:
    staged_removed: int = 0
    physical_orphans_removed: int = 0
    rows_marked_orphan: int = 0
    rows_restored: int = 0
    rows_deleted: int = 0
    delete_failures: int = 0


class ArtifactStore:
    """Filesystem adapter for immutable, scope-isolated Artifact blobs."""

    def __init__(self, root: Path, *, scope_key_secret: bytes) -> None:
        if len(scope_key_secret) < 32:
            raise ValueError("Artifact scope key secret至少需要32字节")
        self.root = root.expanduser().resolve()
        self._scope_key_secret = scope_key_secret

    def scope_storage_key(self, scope_id: str) -> str:
        if not scope_id or len(scope_id) > 100:
            raise ArtifactStoragePathInvalid("Artifact scope_id无效")
        return hmac.new(
            self._scope_key_secret,
            scope_id.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()[:32]

    async def stage(self, scope_id: str, content: bytes) -> StagedBlob:
        return await asyncio.to_thread(self._stage, scope_id, content)

    async def publish(self, staged: StagedBlob) -> None:
        await asyncio.to_thread(self._publish, staged)

    async def cleanup_staging(self, staged: StagedBlob) -> None:
        await asyncio.to_thread(staged.staging_path.unlink, missing_ok=True)

    async def read(self, *, storage_path: str, sha256: str, size_bytes: int) -> bytes:
        return await asyncio.to_thread(
            self._read_verified,
            storage_path,
            sha256,
            size_bytes,
        )

    def resolve_storage_path(self, storage_path: str) -> Path:
        pure = PurePosixPath(storage_path)
        if pure.is_absolute() or not pure.parts or ".." in pure.parts:
            raise ArtifactStoragePathInvalid("Artifact storage_path必须是安全相对路径")
        candidate = (self.root / Path(*pure.parts)).resolve(strict=False)
        if candidate == self.root or not candidate.is_relative_to(self.root):
            raise ArtifactStoragePathInvalid("Artifact storage_path越出Store根目录")
        return candidate

    def scope_staging_directory(self, scope_id: str) -> Path:
        return self.root / "staging" / self.scope_storage_key(scope_id)

    def scope_blob_directory(self, scope_id: str) -> Path:
        return self.root / "blobs" / self.scope_storage_key(scope_id)

    def _stage(self, scope_id: str, content: bytes) -> StagedBlob:
        digest = hashlib.sha256(content).hexdigest()
        scope_key = self.scope_storage_key(scope_id)
        staging_directory = self.root / "staging" / scope_key
        staging_directory.mkdir(parents=True, exist_ok=True)
        staging_path = staging_directory / f"{uuid.uuid4()}.tmp"
        with staging_path.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        self._fsync_directory(staging_directory)
        return StagedBlob(
            scope_id=scope_id,
            scope_storage_key=scope_key,
            sha256=digest,
            size_bytes=len(content),
            staging_path=staging_path,
            storage_path=f"blobs/{scope_key}/{digest[:2]}/{digest}",
        )

    def _publish(self, staged: StagedBlob) -> None:
        final_path = self.resolve_storage_path(staged.storage_path)
        final_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            # hard-link creation is atomic and fails with EEXIST.  Unlike
            # os.replace it can never overwrite bytes referenced by another
            # ArtifactRevision.
            os.link(staged.staging_path, final_path)
            self._fsync_directory(final_path.parent)
        except FileExistsError:
            pass
        except OSError as error:
            if error.errno == errno.EEXIST:
                pass
            else:
                raise

        try:
            self._read_verified(staged.storage_path, staged.sha256, staged.size_bytes)
        except (ArtifactHashMismatch, ArtifactBlobMissing) as error:
            self._quarantine(staged)
            raise ArtifactStorageConflict("同一内容地址已存在不一致字节；既有Blob未被覆盖") from error

    def _read_verified(self, storage_path: str, sha256: str, size_bytes: int) -> bytes:
        target = self.resolve_storage_path(storage_path)
        try:
            content = target.read_bytes()
        except FileNotFoundError as error:
            raise ArtifactBlobMissing("Artifact Blob文件不存在") from error
        if len(content) != size_bytes or hashlib.sha256(content).hexdigest() != sha256:
            raise ArtifactHashMismatch("Artifact Blob内容Hash或大小不匹配")
        return content

    def _quarantine(self, staged: StagedBlob) -> None:
        quarantine = self.root / "quarantine" / staged.scope_storage_key
        quarantine.mkdir(parents=True, exist_ok=True)
        target = quarantine / f"{staged.sha256}-{uuid.uuid4()}.bin"
        shutil.copyfile(staged.staging_path, target)
        with target.open("rb") as handle:
            os.fsync(handle.fileno())
        self._fsync_directory(quarantine)

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


class ArtifactCoordinator:
    """Application coordinator for one scope's bytes and metadata transaction."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        store: ArtifactStore,
        scope_id: str,
        principal_id: str,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.database = database
        self.store = store
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock or _utc_now

    async def create_artifact(
        self,
        *,
        kind: str,
        title: str,
        media_type: str,
        content: bytes,
        command_id: str,
        excerpt: str | None = None,
        product_run_id: str | None = None,
        run_attempt_id: str | None = None,
    ) -> ArtifactWriteResult:
        staged = await self.store.stage(self.scope_id, content)
        try:
            try:
                await self.store.publish(staged)
            except ArtifactStorageConflict:
                await self._mark_blob_integrity(staged.sha256, "corrupt")
                raise
            for attempt in range(2):
                try:
                    result = await self._create_artifact_transaction(
                        staged=staged,
                        kind=kind,
                        title=title,
                        media_type=media_type,
                        command_id=command_id,
                        excerpt=excerpt,
                        product_run_id=product_run_id,
                        run_attempt_id=run_attempt_id,
                    )
                    return result
                except IntegrityError as error:
                    if attempt:
                        raise EvidenceConflict("Artifact并发写入冲突") from error
            raise AssertionError("unreachable")
        finally:
            await self.store.cleanup_staging(staged)

    async def append_revision(
        self,
        *,
        artifact_id: str,
        expected_artifact_record_version: int,
        content: bytes,
        command_id: str,
        excerpt: str | None = None,
    ) -> ArtifactWriteResult:
        staged = await self.store.stage(self.scope_id, content)
        try:
            try:
                await self.store.publish(staged)
            except ArtifactStorageConflict:
                await self._mark_blob_integrity(staged.sha256, "corrupt")
                raise
            for attempt in range(2):
                try:
                    async with self.database.sessions.begin() as transaction:
                        repository = self._repository()
                        existing = await transaction.scalar(
                            select(ArtifactRevisionRecord).where(
                                ArtifactRevisionRecord.artifact_id == artifact_id,
                                ArtifactRevisionRecord.command_id == command_id,
                            )
                        )
                        if existing is not None:
                            if existing.sha256 != staged.sha256 or existing.size_bytes != staged.size_bytes:
                                raise EvidenceConflict("同一Revision command_id对应不同内容")
                            return self._write_result(existing)
                        blob = await self._active_blob(transaction, repository, staged)
                        revision = await repository.create_artifact_revision(
                            transaction,
                            artifact_id=artifact_id,
                            expected_artifact_record_version=expected_artifact_record_version,
                            storage_blob_id=blob.id,
                            sha256=staged.sha256,
                            size_bytes=staged.size_bytes,
                            excerpt=excerpt,
                            command_id=command_id,
                        )
                        await transaction.flush()
                        return self._write_result(revision)
                except IntegrityError as error:
                    if attempt:
                        raise EvidenceConflict("Artifact Revision并发写入冲突") from error
            raise AssertionError("unreachable")
        finally:
            await self.store.cleanup_staging(staged)

    async def read_revision(self, artifact_revision_id: str) -> bytes:
        async with self.database.sessions() as transaction:
            revision = await transaction.get(ArtifactRevisionRecord, artifact_revision_id)
            if revision is None:
                raise EvidenceNotFound("Artifact Revision不存在")
            artifact = await transaction.get(ArtifactRecord, revision.artifact_id)
            blob = await transaction.get(ArtifactBlobRecord, revision.storage_blob_id)
            if artifact is None or artifact.scope_id != self.scope_id or blob is None:
                raise EvidenceNotFound("Artifact Revision不存在于当前scope")
            storage_path = blob.storage_path
            digest = revision.sha256
            size = revision.size_bytes
        try:
            return await self.store.read(
                storage_path=storage_path,
                sha256=digest,
                size_bytes=size,
            )
        except ArtifactBlobMissing:
            await self._mark_blob_integrity(blob.id, "missing", by_id=True)
            raise
        except ArtifactHashMismatch:
            await self._mark_blob_integrity(blob.id, "corrupt", by_id=True)
            raise

    async def _create_artifact_transaction(
        self,
        *,
        staged: StagedBlob,
        kind: str,
        title: str,
        media_type: str,
        command_id: str,
        excerpt: str | None,
        product_run_id: str | None,
        run_attempt_id: str | None,
    ) -> ArtifactWriteResult:
        async with self.database.sessions.begin() as transaction:
            repository = self._repository()
            existing = await transaction.scalar(
                select(ArtifactRecord).where(
                    ArtifactRecord.scope_id == self.scope_id,
                    ArtifactRecord.command_id == command_id,
                )
            )
            if existing is not None:
                revision = await repository.get_current_artifact_revision(transaction, existing.id)
                if (
                    revision is None
                    or revision.sha256 != staged.sha256
                    or revision.size_bytes != staged.size_bytes
                    or existing.kind != kind
                    or existing.title != title
                    or existing.media_type != media_type
                    or existing.product_run_id != product_run_id
                    or existing.run_attempt_id != run_attempt_id
                ):
                    raise EvidenceConflict("同一Artifact command_id对应不同请求")
                return self._write_result(revision)
            blob = await self._active_blob(transaction, repository, staged)
            artifact = await repository.create_artifact_record(
                transaction,
                kind=kind,
                title=title,
                media_type=media_type,
                product_run_id=product_run_id,
                run_attempt_id=run_attempt_id,
                command_id=command_id,
            )
            await transaction.flush()
            revision = await repository.create_artifact_revision(
                transaction,
                artifact_id=artifact.id,
                expected_artifact_record_version=artifact.row_version,
                storage_blob_id=blob.id,
                sha256=staged.sha256,
                size_bytes=staged.size_bytes,
                excerpt=excerpt,
                command_id=f"{command_id}:revision:1",
            )
            await transaction.flush()
            return self._write_result(revision)

    async def _active_blob(self, transaction, repository: EvidenceRepository, staged: StagedBlob):
        blob = await transaction.scalar(
            select(ArtifactBlobRecord)
            .where(
                ArtifactBlobRecord.scope_id == self.scope_id,
                ArtifactBlobRecord.sha256 == staged.sha256,
            )
            .with_for_update()
        )
        if blob is None:
            blob = await repository.create_artifact_blob(
                transaction,
                sha256=staged.sha256,
                size_bytes=staged.size_bytes,
                storage_path=staged.storage_path,
            )
            await transaction.flush()
            return blob
        if blob.storage_path != staged.storage_path or blob.size_bytes != staged.size_bytes:
            raise ArtifactHashMismatch("Artifact Blob元数据与内容地址不一致")
        if blob.integrity_status != "available" or blob.gc_status in {"deleting", "delete_failed"}:
            raise EvidenceConflict("Artifact Blob当前不可用于新Revision")
        if blob.gc_status == "orphan_candidate":
            blob.gc_status = "active"
            blob.orphaned_at = None
            blob.row_version += 1
            blob.updated_at = self._clock()
        return blob

    async def _mark_blob_integrity(
        self,
        identity: str,
        status: str,
        *,
        by_id: bool = False,
    ) -> None:
        async with self.database.sessions.begin() as transaction:
            condition = (
                ArtifactBlobRecord.id == identity
                if by_id
                else (
                    (ArtifactBlobRecord.scope_id == self.scope_id) & (ArtifactBlobRecord.sha256 == identity)
                )
            )
            blob = await transaction.scalar(select(ArtifactBlobRecord).where(condition))
            if blob is not None and blob.scope_id == self.scope_id:
                blob.integrity_status = status
                blob.row_version += 1
                blob.updated_at = self._clock()
                logger.error(
                    "artifact_blob_integrity_changed blob_id=%s scope_id=%s status=%s",
                    blob.id,
                    self.scope_id,
                    status,
                )

    def _repository(self) -> EvidenceRepository:
        return EvidenceRepository(
            scope_id=self.scope_id,
            principal_id=self.principal_id,
            clock=self._clock,
        )

    @staticmethod
    def _write_result(revision: ArtifactRevisionRecord) -> ArtifactWriteResult:
        return ArtifactWriteResult(
            artifact_id=revision.artifact_id,
            artifact_revision_id=revision.id,
            storage_blob_id=revision.storage_blob_id,
            sha256=revision.sha256,
            size_bytes=revision.size_bytes,
            revision_number=revision.revision_number,
        )


class ArtifactStoreReconciler:
    """Repair only orphan storage state; referenced blobs are never GC targets."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        store: ArtifactStore,
        scope_id: str,
        grace_period: timedelta = timedelta(hours=24),
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.database = database
        self.store = store
        self.scope_id = scope_id
        self.grace_period = grace_period
        self._clock = clock or _utc_now

    async def reconcile(self) -> ArtifactReconcileResult:
        now = self._clock()
        staged_removed = await asyncio.to_thread(self._remove_stale_staging, now)
        physical_removed = await self._remove_untracked_physical_blobs(now)
        marked = restored = deleted = failures = 0
        async with self.database.sessions() as transaction:
            blob_ids = list(
                await transaction.scalars(
                    select(ArtifactBlobRecord.id).where(ArtifactBlobRecord.scope_id == self.scope_id)
                )
            )
        for blob_id in blob_ids:
            outcome = await self._reconcile_row(blob_id, now)
            marked += outcome == "marked"
            restored += outcome == "restored"
            deleted += outcome == "deleted"
            failures += outcome == "failed"
        return ArtifactReconcileResult(
            staged_removed=staged_removed,
            physical_orphans_removed=physical_removed,
            rows_marked_orphan=marked,
            rows_restored=restored,
            rows_deleted=deleted,
            delete_failures=failures,
        )

    def _remove_stale_staging(self, now: datetime) -> int:
        directory = self.store.scope_staging_directory(self.scope_id)
        if not directory.exists():
            return 0
        removed = 0
        for path in directory.glob("*.tmp"):
            modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
            if now - modified >= self.grace_period:
                path.unlink(missing_ok=True)
                removed += 1
        return removed

    async def _remove_untracked_physical_blobs(self, now: datetime) -> int:
        directory = self.store.scope_blob_directory(self.scope_id)
        if not directory.exists():
            return 0
        async with self.database.sessions() as transaction:
            tracked = set(
                await transaction.scalars(
                    select(ArtifactBlobRecord.storage_path).where(
                        ArtifactBlobRecord.scope_id == self.scope_id
                    )
                )
            )
        removed = 0
        for path in directory.glob("*/*"):
            if not path.is_file():
                continue
            relative = path.relative_to(self.store.root).as_posix()
            modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
            if relative not in tracked and now - modified >= self.grace_period:
                path.unlink(missing_ok=True)
                removed += 1
        return removed

    async def _reconcile_row(self, blob_id: str, now: datetime) -> str | None:
        storage_path: str | None = None
        async with self.database.sessions.begin() as transaction:
            blob = await transaction.scalar(
                select(ArtifactBlobRecord).where(ArtifactBlobRecord.id == blob_id).with_for_update()
            )
            if blob is None or blob.scope_id != self.scope_id:
                return None
            referenced = (
                await transaction.scalar(
                    select(func.count(ArtifactRevisionRecord.id)).where(
                        ArtifactRevisionRecord.storage_blob_id == blob.id
                    )
                )
                or 0
            ) > 0
            if referenced:
                if blob.gc_status != "active" or blob.orphaned_at is not None:
                    blob.gc_status = "active"
                    blob.orphaned_at = None
                    blob.last_gc_error_code = None
                    blob.row_version += 1
                    blob.updated_at = now
                    return "restored"
                return None
            if blob.gc_status == "active":
                blob.gc_status = "orphan_candidate"
                blob.orphaned_at = now
                blob.row_version += 1
                blob.updated_at = now
                return "marked"
            orphaned_at = _aware(blob.orphaned_at or blob.updated_at)
            retention_until = _aware(blob.retention_until) if blob.retention_until else None
            if retention_until is not None and retention_until > now:
                return None
            if blob.gc_status == "orphan_candidate" and now - orphaned_at < self.grace_period:
                return None
            blob.gc_status = "deleting"
            blob.last_gc_error_code = None
            blob.row_version += 1
            blob.updated_at = now
            storage_path = blob.storage_path
        assert storage_path is not None
        try:
            await asyncio.to_thread(
                self.store.resolve_storage_path(storage_path).unlink,
                missing_ok=True,
            )
        except OSError:
            async with self.database.sessions.begin() as transaction:
                blob = await transaction.get(ArtifactBlobRecord, blob_id)
                if blob is not None and blob.gc_status == "deleting":
                    blob.gc_status = "delete_failed"
                    blob.last_gc_error_code = "artifact_blob_unlink_failed"
                    blob.row_version += 1
                    blob.updated_at = now
            logger.exception("artifact_blob_gc_unlink_failed blob_id=%s", blob_id)
            return "failed"
        async with self.database.sessions.begin() as transaction:
            still_referenced = await transaction.scalar(
                select(ArtifactRevisionRecord.id)
                .where(ArtifactRevisionRecord.storage_blob_id == blob_id)
                .limit(1)
            )
            blob = await transaction.get(ArtifactBlobRecord, blob_id)
            if blob is not None and blob.gc_status == "deleting" and still_referenced is None:
                await transaction.execute(delete(ArtifactBlobRecord).where(ArtifactBlobRecord.id == blob_id))
        return "deleted"
