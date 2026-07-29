"""Compose user-facing Home facts without creating a second source of truth.

Home is a read model only. It projects Product Session, Harness, Governance and
Evidence records; it never owns or mutates those records.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy import select

from ..evidence.models import ArtifactRecord
from ..governance.models import HumanDecisionRequestRecord
from ..harness.models import (
    HarnessTraceRecord,
    NoteRecord,
    ProductProjectRecord,
    WorkItemRecord,
)
from ..product_sessions.database import (
    InteractionRecord,
    ProductDatabase,
    RunRecord,
    SessionRecord,
    utc_now,
)

OPEN_WORK_STATUSES = {"draft", "planned", "ready", "in_progress", "blocked"}
ACTIVE_RUN_STATUSES = {"accepted", "running", "waiting_human", "queued"}


class HomeProjectionError(ValueError):
    """The requested projection window is outside the supported bounds."""


class HomeProjectionService:
    """Build one Home snapshot from authoritative product records."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        scope_id: str = "local-user",
        principal_id: str = "local-user",
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.database = database
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock

    async def overview(self, *, year: int, utc_offset_minutes: int) -> dict[str, Any]:
        if year < 2000 or year > 2100:
            raise HomeProjectionError("year must be between 2000 and 2100")
        if utc_offset_minutes < -840 or utc_offset_minutes > 840:
            raise HomeProjectionError("utc_offset_minutes must be between -840 and 840")

        local_timezone = timezone(timedelta(minutes=utc_offset_minutes))
        as_of = _as_utc(self._clock())
        year_start = datetime(year, 1, 1, tzinfo=local_timezone).astimezone(timezone.utc)
        year_end = datetime(year + 1, 1, 1, tzinfo=local_timezone).astimezone(timezone.utc)
        today_key = as_of.astimezone(local_timezone).date().isoformat()

        async with self.database.sessions() as transaction:
            work_rows = (
                await transaction.execute(
                    select(WorkItemRecord, ProductProjectRecord)
                    .outerjoin(ProductProjectRecord, ProductProjectRecord.id == WorkItemRecord.project_id)
                    .where(
                        WorkItemRecord.scope_id == self.scope_id,
                        WorkItemRecord.status.in_(OPEN_WORK_STATUSES),
                    )
                )
            ).all()
            project_rows = (
                await transaction.execute(
                    select(ProductProjectRecord).where(
                        ProductProjectRecord.scope_id == self.scope_id,
                        ProductProjectRecord.status.in_({"proposed", "active", "paused"}),
                    )
                )
            ).scalars().all()
            idea_rows = (
                await transaction.execute(
                    select(NoteRecord)
                    .where(
                        NoteRecord.scope_id == self.scope_id,
                        NoteRecord.kind == "idea",
                        NoteRecord.status.in_({"draft", "active"}),
                    )
                    .order_by(NoteRecord.updated_at.desc())
                    .limit(3)
                )
            ).scalars().all()
            artifact_rows = (
                await transaction.execute(
                    select(ArtifactRecord)
                    .where(
                        ArtifactRecord.scope_id == self.scope_id,
                        ArtifactRecord.status.not_in({"discarded", "rejected", "not_adopted"}),
                    )
                    .order_by(ArtifactRecord.updated_at.desc())
                    .limit(3)
                )
            ).scalars().all()
            interaction_rows = (
                await transaction.execute(
                    select(
                        InteractionRecord.id,
                        InteractionRecord.session_id,
                        InteractionRecord.status,
                        InteractionRecord.created_at,
                    )
                    .join(SessionRecord, SessionRecord.id == InteractionRecord.session_id)
                    .where(
                        SessionRecord.scope_id == self.scope_id,
                        InteractionRecord.created_at >= year_start,
                        InteractionRecord.created_at < year_end,
                        InteractionRecord.status != "abandoned",
                    )
                )
            ).all()
            trace_rows = (
                await transaction.execute(
                    select(HarnessTraceRecord).where(
                        HarnessTraceRecord.scope_id == self.scope_id,
                        HarnessTraceRecord.created_at >= year_start,
                        HarnessTraceRecord.created_at < year_end,
                    )
                )
            ).scalars().all()
            calendar_ideas = (
                await transaction.execute(
                    select(NoteRecord.id, NoteRecord.created_at).where(
                        NoteRecord.scope_id == self.scope_id,
                        NoteRecord.kind == "idea",
                        NoteRecord.created_at >= year_start,
                        NoteRecord.created_at < year_end,
                    )
                )
            ).all()
            calendar_artifacts = (
                await transaction.execute(
                    select(ArtifactRecord.id, ArtifactRecord.created_at).where(
                        ArtifactRecord.scope_id == self.scope_id,
                        ArtifactRecord.created_at >= year_start,
                        ArtifactRecord.created_at < year_end,
                        ArtifactRecord.status.not_in({"discarded", "rejected", "not_adopted"}),
                    )
                )
            ).all()
            pending_decision_count = len(
                (
                    await transaction.execute(
                        select(HumanDecisionRequestRecord.id).where(
                            HumanDecisionRequestRecord.principal_id == self.principal_id,
                            HumanDecisionRequestRecord.status == "pending",
                        )
                    )
                ).all()
            )
            active_run_count = len(
                (
                    await transaction.execute(
                        select(RunRecord.id)
                        .join(SessionRecord, SessionRecord.id == RunRecord.session_id)
                        .where(
                            SessionRecord.scope_id == self.scope_id,
                            RunRecord.status.in_(ACTIVE_RUN_STATUSES),
                        )
                    )
                ).all()
            )

        calendar = self._calendar_days(
            interactions=[tuple(row) for row in interaction_rows],
            traces=list(trace_rows),
            ideas=[tuple(row) for row in calendar_ideas],
            artifacts=[tuple(row) for row in calendar_artifacts],
            local_timezone=local_timezone,
        )
        return {
            "as_of": as_of.isoformat(),
            "year": year,
            "utc_offset_minutes": utc_offset_minutes,
            "today": today_key,
            "today_summary": {
                "open_work_count": len(work_rows),
                "collaboration_count": calendar.get(today_key, {}).get("interaction_count", 0),
                "new_idea_count": calendar.get(today_key, {}).get("idea_count", 0),
                "pending_decision_count": pending_decision_count,
                "active_run_count": active_run_count,
            },
            "continue_items": self._continue_items(
                [(work, project) for work, project in work_rows],
                list(project_rows),
            ),
            "calendar_days": list(calendar.values()),
            "recent_artifacts": [
                {
                    "id": record.id,
                    "kind": record.kind,
                    "title": record.title,
                    "media_type": record.media_type,
                    "status": record.status,
                    "updated_at": _as_utc(record.updated_at).isoformat(),
                }
                for record in artifact_rows
            ],
            "ideas": [
                {
                    "id": record.id,
                    "title": record.title,
                    "status": record.status,
                    "updated_at": _as_utc(record.updated_at).isoformat(),
                }
                for record in idea_rows
            ],
        }

    def _continue_items(
        self,
        work_rows: list[tuple[WorkItemRecord, ProductProjectRecord | None]],
        project_rows: list[ProductProjectRecord],
    ) -> list[dict[str, Any]]:
        status_order = {"in_progress": 0, "blocked": 1, "ready": 2, "planned": 3, "draft": 4}
        priority_order = {"critical": 0, "high": 1, "normal": 2, "low": 3}
        ordered = sorted(
            work_rows,
            key=lambda row: (
                status_order.get(row[0].status, 9),
                priority_order.get(row[0].priority, 9),
                -_as_utc(row[0].updated_at).timestamp(),
            ),
        )
        items = [
            {
                "resource_kind": "work_item",
                "id": work.id,
                "title": work.title,
                "objective": work.objective,
                "status": work.status,
                "priority": work.priority,
                "project_id": project.id if project is not None else None,
                "project_title": project.title if project is not None else None,
                "updated_at": _as_utc(work.updated_at).isoformat(),
            }
            for work, project in ordered[:3]
        ]
        if len(items) >= 3:
            return items

        represented_projects = {item["project_id"] for item in items if item["project_id"]}
        for project in sorted(
            project_rows,
            key=lambda record: -_as_utc(record.updated_at).timestamp(),
        ):
            if project.id in represented_projects:
                continue
            items.append(
                {
                    "resource_kind": "project",
                    "id": project.id,
                    "title": project.title,
                    "objective": project.goal,
                    "status": project.status,
                    "priority": None,
                    "project_id": project.id,
                    "project_title": project.title,
                    "updated_at": _as_utc(project.updated_at).isoformat(),
                }
            )
            if len(items) == 3:
                break
        return items

    def _calendar_days(
        self,
        *,
        interactions: list[Any],
        traces: list[HarnessTraceRecord],
        ideas: list[Any],
        artifacts: list[Any],
        local_timezone: timezone,
    ) -> dict[str, dict[str, Any]]:
        days: defaultdict[str, dict[str, Any]] = defaultdict(_empty_day)

        for interaction_id, session_id, _status, created_at in interactions:
            day = _day_key(created_at, local_timezone)
            days[day]["interaction_count"] += 1
            _add_source(days[day], "interaction", interaction_id, session_id=session_id)

        for trace in traces:
            day = _day_key(trace.created_at, local_timezone)
            event_type = trace.event_type.removeprefix("harness.")
            if event_type.startswith(("project.", "work.", "action.", "plan.", "repository.")):
                days[day]["work_change_count"] += 1
                _add_source(days[day], trace.resource_kind, trace.resource_id)
            elif event_type.startswith(("note.", "memory.")):
                days[day]["knowledge_change_count"] += 1
                _add_source(days[day], trace.resource_kind, trace.resource_id)

        for idea_id, created_at in ideas:
            day = _day_key(created_at, local_timezone)
            days[day]["idea_count"] += 1
            _add_source(days[day], "idea", idea_id)

        for artifact_id, created_at in artifacts:
            day = _day_key(created_at, local_timezone)
            days[day]["artifact_count"] += 1
            _add_source(days[day], "artifact", artifact_id)

        normalized: dict[str, dict[str, Any]] = {}
        for day_key, counters in sorted(days.items()):
            counters["date"] = day_key
            counters["level"] = _activity_level(counters)
            counters["source_count"] = sum(
                counters[key]
                for key in (
                    "interaction_count",
                    "work_change_count",
                    "knowledge_change_count",
                    "idea_count",
                    "artifact_count",
                )
            )
            counters["summary"] = _activity_summary(counters)
            normalized[day_key] = counters
        return normalized


def _empty_day() -> dict[str, Any]:
    return {
        "date": "",
        "level": 0,
        "interaction_count": 0,
        "work_change_count": 0,
        "knowledge_change_count": 0,
        "idea_count": 0,
        "artifact_count": 0,
        "source_count": 0,
        "source_refs": [],
        "summary": "",
    }


def _add_source(day: dict[str, Any], kind: str, resource_id: str, **extra: Any) -> None:
    if len(day["source_refs"]) >= 8:
        return
    ref = {"kind": kind, "id": resource_id, **extra}
    if ref not in day["source_refs"]:
        day["source_refs"].append(ref)


def _activity_level(day: dict[str, Any]) -> int:
    if day["artifact_count"] or day["idea_count"]:
        return 3
    if day["work_change_count"] or day["knowledge_change_count"]:
        return 2
    if day["interaction_count"]:
        return 1
    return 0


def _activity_summary(day: dict[str, Any]) -> str:
    parts: list[str] = []
    labels = (
        ("interaction_count", "次协作"),
        ("work_change_count", "项工作变化"),
        ("knowledge_change_count", "项知识变化"),
        ("idea_count", "个灵感"),
        ("artifact_count", "个产物"),
    )
    for key, label in labels:
        if day[key]:
            parts.append(f"{day[key]}{label}")
    return " · ".join(parts) or "当天没有记录到活动"


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _day_key(value: datetime, local_timezone: timezone) -> str:
    return _as_utc(value).astimezone(local_timezone).date().isoformat()
