"""Product-owned Agent profiles and optimistic edit contracts."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select, update

from .model_providers import ModelProviderCatalog, ModelProviderCatalogError
from .product_sessions.database import AgentProfileRecord, ProductDatabase, utc_now


class AgentProfileError(ValueError):
    pass


class AgentProfileNotFound(AgentProfileError):
    pass


class AgentProfileConflict(AgentProfileError):
    pass


@dataclass(frozen=True, slots=True)
class AgentProfileSnapshot:
    id: str
    name: str
    description: str
    instructions: str
    provider_id: str
    model: str
    enabled: bool
    revision: int

    def view(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "instructions": self.instructions,
            "provider_id": self.provider_id,
            "model": self.model,
            "enabled": self.enabled,
            "revision": self.revision,
        }


def _snapshot(value: AgentProfileRecord) -> AgentProfileSnapshot:
    return AgentProfileSnapshot(
        id=value.id,
        name=value.name,
        description=value.description,
        instructions=value.instructions,
        provider_id=value.provider_id,
        model=value.model,
        enabled=value.enabled,
        revision=value.revision,
    )


class AgentProfileService:
    """Keeps Product DB authoritative and a read-only runtime snapshot cache."""

    def __init__(self, database: ProductDatabase, catalog: ModelProviderCatalog | None) -> None:
        self._database = database
        self._catalog = catalog
        self._cache: dict[str, AgentProfileSnapshot] = {}

    async def initialize(self) -> None:
        if self._catalog is None:
            self._cache = {}
            return
        async with self._database.sessions.begin() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(AgentProfileRecord).order_by(AgentProfileRecord.id)
                    )
                ).all()
            )
            if not values:
                provider_id = self._catalog.default_provider_id
                model = self._catalog.default_model
                values = [
                    AgentProfileRecord(
                        id="planner",
                        name="规划 Agent",
                        description="先理解目标、约束和现有上下文，形成可交接的方案草稿。",
                        instructions=(
                            "你是规划 Agent。请基于完整会话理解用户目标，给出结构清晰、"
                            "可执行且明确约束的方案草稿，供下一位审校 Agent 复核。"
                        ),
                        provider_id=provider_id,
                        model=model,
                    ),
                    AgentProfileRecord(
                        id="reviewer",
                        name="审校 Agent",
                        description="接收完整会话和规划结果，检查遗漏并形成最终答复。",
                        instructions=(
                            "你是审校 Agent。请查看原始会话、规划 Agent 的草稿和交接要求，"
                            "纠正遗漏或不可靠结论，然后直接给出面向用户的最终答复。"
                        ),
                        provider_id=provider_id,
                        model=model,
                    ),
                ]
                transaction.add_all(values)
        self._cache = {value.id: _snapshot(value) for value in values}

    def runtime_snapshot(self, agent_id: str) -> AgentProfileSnapshot:
        value = self._cache.get(agent_id)
        if value is None or not value.enabled:
            raise AgentProfileNotFound(f"Agent不可用: {agent_id}")
        return copy.deepcopy(value)

    async def list(self) -> list[dict[str, Any]]:
        return [value.view() for value in self._cache.values()]

    async def update(
        self,
        agent_id: str,
        *,
        expected_revision: int,
        name: str,
        description: str,
        instructions: str,
        provider_id: str,
        model: str,
        enabled: bool,
    ) -> dict[str, Any]:
        if self._catalog is None:
            raise AgentProfileError("当前没有可用于Agent的模型Provider")
        try:
            self._catalog.require_selection(provider_id, model)
        except ModelProviderCatalogError as error:
            raise AgentProfileError(str(error)) from error
        clean_name = name.strip()
        clean_instructions = instructions.strip()
        if not clean_name:
            raise AgentProfileError("Agent名称不能为空")
        if not clean_instructions:
            raise AgentProfileError("Agent Instructions不能为空")
        if agent_id in {"planner", "reviewer"} and not enabled:
            raise AgentProfileError("会话传递Workflow依赖的Agent不能停用")

        next_revision = expected_revision + 1
        next_updated_at = utc_now()
        async with self._database.sessions.begin() as transaction:
            changed = await transaction.execute(
                update(AgentProfileRecord)
                .where(
                    AgentProfileRecord.id == agent_id,
                    AgentProfileRecord.revision == expected_revision,
                )
                .values(
                    name=clean_name[:120],
                    description=description.strip(),
                    instructions=clean_instructions,
                    provider_id=provider_id,
                    model=model,
                    enabled=enabled,
                    revision=next_revision,
                    updated_at=next_updated_at,
                )
            )
            if changed.rowcount != 1:
                exists = await transaction.get(AgentProfileRecord, agent_id)
                if exists is None:
                    raise AgentProfileNotFound(f"Agent不存在: {agent_id}")
                raise AgentProfileConflict("Agent配置已变化，请刷新后再保存")
        result = AgentProfileSnapshot(
            id=agent_id,
            name=clean_name[:120],
            description=description.strip(),
            instructions=clean_instructions,
            provider_id=provider_id,
            model=model,
            enabled=enabled,
            revision=next_revision,
        )
        self._cache[agent_id] = result
        return result.view()
