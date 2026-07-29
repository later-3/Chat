"""持续协作节点15背后的不可变协作协议与CAS绑定服务。

内置协议按revision发布；相同revision内容Hash变化会拒绝启动。节点15调用
``resolve_for_turn``，按Work -> Project -> User -> System解析唯一绑定，并返回选择原因、
适用规则、上下文/HITL/执行/验证/写回策略；后续Draft与Trace固定引用该revision。
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Callable, Mapping, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..harness.commands import HarnessCommandRecorder
from ..harness.models import ProductProjectRecord, WorkItemRecord
from ..observability.context import bind_context
from ..product_sessions.database import ProductDatabase, utc_now
from ..product_sessions.service import DEFAULT_SCOPE_ID
from .catalog import BUILTIN_PROTOCOLS, DEFAULT_PROTOCOL_BY_SCENARIO
from .contracts import (
    BINDING_SCOPE_KINDS,
    BINDING_STATUSES,
    PROTOCOL_STATUSES,
    SCENARIO_KINDS,
    ProtocolConflict,
    ProtocolNotFound,
    ProtocolValidationError,
    binding_view,
    content_hash,
    definition_hash_payload,
    definition_view,
    new_id,
    normalized_text,
)
from .models import (
    CollaborationProtocolBindingRecord,
    CollaborationProtocolDefinitionRecord,
    CollaborationProtocolRuleRecord,
)

logger = logging.getLogger(__name__)

PROJECT_KIND_TO_SCENARIO = {
    "delivery": "software_delivery",
    "learning": "learning",
    "research": "research",
    "personal": "project",
}


class CollaborationProtocolService:
    """拥有协议目录同步、绑定命令和确定性解析，不拥有Workflow运行状态。"""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        scope_id: str = DEFAULT_SCOPE_ID,
        principal_id: str = "local-user",
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.database = database
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock
        self._commands = HarnessCommandRecorder(
            scope_id=scope_id,
            principal_id=principal_id,
            clock=clock,
        )

    async def initialize(self) -> None:
        """同步已审核内置协议；已发布revision只校验Hash，绝不原地改写。"""

        created_definitions = 0
        created_bindings = 0
        async with self.database.sessions.begin() as transaction:
            definitions_by_key: dict[str, CollaborationProtocolDefinitionRecord] = {}
            for raw in BUILTIN_PROTOCOLS:
                normalized = self._normalized_catalog_definition(raw)
                expected_hash = content_hash(definition_hash_payload(normalized))
                existing = await transaction.scalar(
                    select(CollaborationProtocolDefinitionRecord).where(
                        CollaborationProtocolDefinitionRecord.protocol_key == normalized["protocol_key"],
                        CollaborationProtocolDefinitionRecord.revision == normalized["revision"],
                    )
                )
                if existing is not None:
                    if existing.definition_hash != expected_hash:
                        raise ProtocolConflict(
                            f"内置协议{normalized['protocol_key']}@{normalized['revision']}"
                            "内容已变化；必须发布新revision"
                        )
                    definitions_by_key[normalized["protocol_key"]] = existing
                    continue
                definition = CollaborationProtocolDefinitionRecord(
                    id=new_id(),
                    protocol_key=normalized["protocol_key"],
                    revision=normalized["revision"],
                    name=normalized["name"],
                    description=normalized["description"],
                    status=normalized["status"],
                    scenario_kinds_json=normalized["scenario_kinds"],
                    phases_json=normalized["phases"],
                    context_policy_json=normalized["context_policy"],
                    hitl_policy_json=normalized["hitl_policy"],
                    execution_policy_json=normalized["execution_policy"],
                    validation_policy_json=normalized["validation_policy"],
                    writeback_policy_json=normalized["writeback_policy"],
                    ui_schema_json=normalized["ui_schema"],
                    definition_hash=expected_hash,
                    created_by="builtin-catalog",
                    created_at=self._clock(),
                )
                transaction.add(definition)
                await transaction.flush()
                for rule in normalized["rules"]:
                    transaction.add(
                        CollaborationProtocolRuleRecord(
                            id=new_id(),
                            definition_id=definition.id,
                            rule_key=rule["rule_key"],
                            name=rule["name"],
                            description=rule["description"],
                            category=rule["category"],
                            enforcement=rule["enforcement"],
                            severity=rule["severity"],
                            overridable=rule["overridable"],
                            condition_json=rule["condition"],
                            validator_json=rule["validator"],
                            failure_action=rule["failure_action"],
                            ordinal=rule["ordinal"],
                        )
                    )
                definitions_by_key[definition.protocol_key] = definition
                created_definitions += 1

            for scenario_kind, protocol_key in DEFAULT_PROTOCOL_BY_SCENARIO.items():
                existing_binding = await transaction.scalar(
                    select(CollaborationProtocolBindingRecord).where(
                        CollaborationProtocolBindingRecord.scope_id == self.scope_id,
                        CollaborationProtocolBindingRecord.scope_kind == "system",
                        CollaborationProtocolBindingRecord.scope_ref_id == "*",
                        CollaborationProtocolBindingRecord.scenario_kind == scenario_kind,
                    )
                )
                if existing_binding is not None:
                    continue
                definition = definitions_by_key[protocol_key]
                now = self._clock()
                transaction.add(
                    CollaborationProtocolBindingRecord(
                        id=new_id(),
                        scope_id=self.scope_id,
                        scope_kind="system",
                        scope_ref_id="*",
                        scenario_kind=scenario_kind,
                        protocol_definition_id=definition.id,
                        parameter_overrides_json={},
                        disabled_rule_keys_json=[],
                        status="active",
                        row_version=1,
                        created_by="builtin-catalog",
                        created_at=now,
                        updated_at=now,
                    )
                )
                created_bindings += 1
        logger.info(
            "collaboration_protocol_catalog_synchronized created_definitions=%d "
            "created_system_bindings=%d total_definitions=%d",
            created_definitions,
            created_bindings,
            len(BUILTIN_PROTOCOLS),
        )

    @staticmethod
    def _normalized_catalog_definition(raw: Mapping[str, Any]) -> dict[str, Any]:
        protocol_key = normalized_text(
            str(raw.get("protocol_key") or ""),
            field="protocol_key",
            max_length=80,
        )
        status = str(raw.get("status") or "active")
        if status not in PROTOCOL_STATUSES:
            raise ProtocolValidationError(f"{protocol_key}的status无效")
        scenarios = list(raw.get("scenario_kinds") or [])
        if not scenarios or any(value not in SCENARIO_KINDS for value in scenarios):
            raise ProtocolValidationError(f"{protocol_key}的scenario_kinds无效")
        rules: list[dict[str, Any]] = []
        for ordinal, value in enumerate(raw.get("rules") or []):
            rule = dict(value)
            rule["ordinal"] = ordinal
            rules.append(rule)
        return {
            "protocol_key": protocol_key,
            "revision": int(raw.get("revision") or 0),
            "name": normalized_text(str(raw.get("name") or ""), field="name", max_length=160),
            "description": normalized_text(
                str(raw.get("description") or ""),
                field="description",
                max_length=4000,
            ),
            "status": status,
            "scenario_kinds": scenarios,
            "phases": list(raw.get("phases") or []),
            "context_policy": dict(raw.get("context_policy") or {}),
            "hitl_policy": dict(raw.get("hitl_policy") or {}),
            "execution_policy": dict(raw.get("execution_policy") or {}),
            "validation_policy": dict(raw.get("validation_policy") or {}),
            "writeback_policy": dict(raw.get("writeback_policy") or {}),
            "ui_schema": dict(raw.get("ui_schema") or {}),
            "rules": rules,
        }

    async def list_definitions(
        self,
        *,
        include_inactive: bool = False,
    ) -> list[dict[str, Any]]:
        query = select(CollaborationProtocolDefinitionRecord)
        if not include_inactive:
            query = query.where(CollaborationProtocolDefinitionRecord.status == "active")
        query = query.order_by(
            CollaborationProtocolDefinitionRecord.protocol_key,
            CollaborationProtocolDefinitionRecord.revision.desc(),
        )
        async with self.database.sessions() as transaction:
            definitions = list((await transaction.scalars(query)).all())
            result: list[dict[str, Any]] = []
            for definition in definitions:
                rules = list(
                    (
                        await transaction.scalars(
                            select(CollaborationProtocolRuleRecord)
                            .where(CollaborationProtocolRuleRecord.definition_id == definition.id)
                            .order_by(CollaborationProtocolRuleRecord.ordinal)
                        )
                    ).all()
                )
                result.append(definition_view(definition, rules))
            return result

    async def get_definition(self, definition_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            definition = await transaction.get(
                CollaborationProtocolDefinitionRecord,
                definition_id,
            )
            if definition is None:
                raise ProtocolNotFound("协作协议revision不存在")
            rules = list(
                (
                    await transaction.scalars(
                        select(CollaborationProtocolRuleRecord)
                        .where(CollaborationProtocolRuleRecord.definition_id == definition.id)
                        .order_by(CollaborationProtocolRuleRecord.ordinal)
                    )
                ).all()
            )
            return definition_view(definition, rules)

    async def list_bindings(
        self,
        *,
        scope_kind: str | None = None,
        scope_ref_id: str | None = None,
        scenario_kind: str | None = None,
    ) -> list[dict[str, Any]]:
        query = select(CollaborationProtocolBindingRecord).where(
            CollaborationProtocolBindingRecord.scope_id == self.scope_id
        )
        if scope_kind:
            query = query.where(CollaborationProtocolBindingRecord.scope_kind == scope_kind)
        if scope_ref_id:
            query = query.where(CollaborationProtocolBindingRecord.scope_ref_id == scope_ref_id)
        if scenario_kind:
            query = query.where(CollaborationProtocolBindingRecord.scenario_kind == scenario_kind)
        query = query.order_by(
            CollaborationProtocolBindingRecord.scope_kind,
            CollaborationProtocolBindingRecord.scenario_kind,
        )
        async with self.database.sessions() as transaction:
            bindings = list((await transaction.scalars(query)).all())
            return [await self._binding_view(transaction, binding) for binding in bindings]

    async def configuration(self) -> dict[str, Any]:
        """Return the safe identity and catalogs needed by the settings UI."""

        return {
            "scope_id": self.scope_id,
            "principal_id": self.principal_id,
            "scenario_kinds": sorted(SCENARIO_KINDS),
            "protocols": await self.list_definitions(),
            "bindings": await self.list_bindings(),
        }

    async def upsert_binding(
        self,
        *,
        command_id: str,
        scope_kind: str,
        scope_ref_id: str,
        scenario_kind: str,
        protocol_definition_id: str,
        parameter_overrides: Mapping[str, Any] | None = None,
        disabled_rule_keys: Sequence[str] = (),
        status: str = "active",
        expected_row_version: int | None = None,
    ) -> dict[str, Any]:
        self._validate_binding_identity(
            scope_kind=scope_kind,
            scope_ref_id=scope_ref_id,
            scenario_kind=scenario_kind,
            status=status,
        )
        request = {
            "scope_kind": scope_kind,
            "scope_ref_id": scope_ref_id,
            "scenario_kind": scenario_kind,
            "protocol_definition_id": protocol_definition_id,
            "parameter_overrides": dict(parameter_overrides or {}),
            "disabled_rule_keys": sorted(set(disabled_rule_keys)),
            "status": status,
            "expected_row_version": expected_row_version,
        }
        request_hash = content_hash(request)
        async with self.database.sessions.begin() as transaction:
            replay = await self._commands.existing(transaction, command_id, request_hash)
            if replay is not None:
                return replay
            definition, rules = await self._definition_records(
                transaction,
                protocol_definition_id,
            )
            if definition.status == "blocked":
                raise ProtocolValidationError("被阻止的协议revision不能用于新Binding")
            if scenario_kind not in set(definition.scenario_kinds_json or []):
                raise ProtocolValidationError("协议revision不适用于所选场景")
            disabled = sorted(set(disabled_rule_keys))
            rule_by_key = {rule.rule_key: rule for rule in rules}
            unknown = [key for key in disabled if key not in rule_by_key]
            if unknown:
                raise ProtocolValidationError(f"未知协议规则：{', '.join(unknown)}")
            protected = [key for key in disabled if not rule_by_key[key].overridable]
            if protected:
                raise ProtocolValidationError(f"不可关闭的协议规则：{', '.join(protected)}")
            await self._validate_scope_reference(transaction, scope_kind, scope_ref_id)
            binding = await transaction.scalar(
                select(CollaborationProtocolBindingRecord).where(
                    CollaborationProtocolBindingRecord.scope_id == self.scope_id,
                    CollaborationProtocolBindingRecord.scope_kind == scope_kind,
                    CollaborationProtocolBindingRecord.scope_ref_id == scope_ref_id,
                    CollaborationProtocolBindingRecord.scenario_kind == scenario_kind,
                )
            )
            now = self._clock()
            if binding is None:
                if expected_row_version not in {None, 0}:
                    raise ProtocolConflict("协议Binding尚不存在，expected_row_version必须为空或0")
                binding = CollaborationProtocolBindingRecord(
                    id=new_id(),
                    scope_id=self.scope_id,
                    scope_kind=scope_kind,
                    scope_ref_id=scope_ref_id,
                    scenario_kind=scenario_kind,
                    protocol_definition_id=definition.id,
                    parameter_overrides_json=dict(parameter_overrides or {}),
                    disabled_rule_keys_json=disabled,
                    status=status,
                    row_version=1,
                    created_by=self.principal_id,
                    created_at=now,
                    updated_at=now,
                )
                transaction.add(binding)
                event_type = "harness.protocol_binding.created"
            else:
                if expected_row_version is None or binding.row_version != expected_row_version:
                    raise ProtocolConflict(f"协议Binding版本冲突，当前revision为{binding.row_version}")
                binding.protocol_definition_id = definition.id
                binding.parameter_overrides_json = dict(parameter_overrides or {})
                binding.disabled_rule_keys_json = disabled
                binding.status = status
                binding.row_version += 1
                binding.updated_at = now
                event_type = "harness.protocol_binding.updated"
            await transaction.flush()
            definition_projection = definition_view(definition, rules)
            result = binding_view(binding, definition_projection)
            self._commands.record(
                transaction,
                command_id=command_id,
                command_kind="upsert_protocol_binding",
                request_hash=request_hash,
                result=result,
                resource_kind="protocol_binding",
                resource_id=binding.id,
                event_type=event_type,
                trace_payload={
                    "scope_kind": scope_kind,
                    "scope_ref_id": scope_ref_id,
                    "scenario_kind": scenario_kind,
                    "protocol_key": definition.protocol_key,
                    "protocol_revision": definition.revision,
                    "row_version": binding.row_version,
                    "disabled_rule_count": len(disabled),
                },
            )
        with bind_context(command_id=command_id, resource_id=binding.id):
            logger.info(
                "collaboration_protocol_binding_committed scenario=%s scope_kind=%s "
                "protocol=%s revision=%d row_version=%d",
                scenario_kind,
                scope_kind,
                definition.protocol_key,
                definition.revision,
                binding.row_version,
            )
        return result

    async def resolve_for_turn(
        self,
        *,
        scenario: str,
        project_id: str | None,
        work_item_id: str | None = None,
        user_ref_id: str | None = None,
        query_kind: str | None = None,
    ) -> dict[str, Any]:
        """节点15使用：不调用模型，按Work→Project→User→System解析协议。"""

        async with self.database.sessions() as transaction:
            scenario_kind = await self._scenario_kind(
                transaction,
                scenario=scenario,
                project_id=project_id,
                query_kind=query_kind,
            )
            candidates = [
                ("work_item", work_item_id),
                ("project", project_id),
                ("user", user_ref_id or self.principal_id),
                ("system", "*"),
            ]
            selected_binding: CollaborationProtocolBindingRecord | None = None
            selection_source = ""
            for scope_kind, scope_ref_id in candidates:
                if not scope_ref_id:
                    continue
                values = list(
                    (
                        await transaction.scalars(
                            select(CollaborationProtocolBindingRecord).where(
                                CollaborationProtocolBindingRecord.scope_id == self.scope_id,
                                CollaborationProtocolBindingRecord.scope_kind == scope_kind,
                                CollaborationProtocolBindingRecord.scope_ref_id == scope_ref_id,
                                CollaborationProtocolBindingRecord.scenario_kind == scenario_kind,
                                CollaborationProtocolBindingRecord.status == "active",
                            )
                        )
                    ).all()
                )
                if len(values) > 1:
                    raise ProtocolConflict(f"{scope_kind}:{scope_ref_id}存在多个同优先级有效协议Binding")
                if values:
                    selected_binding = values[0]
                    selection_source = scope_kind
                    break
            if selected_binding is None:
                raise ProtocolNotFound(f"场景{scenario_kind}没有可用协作协议")
            definition, rules = await self._definition_records(
                transaction,
                selected_binding.protocol_definition_id,
            )
            if definition.status == "blocked":
                raise ProtocolConflict(
                    f"协议{definition.protocol_key}@{definition.revision}已被阻止用于新Run"
                )
            disabled = set(selected_binding.disabled_rule_keys_json or [])
            applicable_rules = [
                {
                    "rule_key": rule.rule_key,
                    "name": rule.name,
                    "description": rule.description,
                    "category": rule.category,
                    "enforcement": rule.enforcement,
                    "severity": rule.severity,
                    "validator": dict(rule.validator_json or {}),
                    "failure_action": rule.failure_action,
                }
                for rule in rules
                if rule.rule_key not in disabled
            ]
            payload = {
                "protocol_key": definition.protocol_key,
                "protocol_name": definition.name,
                "description": definition.description,
                "revision": definition.revision,
                "definition_id": definition.id,
                "definition_hash": definition.definition_hash,
                "binding_id": selected_binding.id,
                "binding_row_version": selected_binding.row_version,
                "scenario_kind": scenario_kind,
                "selection_source": selection_source,
                "selection_reason": (
                    f"按WorkItem→Project→User→System优先级命中{selection_source}作用域Binding"
                ),
                "phases": list(definition.phases_json or []),
                "context_policy": dict(definition.context_policy_json or {}),
                "hitl_policy": dict(definition.hitl_policy_json or {}),
                "execution_policy": dict(definition.execution_policy_json or {}),
                "validation_policy": dict(definition.validation_policy_json or {}),
                "writeback_policy": dict(definition.writeback_policy_json or {}),
                "ui_schema": dict(definition.ui_schema_json or {}),
                "parameter_overrides": dict(selected_binding.parameter_overrides_json or {}),
                "disabled_rule_keys": sorted(disabled),
                "applicable_rules": applicable_rules,
            }
            payload["selection_hash"] = content_hash(payload)
        with bind_context(resource_id=selected_binding.id):
            logger.info(
                "collaboration_protocol_resolved scenario=%s source=%s protocol=%s "
                "revision=%d applicable_rules=%d",
                scenario_kind,
                selection_source,
                definition.protocol_key,
                definition.revision,
                len(applicable_rules),
            )
        return payload

    async def _definition_records(
        self,
        transaction: AsyncSession,
        definition_id: str,
    ) -> tuple[
        CollaborationProtocolDefinitionRecord,
        list[CollaborationProtocolRuleRecord],
    ]:
        definition = await transaction.get(
            CollaborationProtocolDefinitionRecord,
            definition_id,
        )
        if definition is None:
            raise ProtocolNotFound("协作协议revision不存在")
        rules = list(
            (
                await transaction.scalars(
                    select(CollaborationProtocolRuleRecord)
                    .where(CollaborationProtocolRuleRecord.definition_id == definition.id)
                    .order_by(CollaborationProtocolRuleRecord.ordinal)
                )
            ).all()
        )
        return definition, rules

    async def _binding_view(
        self,
        transaction: AsyncSession,
        binding: CollaborationProtocolBindingRecord,
    ) -> dict[str, Any]:
        definition, rules = await self._definition_records(
            transaction,
            binding.protocol_definition_id,
        )
        return binding_view(binding, definition_view(definition, rules))

    def _validate_binding_identity(
        self,
        *,
        scope_kind: str,
        scope_ref_id: str,
        scenario_kind: str,
        status: str,
    ) -> None:
        if scope_kind not in BINDING_SCOPE_KINDS:
            raise ProtocolValidationError("协议Binding scope_kind无效")
        normalized_text(scope_ref_id, field="scope_ref_id", max_length=100)
        if scenario_kind not in SCENARIO_KINDS:
            raise ProtocolValidationError("协议Binding scenario_kind无效")
        if status not in BINDING_STATUSES:
            raise ProtocolValidationError("协议Binding status无效")
        if scope_kind == "system" and scope_ref_id != "*":
            raise ProtocolValidationError("system作用域必须使用scope_ref_id='*'")

    async def _validate_scope_reference(
        self,
        transaction: AsyncSession,
        scope_kind: str,
        scope_ref_id: str,
    ) -> None:
        if scope_kind == "project":
            project = await transaction.get(ProductProjectRecord, scope_ref_id)
            if project is None or project.scope_id != self.scope_id:
                raise ProtocolNotFound("协议Binding关联的Project不存在")
        if scope_kind == "work_item":
            work = await transaction.get(WorkItemRecord, scope_ref_id)
            if work is None or work.scope_id != self.scope_id:
                raise ProtocolNotFound("协议Binding关联的WorkItem不存在")

    async def _scenario_kind(
        self,
        transaction: AsyncSession,
        *,
        scenario: str,
        project_id: str | None,
        query_kind: str | None,
    ) -> str:
        if query_kind == "project_catalog" or scenario == "simple_question":
            return "simple_question"
        if project_id:
            project = await transaction.get(ProductProjectRecord, project_id)
            if project is None or project.scope_id != self.scope_id:
                raise ProtocolNotFound("协议解析关联的Project不存在")
            return PROJECT_KIND_TO_SCENARIO.get(project.kind, "project")
        if scenario in {"new_task", "plan_request"}:
            return "task"
        if scenario == "continue_project":
            return "project"
        if scenario in SCENARIO_KINDS:
            return scenario
        return "simple_question"
