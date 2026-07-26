"""SD4-B filesystem and transaction tests for the content-addressed Artifact Store."""

from __future__ import annotations

import asyncio
import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import delete, func, select

# Register every Base-owned module before create_all.  This test must remain
# runnable alone; relying on another test module's import order hides schema
# dependency regressions.
from backend.app.collaboration_intents import models as _ci  # noqa: F401
from backend.app.collaboration_protocols import models as _cp  # noqa: F401
from backend.app.evidence.artifact_store import (
    ArtifactCoordinator,
    ArtifactStore,
    ArtifactStoreReconciler,
)
from backend.app.evidence.contracts import (
    ArtifactBlobMissing,
    ArtifactHashMismatch,
    ArtifactStorageConflict,
    ArtifactStoragePathInvalid,
    EvidenceConflict,
    EvidenceValidationError,
)
from backend.app.evidence.models import (
    ArtifactBlobRecord,
    ArtifactRecord,
    ArtifactRevisionRecord,
)
from backend.app.execution_workspaces import models as _ew  # noqa: F401
from backend.app.governance import models as _gov  # noqa: F401
from backend.app.harness import models as _har  # noqa: F401
from backend.app.product_sessions.database import ProductDatabase
from backend.app.project_resources import models as _pr  # noqa: F401
from backend.app.runtime_execution import models as _re  # noqa: F401
from backend.app.step_inputs import models as _si  # noqa: F401
from backend.app.tool_execution import models as _te  # noqa: F401

_SECRET = b"artifact-store-test-secret-32-bytes-minimum"


def _run(scenario) -> None:
    asyncio.run(scenario())


async def _runtime(tmp_path: Path, *, database_name: str = ":memory:"):
    if database_name == ":memory:":
        url = "sqlite+aiosqlite:///:memory:"
    else:
        url = f"sqlite+aiosqlite:///{(tmp_path / database_name).as_posix()}"
    database = ProductDatabase(url)
    await database.initialize()
    store = ArtifactStore(tmp_path / "artifacts", scope_key_secret=_SECRET)
    coordinator = ArtifactCoordinator(
        database,
        store=store,
        scope_id="local-user",
        principal_id="local-user",
    )
    return database, store, coordinator


def test_stage_publish_transaction_order_is_idempotent_and_scope_deduplicated(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, store, coordinator = await _runtime(tmp_path)
        try:
            content = b"diff --git a/a.txt b/a.txt\n"
            first = await coordinator.create_artifact(
                kind="diff_patch",
                title="first",
                media_type="text/x-diff",
                content=content,
                command_id="artifact:first",
            )
            replay = await coordinator.create_artifact(
                kind="diff_patch",
                title="first",
                media_type="text/x-diff",
                content=content,
                command_id="artifact:first",
            )
            second = await coordinator.create_artifact(
                kind="diff_patch",
                title="second",
                media_type="text/x-diff",
                content=content,
                command_id="artifact:second",
            )

            assert replay == first
            assert second.artifact_id != first.artifact_id
            assert second.storage_blob_id == first.storage_blob_id
            assert await coordinator.read_revision(first.artifact_revision_id) == content
            async with database.sessions() as transaction:
                assert await transaction.scalar(select(func.count(ArtifactBlobRecord.id))) == 1
                blob = await transaction.get(ArtifactBlobRecord, first.storage_blob_id)
                assert blob is not None
                assert blob.storage_path.startswith("blobs/")
                assert "local-user" not in blob.storage_path
                assert store.resolve_storage_path(blob.storage_path).read_bytes() == content
            assert not list(store.scope_staging_directory("local-user").glob("*.tmp"))
        finally:
            await database.close()

    _run(scenario)


def test_same_content_is_physically_isolated_across_scopes(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, store, first = await _runtime(tmp_path)
        second = ArtifactCoordinator(
            database,
            store=store,
            scope_id="other-user",
            principal_id="other-user",
        )
        try:
            content = b"same bytes"
            one = await first.create_artifact(
                kind="generated_file",
                title="one",
                media_type="text/plain",
                content=content,
                command_id="one",
            )
            two = await second.create_artifact(
                kind="generated_file",
                title="two",
                media_type="text/plain",
                content=content,
                command_id="two",
            )
            async with database.sessions() as transaction:
                one_blob = await transaction.get(ArtifactBlobRecord, one.storage_blob_id)
                two_blob = await transaction.get(ArtifactBlobRecord, two.storage_blob_id)
                assert one_blob is not None and two_blob is not None
                assert one_blob.storage_path != two_blob.storage_path
                assert store.resolve_storage_path(one_blob.storage_path).exists()
                assert store.resolve_storage_path(two_blob.storage_path).exists()
        finally:
            await database.close()

    _run(scenario)


def test_existing_corrupt_digest_never_gets_overwritten_and_is_quarantined(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, store, coordinator = await _runtime(tmp_path)
        try:
            content = b"trusted content"
            created = await coordinator.create_artifact(
                kind="generated_file",
                title="trusted",
                media_type="text/plain",
                content=content,
                command_id="trusted",
            )
            async with database.sessions() as transaction:
                blob = await transaction.get(ArtifactBlobRecord, created.storage_blob_id)
                assert blob is not None
                final_path = store.resolve_storage_path(blob.storage_path)
            final_path.write_bytes(b"corrupt existing bytes")

            with pytest.raises(ArtifactStorageConflict):
                await coordinator.create_artifact(
                    kind="generated_file",
                    title="new",
                    media_type="text/plain",
                    content=content,
                    command_id="new",
                )

            assert final_path.read_bytes() == b"corrupt existing bytes"
            quarantine = tmp_path / "artifacts" / "quarantine" / store.scope_storage_key("local-user")
            assert [path.read_bytes() for path in quarantine.iterdir()] == [content]
            async with database.sessions() as transaction:
                blob = await transaction.get(ArtifactBlobRecord, created.storage_blob_id)
                assert blob is not None
                assert blob.integrity_status == "corrupt"
        finally:
            await database.close()

    _run(scenario)


def test_read_revalidates_bytes_and_marks_missing_or_corrupt(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, store, coordinator = await _runtime(tmp_path)
        try:
            first = await coordinator.create_artifact(
                kind="validation_report",
                title="report",
                media_type="text/plain",
                content=b"ok",
                command_id="report",
            )
            async with database.sessions() as transaction:
                blob = await transaction.get(ArtifactBlobRecord, first.storage_blob_id)
                assert blob is not None
                path = store.resolve_storage_path(blob.storage_path)
            path.write_bytes(b"changed")
            with pytest.raises(ArtifactHashMismatch):
                await coordinator.read_revision(first.artifact_revision_id)
            async with database.sessions() as transaction:
                blob = await transaction.get(ArtifactBlobRecord, first.storage_blob_id)
                assert blob is not None and blob.integrity_status == "corrupt"

            second = await coordinator.create_artifact(
                kind="validation_report",
                title="report 2",
                media_type="text/plain",
                content=b"second",
                command_id="report-2",
            )
            async with database.sessions() as transaction:
                blob = await transaction.get(ArtifactBlobRecord, second.storage_blob_id)
                assert blob is not None
                store.resolve_storage_path(blob.storage_path).unlink()
            with pytest.raises(ArtifactBlobMissing):
                await coordinator.read_revision(second.artifact_revision_id)
            async with database.sessions() as transaction:
                blob = await transaction.get(ArtifactBlobRecord, second.storage_blob_id)
                assert blob is not None and blob.integrity_status == "missing"
        finally:
            await database.close()

    _run(scenario)


def test_publish_then_database_failure_leaves_collectable_physical_orphan(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, store, coordinator = await _runtime(tmp_path)
        try:
            content = b"orphan after invalid metadata"
            digest = hashlib.sha256(content).hexdigest()
            with pytest.raises(EvidenceValidationError):
                await coordinator.create_artifact(
                    kind="not-a-real-kind",
                    title="invalid",
                    media_type="text/plain",
                    content=content,
                    command_id="invalid",
                )
            path = store.resolve_storage_path(
                f"blobs/{store.scope_storage_key('local-user')}/{digest[:2]}/{digest}"
            )
            assert path.exists()
            async with database.sessions() as transaction:
                assert await transaction.scalar(select(func.count(ArtifactBlobRecord.id))) == 0

            reconciler = ArtifactStoreReconciler(
                database,
                store=store,
                scope_id="local-user",
                grace_period=timedelta(0),
            )
            result = await reconciler.reconcile()
            assert result.physical_orphans_removed == 1
            assert not path.exists()
        finally:
            await database.close()

    _run(scenario)


def test_orphan_gc_marks_then_deletes_but_new_reference_restores_candidate(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, store, coordinator = await _runtime(tmp_path)
        try:
            created = await coordinator.create_artifact(
                kind="generated_file",
                title="temporary",
                media_type="text/plain",
                content=b"gc me",
                command_id="gc-source",
            )
            async with database.sessions.begin() as transaction:
                await transaction.execute(
                    delete(ArtifactRevisionRecord).where(
                        ArtifactRevisionRecord.id == created.artifact_revision_id
                    )
                )
                await transaction.execute(
                    delete(ArtifactRecord).where(ArtifactRecord.id == created.artifact_id)
                )

            now = datetime(2026, 7, 26, tzinfo=timezone.utc)
            reconciler = ArtifactStoreReconciler(
                database,
                store=store,
                scope_id="local-user",
                grace_period=timedelta(hours=1),
                clock=lambda: now,
            )
            first = await reconciler.reconcile()
            assert first.rows_marked_orphan == 1
            async with database.sessions() as transaction:
                blob = await transaction.get(ArtifactBlobRecord, created.storage_blob_id)
                assert blob is not None and blob.gc_status == "orphan_candidate"

            restored = await coordinator.create_artifact(
                kind="generated_file",
                title="restored",
                media_type="text/plain",
                content=b"gc me",
                command_id="gc-restored",
            )
            assert restored.storage_blob_id == created.storage_blob_id
            async with database.sessions() as transaction:
                blob = await transaction.get(ArtifactBlobRecord, created.storage_blob_id)
                assert blob is not None and blob.gc_status == "active"
                revision = await transaction.get(
                    ArtifactRevisionRecord,
                    restored.artifact_revision_id,
                )
                assert revision is not None

            # Remove the new reference, mark once, then advance beyond grace.
            async with database.sessions.begin() as transaction:
                await transaction.execute(
                    delete(ArtifactRevisionRecord).where(
                        ArtifactRevisionRecord.id == restored.artifact_revision_id
                    )
                )
                await transaction.execute(
                    delete(ArtifactRecord).where(ArtifactRecord.id == restored.artifact_id)
                )
            assert (await reconciler.reconcile()).rows_marked_orphan == 1
            later = ArtifactStoreReconciler(
                database,
                store=store,
                scope_id="local-user",
                grace_period=timedelta(hours=1),
                clock=lambda: now + timedelta(hours=2),
            )
            final = await later.reconcile()
            assert final.rows_deleted == 1
            async with database.sessions() as transaction:
                assert await transaction.get(ArtifactBlobRecord, created.storage_blob_id) is None
        finally:
            await database.close()

    _run(scenario)


def test_command_replay_with_changed_content_and_path_traversal_fail_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, store, coordinator = await _runtime(tmp_path)
        try:
            await coordinator.create_artifact(
                kind="generated_file",
                title="same command",
                media_type="text/plain",
                content=b"first",
                command_id="same-command",
            )
            with pytest.raises(EvidenceConflict):
                await coordinator.create_artifact(
                    kind="generated_file",
                    title="same command",
                    media_type="text/plain",
                    content=b"different",
                    command_id="same-command",
                )
            with pytest.raises(ArtifactStoragePathInvalid):
                await store.read(
                    storage_path="../backend/config.json",
                    sha256="a" * 64,
                    size_bytes=1,
                )
        finally:
            await database.close()

    _run(scenario)
