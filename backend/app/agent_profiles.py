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
            provider_id = self._catalog.default_provider_id
            model = self._catalog.default_model
            defaults = (
                AgentProfileRecord(
                        id="intent_router",
                        name="意图与上下文 Agent",
                        description="用最小上下文识别场景、目标、项目关联和需要补充的信息。",
                        instructions=(
                            "你是Chat主Workflow的意图与上下文Agent。只根据明确可见的用户输入和候选摘要判断，"
                            "不得编造Project或任务状态。必须只输出一个JSON对象，字段为："
                            "scenario（simple_question/continue_project/new_task/plan_request/learning/clarify之一）、"
                            "goal、confidence（0到1）、project_hint、needs_plan、needs_clarification、"
                            "clarification_question、context_keywords（字符串数组）、reason_summary。"
                        ),
                        provider_id=provider_id,
                        model=model,
                ),
                AgentProfileRecord(
                        id="task_planner",
                        name="任务规划 Agent",
                        description="把已确认目标和最小充分背景拆成可验证的执行步骤。",
                        instructions=(
                            "你是Chat主Workflow的任务规划Agent。基于已识别意图和采用的最小充分上下文，"
                            "形成具体、可验证、不过度扩权的计划。明确步骤、依赖、完成条件、验证和需要用户决定的点。"
                        ),
                        provider_id=provider_id,
                        model=model,
                ),
                AgentProfileRecord(
                        id="response_agent",
                        name="协作响应 Agent",
                        description="根据当前场景的Execution Brief形成直接、可靠的用户答复。",
                        instructions=(
                            "你是Chat主Workflow的协作响应Agent。严格使用本次明确装配的背景、目标、计划和约束；"
                            "不要假装读取了未提供的文件，不要声称未验证的动作已经完成。用中文直接给出当前场景所需答复。"
                        ),
                        provider_id=provider_id,
                        model=model,
                ),
                AgentProfileRecord(
                        id="turn_summarizer",
                        name="回合主题提取 Agent",
                        description="在回合结束后提取主题、已确认事实、开放问题和候选状态更新。",
                        instructions=(
                            "你是Chat回合主题提取Agent。只输出JSON，字段为topic、confirmed_facts、decisions、"
                            "open_questions、project_hint、work_state_candidates、memory_candidates。"
                            "无关寒暄不进入长期候选；推断内容必须标为candidate，不能冒充已接受事实。"
                        ),
                        provider_id=provider_id,
                        model=model,
                ),
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
                AgentProfileRecord(
                    id="idiom_agent_a",
                    name="接龙 Agent 甲",
                    description="承接用户给出的四字成语，生成下一棒。",
                    instructions=(
                        "你是成语接龙 Agent 甲。严格遵守本轮给出的开头字，"
                        "只回复一个常见、规范的四字成语，不要解释或添加标点。"
                    ),
                    provider_id=provider_id,
                    model=model,
                ),
                AgentProfileRecord(
                    id="idiom_agent_b",
                    name="接龙 Agent 乙",
                    description="承接Agent甲的四字成语，生成第三棒并把回合交还用户。",
                    instructions=(
                        "你是成语接龙 Agent 乙。严格遵守本轮给出的开头字，"
                        "只回复一个常见、规范的四字成语，不要解释或添加标点。"
                    ),
                    provider_id=provider_id,
                    model=model,
                ),
            )
            existing_ids = {value.id for value in values}
            missing = [value for value in defaults if value.id not in existing_ids]
            if missing:
                transaction.add_all(missing)
                values.extend(missing)
            values.sort(key=lambda value: value.id)
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
        required_agents = {
            "intent_router",
            "task_planner",
            "response_agent",
            "turn_summarizer",
            "planner",
            "reviewer",
            "idiom_agent_a",
            "idiom_agent_b",
        }
        if agent_id in required_agents and not enabled:
            raise AgentProfileError("已注册Workflow依赖的Agent不能停用")

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
