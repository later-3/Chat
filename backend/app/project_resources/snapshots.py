"""Pure construction of immutable repository Snapshot records and safe events."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

from ..harness.contracts import new_id
from .contracts import (
    INSPECTOR_VERSION,
    ProjectResourceValidationError,
    RepositoryInspection,
    RepositoryInspectionError,
    binding_view,
    sha256_json,
    snapshot_view,
)
from .models import ProjectRepositoryBindingRecord, RepositorySnapshotRecord
from .paths import SafeRepositoryPath


def available_snapshot(
    *,
    scope_id: str,
    binding_id: str,
    generation: int,
    sequence: int,
    repository: SafeRepositoryPath,
    inspection: RepositoryInspection,
) -> RepositorySnapshotRecord:
    return RepositorySnapshotRecord(
        id=new_id(),
        scope_id=scope_id,
        binding_id=binding_id,
        binding_generation=generation,
        sequence=sequence,
        capture_status="available",
        observed_at=inspection.observed_at,
        root_identity_hash=repository.root_identity_hash,
        relative_path=repository.relative_path,
        locator_hash=repository.locator_hash,
        head_oid=inspection.head_oid,
        head_ref=inspection.head_ref,
        upstream_ref=inspection.upstream_ref,
        detached_head=inspection.detached_head,
        ahead_count=inspection.ahead_count,
        behind_count=inspection.behind_count,
        dirty=inspection.dirty,
        staged_count=inspection.staged_count,
        unstaged_count=inspection.unstaged_count,
        untracked_count=inspection.untracked_count,
        change_count=inspection.change_count,
        changes_truncated=inspection.changes_truncated,
        change_summary_json=list(inspection.change_summary),
        fingerprint_complete=inspection.fingerprint_complete,
        worktree_fingerprint=inspection.worktree_fingerprint,
        governance_manifest_json=list(inspection.governance_manifest),
        governance_manifest_hash=inspection.governance_manifest_hash,
        semantic_hash=inspection.semantic_hash,
        error_code=None,
        error_detail_safe=None,
        inspector_version=inspection.inspector_version,
    )


def unavailable_snapshot(
    *,
    scope_id: str,
    binding: ProjectRepositoryBindingRecord,
    sequence: int,
    error: RepositoryInspectionError | ProjectResourceValidationError | None,
    clock: Callable[[], datetime],
) -> RepositorySnapshotRecord:
    error_code = error.code if error else "REPOSITORY_INSPECTION_FAILED"
    empty_manifest_hash = sha256_json(
        {
            "schema": "repository-governance-manifest-v1",
            "documents": [],
        }
    )
    return RepositorySnapshotRecord(
        id=new_id(),
        scope_id=scope_id,
        binding_id=binding.id,
        binding_generation=binding.generation,
        sequence=sequence,
        capture_status="unavailable",
        observed_at=clock(),
        root_identity_hash=binding.root_identity_hash,
        relative_path=binding.relative_path,
        locator_hash=binding.locator_hash,
        head_oid=None,
        head_ref=None,
        upstream_ref=None,
        detached_head=False,
        ahead_count=0,
        behind_count=0,
        dirty=False,
        staged_count=0,
        unstaged_count=0,
        untracked_count=0,
        change_count=0,
        changes_truncated=False,
        change_summary_json=[],
        fingerprint_complete=False,
        worktree_fingerprint=None,
        governance_manifest_json=[],
        governance_manifest_hash=empty_manifest_hash,
        semantic_hash=None,
        error_code=error_code,
        error_detail_safe=str(error) if error else "Repository只读检查失败",
        inspector_version=INSPECTOR_VERSION,
    )


def command_result(
    *,
    binding: ProjectRepositoryBindingRecord,
    snapshot: RepositorySnapshotRecord | None,
    project_row_version: int | None = None,
) -> dict[str, Any]:
    result = {
        "binding": binding_view(binding),
        "snapshot": snapshot_view(snapshot) if snapshot else None,
    }
    if project_row_version is not None:
        result["project_row_version"] = project_row_version
    return result


def trace_payload(
    binding: ProjectRepositoryBindingRecord,
    snapshot: RepositorySnapshotRecord,
) -> dict[str, Any]:
    """Keep Product Trace useful without exposing paths or filenames."""

    return {
        "status": binding.status,
        "generation": binding.generation,
        "sequence": snapshot.sequence,
        "capture_status": snapshot.capture_status,
        "semantic_hash": snapshot.semantic_hash,
        "fingerprint_complete": snapshot.fingerprint_complete,
        "dirty": snapshot.dirty,
        "staged_count": snapshot.staged_count,
        "unstaged_count": snapshot.unstaged_count,
        "untracked_count": snapshot.untracked_count,
        "change_count": snapshot.change_count,
        "error_code": snapshot.error_code,
    }
