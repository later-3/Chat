"""Application service for versioned execution and human-in-the-loop governance."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Sequence
from uuid import uuid4

from sqlalchemy import func, select, update

from ..model_call_review import canonical_json_bytes
from ..product_sessions.database import (
    InteractionRecord,
    ProductDatabase,
    RunAttemptRecord,
    RunRecord,
    utc_now,
)
from .models import (
    AuthorizationConsumptionRecord,
    AuthorizationGrantRecord,
    DecisionPointDefinitionRecord,
    DecisionRecord,
    DecisionSubjectRecord,
    ExecutionDraftRecord,
    ExecutionDraftRevisionRecord,
    GovernanceOutboxRecord,
    HitlPolicyRevisionRecord,
    HitlPolicyRuleRecord,
    HitlPolicySetRecord,
    HitlPolicySnapshotRecord,
    HumanDecisionRequestItemRecord,
    HumanDecisionRequestRecord,
    ModelCallAttemptRecord,
    ModelCallDraftRecord,
    ModelCallDraftRevisionRecord,
    PolicyEvaluationRecord,
    RunSpecRecord,
    TurnSummaryRecord,
)


EXECUTION_DRAFT_KEYS = (
    "identity_lineage",
    "intent_goal",
    "project_work_binding",
    "background",
    "accepted_decisions",
    "scope",
    "plan",
    "context_binding",
    "resource_manifest",
    "runtime_target",
    "capability_grant",
    "model_envelope",
    "prompt_assembly_plan",
    "hitl_plan",
    "validation_plan",
    "output_commit_contract",
    "stop_escalation",
)

RUN_SPEC_KEYS = (
    "identity",
    "source_binding",
    "principal_scope",
    "workflow_binding",
    "execution_brief",
    "context_manifest",
    "plan",
    "prompt_assembly_contract",
    "runtime_agent",
    "capability_envelope",
    "model_envelope",
    "hitl_policy_snapshot",
    "validation_evidence",
    "output_commit",
    "control",
    "correlation_idempotency",
)

POLICY_MODES = {"inherit", "deny", "require_human", "conditional", "auto_continue"}
FINAL_ACTIONS = {"deny", "require_human", "auto_continue"}
ACTION_RANK = {"auto_continue": 1, "require_human": 2, "deny": 3}
RESOLVER_VERSION = "hitl-resolver-v1"
COMPILER_VERSION = "run-spec-compiler-v1"

SCOPE_RANK = {
    "decision_instance": 1100,
    "run": 1000,
    "interaction": 900,
    "product_session": 800,
    "task_plan": 730,
    "work_item": 720,
    "project": 710,
    "workflow_node": 620,
    "workflow_version": 610,
    "scenario": 500,
    "agent_profile": 400,
    "tool_profile": 400,
    "model_profile": 400,
    "channel": 300,
    "principal": 200,
    "product_default": 100,
}


@dataclass(frozen=True, slots=True)
class DecisionPointSeed:
    key: str
    category: str
    label: str
    description: str
    subject_kind: str
    default_mode: str
    actions: tuple[str, ...]


DECISION_POINTS = (
    DecisionPointSeed("intent_binding", "understanding", "理解用户意图", "确认系统对本轮目标和场景的理解。", "intent", "conditional", ("accept", "revise", "split", "cancel")),
    DecisionPointSeed("project_work_binding", "context", "关联 Project / Work", "确认本轮属于哪个项目、工作或不关联。", "work_binding", "conditional", ("accept", "reselect", "unbound", "cancel")),
    DecisionPointSeed("context_adoption", "context", "采用 Context", "确认哪些背景、历史、知识和资源进入本轮。", "context_package", "conditional", ("accept", "revise", "cancel")),
    DecisionPointSeed("plan_acceptance", "planning", "接受 Plan", "确认任务拆分、顺序、负责人和验证方式。", "task_plan", "conditional", ("accept", "revise", "skip", "cancel")),
    DecisionPointSeed("execution_authorization", "execution", "授权 ExecutionDraft", "确认准备执行的目标、范围、能力和完成门。", "execution_draft", "conditional", ("execute", "revise", "cancel")),
    DecisionPointSeed("model_call_authorization", "model", "发送 ModelCallDraft", "确认将要发送给模型的完整请求。", "model_call_draft", "require_human", ("approve", "revise", "abandon")),
    DecisionPointSeed("tool_execution_authorization", "tool", "执行 Tool", "确认真实工具、参数、目标和副作用。", "tool_call_request", "conditional", ("approve", "revise", "deny")),
    DecisionPointSeed("work_state_commit", "commit", "提交 Work 状态", "确认任务或项目状态的长期变化。", "work_state_candidate", "conditional", ("commit", "revise", "reject")),
    DecisionPointSeed("memory_commit", "commit", "提交 Memory", "确认哪些候选信息成为可复用记忆。", "memory_candidate", "require_human", ("commit", "revise", "session_only", "reject")),
    DecisionPointSeed("result_commit", "commit", "提交 Result", "确认结果、证据和完成声明可被接受。", "result_candidate", "conditional", ("accept", "verify_more", "revise")),
    DecisionPointSeed("runtime_recovery", "recovery", "Runtime 恢复或干预", "确认重试、Restart、新 Run、停止或人工处理。", "runtime_recovery", "require_human", ("retry", "restart", "new_run", "stop")),
    DecisionPointSeed("unknown_or_high_risk", "safety", "未知或高风险结果", "结果未知、高风险或证据不足时关闭失败。", "risk_incident", "require_human", ("stop", "reconcile", "inspect", "next_step")),
)

PRODUCT_DEFAULTS = {seed.key: seed.default_mode for seed in DECISION_POINTS}
PRODUCT_DEFAULT_RULES: dict[str, dict[str, Any]] = {
    "intent_binding": {
        "mode": "conditional",
        "condition": {"any": [
            {"lte": ["intent.confidence", 0.84]},
            {"eq": ["intent.changes_active_work", True]},
            {"eq": ["intent.ambiguous", True]},
        ]},
        "on_match": "require_human",
    },
    "project_work_binding": {
        "mode": "conditional",
        "condition": {"any": [
            {"gte": ["project.candidate_count", 2]},
            {"eq": ["project.cross_sensitive_scope", True]},
        ]},
        "on_match": "require_human",
    },
    "context_adoption": {
        "mode": "conditional",
        "condition": {"any": [
            {"eq": ["context.requires_review", True]},
            {"eq": ["context.cross_project", True]},
            {"eq": ["context.source_invalid", True]},
        ]},
        "on_match": "require_human",
    },
    "plan_acceptance": {
        "mode": "conditional",
        "condition": {"any": [
            {"gte": ["plan.risk_level", 2]},
            {"eq": ["plan.expands_capability", True]},
            {"eq": ["plan.boundary_unclear", True]},
        ]},
        "on_match": "require_human",
    },
    "execution_authorization": {
        "mode": "conditional",
        "condition": {"any": [
            {"gte": ["execution.risk_level", 2]},
            {"eq": ["execution.has_side_effects", True]},
            {"eq": ["execution.goal_incomplete", True]},
        ]},
        "on_match": "require_human",
    },
    "model_call_authorization": {"mode": "require_human"},
    "tool_execution_authorization": {
        "mode": "conditional",
        "condition": {"any": [
            {"gte": ["tool.risk_level", 2]},
            {"eq": ["tool.has_side_effects", True]},
            {"eq": ["tool.outside_capability", True]},
        ]},
        "on_match": "require_human",
    },
    "work_state_commit": {
        "mode": "conditional",
        "condition": {"any": [
            {"eq": ["work.creates_or_deletes", True]},
            {"eq": ["work.claims_completion_without_evidence", True]},
        ]},
        "on_match": "require_human",
    },
    "memory_commit": {"mode": "require_human"},
    "result_commit": {
        "mode": "conditional",
        "condition": {"any": [
            {"eq": ["result.evidence_sufficient", False]},
            {"eq": ["result.external_delivery", True]},
            {"eq": ["result.changes_long_term_state", True]},
        ]},
        "on_match": "require_human",
    },
    "runtime_recovery": {"mode": "require_human"},
    "unknown_or_high_risk": {"mode": "require_human"},
}
SYSTEM_FLOOR_RULES: dict[str, dict[str, Any]] = {
    seed.key: {"mode": "auto_continue"} for seed in DECISION_POINTS
} | {"unknown_or_high_risk": {"mode": "require_human"}}
GRANT_KIND_BY_POINT = {
    "execution_authorization": "start_run",
    "model_call_authorization": "send_model_call",
    "tool_execution_authorization": "execute_tool",
    "work_state_commit": "commit_work_state",
    "memory_commit": "commit_memory",
    "result_commit": "commit_result",
    "runtime_recovery": "perform_recovery",
}


class GovernanceError(ValueError):
    pass


class GovernanceValidationError(GovernanceError):
    pass


class GovernanceConflict(GovernanceError):
    pass


def _id() -> str:
    return str(uuid4())


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _hash(kind: str, schema_version: str, value: Any) -> str:
    return hashlib.sha256(
        f"{kind}:{schema_version}\0".encode("utf-8") + _canonical(value)
    ).hexdigest()


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _strictest(actions: Iterable[str]) -> str:
    values = [value for value in actions if value in FINAL_ACTIONS]
    return max(values, key=ACTION_RANK.__getitem__) if values else "auto_continue"


def _fact(facts: Mapping[str, Any], path: str) -> tuple[bool, Any]:
    current: Any = facts
    for part in path.split("."):
        if not isinstance(current, Mapping) or part not in current:
            return False, None
        current = current[part]
    return True, current


def _eval_condition(expression: Any, facts: Mapping[str, Any]) -> tuple[bool, bool]:
    """Return ``(matched, complete)`` for the restricted condition DSL."""

    if not isinstance(expression, Mapping) or len(expression) != 1:
        return False, False
    operator, value = next(iter(expression.items()))
    if operator in {"all", "any"}:
        if not isinstance(value, list) or not value:
            return False, False
        results = [_eval_condition(item, facts) for item in value]
        complete = all(item[1] for item in results)
        matched = all(item[0] for item in results) if operator == "all" else any(item[0] for item in results)
        return matched, complete
    if operator == "not":
        matched, complete = _eval_condition(value, facts)
        return (not matched, complete)
    if operator not in {"eq", "in", "gte", "lte", "prefix"}:
        return False, False
    if not isinstance(value, list) or len(value) != 2 or not isinstance(value[0], str):
        return False, False
    exists, actual = _fact(facts, value[0])
    if not exists:
        return False, False
    expected = value[1]
    try:
        if operator == "eq":
            return actual == expected, True
        if operator == "in":
            return actual in expected, isinstance(expected, list)
        if operator == "gte":
            return actual >= expected, True
        if operator == "lte":
            return actual <= expected, True
        return str(actual).startswith(str(expected)), True
    except (TypeError, ValueError):
        return False, False


def _condition_specificity(expression: Any) -> int:
    if not isinstance(expression, Mapping):
        return 0
    return 1 + sum(_condition_specificity(value) for value in expression.values() if isinstance(value, (dict, list))) + sum(
        _condition_specificity(item)
        for value in expression.values()
        if isinstance(value, list)
        for item in value
    )


def _valid_condition_shape(expression: Any) -> bool:
    if not isinstance(expression, Mapping) or len(expression) != 1:
        return False
    operator, value = next(iter(expression.items()))
    if operator in {"all", "any"}:
        return isinstance(value, list) and bool(value) and all(
            _valid_condition_shape(item) for item in value
        )
    if operator == "not":
        return _valid_condition_shape(value)
    if operator not in {"eq", "in", "gte", "lte", "prefix"}:
        return False
    if not isinstance(value, list) or len(value) != 2 or not isinstance(value[0], str):
        return False
    return operator != "in" or isinstance(value[1], list)


def _validate_payload(value: Mapping[str, Any], required: Sequence[str], schema_version: str) -> dict[str, Any]:
    missing = [key for key in required if key not in value]
    if missing:
        raise GovernanceValidationError(f"{schema_version}缺少字段: {', '.join(missing)}")
    try:
        _canonical(value)
    except (TypeError, ValueError) as error:
        raise GovernanceValidationError(f"{schema_version}不是规范JSON: {error}") from error
    return dict(value)


class ExecutionGovernanceService:
    """Own durable schemas, policy resolution, decisions and authorization consumption."""

    def __init__(self, database: ProductDatabase, *, principal_id: str = "local-user") -> None:
        self.database = database
        self.principal_id = principal_id

    async def initialize(self) -> None:
        async with self.database.sessions.begin() as transaction:
            for seed in DECISION_POINTS:
                exists = await transaction.scalar(
                    select(DecisionPointDefinitionRecord).where(
                        DecisionPointDefinitionRecord.key == seed.key,
                        DecisionPointDefinitionRecord.version == 1,
                    )
                )
                if exists is None:
                    content = {
                        "key": seed.key,
                        "version": 1,
                        "category": seed.category,
                        "label": seed.label,
                        "description": seed.description,
                        "subject_kind": seed.subject_kind,
                        "default_mode": seed.default_mode,
                        "actions": list(seed.actions),
                    }
                    transaction.add(
                        DecisionPointDefinitionRecord(
                            id=_id(),
                            key=seed.key,
                            version=1,
                            category=seed.category,
                            label=seed.label,
                            description=seed.description,
                            subject_kind=seed.subject_kind,
                            default_mode=seed.default_mode,
                            allowed_human_actions_json=list(seed.actions),
                            applicability_schema_json={},
                            response_schema_json={},
                            definition_hash=_hash("decision-point", "v1", content),
                        )
                    )
        await self._ensure_seed_policy("product_default", PRODUCT_DEFAULT_RULES)
        await self._ensure_seed_policy("system_safety", SYSTEM_FLOOR_RULES)

    async def _ensure_seed_policy(
        self,
        authority: str,
        rule_specs: Mapping[str, Mapping[str, Any]],
    ) -> None:
        async with self.database.sessions.begin() as transaction:
            policy_set = await transaction.scalar(
                select(HitlPolicySetRecord).where(
                    HitlPolicySetRecord.authority == authority,
                    HitlPolicySetRecord.scope_kind == "product_default",
                    HitlPolicySetRecord.scope_ref_id == "*",
                    HitlPolicySetRecord.owner_principal_id == "",
                )
            )
            set_id = policy_set.id if policy_set is not None else _id()
            revision_id = _id()
            rule_payloads = [
                {
                    "decision_point_key": key,
                    "mode": str(spec["mode"]),
                    "condition": spec.get("condition"),
                    "on_match": spec.get("on_match"),
                    "constraints": dict(spec.get("constraints") or {}),
                }
                for key, spec in rule_specs.items()
            ]
            policy_hash = _hash("hitl-policy", "hitl-policy-v1", rule_payloads)
            current: HitlPolicyRevisionRecord | None = None
            if policy_set is None:
                policy_set = HitlPolicySetRecord(
                    id=set_id,
                    authority=authority,
                    scope_kind="product_default",
                    scope_ref_id="*",
                    scope_ref_revision="",
                    owner_principal_id="",
                    # The container/revision active pointer is published only
                    # after both rows exist so SQLite can enforce the cycle.
                    active_revision_id=None,
                )
                transaction.add(policy_set)
                await transaction.flush()
                next_revision = 1
            else:
                current = (
                    await transaction.get(HitlPolicyRevisionRecord, policy_set.active_revision_id)
                    if policy_set.active_revision_id else None
                )
                if current is not None and current.policy_hash == policy_hash:
                    return
                next_revision = int(
                    await transaction.scalar(
                        select(func.max(HitlPolicyRevisionRecord.revision)).where(
                            HitlPolicyRevisionRecord.policy_set_id == policy_set.id
                        )
                    ) or 0
                ) + 1
                if current is not None:
                    current.status = "superseded"
            revision = HitlPolicyRevisionRecord(
                id=revision_id,
                policy_set_id=set_id,
                revision=next_revision,
                base_revision_id=current.id if current else None,
                status="active",
                schema_version="hitl-policy-v1",
                policy_hash=policy_hash,
                change_summary="内置产品默认" if authority == "product_default" else "内置系统安全下限",
                effective_from=utc_now(),
                created_by="system",
                activated_by="system",
                activated_at=utc_now(),
            )
            transaction.add(revision)
            await transaction.flush()
            transaction.add_all(
                HitlPolicyRuleRecord(
                    id=_id(),
                    policy_revision_id=revision_id,
                    decision_point_key=key,
                    definition_version=1,
                    mode=mode,
                    condition_json=spec.get("condition"),
                    on_match=spec.get("on_match"),
                    constraints_json=dict(spec.get("constraints") or {}),
                    reason_template="产品默认" if authority == "product_default" else "系统安全下限",
                    condition_specificity=_condition_specificity(spec.get("condition")),
                    rule_hash=_hash("hitl-rule", "v1", payload),
                )
                for (key, spec), payload in zip(rule_specs.items(), rule_payloads, strict=True)
                for mode in (str(spec["mode"]),)
            )
            await transaction.flush()
            policy_set.active_revision_id = revision_id

    async def decision_points(self) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(DecisionPointDefinitionRecord)
                        .where(DecisionPointDefinitionRecord.active.is_(True))
                        .order_by(DecisionPointDefinitionRecord.category, DecisionPointDefinitionRecord.key)
                    )
                ).all()
            )
        return [
            {
                "key": value.key,
                "version": value.version,
                "category": value.category,
                "label": value.label,
                "description": value.description,
                "subject_kind": value.subject_kind,
                "default_mode": value.default_mode,
                "allowed_human_actions": value.allowed_human_actions_json,
                "definition_hash": value.definition_hash,
            }
            for value in values
        ]

    async def policy_sets(self, *, principal_id: str | None = None) -> list[dict[str, Any]]:
        owner = principal_id or self.principal_id
        async with self.database.sessions() as transaction:
            sets = list(
                (
                    await transaction.scalars(
                        select(HitlPolicySetRecord)
                        .where(
                            HitlPolicySetRecord.status == "active",
                            HitlPolicySetRecord.owner_principal_id.in_(("", owner)),
                        )
                        .order_by(HitlPolicySetRecord.authority, HitlPolicySetRecord.scope_kind)
                    )
                ).all()
            )
            revision_ids = [value.active_revision_id for value in sets if value.active_revision_id]
            revisions = list(
                (
                    await transaction.scalars(
                        select(HitlPolicyRevisionRecord).where(HitlPolicyRevisionRecord.id.in_(revision_ids))
                    )
                ).all()
            ) if revision_ids else []
            rules = list(
                (
                    await transaction.scalars(
                        select(HitlPolicyRuleRecord).where(HitlPolicyRuleRecord.policy_revision_id.in_(revision_ids))
                    )
                ).all()
            ) if revision_ids else []
        revisions_by_id = {value.id: value for value in revisions}
        rules_by_revision: dict[str, list[HitlPolicyRuleRecord]] = {}
        for rule in rules:
            rules_by_revision.setdefault(rule.policy_revision_id, []).append(rule)
        return [self._policy_set_view(value, revisions_by_id.get(value.active_revision_id or ""), rules_by_revision) for value in sets]

    @staticmethod
    def _policy_set_view(
        value: HitlPolicySetRecord,
        revision: HitlPolicyRevisionRecord | None,
        rules_by_revision: Mapping[str, list[HitlPolicyRuleRecord]],
    ) -> dict[str, Any]:
        rules = rules_by_revision.get(revision.id, []) if revision else []
        return {
            "id": value.id,
            "authority": value.authority,
            "scope_kind": value.scope_kind,
            "scope_ref_id": value.scope_ref_id,
            "scope_ref_revision": value.scope_ref_revision or None,
            "owner_principal_id": value.owner_principal_id or None,
            "row_version": value.row_version,
            "active_revision": None if revision is None else {
                "id": revision.id,
                "revision": revision.revision,
                "policy_hash": revision.policy_hash,
                "change_summary": revision.change_summary,
                "activated_at": _iso(revision.activated_at),
                "rules": [
                    {
                        "decision_point_key": rule.decision_point_key,
                        "mode": rule.mode,
                        "condition": rule.condition_json,
                        "on_match": rule.on_match,
                        "constraints": rule.constraints_json,
                        "reason": rule.reason_template,
                    }
                    for rule in sorted(rules, key=lambda item: item.decision_point_key)
                ],
            },
        }

    async def activate_policy(
        self,
        *,
        scope_kind: str,
        scope_ref_id: str,
        scope_ref_revision: str | None,
        rules: Sequence[Mapping[str, Any]],
        expected_active_revision_id: str | None,
        change_summary: str,
        principal_id: str | None = None,
    ) -> dict[str, Any]:
        if scope_kind not in SCOPE_RANK or scope_kind == "product_default":
            raise GovernanceValidationError("用户策略作用域无效")
        owner = principal_id or self.principal_id
        normalized = self._validate_rules(rules)
        now = utc_now()
        async with self.database.sessions.begin() as transaction:
            policy_set = await transaction.scalar(
                select(HitlPolicySetRecord).where(
                    HitlPolicySetRecord.authority == "user_preference",
                    HitlPolicySetRecord.scope_kind == scope_kind,
                    HitlPolicySetRecord.scope_ref_id == scope_ref_id,
                    HitlPolicySetRecord.scope_ref_revision == (scope_ref_revision or ""),
                    HitlPolicySetRecord.owner_principal_id == owner,
                )
            )
            if policy_set is None:
                if expected_active_revision_id is not None:
                    raise GovernanceConflict("策略尚不存在，不能基于旧revision激活")
                policy_set = HitlPolicySetRecord(
                    id=_id(),
                    authority="user_preference",
                    scope_kind=scope_kind,
                    scope_ref_id=scope_ref_id,
                    scope_ref_revision=scope_ref_revision or "",
                    owner_principal_id=owner,
                )
                transaction.add(policy_set)
                await transaction.flush()
                next_revision = 1
            else:
                if policy_set.active_revision_id != expected_active_revision_id:
                    raise GovernanceConflict("其他页面已激活新策略版本，请刷新后比较")
                next_revision = int(
                    await transaction.scalar(
                        select(func.max(HitlPolicyRevisionRecord.revision)).where(
                            HitlPolicyRevisionRecord.policy_set_id == policy_set.id
                        )
                    ) or 0
                ) + 1
                if policy_set.active_revision_id:
                    previous = await transaction.get(HitlPolicyRevisionRecord, policy_set.active_revision_id)
                    if previous:
                        previous.status = "superseded"
            revision_id = _id()
            revision = HitlPolicyRevisionRecord(
                id=revision_id,
                policy_set_id=policy_set.id,
                revision=next_revision,
                base_revision_id=policy_set.active_revision_id,
                status="active",
                schema_version="hitl-policy-v1",
                policy_hash=_hash("hitl-policy", "hitl-policy-v1", normalized),
                change_summary=change_summary.strip() or "更新人工介入策略",
                effective_from=now,
                created_by=owner,
                activated_by=owner,
                activated_at=now,
            )
            transaction.add(revision)
            await transaction.flush()
            transaction.add_all(
                HitlPolicyRuleRecord(
                    id=_id(),
                    policy_revision_id=revision_id,
                    decision_point_key=rule["decision_point_key"],
                    definition_version=1,
                    mode=rule["mode"],
                    condition_json=rule.get("condition"),
                    on_match=rule.get("on_match"),
                    constraints_json=rule.get("constraints", {}),
                    reason_template=str(rule.get("reason") or "用户配置"),
                    condition_specificity=_condition_specificity(rule.get("condition")),
                    rule_hash=_hash("hitl-rule", "v1", rule),
                )
                for rule in normalized
            )
            await transaction.flush()
            policy_set.active_revision_id = revision_id
            policy_set.row_version += 1
            policy_set.updated_at = now
        values = await self.policy_sets(principal_id=owner)
        return next(value for value in values if value["id"] == policy_set.id)

    @staticmethod
    def _validate_rules(rules: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
        if not rules:
            raise GovernanceValidationError("策略至少需要一条规则")
        known = {seed.key for seed in DECISION_POINTS}
        seen: set[str] = set()
        normalized: list[dict[str, Any]] = []
        for value in rules:
            key = str(value.get("decision_point_key") or "")
            mode = str(value.get("mode") or "")
            if key not in known or key in seen:
                raise GovernanceValidationError(f"决策点无效或重复: {key}")
            if mode not in POLICY_MODES:
                raise GovernanceValidationError(f"策略mode无效: {mode}")
            condition = value.get("condition")
            on_match = value.get("on_match")
            if mode == "conditional":
                if condition is None or on_match not in {"deny", "require_human"}:
                    raise GovernanceValidationError("conditional必须提供受控条件和deny/require_human结果")
                if not _valid_condition_shape(condition):
                    raise GovernanceValidationError("condition格式无效")
            elif condition is not None or on_match is not None:
                raise GovernanceValidationError("非conditional规则不能提供condition/on_match")
            seen.add(key)
            normalized.append({
                "decision_point_key": key,
                "mode": mode,
                "condition": condition,
                "on_match": on_match,
                "constraints": dict(value.get("constraints") or {}),
                "reason": str(value.get("reason") or ""),
            })
        return normalized

    async def preview(
        self,
        *,
        decision_point_key: str,
        scopes: Sequence[Mapping[str, str]],
        facts: Mapping[str, Any],
        principal_id: str | None = None,
    ) -> dict[str, Any]:
        owner = principal_id or self.principal_id
        async with self.database.sessions() as transaction:
            definition = await transaction.scalar(
                select(DecisionPointDefinitionRecord).where(
                    DecisionPointDefinitionRecord.key == decision_point_key,
                    DecisionPointDefinitionRecord.active.is_(True),
                )
            )
            if definition is None:
                raise GovernanceValidationError("未知Decision Point")
            sets = list(
                (
                    await transaction.scalars(
                        select(HitlPolicySetRecord).where(
                            HitlPolicySetRecord.status == "active",
                            HitlPolicySetRecord.owner_principal_id.in_(("", owner)),
                            HitlPolicySetRecord.active_revision_id.is_not(None),
                        )
                    )
                ).all()
            )
            revision_ids = [value.active_revision_id for value in sets if value.active_revision_id]
            rules = list(
                (
                    await transaction.scalars(
                        select(HitlPolicyRuleRecord).where(
                            HitlPolicyRuleRecord.policy_revision_id.in_(revision_ids),
                            HitlPolicyRuleRecord.decision_point_key == decision_point_key,
                        )
                    )
                ).all()
            ) if revision_ids else []
        sets_by_revision = {value.active_revision_id: value for value in sets}
        scope_lookup = {(str(value.get("kind")), str(value.get("ref_id"))): value for value in scopes}
        scope_lookup[("product_default", "*")] = {"kind": "product_default", "ref_id": "*"}
        candidates: list[tuple[HitlPolicySetRecord, HitlPolicyRuleRecord, str, bool]] = []
        for rule in rules:
            policy_set = sets_by_revision.get(rule.policy_revision_id)
            if policy_set is None or (policy_set.scope_kind, policy_set.scope_ref_id) not in scope_lookup:
                continue
            # ``inherit`` means that this scope deliberately has no opinion.  It
            # must not become an ``auto_continue`` candidate at a more specific
            # rank, otherwise a freshly-created user policy would silently
            # override the product default instead of inheriting it.
            if rule.mode == "inherit":
                continue
            action, complete = self._rule_action(rule, facts)
            candidates.append((policy_set, rule, action, complete))
        floors = [value for value in candidates if value[0].authority in {"system_safety", "identity_scope", "capability"}]
        preferences = [value for value in candidates if value[0].authority in {"product_default", "user_preference"}]
        floor_action = _strictest(value[2] for value in floors)
        preference_action = self._preference_action(preferences)
        final_action = _strictest((floor_action, preference_action))
        failed_closed = any(not value[3] for value in candidates)
        if failed_closed:
            final_action = _strictest((final_action, "require_human"))
        matched = [
            {
                "policy_set_id": policy_set.id,
                "policy_revision_id": rule.policy_revision_id,
                "rule_id": rule.id,
                "authority": policy_set.authority,
                "scope_kind": policy_set.scope_kind,
                "scope_ref_id": policy_set.scope_ref_id,
                "mode": rule.mode,
                "resolved_action": action,
                "complete": complete,
                "reason": rule.reason_template,
            }
            for policy_set, rule, action, complete in candidates
        ]
        return {
            "decision_point_key": decision_point_key,
            "applicability": "applicable",
            "floor_action": floor_action,
            "preference_action": preference_action,
            "final_action": final_action,
            "result_status": "failed_closed" if failed_closed else "resolved",
            "facts": dict(facts),
            "matched_rules": matched,
            "reason_codes": ["missing_or_invalid_policy_fact"] if failed_closed else ["policy_resolved"],
            "resolver_version": RESOLVER_VERSION,
        }

    @staticmethod
    def _rule_action(rule: HitlPolicyRuleRecord, facts: Mapping[str, Any]) -> tuple[str, bool]:
        if rule.mode == "inherit":
            return "auto_continue", True
        if rule.mode in FINAL_ACTIONS:
            return rule.mode, True
        matched, complete = _eval_condition(rule.condition_json, facts)
        if not complete:
            return "require_human", False
        return (str(rule.on_match) if matched else "auto_continue"), True

    @staticmethod
    def _preference_action(
        candidates: Sequence[tuple[HitlPolicySetRecord, HitlPolicyRuleRecord, str, bool]]
    ) -> str:
        if not candidates:
            return "require_human"
        user = [value for value in candidates if value[0].authority == "user_preference"]
        selected = user or [value for value in candidates if value[0].authority == "product_default"]
        if not selected:
            return "require_human"
        highest = max(SCOPE_RANK.get(value[0].scope_kind, 0) for value in selected)
        same_rank = [value[2] for value in selected if SCOPE_RANK.get(value[0].scope_kind, 0) == highest]
        return _strictest(same_rank)

    async def create_policy_snapshot(
        self,
        *,
        scopes: Sequence[Mapping[str, str]],
        principal_id: str | None = None,
    ) -> HitlPolicySnapshotRecord:
        owner = principal_id or self.principal_id
        results = {
            seed.key: await self.preview(
                decision_point_key=seed.key,
                scopes=scopes,
                facts={},
                principal_id=owner,
            )
            for seed in DECISION_POINTS
        }
        active = await self.policy_sets(principal_id=owner)
        refs = [
            {"policy_set_id": value["id"], "revision_id": value["active_revision"]["id"], "policy_hash": value["active_revision"]["policy_hash"]}
            for value in active
            if value["active_revision"] is not None
        ]
        preference = {key: value["preference_action"] for key, value in results.items()}
        floors = {key: value["floor_action"] for key, value in results.items()}
        content = {"principal_id": owner, "refs": refs, "preference": preference, "floors": floors}
        snapshot_hash = _hash("hitl-policy-snapshot", "v1", content)
        async with self.database.sessions.begin() as transaction:
            existing = await transaction.scalar(
                select(HitlPolicySnapshotRecord).where(HitlPolicySnapshotRecord.snapshot_hash == snapshot_hash)
            )
            if existing is not None:
                return existing
            value = HitlPolicySnapshotRecord(
                id=_id(),
                principal_id=owner,
                resolver_version=RESOLVER_VERSION,
                active_revision_refs_json=refs,
                preference_rules_json=preference,
                floor_rules_json=floors,
                snapshot_hash=snapshot_hash,
            )
            transaction.add(value)
        return value

    async def register_subject(
        self,
        *,
        subject_kind: str,
        resource_id: str,
        resource_revision: str,
        subject_content: Any,
        session_id: str,
        interaction_id: str | None,
        run_id: str | None,
        run_attempt_id: str | None,
        workflow_definition_id: str | None,
        workflow_version: str | None,
        node_id: str | None,
        decision_view: Mapping[str, Any],
    ) -> DecisionSubjectRecord:
        subject_hash = _hash("decision-subject", "v1", subject_content)
        async with self.database.sessions.begin() as transaction:
            existing = await transaction.scalar(
                select(DecisionSubjectRecord).where(
                    DecisionSubjectRecord.subject_kind == subject_kind,
                    DecisionSubjectRecord.resource_id == resource_id,
                    DecisionSubjectRecord.resource_revision == resource_revision,
                    DecisionSubjectRecord.subject_hash == subject_hash,
                )
            )
            if existing is not None:
                return existing
            value = DecisionSubjectRecord(
                id=_id(),
                subject_kind=subject_kind,
                resource_id=resource_id,
                resource_revision=resource_revision,
                subject_hash=subject_hash,
                session_id=session_id,
                interaction_id=interaction_id,
                run_id=run_id,
                run_attempt_id=run_attempt_id,
                workflow_definition_id=workflow_definition_id,
                workflow_version=workflow_version,
                node_id=node_id,
                decision_view_json=dict(decision_view),
            )
            transaction.add(value)
        return value

    async def evaluate_subject(
        self,
        *,
        subject: DecisionSubjectRecord,
        decision_point_key: str,
        scopes: Sequence[Mapping[str, str]],
        facts: Mapping[str, Any],
        policy_snapshot_id: str | None = None,
    ) -> tuple[PolicyEvaluationRecord, dict[str, Any]]:
        preview = await self.preview(
            decision_point_key=decision_point_key,
            scopes=scopes,
            facts=facts,
        )
        async with self.database.sessions.begin() as transaction:
            definition = await transaction.scalar(
                select(DecisionPointDefinitionRecord).where(
                    DecisionPointDefinitionRecord.key == decision_point_key,
                    DecisionPointDefinitionRecord.active.is_(True),
                )
            )
            if definition is None:
                raise GovernanceValidationError("Decision Point不存在")
            value = PolicyEvaluationRecord(
                id=_id(),
                subject_id=subject.id,
                decision_point_definition_id=definition.id,
                policy_snapshot_id=policy_snapshot_id,
                principal_id=self.principal_id,
                applicability_status="applicable",
                facts_json=dict(facts),
                facts_hash=_hash("policy-facts", "v1", facts),
                matched_rule_refs_json=preview["matched_rules"],
                floor_action=preview["floor_action"],
                preference_action=preview["preference_action"],
                final_action=preview["final_action"],
                result_status=preview["result_status"],
                reason_codes_json=preview["reason_codes"],
                resolver_version=RESOLVER_VERSION,
            )
            transaction.add(value)
        return value, preview

    async def record_not_applicable(
        self,
        *,
        subject: DecisionSubjectRecord,
        decision_point_key: str,
        facts: Mapping[str, Any],
        reason_code: str,
    ) -> PolicyEvaluationRecord:
        """Persist that a registered decision point does not apply this turn."""

        async with self.database.sessions.begin() as transaction:
            definition = await transaction.scalar(
                select(DecisionPointDefinitionRecord).where(
                    DecisionPointDefinitionRecord.key == decision_point_key,
                    DecisionPointDefinitionRecord.active.is_(True),
                )
            )
            if definition is None:
                raise GovernanceValidationError("Decision Point不存在")
            value = PolicyEvaluationRecord(
                id=_id(),
                subject_id=subject.id,
                decision_point_definition_id=definition.id,
                policy_snapshot_id=None,
                principal_id=self.principal_id,
                applicability_status="not_applicable",
                facts_json=dict(facts),
                facts_hash=_hash("policy-facts", "v1", facts),
                matched_rule_refs_json=[],
                floor_action="auto_continue",
                preference_action="auto_continue",
                final_action=None,
                result_status="not_applicable",
                reason_codes_json=[reason_code],
                resolver_version=RESOLVER_VERSION,
            )
            transaction.add(value)
        return value

    async def run_context(self, run_id: str) -> dict[str, str | None]:
        async with self.database.sessions() as transaction:
            run = await transaction.get(RunRecord, run_id)
            if run is None:
                raise GovernanceValidationError("Product Run不存在")
            attempt = await transaction.scalar(
                select(RunAttemptRecord)
                .where(RunAttemptRecord.run_id == run.id)
                .order_by(RunAttemptRecord.attempt_number.desc())
            )
        return {
            "session_id": run.session_id,
            "interaction_id": run.interaction_id,
            "run_id": run.id,
            "run_attempt_id": attempt.id if attempt else None,
        }

    async def get_subject(self, subject_id: str) -> DecisionSubjectRecord:
        async with self.database.sessions() as transaction:
            subject = await transaction.get(DecisionSubjectRecord, subject_id)
            if subject is None:
                raise GovernanceValidationError("Decision Subject不存在")
            return subject

    async def execution_draft_subject(
        self,
        draft_revision_id: str,
    ) -> DecisionSubjectRecord:
        async with self.database.sessions() as transaction:
            revision = await transaction.get(ExecutionDraftRevisionRecord, draft_revision_id)
            if revision is None:
                raise GovernanceValidationError("ExecutionDraft revision不存在")
            subject = await transaction.get(DecisionSubjectRecord, revision.subject_id)
            if subject is None:
                raise GovernanceValidationError("ExecutionDraft Decision Subject不存在")
            return subject

    async def record_automatic_decision(
        self,
        *,
        evaluation: PolicyEvaluationRecord,
        subject: DecisionSubjectRecord,
        decision_code: str,
        grant_kind: str | None,
        binding_hash: str,
        constraints: Mapping[str, Any] | None = None,
    ) -> tuple[DecisionRecord, AuthorizationGrantRecord | None]:
        source = "policy"
        effect = "allow" if grant_kind else "none"
        input_content = {"evaluation_id": evaluation.id, "subject_hash": subject.subject_hash, "decision_code": decision_code}
        input_hash = _hash("decision-input", "v1", input_content)
        record_hash = _hash("decision-record", "v1", input_content | {"source": source, "effect": effect})
        async with self.database.sessions.begin() as transaction:
            record = DecisionRecord(
                id=_id(),
                policy_evaluation_id=evaluation.id,
                request_id=None,
                request_item_id=None,
                subject_id=subject.id,
                source=source,
                actor_principal_id="policy-resolver",
                decision_code=decision_code,
                authorization_effect=effect,
                reason="按已解析HITL策略自动推进",
                bound_subject_hash=subject.subject_hash,
                policy_rule_refs_json=evaluation.matched_rule_refs_json,
                input_hash=input_hash,
                record_hash=record_hash,
            )
            transaction.add(record)
            await transaction.flush()
            grant: AuthorizationGrantRecord | None = None
            if grant_kind:
                grant = AuthorizationGrantRecord(
                    id=_id(),
                    decision_record_id=record.id,
                    subject_id=subject.id,
                    grant_kind=grant_kind,
                    binding_hash=binding_hash,
                    constraints_json=dict(constraints or {}),
                    max_consumptions=1,
                    expires_at=utc_now() + timedelta(hours=1),
                )
                transaction.add(grant)
        return record, grant

    async def create_human_request(
        self,
        *,
        evaluation: PolicyEvaluationRecord,
        subject: DecisionSubjectRecord,
        title: str,
        reason: str,
        evidence: Mapping[str, Any],
        consequence: Mapping[str, Any],
        allowed_actions: Sequence[str],
        decision_point_key: str | None = None,
    ) -> HumanDecisionRequestRecord:
        decision_point = decision_point_key or next(
            seed.key for seed in DECISION_POINTS if seed.subject_kind == subject.subject_kind
        )
        content = {
            "decision_point": decision_point,
            "subject_id": subject.id,
            "subject_hash": subject.subject_hash,
            "actions": list(allowed_actions),
        }
        request = HumanDecisionRequestRecord(
            id=_id(),
            decision_point_key=decision_point,
            principal_id=self.principal_id,
            session_id=subject.session_id,
            interaction_id=subject.interaction_id,
            run_id=subject.run_id,
            request_hash=_hash("human-decision-request", "v1", content),
            title=title,
            reason_summary=reason,
            visible_evidence_json=dict(evidence),
            consequence_json=dict(consequence),
            expires_at=utc_now() + timedelta(hours=24),
        )
        item = HumanDecisionRequestItemRecord(
            id=_id(),
            request_id=request.id,
            policy_evaluation_id=evaluation.id,
            subject_id=subject.id,
            item_key=subject.id,
            ordinal=0,
            allowed_actions_json=list(allowed_actions),
        )
        async with self.database.sessions.begin() as transaction:
            transaction.add(request)
            await transaction.flush()
            transaction.add(item)
        return request

    async def resolve_human_request(
        self,
        *,
        request_id: str,
        expected_request_hash: str,
        expected_row_version: int,
        decisions: Sequence[Mapping[str, str]],
    ) -> list[dict[str, Any]]:
        async with self.database.sessions.begin() as transaction:
            request = await transaction.get(HumanDecisionRequestRecord, request_id)
            if request is None:
                raise GovernanceValidationError("人工决定请求不存在")
            if request.status != "pending" or request.request_hash != expected_request_hash or request.row_version != expected_row_version:
                raise GovernanceConflict("决定请求已失效或已由其他入口处理")
            items = list(
                (
                    await transaction.scalars(
                        select(HumanDecisionRequestItemRecord)
                        .where(HumanDecisionRequestItemRecord.request_id == request_id)
                        .order_by(HumanDecisionRequestItemRecord.ordinal)
                    )
                ).all()
            )
            by_key = {str(value.get("item_key")): str(value.get("decision")) for value in decisions}
            if set(by_key) != {item.item_key for item in items}:
                raise GovernanceValidationError("必须完整且不重复地决定全部请求项")
            result: list[dict[str, Any]] = []
            for item in items:
                decision = by_key[item.item_key]
                if decision not in set(item.allowed_actions_json):
                    raise GovernanceValidationError(f"请求项不允许该决定: {decision}")
                subject = await transaction.get(DecisionSubjectRecord, item.subject_id)
                evaluation = await transaction.get(PolicyEvaluationRecord, item.policy_evaluation_id)
                if subject is None or evaluation is None:
                    raise GovernanceConflict("决定请求引用损坏")
                allow = decision in {"accept", "approve", "execute", "commit", "retry", "restart", "new_run"}
                input_content = {"request_id": request.id, "item_key": item.item_key, "decision": decision, "subject_hash": subject.subject_hash}
                record = DecisionRecord(
                    id=_id(),
                    policy_evaluation_id=evaluation.id,
                    request_id=request.id,
                    request_item_id=item.id,
                    subject_id=subject.id,
                    source="human",
                    actor_principal_id=self.principal_id,
                    decision_code=decision,
                    authorization_effect="allow" if allow else "none",
                    reason="用户通过人工介入界面提交决定",
                    bound_subject_hash=subject.subject_hash,
                    policy_rule_refs_json=evaluation.matched_rule_refs_json,
                    input_hash=_hash("decision-input", "v1", input_content),
                    record_hash=_hash("decision-record", "v1", input_content | {"actor": self.principal_id}),
                )
                transaction.add(record)
                await transaction.flush()
                grant: AuthorizationGrantRecord | None = None
                grant_kind = GRANT_KIND_BY_POINT.get(request.decision_point_key) if allow else None
                if grant_kind is not None:
                    grant = AuthorizationGrantRecord(
                        id=_id(),
                        decision_record_id=record.id,
                        subject_id=subject.id,
                        grant_kind=grant_kind,
                        binding_hash=subject.subject_hash,
                        constraints_json={},
                        max_consumptions=1,
                        expires_at=utc_now() + timedelta(hours=1),
                    )
                    transaction.add(grant)
                item.status = "resolved"
                item.decision_record_id = record.id
                result.append({
                    "item_key": item.item_key,
                    "decision": decision,
                    "decision_record_id": record.id,
                    "authorization_grant_id": grant.id if grant else None,
                    "binding_hash": subject.subject_hash,
                })
            request.status = "resolved"
            request.row_version += 1
            request.resolved_at = utc_now()
            transaction.add(
                GovernanceOutboxRecord(
                    id=_id(),
                    aggregate_kind="human_decision_request",
                    aggregate_id=request.id,
                    event_type="runtime.resume_requested",
                    payload_json={"decision_request_id": request.id, "decisions": result},
                    dedupe_key=f"runtime.resume_requested:{request.id}:{request.row_version}",
                )
            )
        return result

    async def resolve_single_human_request(
        self,
        *,
        request_id: str,
        expected_request_hash: str,
        expected_row_version: int,
        decision: str,
    ) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            item = await transaction.scalar(
                select(HumanDecisionRequestItemRecord).where(
                    HumanDecisionRequestItemRecord.request_id == request_id
                )
            )
            if item is None:
                raise GovernanceValidationError("人工决定请求没有可处理项")
            item_key = item.item_key
        values = await self.resolve_human_request(
            request_id=request_id,
            expected_request_hash=expected_request_hash,
            expected_row_version=expected_row_version,
            decisions=[{"item_key": item_key, "decision": decision}],
        )
        return values[0]

    async def claim_grant(
        self,
        *,
        grant_id: str,
        binding_hash: str,
        consumer_kind: str,
        consumer_id: str,
        idempotency_key: str,
        claimed_by: str,
    ) -> AuthorizationConsumptionRecord:
        now = utc_now()
        async with self.database.sessions.begin() as transaction:
            existing = await transaction.scalar(
                select(AuthorizationConsumptionRecord).where(
                    AuthorizationConsumptionRecord.idempotency_key == idempotency_key
                )
            )
            if existing is not None:
                return existing
            grant = await transaction.get(AuthorizationGrantRecord, grant_id)
            if grant is None or grant.status != "active" or grant.binding_hash != binding_hash:
                raise GovernanceConflict("授权不存在、失效或内容绑定不一致")
            expires_at = grant.expires_at
            if expires_at is not None:
                if expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=timezone.utc)
                if expires_at <= now:
                    grant.status = "expired"
                    raise GovernanceConflict("授权已过期")
            if grant.consumed_count >= grant.max_consumptions:
                grant.status = "exhausted"
                raise GovernanceConflict("授权已经消费完毕")
            consumption_no = grant.consumed_count + 1
            grant.consumed_count = consumption_no
            grant.row_version += 1
            if grant.consumed_count >= grant.max_consumptions:
                grant.status = "exhausted"
            value = AuthorizationConsumptionRecord(
                id=_id(),
                grant_id=grant.id,
                consumption_no=consumption_no,
                consumer_kind=consumer_kind,
                consumer_id=consumer_id,
                idempotency_key=idempotency_key,
                claimed_by=claimed_by,
            )
            transaction.add(value)
        return value

    async def bind_execution_authorization(
        self,
        *,
        run_id: str,
        consumption_id: str,
    ) -> None:
        async with self.database.sessions.begin() as transaction:
            run = await transaction.get(RunRecord, run_id)
            attempt = await transaction.scalar(
                select(RunAttemptRecord)
                .where(RunAttemptRecord.run_id == run_id)
                .order_by(RunAttemptRecord.attempt_number.desc())
            )
            consumption = await transaction.get(AuthorizationConsumptionRecord, consumption_id)
            if run is None or attempt is None or consumption is None:
                raise GovernanceValidationError("Run Attempt或执行授权消费不存在")
            grant = await transaction.get(AuthorizationGrantRecord, consumption.grant_id)
            if grant is None or grant.grant_kind != "start_run":
                raise GovernanceValidationError("授权消费不是ExecutionDraft启动授权")
            revision = await transaction.scalar(
                select(ExecutionDraftRevisionRecord).where(
                    ExecutionDraftRevisionRecord.subject_id == grant.subject_id
                )
            )
            if revision is None:
                raise GovernanceValidationError("ExecutionDraft授权没有对应revision")
            draft = await transaction.get(ExecutionDraftRecord, revision.draft_id)
            decision = await transaction.get(DecisionRecord, grant.decision_record_id)
            if draft is None or decision is None:
                raise GovernanceValidationError("ExecutionDraft授权引用不完整")
            if draft.session_id != run.session_id or draft.interaction_id != run.interaction_id:
                raise GovernanceConflict("ExecutionDraft授权与Run Attempt不属于同一Interaction")
            if (
                attempt.start_authorization_consumption_id is not None
                and attempt.start_authorization_consumption_id != consumption.id
            ):
                raise GovernanceConflict("Run Attempt已经绑定其他执行授权")
            attempt.start_authorization_consumption_id = consumption.id
            revision.status = "accepted"
            draft.accepted_revision_id = revision.id
            draft.acceptance_decision_record_id = decision.id
            draft.status = "accepted"
            draft.row_version += 1
            draft.updated_at = utc_now()

    async def accepted_execution_draft(
        self,
        draft_revision_id: str,
    ) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            revision = await transaction.get(ExecutionDraftRevisionRecord, draft_revision_id)
            if revision is None:
                raise GovernanceValidationError("ExecutionDraft revision不存在")
            draft = await transaction.get(ExecutionDraftRecord, revision.draft_id)
            if (
                draft is None
                or revision.status != "accepted"
                or draft.status != "accepted"
                or draft.accepted_revision_id != revision.id
            ):
                raise GovernanceConflict("ExecutionDraft尚未获得当前revision的有效授权")
            return {
                "draft_id": draft.id,
                "revision_id": revision.id,
                "draft_hash": revision.draft_hash,
                "execution_brief": revision.execution_brief_text,
                "payload": dict(revision.payload_json),
            }

    async def create_execution_draft(
        self,
        *,
        session_id: str,
        run_id: str,
        workflow_definition_id: str,
        workflow_version: str,
        payload: Mapping[str, Any],
        execution_brief: str,
        author_type: str = "system",
        author_id: str = "workflow",
        authorization_node_id: str = "execution_authorization",
    ) -> tuple[ExecutionDraftRecord, ExecutionDraftRevisionRecord]:
        value = _validate_payload(payload, EXECUTION_DRAFT_KEYS, "execution-draft-v1")
        context_hash = str(value["context_binding"].get("context_hash") or _hash("context", "v1", value["context_binding"]))
        draft_hash = _hash("execution-draft", "execution-draft-v1", value | {"execution_brief": execution_brief})
        async with self.database.sessions.begin() as transaction:
            run = await transaction.get(RunRecord, run_id)
            if run is None or run.session_id != session_id:
                raise GovernanceValidationError("Product Run不存在")
            draft = await transaction.scalar(
                select(ExecutionDraftRecord).where(
                    ExecutionDraftRecord.interaction_id == run.interaction_id,
                    ExecutionDraftRecord.workflow_definition_id == workflow_definition_id,
                    ExecutionDraftRecord.branch_key == "main",
                )
            )
            previous: ExecutionDraftRevisionRecord | None = None
            if draft is None:
                draft = ExecutionDraftRecord(
                    id=_id(),
                    session_id=session_id,
                    interaction_id=run.interaction_id,
                    principal_id=self.principal_id,
                    workflow_definition_id=workflow_definition_id,
                    workflow_version=workflow_version,
                    branch_key="main",
                )
                transaction.add(draft)
                await transaction.flush()
                revision_no = 1
            else:
                previous = await transaction.get(ExecutionDraftRevisionRecord, draft.current_revision_id) if draft.current_revision_id else None
                revision_no = (previous.revision if previous else 0) + 1
                if previous:
                    previous.status = "superseded"
            revision_id = _id()
            subject = DecisionSubjectRecord(
                id=_id(),
                subject_kind="execution_draft",
                resource_id=draft.id,
                resource_revision=str(revision_no),
                subject_hash=draft_hash,
                session_id=session_id,
                interaction_id=run.interaction_id,
                run_id=run.id,
                run_attempt_id=None,
                workflow_definition_id=workflow_definition_id,
                workflow_version=workflow_version,
                node_id=authorization_node_id,
                decision_view_json={"execution_brief": execution_brief, "draft_hash": draft_hash},
            )
            revision = ExecutionDraftRevisionRecord(
                id=revision_id,
                draft_id=draft.id,
                revision=revision_no,
                previous_revision_id=previous.id if previous else None,
                subject_id=subject.id,
                schema_version="execution-draft-v1",
                payload_json=value,
                execution_brief_text=execution_brief,
                context_hash=context_hash,
                draft_hash=draft_hash,
                author_type=author_type,
                author_id=author_id,
                status="reviewable",
            )
            transaction.add(subject)
            await transaction.flush()
            transaction.add(revision)
            await transaction.flush()
            draft.current_revision_id = revision.id
            draft.status = "reviewable"
            draft.row_version = (draft.row_version or 0) + 1
            draft.updated_at = utc_now()
        return draft, revision

    async def compile_run_spec(
        self,
        *,
        draft_revision_id: str,
        scopes: Sequence[Mapping[str, str]],
        spec_payload: Mapping[str, Any],
        run_id: str,
    ) -> RunSpecRecord:
        value = _validate_payload(spec_payload, RUN_SPEC_KEYS, "run-spec-v1")
        snapshot = await self.create_policy_snapshot(scopes=scopes)
        run_spec_hash = _hash("run-spec", "run-spec-v1", value)
        async with self.database.sessions.begin() as transaction:
            revision = await transaction.get(ExecutionDraftRevisionRecord, draft_revision_id)
            run = await transaction.get(RunRecord, run_id)
            if revision is None or run is None:
                raise GovernanceValidationError("Draft revision或Run不存在")
            draft = await transaction.get(ExecutionDraftRecord, revision.draft_id)
            if (
                draft is None
                or revision.status != "accepted"
                or draft.status != "accepted"
                or draft.accepted_revision_id != revision.id
            ):
                raise GovernanceConflict("只有已授权的ExecutionDraft revision才能编译RunSpec")
            subject = DecisionSubjectRecord(
                id=_id(),
                subject_kind="run_spec",
                resource_id="pending",
                resource_revision="1",
                subject_hash=run_spec_hash,
                session_id=run.session_id,
                interaction_id=run.interaction_id,
                run_id=run.id,
                run_attempt_id=None,
                workflow_definition_id=str(value["workflow_binding"].get("definition_id") or ""),
                workflow_version=str(value["workflow_binding"].get("version") or ""),
                node_id="run_spec",
                decision_view_json={"run_spec_hash": run_spec_hash},
            )
            spec = RunSpecRecord(
                id=_id(),
                draft_revision_id=revision.id,
                subject_id=subject.id,
                policy_snapshot_id=snapshot.id,
                schema_version="run-spec-v1",
                compiler_version=COMPILER_VERSION,
                spec_json=value,
                run_spec_hash=run_spec_hash,
                status="bound",
                bound_run_id=run.id,
            )
            subject.resource_id = spec.id
            transaction.add(subject)
            await transaction.flush()
            transaction.add(spec)
            await transaction.flush()
            run.execution_draft_revision_id = revision.id
            run.run_spec_id = spec.id
        return spec

    async def register_model_call(
        self,
        *,
        review_card: Mapping[str, Any],
    ) -> tuple[
        ModelCallDraftRecord,
        ModelCallDraftRevisionRecord,
        PolicyEvaluationRecord,
        dict[str, Any],
        HumanDecisionRequestRecord | None,
    ]:
        run_id = str(review_card.get("run_id") or "")
        execution_context = review_card.get("execution_context") if isinstance(review_card.get("execution_context"), Mapping) else {}
        node_id = str(execution_context.get("executor_id") or execution_context.get("agent_id") or "model_call")
        call_ordinal = int(execution_context.get("call_ordinal") or execution_context.get("call_position") or 1)
        provider_request = review_card.get("provider_request")
        if not isinstance(provider_request, Mapping):
            raise GovernanceValidationError("ModelCallDraft缺少Provider请求")
        body = canonical_json_bytes(provider_request)
        body_hash = hashlib.sha256(body).hexdigest()
        if body_hash != review_card.get("body_sha256"):
            raise GovernanceValidationError("Provider Body与审批Hash不一致")
        async with self.database.sessions.begin() as transaction:
            run = await transaction.get(RunRecord, run_id)
            if run is None:
                raise GovernanceValidationError("ModelCall关联的Run不存在")
            attempt = await transaction.scalar(
                select(RunAttemptRecord)
                .where(RunAttemptRecord.run_id == run.id)
                .order_by(RunAttemptRecord.attempt_number.desc())
            )
            if attempt is None:
                raise GovernanceValidationError("ModelCall关联的Run Attempt不存在")
            slot = await transaction.scalar(
                select(ModelCallDraftRecord).where(
                    ModelCallDraftRecord.run_id == run.id,
                    ModelCallDraftRecord.workflow_node_id == node_id,
                    ModelCallDraftRecord.call_ordinal == call_ordinal,
                )
            )
            previous: ModelCallDraftRevisionRecord | None = None
            if slot is None:
                slot = ModelCallDraftRecord(
                    id=_id(),
                    run_id=run.id,
                    run_attempt_id=attempt.id,
                    workflow_node_id=node_id,
                    call_ordinal=call_ordinal,
                )
                transaction.add(slot)
                await transaction.flush()
                revision_no = 1
            else:
                previous = await transaction.get(ModelCallDraftRevisionRecord, slot.current_revision_id) if slot.current_revision_id else None
                revision_no = (previous.revision if previous else 0) + 1
                if previous:
                    previous.status = "superseded"
            revision_id = _id()
            binding_hash = str(review_card.get("binding_hash") or "")
            subject = DecisionSubjectRecord(
                id=_id(),
                subject_kind="model_call_draft",
                resource_id=slot.id,
                resource_revision=str(revision_no),
                subject_hash=binding_hash,
                session_id=run.session_id,
                interaction_id=run.interaction_id,
                run_id=run.id,
                run_attempt_id=attempt.id,
                workflow_definition_id=str(execution_context.get("workflow_id") or ""),
                workflow_version=str(execution_context.get("workflow_version") or ""),
                node_id=node_id,
                decision_view_json={
                    "provider_id": review_card.get("provider_id"),
                    "model": provider_request.get("model"),
                    "body_sha256": body_hash,
                    "binding_hash": binding_hash,
                },
            )
            revision = ModelCallDraftRevisionRecord(
                id=revision_id,
                model_call_draft_id=slot.id,
                revision=revision_no,
                previous_revision_id=previous.id if previous else None,
                subject_id=subject.id,
                provider_id=str(review_card.get("provider_id") or ""),
                provider_protocol=str(review_card.get("provider_protocol") or ""),
                model=str(provider_request.get("model") or ""),
                provider_request_json=dict(provider_request),
                provider_body=body,
                provider_body_sha256=body_hash,
                binding_hash=binding_hash,
                effective_context_json=dict(review_card.get("effective_context") or {}),
                context_source_annotations_json=list((review_card.get("effective_context") or {}).get("history_and_knowledge") or []),
                adapter_version="provider-adapter-v1",
                status="reviewable",
            )
            transaction.add(subject)
            await transaction.flush()
            transaction.add(revision)
            await transaction.flush()
            slot.current_revision_id = revision.id
            slot.status = "reviewable"
            slot.row_version = (slot.row_version or 0) + 1
        scopes = [
            {"kind": "product_default", "ref_id": "*"},
            {"kind": "principal", "ref_id": self.principal_id},
            {"kind": "product_session", "ref_id": subject.session_id},
            {"kind": "run", "ref_id": subject.run_id or ""},
            {"kind": "workflow_version", "ref_id": subject.workflow_definition_id or ""},
            {"kind": "workflow_node", "ref_id": node_id},
        ]
        scenario = execution_context.get("scenario")
        if isinstance(scenario, str) and scenario:
            scopes.append({"kind": "scenario", "ref_id": scenario})
        evaluation, preview = await self.evaluate_subject(
            subject=subject,
            decision_point_key="model_call_authorization",
            scopes=scopes,
            facts={
                "model": {"call_ordinal": call_ordinal},
                "tokens": {"estimated": (review_card.get("effective_context") or {}).get("token_estimate")},
                "context": {"changed": revision_no > 1},
                "subject": {"changed_since_decision": revision_no > 1},
            },
        )
        request: HumanDecisionRequestRecord | None = None
        if preview["final_action"] == "require_human":
            request = await self.create_human_request(
                evaluation=evaluation,
                subject=subject,
                title="确认本次模型调用",
                reason="策略要求在Provider发送前确认完整请求。",
                evidence={
                    "provider_id": revision.provider_id,
                    "model": revision.model,
                    "provider_body_sha256": revision.provider_body_sha256,
                    "binding_hash": revision.binding_hash,
                    "workflow_node_id": node_id,
                },
                consequence={
                    "approve": "签发一次性发送授权并发送当前绑定版本。",
                    "revise": "旧版本不发送，修改后形成新revision并重新评估。",
                    "abandon": "当前调用不发送，Workflow按放弃语义结束或返回。",
                },
                allowed_actions=("approve", "revise", "abandon"),
            )
        return slot, revision, evaluation, preview, request

    async def start_model_call_attempt(
        self,
        *,
        revision: ModelCallDraftRevisionRecord,
        consumption: AuthorizationConsumptionRecord,
    ) -> ModelCallAttemptRecord:
        async with self.database.sessions.begin() as transaction:
            slot = await transaction.get(ModelCallDraftRecord, revision.model_call_draft_id)
            if slot is None:
                raise GovernanceValidationError("ModelCall slot不存在")
            persisted_consumption = await transaction.get(
                AuthorizationConsumptionRecord, consumption.id
            )
            if persisted_consumption is None:
                raise GovernanceValidationError("ModelCall授权消费不存在")
            attempt_number = int(
                await transaction.scalar(
                    select(func.max(ModelCallAttemptRecord.attempt_number)).where(
                        ModelCallAttemptRecord.model_call_draft_revision_id == revision.id
                    )
                ) or 0
            ) + 1
            value = ModelCallAttemptRecord(
                id=_id(),
                model_call_draft_revision_id=revision.id,
                authorization_consumption_id=consumption.id,
                run_id=slot.run_id,
                run_attempt_id=slot.run_attempt_id,
                attempt_number=attempt_number,
                transport_idempotency_key=f"model-call:{revision.id}:{attempt_number}",
                status="dispatched",
            )
            transaction.add(value)
            persisted_consumption.status = "dispatched"
            persisted_consumption.dispatched_at = utc_now()
        return value

    async def finish_model_call_attempt(
        self,
        *,
        attempt_id: str,
        status: str,
        failure_code: str | None = None,
    ) -> None:
        async with self.database.sessions.begin() as transaction:
            attempt = await transaction.get(ModelCallAttemptRecord, attempt_id)
            if attempt is None:
                raise GovernanceValidationError("ModelCall Attempt不存在")
            consumption = await transaction.get(
                AuthorizationConsumptionRecord, attempt.authorization_consumption_id
            )
            attempt.status = status
            attempt.failure_code = failure_code
            attempt.finished_at = utc_now()
            if consumption is not None:
                consumption.status = status
                consumption.error_code = failure_code
                consumption.finished_at = utc_now()

    async def governance_for_run(self, run_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            run = await transaction.get(RunRecord, run_id)
            if run is None:
                raise GovernanceValidationError("Product Run不存在")
            draft = await transaction.get(ExecutionDraftRevisionRecord, run.execution_draft_revision_id) if run.execution_draft_revision_id else None
            spec = await transaction.get(RunSpecRecord, run.run_spec_id) if run.run_spec_id else None
            requests = list(
                (
                    await transaction.scalars(
                        select(HumanDecisionRequestRecord)
                        .where(HumanDecisionRequestRecord.run_id == run.id)
                        .order_by(HumanDecisionRequestRecord.created_at)
                    )
                ).all()
            )
            evaluations = list(
                (
                    await transaction.scalars(
                        select(PolicyEvaluationRecord)
                        .join(DecisionSubjectRecord, DecisionSubjectRecord.id == PolicyEvaluationRecord.subject_id)
                        .where(DecisionSubjectRecord.run_id == run.id)
                        .order_by(PolicyEvaluationRecord.evaluated_at)
                    )
                ).all()
            )
            evaluation_subject_ids = [value.subject_id for value in evaluations]
            evaluation_definition_ids = [value.decision_point_definition_id for value in evaluations]
            evaluation_subjects = list(
                (
                    await transaction.scalars(
                        select(DecisionSubjectRecord).where(
                            DecisionSubjectRecord.id.in_(evaluation_subject_ids)
                        )
                    )
                ).all()
            ) if evaluation_subject_ids else []
            evaluation_definitions = list(
                (
                    await transaction.scalars(
                        select(DecisionPointDefinitionRecord).where(
                            DecisionPointDefinitionRecord.id.in_(evaluation_definition_ids)
                        )
                    )
                ).all()
            ) if evaluation_definition_ids else []
            model_slots = list(
                (
                    await transaction.scalars(
                        select(ModelCallDraftRecord)
                        .where(ModelCallDraftRecord.run_id == run.id)
                        .order_by(ModelCallDraftRecord.call_ordinal)
                    )
                ).all()
            )
            slot_ids = [value.id for value in model_slots]
            model_revisions = list(
                (
                    await transaction.scalars(
                        select(ModelCallDraftRevisionRecord)
                        .where(ModelCallDraftRevisionRecord.model_call_draft_id.in_(slot_ids))
                        .order_by(
                            ModelCallDraftRevisionRecord.model_call_draft_id,
                            ModelCallDraftRevisionRecord.revision,
                        )
                    )
                ).all()
            ) if slot_ids else []
            revision_ids = [value.id for value in model_revisions]
            model_attempts = list(
                (
                    await transaction.scalars(
                        select(ModelCallAttemptRecord)
                        .where(ModelCallAttemptRecord.model_call_draft_revision_id.in_(revision_ids))
                        .order_by(ModelCallAttemptRecord.started_at)
                    )
                ).all()
            ) if revision_ids else []
            turn_summary = await transaction.scalar(
                select(TurnSummaryRecord).where(TurnSummaryRecord.run_id == run.id)
            )
        revisions_by_slot: dict[str, list[ModelCallDraftRevisionRecord]] = {}
        for value in model_revisions:
            revisions_by_slot.setdefault(value.model_call_draft_id, []).append(value)
        attempts_by_revision: dict[str, list[ModelCallAttemptRecord]] = {}
        for value in model_attempts:
            attempts_by_revision.setdefault(value.model_call_draft_revision_id, []).append(value)
        subjects_by_id = {value.id: value for value in evaluation_subjects}
        definitions_by_id = {value.id: value for value in evaluation_definitions}
        return {
            "run_id": run.id,
            "execution_draft": None if draft is None else {
                "id": draft.draft_id,
                "revision_id": draft.id,
                "revision": draft.revision,
                "status": draft.status,
                "draft_hash": draft.draft_hash,
                "execution_brief": draft.execution_brief_text,
                "payload": draft.payload_json,
            },
            "run_spec": None if spec is None else {
                "id": spec.id,
                "status": spec.status,
                "run_spec_hash": spec.run_spec_hash,
                "compiler_version": spec.compiler_version,
                "spec": spec.spec_json,
            },
            "turn_summary": None if turn_summary is None else {
                "id": turn_summary.id,
                "topic": turn_summary.topic,
                "summary": turn_summary.summary_json,
                "project_hint": turn_summary.project_hint,
                "status": turn_summary.extraction_status,
                "summary_hash": turn_summary.summary_hash,
                "source_model_call_revision_id": turn_summary.source_model_call_revision_id,
                "created_at": _iso(turn_summary.created_at),
            },
            "policy_evaluations": [
                {
                    "id": value.id,
                    "subject_id": value.subject_id,
                    "subject_kind": subjects_by_id[value.subject_id].subject_kind,
                    "workflow_node_id": subjects_by_id[value.subject_id].node_id,
                    "decision_point_key": definitions_by_id[value.decision_point_definition_id].key,
                    "applicability_status": value.applicability_status,
                    "floor_action": value.floor_action,
                    "preference_action": value.preference_action,
                    "final_action": value.final_action,
                    "result_status": value.result_status,
                    "reason_codes": value.reason_codes_json,
                    "evaluated_at": _iso(value.evaluated_at),
                }
                for value in evaluations
            ],
            "model_calls": [
                {
                    "id": slot.id,
                    "workflow_node_id": slot.workflow_node_id,
                    "call_ordinal": slot.call_ordinal,
                    "status": slot.status,
                    "current_revision_id": slot.current_revision_id,
                    "revisions": [
                        {
                            "id": revision.id,
                            "revision": revision.revision,
                            "status": revision.status,
                            "provider_id": revision.provider_id,
                            "model": revision.model,
                            "provider_body_sha256": revision.provider_body_sha256,
                            "binding_hash": revision.binding_hash,
                            "attempts": [
                                {
                                    "id": attempt.id,
                                    "attempt_number": attempt.attempt_number,
                                    "status": attempt.status,
                                    "failure_code": attempt.failure_code,
                                    "started_at": _iso(attempt.started_at),
                                    "finished_at": _iso(attempt.finished_at),
                                }
                                for attempt in attempts_by_revision.get(revision.id, [])
                            ],
                        }
                        for revision in revisions_by_slot.get(slot.id, [])
                    ],
                }
                for slot in model_slots
            ],
            "decision_requests": [
                {
                    "id": value.id,
                    "decision_point_key": value.decision_point_key,
                    "request_hash": value.request_hash,
                    "title": value.title,
                    "reason_summary": value.reason_summary,
                    "visible_evidence": value.visible_evidence_json,
                    "consequence": value.consequence_json,
                    "status": value.status,
                    "row_version": value.row_version,
                    "created_at": _iso(value.created_at),
                }
                for value in requests
            ],
        }

    async def recent_turn_summaries(self, session_id: str, *, limit: int = 8) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(TurnSummaryRecord)
                        .where(TurnSummaryRecord.session_id == session_id)
                        .order_by(TurnSummaryRecord.created_at.desc())
                        .limit(max(1, min(limit, 20)))
                    )
                ).all()
            )
        return [
            {
                "id": value.id,
                "interaction_id": value.interaction_id,
                "run_id": value.run_id,
                "topic": value.topic,
                "summary": value.summary_json,
                "project_hint": value.project_hint,
                "status": value.extraction_status,
                "summary_hash": value.summary_hash,
                "created_at": _iso(value.created_at),
            }
            for value in values
        ]

    async def save_turn_summary(
        self,
        *,
        session_id: str,
        run_id: str,
        summary: Mapping[str, Any],
        source_model_call_revision_id: str | None,
    ) -> dict[str, Any]:
        topic = str(summary.get("topic") or "本轮对话").strip()[:240]
        summary_hash = _hash("turn-summary", "v1", summary)
        async with self.database.sessions.begin() as transaction:
            run = await transaction.get(RunRecord, run_id)
            if run is None or run.session_id != session_id:
                raise GovernanceValidationError("Turn Summary关联的Run不存在")
            existing = await transaction.scalar(
                select(TurnSummaryRecord).where(TurnSummaryRecord.interaction_id == run.interaction_id)
            )
            if existing is not None:
                if existing.summary_hash != summary_hash:
                    raise GovernanceConflict("该Interaction已经形成不同的主题提取结果")
                value = existing
            else:
                value = TurnSummaryRecord(
                    id=_id(),
                    session_id=session_id,
                    interaction_id=run.interaction_id,
                    run_id=run.id,
                    topic=topic,
                    summary_json=dict(summary),
                    project_hint=str(summary.get("project_hint") or "").strip()[:240] or None,
                    extraction_status="candidate",
                    source_model_call_revision_id=source_model_call_revision_id,
                    summary_hash=summary_hash,
                )
                transaction.add(value)
        return {
            "id": value.id,
            "topic": value.topic,
            "summary": value.summary_json,
            "project_hint": value.project_hint,
            "status": value.extraction_status,
            "summary_hash": value.summary_hash,
        }
