"""Stable, least-privilege Agent-facing Product Harness contracts."""

from __future__ import annotations

from typing import Any

from .service import HarnessService


HARNESS_TOOL_CATALOG: tuple[dict[str, Any], ...] = (
    {"name": "harness.list_projects", "mode": "query", "description": "列出当前Scope内的正式Project。"},
    {"name": "harness.search_resources", "mode": "query", "description": "检索Project、Work和Note轻量目录。"},
    {"name": "harness.get_project_context", "mode": "query", "description": "按正式Project ID读取当前工作上下文。"},
    {"name": "harness.list_work", "mode": "query", "description": "列出Project或当前Scope的WorkItem。"},
    {"name": "harness.get_work_item", "mode": "query", "description": "读取WorkItem、当前Plan和ActionItem。"},
    {"name": "harness.search_notes", "mode": "query", "description": "读取正式Note当前Revision。"},
    {"name": "harness.search_memory", "mode": "query", "description": "读取仍有效的Accepted Memory。"},
    {"name": "harness.propose_project", "mode": "candidate", "description": "提出Project候选；不直接激活。"},
    {"name": "harness.propose_work_change", "mode": "candidate", "description": "提出Work变更候选；不直接提交状态。"},
    {"name": "harness.capture_note", "mode": "candidate", "description": "提出Note内容；提交仍受CAS和策略治理。"},
    {"name": "harness.propose_memory", "mode": "candidate", "description": "提出长期Memory候选；不是Accepted Memory。"},
)


class HarnessToolset:
    """Narrow facade injected into deterministic Workflow executors.

    The model never receives a database handle. Query methods return compact
    product views; write methods intentionally return command previews so a
    Product decision point can approve, revise or reject them first.
    """

    def __init__(self, service: HarnessService) -> None:
        self.service = service

    async def list_projects(self, *, status: str | None = None, kind: str | None = None) -> dict[str, Any]:
        statuses = (status,) if status else None
        return {"projects": await self.service.list_projects(statuses=statuses, kind=kind)}

    async def search_resources(self, *, query: str, limit: int = 20) -> dict[str, Any]:
        return {"resources": await self.service.search_resources(query, limit=limit)}

    async def get_project_context(self, *, project_id: str) -> dict[str, Any]:
        return await self.service.project_context(project_id)

    async def list_work(self, *, project_id: str | None = None, status: str | None = None) -> dict[str, Any]:
        return {"work_items": await self.service.list_work(
            project_id=project_id,
            statuses=(status,) if status else None,
        )}

    async def get_work_item(self, *, work_item_id: str) -> dict[str, Any]:
        return await self.service.get_work_item(work_item_id)

    async def search_notes(self, *, project_id: str | None = None) -> dict[str, Any]:
        return {"notes": await self.service.list_notes(project_id=project_id)}

    async def search_memory(self, *, scope_kind: str | None = None, scope_ref_id: str | None = None) -> dict[str, Any]:
        return await self.service.list_memory(
            scope_kind=scope_kind,
            scope_ref_id=scope_ref_id,
            include_candidates=False,
        )

    @staticmethod
    def propose_project(**values: Any) -> dict[str, Any]:
        return {"candidate_kind": "project", "status": "candidate", "command_preview": values}

    @staticmethod
    def propose_work_change(**values: Any) -> dict[str, Any]:
        return {"candidate_kind": "work_change", "status": "candidate", "command_preview": values}

    @staticmethod
    def capture_note(**values: Any) -> dict[str, Any]:
        return {"candidate_kind": "note", "status": "candidate", "command_preview": values}

    @staticmethod
    def propose_memory(**values: Any) -> dict[str, Any]:
        return {"candidate_kind": "memory", "status": "candidate", "command_preview": values}
