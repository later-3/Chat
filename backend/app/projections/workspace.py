"""Pure builders used only by the Personal Workspace projection."""

from __future__ import annotations

from typing import Any

from .contracts import source_revision


def independent_sources(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """Describe the exact unclassified Work/Action revisions in the view."""

    sources = []
    for work in snapshot["work_items"]:
        sources.append(
            source_revision(
                owner="MOD-WORK",
                resource_kind="work_item",
                resource_id=work["id"],
                revision=work["row_version"],
                updated_at=work.get("updated_at"),
            )
        )
    for action in snapshot["action_items"]:
        sources.append(
            source_revision(
                owner="MOD-WORK",
                resource_kind="action_item",
                resource_id=action["id"],
                revision=action["row_version"],
                updated_at=action.get("updated_at"),
            )
        )
    return sources


def independent_items(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """Keep standalone Actions visible without inventing a Project domain."""

    actions_by_work: dict[str, list[dict[str, Any]]] = {}
    for action in snapshot["action_items"]:
        if action.get("work_item_id"):
            actions_by_work.setdefault(action["work_item_id"], []).append(action)
    work_items = [
        {
            **work,
            "item_kind": "work_item",
            "actions": actions_by_work.get(work["id"], []),
            "classification": "unclassified",
            "classification_reason": "没有Project归属，Projection不会猜它属于工作或生活。",
        }
        for work in snapshot["work_items"]
    ]
    standalone_actions = [
        {
            **action,
            "item_kind": "action_item",
            "objective": "独立Action；当前没有Project或Work归属。",
            "actions": [],
            "classification": "unclassified",
            "classification_reason": "没有Project归属，Projection不会猜它属于工作或生活。",
        }
        for action in snapshot["action_items"]
        if not action.get("work_item_id")
    ]
    return [*work_items, *standalone_actions]


def learning_queue_item(card: dict[str, Any]) -> dict[str, Any]:
    """Expose known learning work while preserving the missing Schedule fact."""

    return {
        "project_id": card["id"],
        "title": card["title"],
        "goal": card["goal"],
        "status": card["status"],
        "unit_counts": card["count_progress"],
        "next_actions": card["next_actions"],
        "next_review": {
            "state": "unknown",
            "reason_code": "schedule_not_implemented",
            "value": None,
        },
    }
