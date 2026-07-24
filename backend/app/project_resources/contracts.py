"""Pure contracts, validation and projections for Project repositories."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..harness.contracts import HarnessConflict, HarnessError, HarnessNotFound
from .models import ProjectRepositoryBindingRecord, RepositorySnapshotRecord

BINDING_ROLES = {"primary", "supporting", "documentation"}
BINDING_STATUSES = {"active", "unavailable", "detached"}
ALIAS_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
INSPECTOR_VERSION = "git-inspector-v1"


class ProjectResourceError(HarnessError):
    """Base class carrying a stable product-safe failure code."""

    code = "PROJECT_RESOURCE_INVALID"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code


class ProjectResourceNotFound(HarnessNotFound, ProjectResourceError):
    code = "REPOSITORY_NOT_FOUND"


class ProjectResourceConflict(HarnessConflict, ProjectResourceError):
    code = "REPOSITORY_CONFLICT"


class ProjectResourceValidationError(ProjectResourceError):
    code = "REPOSITORY_VALIDATION_FAILED"


class RepositoryInspectionError(ProjectResourceError):
    """Expected adapter failure whose text is safe to persist and show."""

    code = "REPOSITORY_INSPECTION_FAILED"


@dataclass(frozen=True, slots=True)
class RepositoryInspection:
    """Successful, fully public-safe result returned by the Git adapter."""

    observed_at: datetime
    head_oid: str | None
    head_ref: str | None
    upstream_ref: str | None
    detached_head: bool
    ahead_count: int
    behind_count: int
    dirty: bool
    staged_count: int
    unstaged_count: int
    untracked_count: int
    change_count: int
    changes_truncated: bool
    change_summary: tuple[dict[str, str], ...]
    fingerprint_complete: bool
    worktree_fingerprint: str
    governance_manifest: tuple[dict[str, Any], ...]
    governance_manifest_hash: str
    semantic_hash: str
    inspector_version: str = INSPECTOR_VERSION


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def locator_hash(*, root_identity_hash: str, relative_path: str) -> str:
    return sha256_json(
        {
            "schema": "repository-locator-v1",
            "root_identity_hash": root_identity_hash,
            "relative_path": relative_path,
        }
    )


def repository_semantic_hash(
    *,
    binding_generation: int,
    locator_hash_value: str,
    head_oid: str | None,
    head_ref: str | None,
    detached_head: bool,
    worktree_fingerprint: str,
    fingerprint_complete: bool,
    governance_manifest_hash: str,
    inspector_version: str = INSPECTOR_VERSION,
) -> str:
    """Hash only semantic source identity, never observation metadata."""

    return sha256_json(
        {
            "schema": "repository-semantic-v1",
            "binding_generation": binding_generation,
            "locator_hash": locator_hash_value,
            "head_oid": head_oid or "UNBORN",
            "head_ref": head_ref or "",
            "detached_head": detached_head,
            "worktree_fingerprint": worktree_fingerprint,
            "fingerprint_complete": fingerprint_complete,
            "governance_manifest_hash": governance_manifest_hash,
            "inspector_version": inspector_version,
        }
    )


def validate_alias(value: str) -> str:
    alias = value.strip()
    if not ALIAS_PATTERN.fullmatch(alias):
        raise ProjectResourceValidationError(
            "Repository alias必须匹配[a-z][a-z0-9-]{0,63}",
            code="REPOSITORY_ALIAS_INVALID",
        )
    return alias


def validate_display_name(value: str) -> str:
    display_name = value.strip()
    if not display_name or len(display_name) > 120:
        raise ProjectResourceValidationError(
            "Repository名称必须为1到120个字符",
            code="REPOSITORY_DISPLAY_NAME_INVALID",
        )
    return display_name


def validate_role(value: str) -> str:
    role = value.strip()
    if role not in BINDING_ROLES:
        raise ProjectResourceValidationError(
            "Repository role无效",
            code="REPOSITORY_ROLE_INVALID",
        )
    return role


def binding_view(value: ProjectRepositoryBindingRecord) -> dict[str, Any]:
    """Project-safe projection; private root identities never leave services."""

    return {
        "id": value.id,
        "scope_id": value.scope_id,
        "project_id": value.project_id,
        "alias": value.alias,
        "display_name": value.display_name,
        "role": value.role,
        "root_key": value.root_key,
        "relative_path": value.relative_path,
        "generation": value.generation,
        "status": value.status,
        "status_reason_code": value.status_reason_code,
        "latest_snapshot_sequence": value.latest_snapshot_sequence,
        "row_version": value.row_version,
        "created_by": value.created_by,
        "updated_by": value.updated_by,
        "created_at": value.created_at.isoformat(),
        "updated_at": value.updated_at.isoformat(),
        "detached_at": value.detached_at.isoformat() if value.detached_at else None,
    }


def snapshot_view(value: RepositorySnapshotRecord) -> dict[str, Any]:
    """Immutable observation projection without filesystem identities."""

    return {
        "id": value.id,
        "binding_id": value.binding_id,
        "binding_generation": value.binding_generation,
        "sequence": value.sequence,
        "capture_status": value.capture_status,
        "observed_at": value.observed_at.isoformat(),
        "relative_path": value.relative_path,
        "head_oid": value.head_oid,
        "head_ref": value.head_ref,
        "upstream_ref": value.upstream_ref,
        "detached_head": value.detached_head,
        "ahead_count": value.ahead_count,
        "behind_count": value.behind_count,
        "dirty": value.dirty,
        "staged_count": value.staged_count,
        "unstaged_count": value.unstaged_count,
        "untracked_count": value.untracked_count,
        "change_count": value.change_count,
        "changes_truncated": value.changes_truncated,
        "change_summary": list(value.change_summary_json or []),
        "fingerprint_complete": value.fingerprint_complete,
        "worktree_fingerprint": value.worktree_fingerprint,
        "governance_manifest": list(value.governance_manifest_json or []),
        "governance_manifest_hash": value.governance_manifest_hash,
        "semantic_hash": value.semantic_hash,
        "error_code": value.error_code,
        "error_detail_safe": value.error_detail_safe,
        "inspector_version": value.inspector_version,
    }
