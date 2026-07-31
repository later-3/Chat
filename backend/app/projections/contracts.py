"""Pure contracts shared by projection composers and presentation adapters."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Mapping, Sequence

PROJECTION_SCHEMA_VERSION = "1.0"
WORKSPACE_VIEW_SCHEMA = "personal-workspace.v1"
PROJECT_DOSSIER_VIEW_SCHEMA = "project-dossier.v1"

PROJECT_DOMAIN_BY_KIND = {
    "delivery": "work",
    "learning": "learning",
    "research": "research",
    "personal": "life",
}

OPEN_WORK_STATUSES = {"draft", "planned", "ready", "in_progress", "blocked"}
TERMINAL_WORK_STATUSES = {"completed", "cancelled", "archived"}
OPEN_ACTION_STATUSES = {"pending", "ready", "in_progress", "blocked"}
TERMINAL_ACTION_STATUSES = {"completed", "cancelled", "skipped"}
ASSIGNEE_KINDS = ("user", "agent", "external")


class ProjectionError(ValueError):
    code = "PROJECTION_INVALID"


class ProjectionNotFound(ProjectionError):
    code = "PROJECTION_SUBJECT_NOT_FOUND"


class ProjectionValidationError(ProjectionError):
    code = "PROJECTION_VALIDATION_FAILED"


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def normalized_time(value: str | None) -> str | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def max_source_time(sources: Sequence[Mapping[str, Any]]) -> str | None:
    timestamps = [
        normalized_time(str(value.get("updated_at") or "")) for value in sources if value.get("updated_at")
    ]
    return max((value for value in timestamps if value is not None), default=None)


def source_revision(
    *,
    owner: str,
    resource_kind: str,
    resource_id: str,
    revision: str | int,
    updated_at: str | None,
) -> dict[str, Any]:
    return {
        "owner": owner,
        "resource_kind": resource_kind,
        "resource_id": resource_id,
        "revision": str(revision),
        "updated_at": normalized_time(updated_at),
    }


def section_state(
    state: str,
    *,
    reason_code: str | None = None,
    detail: str | None = None,
    source_owner: str | None = None,
) -> dict[str, Any]:
    if state not in {"available", "partial", "empty", "unknown", "forbidden", "error"}:
        raise ProjectionValidationError(f"未知Projection section state: {state}")
    return {
        "state": state,
        "reason_code": reason_code,
        "detail": detail,
        "source_owner": source_owner,
    }


def local_scope_permissions() -> dict[str, Any]:
    """Describe current access honestly without inventing a formal Identity role."""

    return {
        "authorization_mode": "legacy_fixed_scope",
        "audience": "local_scope_user",
        "principal_id": "local-user",
        "allowed": ["view", "export_obsidian"],
        "denied": [
            {
                "capability": "propose_projection_change",
                "reason_code": "readonly_projection_slice",
            },
            {
                "capability": "cross_user_view",
                "reason_code": "identity_not_implemented",
            },
        ],
    }


def envelope(
    *,
    view_schema: str,
    view_type: str,
    subject: Mapping[str, Any],
    data: Mapping[str, Any],
    sources: Sequence[Mapping[str, Any]],
    sections: Mapping[str, Mapping[str, Any]],
    generated_at: datetime,
    permissions: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a stable envelope whose semantic revision excludes wall-clock time."""

    unique_sources = {
        (
            str(value.get("owner") or ""),
            str(value.get("resource_kind") or ""),
            str(value.get("resource_id") or ""),
            str(value.get("revision") or ""),
            str(value.get("updated_at") or ""),
        ): dict(value)
        for value in sources
    }
    ordered_sources = sorted(
        unique_sources.values(),
        key=lambda value: (
            str(value.get("owner") or ""),
            str(value.get("resource_kind") or ""),
            str(value.get("resource_id") or ""),
            str(value.get("revision") or ""),
        ),
    )
    permission_view = dict(permissions or local_scope_permissions())
    semantic = {
        "schema_version": PROJECTION_SCHEMA_VERSION,
        "view_schema": view_schema,
        "view_type": view_type,
        "subject": dict(subject),
        "data": dict(data),
        "source_revisions": ordered_sources,
        "sections": {key: dict(value) for key, value in sorted(sections.items())},
        "permissions": permission_view,
    }
    generated = generated_at.astimezone(timezone.utc)
    latest_source = max_source_time(ordered_sources)
    return {
        **semantic,
        "projection_revision": sha256_json(semantic),
        "generated_at": generated.isoformat(),
        "source_snapshot_at": latest_source,
        "freshness": {
            "status": "fresh",
            "as_of": generated.isoformat(),
            "source_updated_at": latest_source,
            "consistency": "per_query_snapshot_with_revision_vector",
            "reason_code": None,
        },
    }
