"""Application-level composers for stable, read-only product projections."""

from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime
from typing import Any, Callable, Protocol

from ..harness.projection_queries import HarnessProjectionQueryService
from ..product_sessions.database import utc_now
from .contracts import (
    ASSIGNEE_KINDS,
    OPEN_ACTION_STATUSES,
    OPEN_WORK_STATUSES,
    PROJECT_DOMAIN_BY_KIND,
    PROJECT_DOSSIER_VIEW_SCHEMA,
    TERMINAL_ACTION_STATUSES,
    WORKSPACE_VIEW_SCHEMA,
    ProjectionNotFound,
    ProjectionValidationError,
    envelope,
    section_state,
    source_revision,
)
from .workspace import (
    independent_items as build_independent_items,
)
from .workspace import (
    independent_sources,
    learning_queue_item,
)

logger = logging.getLogger(__name__)


class ProtocolProjectionQueries(Protocol):
    async def resolve_for_turn(
        self,
        *,
        scenario: str,
        project_id: str | None,
        work_item_id: str | None = None,
        user_ref_id: str | None = None,
        query_kind: str | None = None,
    ) -> dict[str, Any]: ...


class ProjectResourceProjectionQueries(Protocol):
    async def list_summaries(self, *, project_id: str) -> list[dict[str, Any]]: ...


class ProjectionService:
    """Compose presentation-neutral Read Models from owner query contracts.

    This coordinator is intentionally read only.  It neither opens product
    transactions nor persists a projection database; callers can discard and
    rebuild every response from the source revision vector.
    """

    def __init__(
        self,
        harness: HarnessProjectionQueryService,
        *,
        protocols: ProtocolProjectionQueries | None = None,
        project_resources: ProjectResourceProjectionQueries | None = None,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.harness = harness
        self.protocols = protocols
        self.project_resources = project_resources
        self._clock = clock

    async def workspace(self, *, domain: str = "all") -> dict[str, Any]:
        if domain not in {"all", "work", "learning", "research", "life"}:
            raise ProjectionValidationError("domain必须是all/work/learning/research/life")
        project_ids_with_sentinel = await self.harness.list_project_ids(
            statuses=("proposed", "active", "paused", "completed"),
            limit=101,
        )
        projects_truncated = len(project_ids_with_sentinel) > 100
        project_ids = project_ids_with_sentinel[:100]
        all_cards: list[dict[str, Any]] = []
        all_card_sources: dict[str, list[dict[str, Any]]] = {}
        for project_id in project_ids:
            snapshot = await self.harness.project_snapshot(project_id)
            if snapshot is None:
                # The Project may have been archived between the directory read
                # and snapshot query. A projection cannot turn that race into an
                # empty card, so it is simply absent from this new revision.
                continue
            card, card_sources = _project_card(snapshot)
            all_cards.append(card)
            all_card_sources[card["id"]] = card_sources

        cards = [card for card in all_cards if domain == "all" or card["domain"] == domain]
        cards.sort(key=_project_card_order)
        # Domain counts also derive from ``all_cards``. Include those revisions
        # even when the selected domain hides the corresponding Project cards.
        sources = [value for card in all_cards for value in all_card_sources[card["id"]]]
        if domain == "all":
            independent_with_sentinel = await self.harness.independent_work_snapshot(limit=101)
            independent_truncated = (
                len(independent_with_sentinel["work_items"]) > 100
                or len(independent_with_sentinel["action_items"]) > 100
            )
            independent = {
                "work_items": independent_with_sentinel["work_items"][:100],
                "action_items": independent_with_sentinel["action_items"][:100],
            }
            independent_items = build_independent_items(independent)
            sources.extend(independent_sources(independent))
        else:
            independent_truncated = False
            independent = {"work_items": [], "action_items": []}
            independent_items: list[dict[str, Any]] = []

        domains = [
            {
                "id": value,
                "label": label,
                "project_count": sum(card["domain"] == value for card in all_cards),
            }
            for value, label in (
                ("work", "工作"),
                ("learning", "学习"),
                ("research", "研究"),
                ("life", "生活"),
            )
        ]
        learning_queue = [learning_queue_item(card) for card in cards if card["domain"] == "learning"]
        attention = [item for card in cards for item in card["attention"]]
        summary = {
            "project_count": len(cards),
            "open_work_count": sum(card["counts"]["open_work"] for card in cards)
            + sum(value["status"] in OPEN_WORK_STATUSES for value in independent["work_items"]),
            "blocked_count": sum(card["counts"]["blocked"] for card in cards)
            + sum(value["status"] == "blocked" for value in independent["work_items"]),
            "open_action_count": sum(card["counts"]["open_actions"] for card in cards)
            + len(independent["action_items"]),
            "attention_count": len(attention),
            "count_semantics": "对象状态计数，不代表质量、投入时长或完成保证",
        }
        sections = {
            "projects": section_state(
                "partial" if projects_truncated else ("available" if cards else "empty"),
                reason_code=(
                    "workspace_project_limit_reached"
                    if projects_truncated
                    else (None if cards else "no_projects_in_view")
                ),
                detail=(
                    "当前只组合最近更新的100个Project；需要稳定Cursor后才能保证全量浏览。"
                    if projects_truncated
                    else None
                ),
                source_owner="MOD-WORK",
            ),
            "independent_work": section_state(
                "partial" if independent_truncated else ("available" if independent_items else "empty"),
                reason_code=(
                    "workspace_independent_limit_reached"
                    if independent_truncated
                    else (
                        None
                        if independent_items
                        else ("not_in_domain_view" if domain != "all" else "no_independent_work")
                    )
                ),
                detail=(
                    "当前只显示最近更新的100个独立Work/Action。"
                    if independent_truncated
                    else ("未归类事项只在“全部”视图显示。" if domain != "all" else None)
                ),
                source_owner="MOD-WORK",
            ),
            "learning_schedule": section_state(
                "unknown",
                reason_code="schedule_not_implemented",
                detail="学习项目可查看，复习触发和下一次时间仍需MOD-SCHEDULE。",
                source_owner="MOD-SCHEDULE",
            ),
        }
        return envelope(
            view_schema=WORKSPACE_VIEW_SCHEMA,
            view_type="personal_workspace",
            subject={"kind": "scope", "id": "local-user", "domain": domain},
            data={
                "domain": domain,
                "domains": domains,
                "summary": summary,
                "projects": cards,
                "independent_work": independent_items,
                "learning_queue": learning_queue,
                "attention": attention,
                "limits": {
                    "projects": 100,
                    "independent_items": 100,
                    "projects_truncated": projects_truncated,
                    "independent_items_truncated": independent_truncated,
                },
            },
            sources=sources,
            sections=sections,
            generated_at=self._clock(),
        )

    async def project_dossier(self, project_id: str) -> dict[str, Any]:
        snapshot = await self.harness.project_snapshot(project_id)
        if snapshot is None:
            # Scope filtering and non-existence deliberately share one response.
            raise ProjectionNotFound("Project不存在")

        card, sources = _project_card(snapshot)
        work_details = snapshot["work_details"]
        responsibility_items = _responsibility_items(snapshot)
        role_lanes = _role_lanes(responsibility_items)
        evidence_items = _harness_evidence_items(snapshot)

        current_milestone = None
        milestone_state = section_state(
            "empty",
            reason_code="current_milestone_not_set",
            source_owner="MOD-WORK",
        )
        milestone_id = snapshot["project"].get("current_milestone_id")
        if milestone_id:
            current_milestone = next(
                (
                    detail["work_item"]
                    for detail in work_details
                    if detail["work_item"]["id"] == milestone_id
                    and detail["work_item"]["kind"] == "milestone"
                ),
                None,
            )
            milestone_state = section_state(
                "available" if current_milestone else "unknown",
                reason_code=None if current_milestone else "current_milestone_reference_invalid",
                detail=None
                if current_milestone
                else "Project指向的里程碑不存在、类型错误或不属于当前Project。",
                source_owner="MOD-WORK",
            )

        protocol, protocol_state, protocol_sources = await self._protocol(project_id, card["domain"])
        repositories, repository_state, repository_sources = await self._repositories(project_id)
        sources.extend(protocol_sources)
        sources.extend(repository_sources)

        sections = {
            "project": section_state("available", source_owner="MOD-WORK"),
            "current_milestone": milestone_state,
            "work": section_state(
                "available" if work_details else "empty",
                reason_code=None if work_details else "no_work_items",
                source_owner="MOD-WORK",
            ),
            "responsibilities": section_state(
                "available" if responsibility_items else "empty",
                reason_code=None if responsibility_items else "no_committed_actions_or_plan_steps",
                source_owner="MOD-WORK",
            ),
            "knowledge": section_state(
                "available" if snapshot["notes"] or snapshot["accepted_memory"] else "empty",
                reason_code=None
                if snapshot["notes"] or snapshot["accepted_memory"]
                else "no_project_knowledge",
                source_owner="MOD-KNOWLEDGE",
            ),
            "protocol": protocol_state,
            "repositories": repository_state,
            "evidence": section_state(
                "partial",
                reason_code="harness_evidence_references_only",
                detail=(
                    "当前显示Work/Action已提交的Evidence引用；完整Artifact、Claim、Validity与失效传播视图属于W8-01。"
                ),
                source_owner="MOD-EVIDENCE",
            ),
            "artifacts": section_state(
                "unknown",
                reason_code="project_artifact_query_not_available",
                detail="Artifact没有project_id，不能按标题或时间猜测归属。",
                source_owner="MOD-EVIDENCE",
            ),
            "schedule": section_state(
                "unknown",
                reason_code="schedule_not_implemented",
                source_owner="MOD-SCHEDULE",
            ),
            "delivery": section_state(
                "unknown",
                reason_code="delivery_not_implemented",
                source_owner="MOD-DELIVERY",
            ),
        }
        return envelope(
            view_schema=PROJECT_DOSSIER_VIEW_SCHEMA,
            view_type="project_dossier",
            subject={
                "kind": "project",
                "id": snapshot["project"]["id"],
                "revision": snapshot["project"]["row_version"],
            },
            data={
                "project": snapshot["project"],
                "domain": card["domain"],
                "current_milestone": current_milestone,
                "counts": card["counts"],
                "count_progress": card["count_progress"],
                "next_actions": card["next_actions"],
                "attention": card["attention"],
                "role_lanes": role_lanes,
                "work_items": work_details,
                "knowledge": {
                    "notes": snapshot["notes"],
                    "accepted_memory": snapshot["accepted_memory"],
                },
                "protocol": protocol,
                "repositories": repositories,
                "evidence": {
                    "references": evidence_items,
                    "reference_count": len(evidence_items),
                    "coverage": "partial",
                },
                "activity": snapshot["activity"],
            },
            sources=sources,
            sections=sections,
            generated_at=self._clock(),
        )

    async def _protocol(
        self,
        project_id: str,
        domain: str,
    ) -> tuple[dict[str, Any] | None, dict[str, Any], list[dict[str, Any]]]:
        if self.protocols is None:
            return (
                None,
                section_state(
                    "unknown",
                    reason_code="protocol_query_not_configured",
                    source_owner="MOD-PROTOCOL",
                ),
                [],
            )
        scenario = {"learning": "learning", "research": "research"}.get(domain, "project")
        try:
            value = await self.protocols.resolve_for_turn(
                scenario=scenario,
                project_id=project_id,
            )
        except Exception as error:  # The optional block degrades independently.
            code = str(getattr(error, "code", "PROTOCOL_UNAVAILABLE"))
            logger.warning(
                "projection_optional_source_unavailable",
                extra={
                    "source_owner": "MOD-PROTOCOL",
                    "project_id": project_id,
                    "error_code": code,
                    "error_type": type(error).__name__,
                },
            )
            return (
                None,
                section_state(
                    "unknown",
                    reason_code=code.lower(),
                    detail="当前没有可解析的有效协作方法。",
                    source_owner="MOD-PROTOCOL",
                ),
                [],
            )
        public = {
            key: value.get(key)
            for key in (
                "protocol_key",
                "protocol_name",
                "description",
                "revision",
                "definition_id",
                "definition_hash",
                "binding_id",
                "binding_row_version",
                "scenario_kind",
                "selection_source",
                "selection_reason",
                "phases",
                "applicable_rules",
            )
        }
        return (
            public,
            section_state("available", source_owner="MOD-PROTOCOL"),
            [
                source_revision(
                    owner="MOD-PROTOCOL",
                    resource_kind="protocol_binding",
                    resource_id=str(value["binding_id"]),
                    revision=str(value["binding_row_version"]),
                    updated_at=None,
                ),
                source_revision(
                    owner="MOD-PROTOCOL",
                    resource_kind="protocol_definition",
                    resource_id=str(value["definition_id"]),
                    revision=str(value["revision"]),
                    updated_at=None,
                ),
            ],
        )

    async def _repositories(
        self,
        project_id: str,
    ) -> tuple[list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
        if self.project_resources is None:
            return (
                [],
                section_state(
                    "unknown",
                    reason_code="repository_query_not_configured",
                    source_owner="MOD-WORK",
                ),
                [],
            )
        try:
            values = await self.project_resources.list_summaries(project_id=project_id)
        except Exception as error:
            code = str(getattr(error, "code", "REPOSITORY_QUERY_FAILED"))
            logger.warning(
                "projection_optional_source_unavailable",
                extra={
                    "source_owner": "MOD-WORK",
                    "project_id": project_id,
                    "error_code": code,
                    "error_type": type(error).__name__,
                },
            )
            return (
                [],
                section_state(
                    "error",
                    reason_code=code.lower(),
                    detail="代码资源暂时无法读取；Project其他事实仍然可用。",
                    source_owner="MOD-WORK",
                ),
                [],
            )
        sources: list[dict[str, Any]] = []
        for item in values:
            binding = item["binding"]
            sources.append(
                source_revision(
                    owner="MOD-WORK",
                    resource_kind="repository_binding",
                    resource_id=binding["id"],
                    revision=f"{binding['row_version']}:{binding['generation']}",
                    updated_at=binding.get("updated_at"),
                )
            )
            snapshot = item.get("latest_snapshot")
            if snapshot:
                sources.append(
                    source_revision(
                        owner="MOD-WORK",
                        resource_kind="repository_snapshot",
                        resource_id=snapshot["id"],
                        revision=snapshot["semantic_hash"],
                        updated_at=snapshot.get("observed_at"),
                    )
                )
        return (
            values,
            section_state(
                "available" if values else "empty",
                reason_code=None if values else "no_repository_bindings",
                source_owner="MOD-WORK",
            ),
            sources,
        )


def _project_card(snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    project = snapshot["project"]
    work = [value["work_item"] for value in snapshot["work_details"]]
    responsibilities = _responsibility_items(snapshot)
    open_work = [value for value in work if value["status"] in OPEN_WORK_STATUSES]
    completed_work = [value for value in work if value["status"] == "completed"]
    blocked = [value for value in work if value["status"] == "blocked"]
    open_actions = [value for value in responsibilities if value["status"] in OPEN_ACTION_STATUSES]
    role_counts = Counter(value["assignee_kind"] for value in open_actions)
    evidence_count = len(_harness_evidence_items(snapshot))
    total = len(work)
    attention: list[dict[str, Any]] = [
        {
            "kind": "blocked_work",
            "severity": "attention",
            "project_id": project["id"],
            "resource_id": value["id"],
            "title": value["title"],
            "reason_code": "work_blocked",
        }
        for value in blocked
    ]
    if project["status"] == "active" and not open_actions and open_work:
        attention.append(
            {
                "kind": "missing_next_action",
                "severity": "attention",
                "project_id": project["id"],
                "resource_id": project["id"],
                "title": "当前没有明确的下一行动",
                "reason_code": "active_project_without_next_action",
            }
        )
    sources = _snapshot_sources(snapshot)
    return (
        {
            "id": project["id"],
            "title": project["title"],
            "goal": project["goal"],
            "kind": project["kind"],
            "domain": PROJECT_DOMAIN_BY_KIND.get(project["kind"], "work"),
            "status": project["status"],
            "row_version": project["row_version"],
            "updated_at": project["updated_at"],
            "counts": {
                "work_total": total,
                "open_work": len(open_work),
                "completed_work": len(completed_work),
                "blocked": len(blocked),
                "open_actions": len(open_actions),
                "notes": len(snapshot["notes"]),
                "accepted_memory": len(snapshot["accepted_memory"]),
                "evidence_references": evidence_count,
            },
            "count_progress": {
                "completed": len(completed_work),
                "total": total,
                "ratio": round(len(completed_work) / total, 4) if total else None,
                "semantics": "WorkItem状态计数，不代表质量或Project完成保证",
            },
            "responsibility_counts": {value: int(role_counts.get(value, 0)) for value in ASSIGNEE_KINDS},
            "next_actions": sorted(open_actions, key=_responsibility_order)[:5],
            "attention": attention,
        },
        sources,
    )


def _responsibility_items(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    work_title_by_id = {
        detail["work_item"]["id"]: detail["work_item"]["title"] for detail in snapshot["work_details"]
    }
    action_node_ids = {
        value["plan_node_id"] for value in snapshot["action_items"] if value.get("plan_node_id")
    }
    items = [
        {
            "source_kind": "action_item",
            "source_id": value["id"],
            "work_item_id": value.get("work_item_id"),
            "work_title": work_title_by_id.get(value.get("work_item_id")),
            "title": value["title"],
            "objective": value["title"],
            "status": value["status"],
            "assignee_kind": value["assignee_kind"],
            "due_at": value.get("due_at"),
            "evidence_count": len(value.get("evidence") or []),
            "commitment_state": "committed_action",
        }
        for value in snapshot["action_items"]
        if value["status"] not in TERMINAL_ACTION_STATUSES
    ]
    for detail in snapshot["work_details"]:
        plan = detail.get("plan") or {}
        revision = plan.get("revision") or {}
        if revision.get("status") != "accepted":
            continue
        for node in revision.get("nodes") or []:
            if node["id"] in action_node_ids or node["status"] in TERMINAL_ACTION_STATUSES:
                continue
            items.append(
                {
                    "source_kind": "plan_node",
                    "source_id": node["id"],
                    "work_item_id": detail["work_item"]["id"],
                    "work_title": detail["work_item"]["title"],
                    "title": node["title"],
                    "objective": node["objective"],
                    "status": node["status"],
                    "assignee_kind": node["assignee_kind"],
                    "due_at": None,
                    "evidence_count": 0,
                    "commitment_state": "accepted_plan_step",
                }
            )
    return sorted(items, key=_responsibility_order)


def _role_lanes(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    labels = {"user": "你来做", "agent": "Chat / AI执行", "external": "外部协作"}
    descriptions = {
        "user": "需要你亲自判断、提供材料或完成的行动。",
        "agent": "已进入正式Action或已接受Plan的AI步骤，不含模型随口建议。",
        "external": "等待其他人或外部系统完成的行动；当前不等于已绑定外部Principal。",
    }
    return [
        {
            "assignee_kind": assignee,
            "label": labels[assignee],
            "description": descriptions[assignee],
            "items": [value for value in items if value["assignee_kind"] == assignee],
        }
        for assignee in ASSIGNEE_KINDS
    ]


def _harness_evidence_items(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    values: list[dict[str, Any]] = []
    for detail in snapshot["work_details"]:
        work = detail["work_item"]
        for index, evidence in enumerate(work.get("completion_evidence") or []):
            values.append(
                {
                    "subject_kind": "work_item",
                    "subject_id": work["id"],
                    "subject_title": work["title"],
                    "ordinal": index,
                    "reference": evidence,
                }
            )
    for action in snapshot["action_items"]:
        for index, evidence in enumerate(action.get("evidence") or []):
            values.append(
                {
                    "subject_kind": "action_item",
                    "subject_id": action["id"],
                    "subject_title": action["title"],
                    "ordinal": index,
                    "reference": evidence,
                }
            )
    return values


def _snapshot_sources(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    project = snapshot["project"]
    sources = [
        source_revision(
            owner="MOD-WORK",
            resource_kind="project",
            resource_id=project["id"],
            revision=project["row_version"],
            updated_at=project.get("updated_at"),
        )
    ]
    for detail in snapshot["work_details"]:
        work = detail["work_item"]
        sources.append(
            source_revision(
                owner="MOD-WORK",
                resource_kind="work_item",
                resource_id=work["id"],
                revision=work["row_version"],
                updated_at=work.get("updated_at"),
            )
        )
        plan = detail.get("plan")
        if plan:
            sources.append(
                source_revision(
                    owner="MOD-WORK",
                    resource_kind="task_plan",
                    resource_id=plan["id"],
                    revision=plan["row_version"],
                    updated_at=plan.get("updated_at"),
                )
            )
            revision = plan.get("revision")
            if revision:
                sources.append(
                    source_revision(
                        owner="MOD-WORK",
                        resource_kind="task_plan_revision",
                        resource_id=revision["id"],
                        revision=revision["revision"],
                        updated_at=revision.get("created_at"),
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
    for note in snapshot["notes"]:
        current = note.get("current_revision") or {}
        sources.append(
            source_revision(
                owner="MOD-KNOWLEDGE",
                resource_kind="note",
                resource_id=note["id"],
                revision=f"{note['row_version']}:{current.get('revision', 0)}",
                updated_at=note.get("updated_at"),
            )
        )
    for memory in snapshot["accepted_memory"]:
        current = memory.get("current_revision") or {}
        sources.append(
            source_revision(
                owner="MOD-MEMORY",
                resource_kind="accepted_memory",
                resource_id=memory["id"],
                revision=f"{memory['row_version']}:{current.get('revision', 0)}",
                updated_at=memory.get("updated_at"),
            )
        )
    for event in snapshot["activity"]:
        sources.append(
            source_revision(
                owner="MOD-WORK",
                resource_kind="harness_trace_event",
                resource_id=event["id"],
                revision=event["id"],
                updated_at=event.get("created_at"),
            )
        )
    return sources


def _project_card_order(value: dict[str, Any]) -> tuple[int, int, float, str]:
    status_order = {"active": 0, "paused": 1, "proposed": 2, "completed": 3}
    attention_order = 0 if value["attention"] else 1
    raw_updated_at = str(value.get("updated_at") or "")
    try:
        updated_at = datetime.fromisoformat(raw_updated_at.replace("Z", "+00:00")).timestamp()
    except ValueError:
        updated_at = 0.0
    return (
        status_order.get(value["status"], 9),
        attention_order,
        -updated_at,
        value["id"],
    )


def _responsibility_order(value: dict[str, Any]) -> tuple[int, str, str]:
    status_order = {"in_progress": 0, "ready": 1, "pending": 2, "blocked": 3}
    return (
        status_order.get(value["status"], 9),
        str(value.get("due_at") or "9999-12-31"),
        value["source_id"],
    )
