"""Read-only Product Harness queries and two-stage Context assembly."""

from __future__ import annotations

import logging
import re
from typing import Any, Mapping, Protocol, Sequence

from sqlalchemy import select

from ..observability.context import bind_context
from ..product_sessions.database import ProductDatabase
from .contracts import MEMORY_ACTIVE_STATUSES
from .contracts import canonical_json as _canonical
from .contracts import iso_timestamp as _iso
from .models import ContextAdoptionRecord, ContextPackageRecord

logger = logging.getLogger(__name__)


class HarnessResourceQueries(Protocol):
    """Narrow read contract required by Context assembly."""

    async def get_project(self, project_id: str) -> dict[str, Any]: ...

    async def get_work_item(self, work_item_id: str) -> dict[str, Any]: ...

    async def list_projects(
        self,
        *,
        statuses: Sequence[str] | None = None,
        kind: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]: ...

    async def list_work(
        self,
        *,
        project_id: str | None = None,
        statuses: Sequence[str] | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]: ...

    async def list_action_items(
        self,
        *,
        project_id: str | None = None,
        work_item_id: str | None = None,
        statuses: Sequence[str] | None = None,
        limit: int = 300,
    ) -> list[dict[str, Any]]: ...

    async def list_notes(
        self,
        *,
        project_id: str | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]: ...

    async def list_memory(
        self,
        *,
        scope_kind: str | None = None,
        scope_ref_id: str | None = None,
        include_candidates: bool = True,
        statuses: Sequence[str] | None = None,
        limit: int = 200,
    ) -> dict[str, Any]: ...


class ContextContributor(Protocol):
    """Read-only extension point for bounded, attributable Context sources."""

    async def directory_context_items(
        self,
        *,
        prompt: str,
        projects: Sequence[Mapping[str, Any]],
    ) -> list[dict[str, Any]]: ...

    async def detailed_context_items(
        self,
        *,
        project_id: str,
        prompt: str,
        scenario: str,
    ) -> list[dict[str, Any]]: ...


class HarnessContextQueryService:
    """Assemble bounded Context views without mutating Harness resources."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        scope_id: str,
        resources: HarnessResourceQueries,
        contributors: Sequence[ContextContributor] = (),
    ) -> None:
        self.database = database
        self.scope_id = scope_id
        self.resources = resources
        self.contributors = tuple(contributors)

    async def project_context(self, project_id: str) -> dict[str, Any]:
        project = await self.resources.get_project(project_id)
        work = await self.resources.list_work(project_id=project_id)
        work_details = [await self.resources.get_work_item(value["id"]) for value in work]
        actions = await self.resources.list_action_items(project_id=project_id)
        notes = await self.resources.list_notes(project_id=project_id)
        memory = await self.resources.list_memory(
            scope_kind="project",
            scope_ref_id=project_id,
            include_candidates=False,
            statuses=tuple(MEMORY_ACTIVE_STATUSES),
        )
        result = {
            "project": project,
            "work_items": work,
            "work_details": work_details,
            "action_items": actions,
            "notes": notes,
            "accepted_memory": memory["accepted"],
        }
        with bind_context(resource_id=project_id):
            logger.info(
                "harness_project_context_loaded work_items=%d action_items=%d notes=%d accepted_memory=%d",
                len(work),
                len(actions),
                len(notes),
                len(memory["accepted"]),
            )
        return result

    async def latest_context_package(self, session_id: str) -> dict[str, Any] | None:
        async with self.database.sessions() as transaction:
            package = await transaction.scalar(
                select(ContextPackageRecord)
                .where(
                    ContextPackageRecord.session_id == session_id,
                    ContextPackageRecord.scope_id == self.scope_id,
                )
                .order_by(ContextPackageRecord.created_at.desc())
                .limit(1)
            )
            if package is None:
                return None
            items = (
                await transaction.scalars(
                    select(ContextAdoptionRecord)
                    .where(ContextAdoptionRecord.context_package_id == package.id)
                    .order_by(ContextAdoptionRecord.ordinal)
                )
            ).all()
            return {
                "id": package.id,
                "session_id": package.session_id,
                "run_id": package.run_id,
                "stage": package.stage,
                "revision": package.revision,
                "previous_package_id": package.previous_package_id,
                "selected_project_id": package.selected_project_id,
                "selected_work_item_id": package.selected_work_item_id,
                "token_budget": package.token_budget,
                "estimated_tokens": package.estimated_tokens,
                "package_hash": package.package_hash,
                "status": package.status,
                "revision_reason": package.revision_reason,
                "created_by": package.created_by,
                "created_at": _iso(package.created_at),
                "items": [
                    {
                        "source_kind": item.source_kind,
                        "source_id": item.source_id,
                        "source_revision": item.source_revision,
                        "title": item.title,
                        "content": item.content_text,
                        "adopted": item.adopted,
                        "locked": item.locked,
                        "selection_origin": item.selection_origin,
                        "reason": item.reason,
                        "token_estimate": item.token_estimate,
                    }
                    for item in items
                ],
            }

    async def context_package_for_run(
        self,
        *,
        run_id: str,
        stage: str,
    ) -> dict[str, Any] | None:
        """Return the newest immutable revision for one Workflow Context stage."""

        async with self.database.sessions() as transaction:
            package = await transaction.scalar(
                select(ContextPackageRecord)
                .where(
                    ContextPackageRecord.run_id == run_id,
                    ContextPackageRecord.scope_id == self.scope_id,
                    ContextPackageRecord.stage == stage,
                    ContextPackageRecord.status != "superseded",
                )
                .order_by(ContextPackageRecord.revision.desc())
                .limit(1)
            )
            if package is None:
                return None
            items = list(
                (
                    await transaction.scalars(
                        select(ContextAdoptionRecord)
                        .where(ContextAdoptionRecord.context_package_id == package.id)
                        .order_by(ContextAdoptionRecord.ordinal)
                    )
                ).all()
            )
            return {
                "id": package.id,
                "run_id": package.run_id,
                "stage": package.stage,
                "revision": package.revision,
                "package_hash": package.package_hash,
                "status": package.status,
                "items": [
                    {
                        "source_kind": item.source_kind,
                        "source_id": item.source_id,
                        "source_revision": item.source_revision,
                        "title": item.title,
                        "content": item.content_text,
                        "adopted": item.adopted,
                        "locked": item.locked,
                        "selection_origin": item.selection_origin,
                        "reason": item.reason,
                        "token_estimate": item.token_estimate,
                    }
                    for item in items
                ],
            }

    async def context_package_by_id(self, package_id: str) -> dict[str, Any] | None:
        """Return one immutable ContextPackage revision, including superseded revisions.

        Workflow decision retries must address the exact revision captured in
        the checkpoint. Looking up only the newest revision would change an
        idempotent command's request after a partial retry.
        """

        async with self.database.sessions() as transaction:
            package = await transaction.get(ContextPackageRecord, package_id)
            if package is None or package.scope_id != self.scope_id:
                return None
            items = list(
                (
                    await transaction.scalars(
                        select(ContextAdoptionRecord)
                        .where(ContextAdoptionRecord.context_package_id == package.id)
                        .order_by(ContextAdoptionRecord.ordinal)
                    )
                ).all()
            )
            return {
                "id": package.id,
                "run_id": package.run_id,
                "stage": package.stage,
                "revision": package.revision,
                "package_hash": package.package_hash,
                "status": package.status,
                "items": [
                    {
                        "ordinal": item.ordinal,
                        "source_kind": item.source_kind,
                        "source_id": item.source_id,
                        "source_revision": item.source_revision,
                        "title": item.title,
                        "content": item.content_text,
                        "adopted": item.adopted,
                        "locked": item.locked,
                        "selection_origin": item.selection_origin,
                        "reason": item.reason,
                        "token_estimate": item.token_estimate,
                    }
                    for item in items
                ],
            }

    async def directory_context_items(
        self,
        *,
        prompt: str,
        summaries: Sequence[Mapping[str, Any]],
        max_projects: int = 20,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        projects = await self.resources.list_projects(
            statuses=("proposed", "active", "paused"),
            limit=max_projects,
        )
        terms = self._search_terms(prompt)
        ranked: list[tuple[int, dict[str, Any]]] = []
        for project in projects:
            haystack = f"{project['title']} {project['goal']}".lower()
            score = sum(term in haystack for term in terms)
            ranked.append((score, project))
        ranked.sort(key=lambda value: (value[0], value[1]["updated_at"] or ""), reverse=True)
        matched_project_ids = {value["id"] for score, value in ranked if score > 0}
        directory_projects = [{**value, "match_score": score} for score, value in ranked[:8]]
        directory = [
            {
                "source_kind": "project_directory",
                "source_id": value["id"],
                "source_revision": value["row_version"],
                "title": value["title"],
                "content": _canonical(
                    {"kind": value["kind"], "status": value["status"], "goal": value["goal"]}
                ),
                "adopted": True,
                "reason": (
                    "Project轻量目录与当前输入匹配"
                    if value["id"] in matched_project_ids
                    else "最近更新的正式Project轻量目录"
                ),
            }
            for value in directory_projects
        ]
        directory.extend(
            {
                "source_kind": "turn_summary",
                "source_id": str(value.get("id") or "unknown"),
                "source_revision": value.get("summary_hash"),
                "title": str(value.get("topic") or "回合主题"),
                "content": _canonical(value.get("summary") or value),
                "adopted": True,
                "reason": "最近回合重点与当前输入匹配",
            }
            for value in summaries
        )
        for contributor in self.contributors:
            directory.extend(
                await contributor.directory_context_items(
                    prompt=prompt,
                    projects=directory_projects,
                )
            )
        logger.info(
            "harness_directory_context_assembled projects=%d matched_projects=%d "
            "summaries=%d adopted_items=%d",
            len(projects),
            len(matched_project_ids),
            len(summaries),
            len(directory),
        )
        return directory, directory_projects

    async def detailed_context_items(
        self,
        project_id: str,
        *,
        prompt: str = "",
        scenario: str = "",
    ) -> list[dict[str, Any]]:
        context = await self.project_context(project_id)
        project = context["project"]
        items: list[dict[str, Any]] = [
            {
                "source_kind": "project",
                "source_id": project["id"],
                "source_revision": project["row_version"],
                "title": project["title"],
                "content": _canonical(
                    {"goal": project["goal"], "status": project["status"], "kind": project["kind"]}
                ),
                "adopted": True,
                "reason": "用户或意图已绑定该Project",
            }
        ]
        for work in context["work_items"]:
            if work["status"] in {"archived", "cancelled"}:
                continue
            items.append(
                {
                    "source_kind": "work_item",
                    "source_id": work["id"],
                    "source_revision": work["row_version"],
                    "title": work["title"],
                    "content": _canonical(
                        {
                            "objective": work["objective"],
                            "status": work["status"],
                            "priority": work["priority"],
                            "evidence": work["completion_evidence"],
                        }
                    ),
                    "adopted": True,
                    "reason": "绑定Project中的开放Work",
                }
            )
        for detail in context["work_details"]:
            plan = detail.get("plan")
            revision = (plan or {}).get("revision") or {}
            if revision:
                items.append(
                    {
                        "source_kind": "task_plan",
                        "source_id": str((plan or {}).get("id") or "unknown"),
                        "source_revision": revision.get("revision"),
                        "title": f"{detail['work_item']['title']} · 当前Plan",
                        "content": _canonical(
                            {
                                "summary": revision.get("summary"),
                                "nodes": revision.get("nodes") or [],
                                "validation_contract": revision.get("validation_contract") or {},
                            }
                        ),
                        "adopted": True,
                        "reason": "绑定Project中WorkItem的当前已接受Plan revision",
                    }
                )
        for action in context["action_items"]:
            if action["status"] in {"completed", "cancelled", "skipped"}:
                continue
            items.append(
                {
                    "source_kind": "action_item",
                    "source_id": action["id"],
                    "source_revision": action["row_version"],
                    "title": action["title"],
                    "content": _canonical(
                        {
                            "status": action["status"],
                            "assignee_kind": action["assignee_kind"],
                            "due_at": action["due_at"],
                        }
                    ),
                    "adopted": True,
                    "reason": "绑定Project中的开放ActionItem",
                }
            )
        for note in context["notes"][:8]:
            revision = note.get("current_revision") or {}
            items.append(
                {
                    "source_kind": "note",
                    "source_id": note["id"],
                    "source_revision": revision.get("revision"),
                    "title": note["title"],
                    "content": str(revision.get("content") or ""),
                    "adopted": True,
                    "reason": "与绑定Project显式关联的当前Note revision",
                }
            )
        for memory in context["accepted_memory"]:
            revision = memory.get("current_revision") or {}
            items.append(
                {
                    "source_kind": "accepted_memory",
                    "source_id": memory["id"],
                    "source_revision": revision.get("revision"),
                    "title": memory["memory_kind"],
                    "content": str(revision.get("content") or ""),
                    "adopted": True,
                    "reason": "绑定Project作用域内仍有效的Accepted Memory",
                }
            )
        contributed: list[dict[str, Any]] = []
        for contributor in self.contributors:
            contributed.extend(
                await contributor.detailed_context_items(
                    project_id=project_id,
                    prompt=prompt,
                    scenario=scenario,
                )
            )
        # Project identity remains first. Repository baseline and rules are
        # intentionally ahead of wider Work/Note/Memory detail so token
        # pressure cannot silently drop the exact code baseline being used.
        items[1:1] = contributed
        with bind_context(resource_id=project_id):
            logger.info("harness_detailed_context_assembled adopted_items=%d", len(items))
        return items

    @staticmethod
    def _search_terms(text: str) -> set[str]:
        lowered = text.lower()
        terms = set(re.findall(r"[a-z0-9_][a-z0-9_.-]{1,}", lowered))
        for sequence in re.findall(r"[\u4e00-\u9fff]{2,}", lowered):
            for size in range(2, min(6, len(sequence)) + 1):
                terms.update(sequence[index : index + size] for index in range(len(sequence) - size + 1))
        return terms

    async def learning_tracks(self) -> list[dict[str, Any]]:
        projects = await self.resources.list_projects(kind="learning")
        tracks: list[dict[str, Any]] = []
        for project in projects:
            units = await self.resources.list_work(project_id=project["id"])
            tracks.append(
                {
                    "project": project,
                    "units": [value for value in units if value["kind"] == "learning_unit"],
                    "progress": {
                        "completed": sum(value["status"] == "completed" for value in units),
                        "total": len(units),
                    },
                }
            )
        return tracks
