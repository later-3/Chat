"""Pure Product Harness rules, validation helpers and public projections."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime
from typing import Any

from .models import (
    AcceptedMemoryRecord,
    ActionItemRecord,
    MemoryRevisionRecord,
    NoteRecord,
    NoteRevisionRecord,
    ProductProjectRecord,
    WorkItemRecord,
)

PROJECT_KINDS = {"delivery", "learning", "research", "personal"}
PROJECT_TRANSITIONS: dict[str, set[str]] = {
    "proposed": {"active", "cancelled"},
    "active": {"paused", "cancelled", "completed", "archived"},
    "paused": {"active", "cancelled", "completed"},
    "completed": {"archived"},
    "cancelled": {"archived"},
    "archived": set(),
}
WORK_KINDS = {"task", "milestone", "learning_unit", "research_question"}
WORK_PRIORITIES = {"low", "normal", "high", "critical"}
WORK_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"planned", "cancelled"},
    "planned": {"ready", "cancelled"},
    "ready": {"in_progress", "blocked", "cancelled"},
    "in_progress": {"blocked", "completed", "cancelled"},
    "blocked": {"ready", "in_progress", "cancelled"},
    "completed": {"in_progress", "archived"},
    "cancelled": {"archived"},
    "archived": set(),
}
NOTE_KINDS = {"learning_note", "project_note", "research_note", "idea"}
NOTE_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"active", "archived"},
    "active": {"superseded", "archived"},
    "superseded": {"archived"},
    "archived": set(),
}
ACTION_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"ready", "blocked", "skipped", "cancelled"},
    "ready": {"in_progress", "blocked", "skipped", "cancelled"},
    "in_progress": {"blocked", "completed", "skipped", "cancelled"},
    "blocked": {"ready", "in_progress", "skipped", "cancelled"},
    "completed": set(),
    "skipped": set(),
    "cancelled": set(),
}
MEMORY_SCOPE_KINDS = {"user", "project", "work_item", "learning_track"}
MEMORY_KINDS = {"preference", "stable_fact", "decision", "experience_rule", "term", "relationship"}
MEMORY_ACTIVE_STATUSES = {"accepted"}
MEMORY_TRANSITIONS: dict[str, set[str]] = {
    "accepted": {"superseded", "revoked", "invalid"},
    "superseded": set(),
    "revoked": set(),
    "invalid": set(),
}


class HarnessError(ValueError):
    code = "HARNESS_INVALID"


class HarnessNotFound(HarnessError):
    code = "HARNESS_NOT_FOUND"


class HarnessConflict(HarnessError):
    code = "HARNESS_CONFLICT"


class HarnessValidationError(HarnessError):
    code = "HARNESS_VALIDATION_FAILED"


def new_id() -> str:
    return str(uuid.uuid4())


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def context_package_hash(
    *,
    stage: str,
    selected_project_id: str | None,
    selected_work_item_id: str | None,
    token_budget: int,
    items: list[dict[str, Any]],
) -> str:
    """Hash every semantic input that can change one runtime Context package.

    Both the Workflow compiler and the user revision coordinator call this
    helper. Keeping one canonical payload prevents the initial package and its
    revisions from silently assigning different meanings to the same hash.
    """

    canonical_items = [
        {
            "ordinal": value["ordinal"],
            "source_kind": value["source_kind"],
            "source_id": value["source_id"],
            "source_revision": value.get("source_revision"),
            "title": value["title"],
            "content": value["content"],
            "adopted": bool(value["adopted"]),
            "locked": bool(value.get("locked", False)),
            "selection_origin": str(value.get("selection_origin") or "system"),
            "reason": value["reason"],
            "token_estimate": int(value["token_estimate"]),
        }
        for value in items
    ]
    return content_hash(
        {
            "stage": stage,
            "project": selected_project_id,
            "work": selected_work_item_id,
            "token_budget": token_budget,
            "items": canonical_items,
        }
    )


def iso_timestamp(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def normalized_text(value: str, *, field: str, max_length: int | None = None) -> str:
    normalized = value.strip()
    if not normalized:
        raise HarnessValidationError(f"{field}不能为空")
    if max_length is not None and len(normalized) > max_length:
        raise HarnessValidationError(f"{field}不能超过{max_length}个字符")
    return normalized


def project_view(value: ProductProjectRecord) -> dict[str, Any]:
    return {
        "id": value.id,
        "scope_id": value.scope_id,
        "kind": value.kind,
        "title": value.title,
        "goal": value.goal,
        "status": value.status,
        "current_milestone_id": value.current_milestone_id,
        "row_version": value.row_version,
        "created_by": value.created_by,
        "created_at": iso_timestamp(value.created_at),
        "updated_at": iso_timestamp(value.updated_at),
    }


def work_view(value: WorkItemRecord) -> dict[str, Any]:
    return {
        "id": value.id,
        "scope_id": value.scope_id,
        "project_id": value.project_id,
        "parent_work_item_id": value.parent_work_item_id,
        "kind": value.kind,
        "title": value.title,
        "objective": value.objective,
        "status": value.status,
        "priority": value.priority,
        "current_plan_revision_id": value.current_plan_revision_id,
        "completion_evidence": list(value.completion_evidence_json or []),
        "completion_waiver_reason": value.completion_waiver_reason,
        "row_version": value.row_version,
        "created_by": value.created_by,
        "created_at": iso_timestamp(value.created_at),
        "updated_at": iso_timestamp(value.updated_at),
    }


def note_view(value: NoteRecord, revision: NoteRevisionRecord | None) -> dict[str, Any]:
    return {
        "id": value.id,
        "scope_id": value.scope_id,
        "kind": value.kind,
        "title": value.title,
        "status": value.status,
        "row_version": value.row_version,
        "current_revision": None
        if revision is None
        else {
            "id": revision.id,
            "revision": revision.revision,
            "content": revision.content,
            "content_hash": revision.content_hash,
            "source_refs": list(revision.source_refs_json or []),
            "created_at": iso_timestamp(revision.created_at),
        },
        "created_at": iso_timestamp(value.created_at),
        "updated_at": iso_timestamp(value.updated_at),
    }


def memory_view(value: AcceptedMemoryRecord, revision: MemoryRevisionRecord | None) -> dict[str, Any]:
    return {
        "id": value.id,
        "scope_id": value.scope_id,
        "scope_kind": value.scope_kind,
        "scope_ref_id": value.scope_ref_id,
        "memory_kind": value.memory_kind,
        "status": value.status,
        "row_version": value.row_version,
        "current_revision": None
        if revision is None
        else {
            "id": revision.id,
            "revision": revision.revision,
            "content": revision.content,
            "content_hash": revision.content_hash,
            "source_refs": list(revision.source_refs_json or []),
            "created_at": iso_timestamp(revision.created_at),
        },
        "created_at": iso_timestamp(value.created_at),
        "updated_at": iso_timestamp(value.updated_at),
    }


def action_view(value: ActionItemRecord) -> dict[str, Any]:
    return {
        "id": value.id,
        "scope_id": value.scope_id,
        "project_id": value.project_id,
        "work_item_id": value.work_item_id,
        "plan_node_id": value.plan_node_id,
        "title": value.title,
        "assignee_kind": value.assignee_kind,
        "status": value.status,
        "due_at": iso_timestamp(value.due_at),
        "evidence": list(value.evidence_json or []),
        "row_version": value.row_version,
        "created_at": iso_timestamp(value.created_at),
        "updated_at": iso_timestamp(value.updated_at),
    }
