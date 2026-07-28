"""Application service for versioned execution and human-in-the-loop governance."""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Sequence
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..model_call_review import canonical_json_bytes
from ..observability.context import bind_context
from ..product_sessions.database import (
    ProductDatabase,
    RunAttemptRecord,
    RunRecord,
    utc_now,
)
from .catalog import (
    COMPILER_VERSION,
    DECISION_POINTS,
    EXECUTION_DRAFT_KEYS,
    EXECUTION_DRAFT_SCHEMA_VERSION,
    FINAL_ACTIONS,
    GRANT_KIND_BY_POINT,
    POLICY_MODES,
    PRODUCT_DEFAULT_RULES,
    RESOLVER_VERSION,
    RUN_SPEC_KEYS,
    RUN_SPEC_SCHEMA_VERSION,
    SCOPE_RANK,
    SYSTEM_FLOOR_RULES,
)
from .errors import GovernanceConflict, GovernanceValidationError
from .model_call_audit import ModelCallAuditService
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
    MafWorkflowCheckpointRecord,
    ModelCallAttemptRecord,
    ModelCallDraftRecord,
    ModelCallDraftRevisionRecord,
    PolicyEvaluationRecord,
    RunSpecRecord,
    RuntimeInterruptLinkRecord,
    ToolCallRequestRecord,
    TurnSummaryRecord,
)
from .policy import (
    condition_specificity as _condition_specificity,
)
from .policy import (
    evaluate_condition as _eval_condition,
)
from .policy import strictest as _strictest
from .policy import valid_condition_shape as _valid_condition_shape
from .queries import RunGovernanceQueryService
from .turn_digest import normalize_turn_digest

logger = logging.getLogger(__name__)


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
    return hashlib.sha256(f"{kind}:{schema_version}\0".encode("utf-8") + _canonical(value)).hexdigest()


def run_spec_content_hash(spec_json: Mapping[str, Any]) -> str:
    """Authoritative hash of an immutable RunSpec payload (D).

    Shared by ``compile_run_spec`` and the result pipeline so a tampered or
    drifting ``spec_json`` can never pass the pipeline's integrity check.
    """

    return _hash("run-spec", RUN_SPEC_SCHEMA_VERSION, dict(spec_json))


def decision_subject_content_hash(subject_content: Mapping[str, Any]) -> str:
    """Authoritative content hash of a DecisionSubject's immutable content.

    Shared by ``register_subject`` and the Evidence decision-binding
    validator so a tampered ``decision_view_json`` is detected by
    recomputation instead of trusted blindly (第四轮复审P0-3)。
    """

    return _hash("decision-subject", "v1", dict(subject_content))


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _validate_payload(
    value: Mapping[str, Any], required: Sequence[str], schema_version: str
) -> dict[str, Any]:
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
        self.run_queries = RunGovernanceQueryService(database)
        self.model_call_audit = ModelCallAuditService(database)

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
                    if policy_set.active_revision_id
                    else None
                )
                if current is not None and current.policy_hash == policy_hash:
                    return
                next_revision = (
                    int(
                        await transaction.scalar(
                            select(func.max(HitlPolicyRevisionRecord.revision)).where(
                                HitlPolicyRevisionRecord.policy_set_id == policy_set.id
                            )
                        )
                        or 0
                    )
                    + 1
                )
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

    def workflow_decision_point_keys(self, workflow_id: str) -> list[str]:
        """Return decision point keys that are actually used by the given workflow.

        The mapping is derived from the workflow's approval nodes whose IDs
        match a governance decision point key. Workflows without explicit
        approval nodes return an empty list.
        """
        from ..workflows.catalog import (
            CHAT_MODEL_CALL_APPROVAL_WORKFLOW,
            CONTINUOUS_COLLABORATION_WORKFLOW,
            GOVERNED_AGENT_HANDOFF_WORKFLOW,
            GOVERNED_IDIOM_CHAIN_WORKFLOW,
            GOVERNED_PI_AGENT_WORKFLOW,
            NESTED_QUALITY_WORKFLOW,
        )

        workflow_map = {
            CHAT_MODEL_CALL_APPROVAL_WORKFLOW.id: CHAT_MODEL_CALL_APPROVAL_WORKFLOW,
            CONTINUOUS_COLLABORATION_WORKFLOW.id: CONTINUOUS_COLLABORATION_WORKFLOW,
            GOVERNED_AGENT_HANDOFF_WORKFLOW.id: GOVERNED_AGENT_HANDOFF_WORKFLOW,
            GOVERNED_IDIOM_CHAIN_WORKFLOW.id: GOVERNED_IDIOM_CHAIN_WORKFLOW,
            GOVERNED_PI_AGENT_WORKFLOW.id: GOVERNED_PI_AGENT_WORKFLOW,
            NESTED_QUALITY_WORKFLOW.id: NESTED_QUALITY_WORKFLOW,
        }
        workflow = workflow_map.get(workflow_id)
        if workflow is None:
            return []
        known_keys = {seed.key for seed in DECISION_POINTS}
        approval_node_ids = {node.id for node in workflow.nodes if node.kind == "approval"}
        return sorted(approval_node_ids & known_keys)

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
            revisions = (
                list(
                    (
                        await transaction.scalars(
                            select(HitlPolicyRevisionRecord).where(
                                HitlPolicyRevisionRecord.id.in_(revision_ids)
                            )
                        )
                    ).all()
                )
                if revision_ids
                else []
            )
            rules = (
                list(
                    (
                        await transaction.scalars(
                            select(HitlPolicyRuleRecord).where(
                                HitlPolicyRuleRecord.policy_revision_id.in_(revision_ids)
                            )
                        )
                    ).all()
                )
                if revision_ids
                else []
            )
        revisions_by_id = {value.id: value for value in revisions}
        rules_by_revision: dict[str, list[HitlPolicyRuleRecord]] = {}
        for rule in rules:
            rules_by_revision.setdefault(rule.policy_revision_id, []).append(rule)
        return [
            self._policy_set_view(
                value, revisions_by_id.get(value.active_revision_id or ""), rules_by_revision
            )
            for value in sets
        ]

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
            "active_revision": None
            if revision is None
            else {
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
                next_revision = (
                    int(
                        await transaction.scalar(
                            select(func.max(HitlPolicyRevisionRecord.revision)).where(
                                HitlPolicyRevisionRecord.policy_set_id == policy_set.id
                            )
                        )
                        or 0
                    )
                    + 1
                )
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
        logger.info(
            "hitl_policy_activated scope_kind=%s scope_ref_id=%s "
            "policy_set_id=%s revision_id=%s revision=%d rule_count=%d",
            scope_kind,
            scope_ref_id,
            policy_set.id,
            revision.id,
            revision.revision,
            len(normalized),
        )
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
            normalized.append(
                {
                    "decision_point_key": key,
                    "mode": mode,
                    "condition": condition,
                    "on_match": on_match,
                    "constraints": dict(value.get("constraints") or {}),
                    "reason": str(value.get("reason") or ""),
                }
            )
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
            rules = (
                list(
                    (
                        await transaction.scalars(
                            select(HitlPolicyRuleRecord).where(
                                HitlPolicyRuleRecord.policy_revision_id.in_(revision_ids),
                                HitlPolicyRuleRecord.decision_point_key == decision_point_key,
                            )
                        )
                    ).all()
                )
                if revision_ids
                else []
            )
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
        floors = [
            value
            for value in candidates
            if value[0].authority in {"system_safety", "identity_scope", "capability"}
        ]
        preferences = [
            value for value in candidates if value[0].authority in {"product_default", "user_preference"}
        ]
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
        candidates: Sequence[tuple[HitlPolicySetRecord, HitlPolicyRuleRecord, str, bool]],
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
            {
                "policy_set_id": value["id"],
                "revision_id": value["active_revision"]["id"],
                "policy_hash": value["active_revision"]["policy_hash"],
            }
            for value in active
            if value["active_revision"] is not None
        ]
        preference = {key: value["preference_action"] for key, value in results.items()}
        floors = {key: value["floor_action"] for key, value in results.items()}
        content = {"principal_id": owner, "refs": refs, "preference": preference, "floors": floors}
        snapshot_hash = _hash("hitl-policy-snapshot", "v1", content)
        async with self.database.sessions.begin() as transaction:
            existing = await transaction.scalar(
                select(HitlPolicySnapshotRecord).where(
                    HitlPolicySnapshotRecord.snapshot_hash == snapshot_hash
                )
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
        subject_hash = decision_subject_content_hash(subject_content)
        async with self.database.sessions.begin() as transaction:
            # 第六轮复审P0-2.1：先按逻辑身份定位，再决定复用或冲突——同资源
            # revision但内容/归属/view任何一项不一致都必须冲突，不能新建第二
            # 个Subject让旧批准漂移授权。
            candidates = list(
                (
                    await transaction.scalars(
                        select(DecisionSubjectRecord).where(
                            DecisionSubjectRecord.subject_kind == subject_kind,
                            DecisionSubjectRecord.resource_id == resource_id,
                            DecisionSubjectRecord.resource_revision == resource_revision,
                        )
                    )
                ).all()
            )
            for existing in candidates:
                if (
                    existing.subject_hash != subject_hash
                    or existing.session_id != session_id
                    or existing.interaction_id != interaction_id
                    or existing.run_id != run_id
                    or existing.run_attempt_id != run_attempt_id
                    or existing.workflow_definition_id != workflow_definition_id
                    or existing.workflow_version != workflow_version
                    or existing.node_id != node_id
                    or existing.decision_view_json != dict(decision_view)
                ):
                    raise GovernanceConflict("相同Subject身份的内容或运行归属不一致，拒绝复用")
            if candidates:
                return candidates[0]
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
            try:
                await transaction.flush()
            except IntegrityError as error:
                # 只翻译逻辑身份唯一冲突；FK/主键等其他约束错误原样抛出，
                # 不能被误报成“同Subject并发”（第八轮复审）。
                message = str(getattr(error, "orig", error))
                identity_markers = (
                    "decision_subjects.subject_kind, decision_subjects.resource_id, "
                    "decision_subjects.resource_revision",
                    "uq_decision_subjects_identity",
                )
                if not any(marker in message for marker in identity_markers):
                    raise
                raise GovernanceConflict("相同Subject并发注册冲突，请重读当前Subject后重试") from error
        return value

    async def register_tool_call(
        self,
        *,
        run_id: str,
        workflow_node_id: str,
        provider_tool_call_id: str,
        tool_id: str,
        tool_definition_revision: str,
        arguments: Mapping[str, Any],
        target_summary: str,
        risk_snapshot: Mapping[str, Any],
        workflow_definition_id: str,
        workflow_version: str,
    ) -> tuple[ToolCallRequestRecord, DecisionSubjectRecord]:
        """Persist one immutable pi internal Tool request and its decision subject."""

        argument_values = dict(arguments)
        arguments_hash = _hash("tool-arguments", "v1", argument_values)
        subject_content = {
            "run_id": run_id,
            "provider_tool_call_id": provider_tool_call_id,
            "tool_id": tool_id,
            "tool_definition_revision": tool_definition_revision,
            "arguments_hash": arguments_hash,
            "risk_snapshot": dict(risk_snapshot),
        }
        subject_hash = decision_subject_content_hash(subject_content)
        async with self.database.sessions.begin() as transaction:
            existing = await transaction.scalar(
                select(ToolCallRequestRecord).where(
                    ToolCallRequestRecord.run_id == run_id,
                    ToolCallRequestRecord.provider_tool_call_id == provider_tool_call_id,
                )
            )
            if existing is not None:
                if existing.arguments_hash != arguments_hash or existing.tool_id != tool_id:
                    raise GovernanceConflict("相同Tool Call ID不能替换参数或Tool")
                subject = await transaction.get(DecisionSubjectRecord, existing.subject_id)
                if subject is None:
                    raise GovernanceConflict("Tool Call Decision Subject引用损坏")
                return existing, subject
            run = await transaction.get(RunRecord, run_id)
            attempt = await transaction.scalar(
                select(RunAttemptRecord)
                .where(RunAttemptRecord.run_id == run_id)
                .order_by(RunAttemptRecord.attempt_number.desc())
                .limit(1)
            )
            if run is None or attempt is None:
                raise GovernanceValidationError("Tool Call关联的Run Attempt不存在")
            request_id = _id()
            subject = DecisionSubjectRecord(
                id=_id(),
                subject_kind="tool_call_request",
                resource_id=request_id,
                resource_revision=tool_definition_revision,
                subject_hash=subject_hash,
                session_id=run.session_id,
                interaction_id=run.interaction_id,
                run_id=run.id,
                run_attempt_id=attempt.id,
                workflow_definition_id=workflow_definition_id,
                workflow_version=workflow_version,
                node_id=workflow_node_id,
                decision_view_json={
                    "tool_id": tool_id,
                    "arguments": argument_values,
                    "target_summary": target_summary,
                    "risk": dict(risk_snapshot),
                },
            )
            request = ToolCallRequestRecord(
                id=request_id,
                run_id=run.id,
                run_attempt_id=attempt.id,
                workflow_node_id=workflow_node_id,
                provider_tool_call_id=provider_tool_call_id,
                tool_id=tool_id,
                tool_definition_revision=tool_definition_revision,
                arguments_json=argument_values,
                arguments_hash=arguments_hash,
                target_summary=target_summary,
                risk_snapshot_json=dict(risk_snapshot),
                subject_id=subject.id,
                status="pending",
            )
            transaction.add(subject)
            await transaction.flush()
            transaction.add(request)
        return request, subject

    async def mark_tool_call_authorized(
        self,
        *,
        tool_call_request_id: str,
        authorization_consumption_id: str,
    ) -> None:
        """Bind authorization consumption before the custom tool is allowed to run."""

        async with self.database.sessions.begin() as transaction:
            request = await transaction.get(ToolCallRequestRecord, tool_call_request_id)
            consumption = await transaction.get(
                AuthorizationConsumptionRecord,
                authorization_consumption_id,
            )
            if request is None or consumption is None:
                raise GovernanceValidationError("Tool Call或授权消费不存在")
            if request.status not in {"pending", "authorized"}:
                raise GovernanceConflict("Tool Call当前状态不能授权")
            request.status = "authorized"

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
            # 第四轮复审P1-4：同一不可变Subject在同一决策点的评估可重入复用；
            # 崩溃在治理写入与MAF checkpoint之间不会产生重复Evaluation。第五轮
            # 复审：复用前必须证明facts/snapshot完全一致，策略或事实漂移冲突。
            existing = await transaction.scalar(
                select(PolicyEvaluationRecord).where(
                    PolicyEvaluationRecord.subject_id == subject.id,
                    PolicyEvaluationRecord.decision_point_definition_id == definition.id,
                )
            )
            if existing is not None:
                # 第六轮复审P0-2.2：复用前必须证明持久化的评估输入与结果
                # 完全一致；策略scope漂移或规则引用漂移（即使final_action
                # 相同）都必须冲突，不能把旧Evaluation配给新preview。
                if (
                    existing.facts_hash != _hash("policy-facts", "v1", facts)
                    or existing.policy_snapshot_id != policy_snapshot_id
                    or existing.principal_id != self.principal_id
                    or existing.applicability_status != "applicable"
                    or list(existing.matched_rule_refs_json or []) != list(preview["matched_rules"])
                    or existing.floor_action != preview["floor_action"]
                    or existing.preference_action != preview["preference_action"]
                    or existing.final_action != preview["final_action"]
                    or existing.result_status != preview["result_status"]
                    or list(existing.reason_codes_json or []) != list(preview["reason_codes"])
                    or existing.resolver_version != RESOLVER_VERSION
                ):
                    raise GovernanceConflict("同一Subject的策略评估输入不一致，拒绝复用旧Evaluation")
                return existing, preview
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
        input_content = {
            "evaluation_id": evaluation.id,
            "subject_hash": subject.subject_hash,
            "decision_code": decision_code,
        }
        input_hash = _hash("decision-input", "v1", input_content)
        record_hash = _hash("decision-record", "v1", input_content | {"source": source, "effect": effect})
        if evaluation.subject_id != subject.id:
            raise GovernanceConflict("Evaluation不属于该Subject，不能记录自动决定")
        async with self.database.sessions.begin() as transaction:
            # 第四轮复审P1-4：同一不可变Subject的同一自动决定可重入复用，
            # 崩溃重进不会生成第二份Decision/Grant。
            existing = await transaction.scalar(
                select(DecisionRecord).where(
                    DecisionRecord.subject_id == subject.id,
                    DecisionRecord.decision_code == decision_code,
                )
            )
            if existing is not None:
                # 第五/六轮复审：完全相同输入才复用；evaluation/input/source/
                # effect/bound hash/rule refs/record hash任一不一致必须冲突；
                # Grant必须逐字段一致，grant_kind=None时也不默许异常旧Grant。
                grants = list(
                    (
                        await transaction.scalars(
                            select(AuthorizationGrantRecord).where(
                                AuthorizationGrantRecord.decision_record_id == existing.id
                            )
                        )
                    ).all()
                )
                if (
                    existing.policy_evaluation_id != evaluation.id
                    or existing.input_hash != input_hash
                    or existing.record_hash != record_hash
                    or existing.source != source
                    or existing.authorization_effect != effect
                    or existing.bound_subject_hash != subject.subject_hash
                    or list(existing.policy_rule_refs_json or [])
                    != list(evaluation.matched_rule_refs_json or [])
                ):
                    raise GovernanceConflict("同一Subject的自动决定输入不一致，拒绝复用旧Decision")
                grant: AuthorizationGrantRecord | None = None
                if grant_kind is not None:
                    expected_constraints = dict(constraints or {})
                    for candidate in grants:
                        if (
                            candidate.subject_id == subject.id
                            and candidate.grant_kind == grant_kind
                            and candidate.binding_hash == binding_hash
                            and dict(candidate.constraints_json or {}) == expected_constraints
                            and candidate.max_consumptions == 1
                        ):
                            grant = candidate
                            break
                    if grant is None:
                        raise GovernanceConflict("同一Subject的授权Grant输入不一致，拒绝复用旧Decision")
                elif grants:
                    raise GovernanceConflict("无需Grant的自动决定存在遗留Grant，拒绝复用")
                return existing, grant
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
            # 第四轮复审P1-4：同一Run/决策点/不可变Subject的待决请求可重入
            # 复用；崩溃在治理写入与MAF checkpoint之间不会产生重复审批卡。
            existing = await transaction.scalar(
                select(HumanDecisionRequestRecord)
                .join(
                    HumanDecisionRequestItemRecord,
                    HumanDecisionRequestItemRecord.request_id == HumanDecisionRequestRecord.id,
                )
                .where(
                    HumanDecisionRequestRecord.run_id == subject.run_id,
                    HumanDecisionRequestRecord.decision_point_key == decision_point,
                    HumanDecisionRequestRecord.status == "pending",
                    HumanDecisionRequestItemRecord.subject_id == subject.id,
                )
            )
            if existing is not None:
                existing_item = await transaction.scalar(
                    select(HumanDecisionRequestItemRecord).where(
                        HumanDecisionRequestItemRecord.request_id == existing.id
                    )
                )
                if (
                    existing_item is None
                    or existing_item.policy_evaluation_id != evaluation.id
                    or existing.request_hash != request.request_hash
                    or existing_item.allowed_actions_json != list(allowed_actions)
                    or existing.title != title
                    or existing.reason_summary != reason
                    or existing.visible_evidence_json != dict(evidence)
                    or existing.consequence_json != dict(consequence)
                ):
                    raise GovernanceConflict("同一Subject的待决请求内容不一致，拒绝复用")
                return existing
            transaction.add(request)
            await transaction.flush()
            transaction.add(item)
        return request

    async def human_decision_requests(
        self,
        *,
        session_id: str | None = None,
        status: str = "pending",
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Return a recoverable, public projection of durable HITL requests."""

        query = select(HumanDecisionRequestRecord).where(
            HumanDecisionRequestRecord.principal_id == self.principal_id,
            HumanDecisionRequestRecord.status == status,
        )
        if session_id is not None:
            query = query.where(HumanDecisionRequestRecord.session_id == session_id)
        query = query.order_by(HumanDecisionRequestRecord.created_at.desc()).limit(min(max(limit, 1), 300))
        async with self.database.sessions() as transaction:
            requests = (await transaction.scalars(query)).all()
            result: list[dict[str, Any]] = []
            for request in requests:
                items = (
                    await transaction.scalars(
                        select(HumanDecisionRequestItemRecord)
                        .where(HumanDecisionRequestItemRecord.request_id == request.id)
                        .order_by(HumanDecisionRequestItemRecord.ordinal)
                    )
                ).all()
                item_views: list[dict[str, Any]] = []
                for item in items:
                    subject = await transaction.get(DecisionSubjectRecord, item.subject_id)
                    item_views.append(
                        {
                            "item_key": item.item_key,
                            "status": item.status,
                            "allowed_actions": list(item.allowed_actions_json or []),
                            "subject": None
                            if subject is None
                            else {
                                "id": subject.id,
                                "kind": subject.subject_kind,
                                "resource_id": subject.resource_id,
                                "resource_revision": subject.resource_revision,
                                "subject_hash": subject.subject_hash,
                                "workflow_definition_id": subject.workflow_definition_id,
                                "workflow_version": subject.workflow_version,
                                "node_id": subject.node_id,
                                "decision_view": dict(subject.decision_view_json or {}),
                            },
                        }
                    )
                runtime_link = await transaction.scalar(
                    select(RuntimeInterruptLinkRecord).where(
                        RuntimeInterruptLinkRecord.decision_request_id == request.id
                    )
                )
                result.append(
                    {
                        "id": request.id,
                        "decision_point_key": request.decision_point_key,
                        "session_id": request.session_id,
                        "interaction_id": request.interaction_id,
                        "run_id": request.run_id,
                        "request_hash": request.request_hash,
                        "title": request.title,
                        "reason_summary": request.reason_summary,
                        "visible_evidence": dict(request.visible_evidence_json or {}),
                        "consequence": dict(request.consequence_json or {}),
                        "status": request.status,
                        "row_version": request.row_version,
                        "created_at": _iso(request.created_at),
                        "expires_at": _iso(request.expires_at),
                        "runtime_recovery": None
                        if runtime_link is None
                        else {
                            "link_id": runtime_link.id,
                            "status": runtime_link.status,
                            "checkpoint_id": runtime_link.maf_checkpoint_id,
                            "workflow_name": runtime_link.maf_workflow_name,
                            "executor_id": runtime_link.maf_executor_id,
                            "graph_signature_hash": runtime_link.maf_graph_signature_hash,
                        },
                        "items": item_views,
                    }
                )
        return result

    async def resolve_human_request(
        self,
        *,
        request_id: str,
        expected_request_hash: str,
        expected_row_version: int,
        decisions: Sequence[Mapping[str, str]],
        response_payload: Mapping[str, Any] | None = None,
        resume_via_outbox: bool = False,
    ) -> list[dict[str, Any]]:
        async with self.database.sessions.begin() as transaction:
            request = await transaction.get(HumanDecisionRequestRecord, request_id)
            if request is None:
                raise GovernanceValidationError("人工决定请求不存在")
            if (
                request.status != "pending"
                or request.request_hash != expected_request_hash
                or request.row_version != expected_row_version
            ):
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
                input_content = {
                    "request_id": request.id,
                    "item_key": item.item_key,
                    "decision": decision,
                    "subject_hash": subject.subject_hash,
                }
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
                result.append(
                    {
                        "item_key": item.item_key,
                        "decision": decision,
                        "decision_record_id": record.id,
                        "authorization_grant_id": grant.id if grant else None,
                        "binding_hash": subject.subject_hash,
                    }
                )
            request.status = "resolved"
            request.row_version += 1
            request.resolved_at = utc_now()
            transaction.add(
                GovernanceOutboxRecord(
                    id=_id(),
                    aggregate_kind="human_decision_request",
                    aggregate_id=request.id,
                    event_type="runtime.resume_requested",
                    payload_json={
                        "decision_request_id": request.id,
                        "decisions": result,
                        "response_payload": dict(response_payload or {}),
                        "dispatch_required": resume_via_outbox,
                    },
                    dedupe_key=f"runtime.resume_requested:{request.id}:{request.row_version}",
                )
            )
        logger.info(
            "human_decision_recorded request_id=%s item_count=%d resume_via_outbox=%s",
            request_id,
            len(result),
            resume_via_outbox,
        )
        return result

    async def close_open_decisions_for_terminal_run(
        self,
        *,
        run_id: str,
        reason_code: str,
    ) -> dict[str, int]:
        """Close recoverable governance state after one Product Run is terminal.

        Product cancellation and terminal failure revoke the authority to
        resume a MAF checkpoint or consume a still-active grant. Immutable
        decisions remain audit evidence; only pending requests, active grants,
        resumable links/checkpoints and unpublished resume commands are
        settled here.
        """

        now = utc_now()
        cancelled = reason_code.startswith("user_cancelled")
        request_terminal_status = "cancelled" if cancelled else "superseded"
        link_terminal_status = "cancelled" if cancelled else "failed"
        counts = {
            "requests": 0,
            "items": 0,
            "grants": 0,
            "interrupts": 0,
            "checkpoints": 0,
            "outbox_events": 0,
            "model_calls": 0,
            "tool_calls": 0,
        }
        async with self.database.sessions.begin() as transaction:
            run = await transaction.get(RunRecord, run_id)
            if run is None:
                raise GovernanceValidationError("Product Run不存在")
            if run.finished_at is None:
                raise GovernanceConflict("活动Product Run不能关闭治理状态")

            requests = list(
                (
                    await transaction.scalars(
                        select(HumanDecisionRequestRecord).where(HumanDecisionRequestRecord.run_id == run_id)
                    )
                ).all()
            )
            request_ids = [value.id for value in requests]
            for request in requests:
                if request.status == "pending":
                    request.status = request_terminal_status
                    request.row_version += 1
                    request.resolved_at = now
                    counts["requests"] += 1

            if request_ids:
                items = list(
                    (
                        await transaction.scalars(
                            select(HumanDecisionRequestItemRecord).where(
                                HumanDecisionRequestItemRecord.request_id.in_(request_ids),
                                HumanDecisionRequestItemRecord.status == "pending",
                            )
                        )
                    ).all()
                )
                for item in items:
                    item.status = request_terminal_status
                counts["items"] = len(items)

                links = list(
                    (
                        await transaction.scalars(
                            select(RuntimeInterruptLinkRecord).where(
                                RuntimeInterruptLinkRecord.decision_request_id.in_(request_ids),
                                RuntimeInterruptLinkRecord.status.in_(
                                    {
                                        "pending",
                                        "decision_recorded",
                                        "resuming",
                                        "recovery_required",
                                    }
                                ),
                            )
                        )
                    ).all()
                )
                for link in links:
                    link.status = link_terminal_status
                    link.last_error_code = reason_code
                    link.updated_at = now
                    checkpoint = await transaction.get(
                        MafWorkflowCheckpointRecord,
                        link.maf_checkpoint_id,
                    )
                    if checkpoint is not None and checkpoint.status in {
                        "linked",
                        "resuming",
                        "incompatible",
                    }:
                        checkpoint.status = link_terminal_status
                        counts["checkpoints"] += 1
                counts["interrupts"] = len(links)

                outbox_events = list(
                    (
                        await transaction.scalars(
                            select(GovernanceOutboxRecord).where(
                                GovernanceOutboxRecord.aggregate_kind == "human_decision_request",
                                GovernanceOutboxRecord.aggregate_id.in_(request_ids),
                                GovernanceOutboxRecord.event_type == "runtime.resume_requested",
                                GovernanceOutboxRecord.status.in_({"pending", "processing"}),
                            )
                        )
                    ).all()
                )
                for event in outbox_events:
                    event.status = "cancelled"
                    event.locked_by = None
                    event.locked_until = None
                    event.last_error_code = reason_code
                counts["outbox_events"] = len(outbox_events)

            model_slots = list(
                (
                    await transaction.scalars(
                        select(ModelCallDraftRecord).where(
                            ModelCallDraftRecord.run_id == run_id,
                            ModelCallDraftRecord.status.in_({"building", "reviewable"}),
                        )
                    )
                ).all()
            )
            for slot in model_slots:
                slot.status = "invalidated"
                slot.row_version += 1
                if slot.current_revision_id:
                    revision = await transaction.get(
                        ModelCallDraftRevisionRecord,
                        slot.current_revision_id,
                    )
                    if revision is not None and revision.status == "reviewable":
                        revision.status = "invalidated"
            counts["model_calls"] = len(model_slots)

            tool_calls = list(
                (
                    await transaction.scalars(
                        select(ToolCallRequestRecord).where(
                            ToolCallRequestRecord.run_id == run_id,
                            ToolCallRequestRecord.status.in_({"pending", "authorized"}),
                        )
                    )
                ).all()
            )
            for tool_call in tool_calls:
                tool_call.status = request_terminal_status
            counts["tool_calls"] = len(tool_calls)

            subject_ids = list(
                (
                    await transaction.scalars(
                        select(DecisionSubjectRecord.id).where(DecisionSubjectRecord.run_id == run_id)
                    )
                ).all()
            )
            if subject_ids:
                grants = list(
                    (
                        await transaction.scalars(
                            select(AuthorizationGrantRecord).where(
                                AuthorizationGrantRecord.subject_id.in_(subject_ids),
                                AuthorizationGrantRecord.status == "active",
                            )
                        )
                    ).all()
                )
                for grant in grants:
                    grant.status = "invalidated"
                    grant.invalidated_at = now
                    grant.invalidation_reason = reason_code
                    grant.row_version += 1
                counts["grants"] = len(grants)

        if any(counts.values()):
            logger.info(
                "terminal_run_governance_closed run_id=%s reason_code=%s "
                "requests=%d items=%d grants=%d interrupts=%d checkpoints=%d "
                "outbox_events=%d model_calls=%d tool_calls=%d",
                run_id,
                reason_code,
                counts["requests"],
                counts["items"],
                counts["grants"],
                counts["interrupts"],
                counts["checkpoints"],
                counts["outbox_events"],
                counts["model_calls"],
                counts["tool_calls"],
            )
        return counts

    async def reconcile_terminal_run_decisions(self) -> int:
        """Close stale pending decisions whose Product Run already finished."""

        async with self.database.sessions() as transaction:
            rows = list(
                (
                    await transaction.execute(
                        select(
                            HumanDecisionRequestRecord.run_id,
                            RunRecord.failure_code,
                        )
                        .join(
                            RunRecord,
                            RunRecord.id == HumanDecisionRequestRecord.run_id,
                        )
                        .where(
                            HumanDecisionRequestRecord.status == "pending",
                            HumanDecisionRequestRecord.run_id.is_not(None),
                            RunRecord.finished_at.is_not(None),
                        )
                        .distinct()
                    )
                ).all()
            )
        for run_id, failure_code in rows:
            if run_id is None:
                continue
            await self.close_open_decisions_for_terminal_run(
                run_id=run_id,
                reason_code=str(failure_code or "product_run_terminal"),
            )
        return len(rows)

    async def bind_runtime_interrupt(
        self,
        *,
        decision_request_id: str,
        product_run_id: str,
        maf_workflow_name: str,
        maf_graph_signature_hash: str,
        maf_checkpoint_id: str,
        maf_request_id: str,
        maf_executor_id: str,
        agui_thread_id: str,
        agui_run_id: str,
        agui_interrupt_id: str | None,
    ) -> RuntimeInterruptLinkRecord:
        """Bind one durable Product decision request to its MAF safe point.

        This command is idempotent for the exact same mapping and rejects a
        request/checkpoint that has already been associated with another run.
        """

        async with self.database.sessions.begin() as transaction:
            request = await transaction.get(HumanDecisionRequestRecord, decision_request_id)
            checkpoint = await transaction.get(MafWorkflowCheckpointRecord, maf_checkpoint_id)
            run = await transaction.get(RunRecord, product_run_id)
            if request is None or checkpoint is None or run is None:
                raise GovernanceValidationError("Interrupt Link引用的请求、Checkpoint或Product Run不存在")
            if request.run_id != run.id or checkpoint.product_run_id != run.id:
                raise GovernanceConflict("Interrupt Request、Checkpoint和Product Run不属于同一运行")
            if checkpoint.workflow_name != maf_workflow_name:
                raise GovernanceConflict("Checkpoint Workflow名称不匹配")
            if checkpoint.graph_signature_hash != maf_graph_signature_hash:
                raise GovernanceConflict("Checkpoint图签名不匹配")
            if maf_request_id not in set(checkpoint.pending_request_ids_json or ()):
                raise GovernanceConflict("Checkpoint不包含待恢复的MAF request id")
            existing = await transaction.scalar(
                select(RuntimeInterruptLinkRecord).where(
                    RuntimeInterruptLinkRecord.decision_request_id == decision_request_id
                )
            )
            if existing is not None:
                if (
                    existing.product_run_id != run.id
                    or existing.maf_checkpoint_id != checkpoint.checkpoint_id
                    or existing.maf_request_id != maf_request_id
                ):
                    raise GovernanceConflict("Decision Request已经绑定其他Runtime Interrupt")
                return existing
            value = RuntimeInterruptLinkRecord(
                id=_id(),
                decision_request_id=request.id,
                product_run_id=run.id,
                run_attempt_id=checkpoint.run_attempt_id,
                maf_workflow_name=maf_workflow_name,
                maf_graph_signature_hash=maf_graph_signature_hash,
                maf_checkpoint_id=checkpoint.checkpoint_id,
                maf_request_id=maf_request_id,
                maf_executor_id=maf_executor_id,
                agui_thread_id=agui_thread_id,
                agui_run_id=agui_run_id,
                agui_interrupt_id=agui_interrupt_id,
                status="pending",
            )
            transaction.add(value)
            checkpoint.status = "linked"
        logger.info(
            "runtime_interrupt_bound request_id=%s run_id=%s checkpoint_id=%s maf_request_id=%s",
            decision_request_id,
            product_run_id,
            maf_checkpoint_id,
            maf_request_id,
        )
        return value

    async def runtime_interrupt_for_request(
        self,
        *,
        decision_request_id: str,
        product_run_id: str | None = None,
    ) -> RuntimeInterruptLinkRecord:
        async with self.database.sessions() as transaction:
            value = await transaction.scalar(
                select(RuntimeInterruptLinkRecord).where(
                    RuntimeInterruptLinkRecord.decision_request_id == decision_request_id
                )
            )
        if value is None:
            raise GovernanceValidationError("Decision Request没有可恢复的Runtime Interrupt")
        if product_run_id is not None and value.product_run_id != product_run_id:
            raise GovernanceConflict("Runtime Interrupt不属于当前Product Run")
        return value

    async def runtime_interrupt_for_maf_request(
        self,
        *,
        maf_request_id: str,
        product_run_id: str,
    ) -> RuntimeInterruptLinkRecord:
        async with self.database.sessions() as transaction:
            value = await transaction.scalar(
                select(RuntimeInterruptLinkRecord).where(
                    RuntimeInterruptLinkRecord.maf_request_id == maf_request_id,
                    RuntimeInterruptLinkRecord.product_run_id == product_run_id,
                )
            )
        if value is None:
            raise GovernanceValidationError("MAF request没有可恢复的Runtime Interrupt")
        return value

    async def mark_runtime_interrupt(
        self,
        *,
        link_id: str,
        status: str,
        error_code: str | None = None,
    ) -> None:
        allowed = {
            "pending",
            "decision_recorded",
            "resuming",
            "resumed",
            "cancelled",
            "recovery_required",
            "failed",
        }
        if status not in allowed:
            raise GovernanceValidationError(f"未知Runtime Interrupt状态: {status}")
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(RuntimeInterruptLinkRecord, link_id)
            if value is None:
                raise GovernanceValidationError("Runtime Interrupt Link不存在")
            value.status = status
            value.last_error_code = error_code
            value.updated_at = utc_now()
            if status == "resuming":
                value.resume_attempts += 1
            if status == "resumed":
                value.last_projected_at = utc_now()
            checkpoint = await transaction.get(MafWorkflowCheckpointRecord, value.maf_checkpoint_id)
            if checkpoint is not None:
                checkpoint.status = {
                    "resuming": "resuming",
                    "resumed": "resumed",
                    "recovery_required": "incompatible",
                    "failed": "failed",
                }.get(status, checkpoint.status)
        logger.info(
            "runtime_interrupt_status_changed link_id=%s status=%s error_code=%s",
            link_id,
            status,
            error_code,
        )

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

    async def resolved_human_request(self, request_id: str) -> list[dict[str, Any]]:
        """Return the immutable decision/grant projection used by an Outbox resume."""

        async with self.database.sessions() as transaction:
            request = await transaction.get(HumanDecisionRequestRecord, request_id)
            if request is None:
                raise GovernanceValidationError("人工决定请求不存在")
            if request.status != "resolved":
                raise GovernanceConflict("人工决定尚未完整记录，不能恢复Runtime")
            items = list(
                (
                    await transaction.scalars(
                        select(HumanDecisionRequestItemRecord)
                        .where(HumanDecisionRequestItemRecord.request_id == request.id)
                        .order_by(HumanDecisionRequestItemRecord.ordinal)
                    )
                ).all()
            )
            result: list[dict[str, Any]] = []
            for item in items:
                if item.decision_record_id is None:
                    raise GovernanceConflict("人工决定请求存在未提交的item")
                record = await transaction.get(DecisionRecord, item.decision_record_id)
                if record is None:
                    raise GovernanceConflict("人工决定记录缺失")
                grant = await transaction.scalar(
                    select(AuthorizationGrantRecord).where(
                        AuthorizationGrantRecord.decision_record_id == record.id
                    )
                )
                result.append(
                    {
                        "item_key": item.item_key,
                        "decision": record.decision_code,
                        "decision_record_id": record.id,
                        "authorization_grant_id": grant.id if grant else None,
                        "binding_hash": record.bound_subject_hash,
                    }
                )
            return result

    async def invalidate_model_call_source(
        self,
        *,
        revision_id: str,
        request_id: str | None,
        reason_code: str,
    ) -> None:
        """Invalidate an unsent ModelCall when its adopted source became stale.

        The immutable human decision, if already recorded by an Outbox
        process, remains audit evidence.  Only the still-active authorization
        is invalidated; no ModelCall Attempt is created by this operation.
        """

        now = utc_now()
        async with self.database.sessions.begin() as transaction:
            revision = await transaction.get(ModelCallDraftRevisionRecord, revision_id)
            if revision is None:
                raise GovernanceValidationError("ModelCall revision不存在")
            revision.status = "invalidated"
            slot = await transaction.get(ModelCallDraftRecord, revision.model_call_draft_id)
            if slot is not None:
                slot.status = "invalidated"
                slot.row_version += 1
            grants = list(
                (
                    await transaction.scalars(
                        select(AuthorizationGrantRecord).where(
                            AuthorizationGrantRecord.subject_id == revision.subject_id,
                            AuthorizationGrantRecord.status == "active",
                        )
                    )
                ).all()
            )
            for grant in grants:
                grant.status = "invalidated"
                grant.invalidated_at = now
                grant.invalidation_reason = reason_code
                grant.row_version += 1
            if request_id:
                request = await transaction.get(HumanDecisionRequestRecord, request_id)
                if request is not None and request.status == "pending":
                    request.status = "superseded"
                    request.row_version += 1
                    request.resolved_at = now
                    items = list(
                        (
                            await transaction.scalars(
                                select(HumanDecisionRequestItemRecord).where(
                                    HumanDecisionRequestItemRecord.request_id == request.id,
                                    HumanDecisionRequestItemRecord.status == "pending",
                                )
                            )
                        ).all()
                    )
                    for item in items:
                        item.status = "superseded"
                link = await transaction.scalar(
                    select(RuntimeInterruptLinkRecord).where(
                        RuntimeInterruptLinkRecord.decision_request_id == request_id
                    )
                )
                if link is not None and link.status not in {"resumed", "closed"}:
                    link.status = "closed"
                    link.last_error_code = reason_code
                    link.updated_at = now
        logger.info(
            "model_call_source_invalidated revision_id=%s request_id=%s reason_code=%s active_grants=%d",
            revision_id,
            request_id,
            reason_code,
            len(grants),
        )

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
        value = _validate_payload(
            payload,
            EXECUTION_DRAFT_KEYS,
            EXECUTION_DRAFT_SCHEMA_VERSION,
        )
        context_hash = str(
            value["context_binding"].get("context_hash") or _hash("context", "v1", value["context_binding"])
        )
        draft_hash = _hash(
            "execution-draft",
            EXECUTION_DRAFT_SCHEMA_VERSION,
            value | {"execution_brief": execution_brief},
        )
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
                previous = (
                    await transaction.get(ExecutionDraftRevisionRecord, draft.current_revision_id)
                    if draft.current_revision_id
                    else None
                )
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
                schema_version=EXECUTION_DRAFT_SCHEMA_VERSION,
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
        with bind_context(
            session_id=session_id,
            product_run_id=run_id,
            workflow_id=workflow_definition_id,
        ):
            logger.info(
                "execution_draft_created draft_id=%s revision_id=%s revision=%d",
                draft.id,
                revision.id,
                revision.revision,
            )
        return draft, revision

    async def execution_draft_view(self, draft_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            draft = await transaction.get(ExecutionDraftRecord, draft_id)
            if draft is None or draft.current_revision_id is None:
                raise GovernanceValidationError("ExecutionDraft不存在")
            revision = await transaction.get(ExecutionDraftRevisionRecord, draft.current_revision_id)
            if revision is None:
                raise GovernanceConflict("ExecutionDraft当前revision引用损坏")
        return {
            "id": draft.id,
            "session_id": draft.session_id,
            "interaction_id": draft.interaction_id,
            "workflow_definition_id": draft.workflow_definition_id,
            "workflow_version": draft.workflow_version,
            "status": draft.status,
            "row_version": draft.row_version,
            "revision_id": revision.id,
            "revision": revision.revision,
            "revision_status": revision.status,
            "draft_hash": revision.draft_hash,
            "context_hash": revision.context_hash,
            "execution_brief": revision.execution_brief_text,
            "payload": dict(revision.payload_json),
        }

    async def revise_execution_draft(
        self,
        *,
        draft_id: str,
        expected_revision_id: str,
        expected_draft_hash: str,
        expected_row_version: int,
        payload: Mapping[str, Any],
        execution_brief: str,
        author_id: str,
    ) -> dict[str, Any]:
        value = _validate_payload(
            payload,
            EXECUTION_DRAFT_KEYS,
            EXECUTION_DRAFT_SCHEMA_VERSION,
        )
        brief = execution_brief.strip()
        if not brief:
            raise GovernanceValidationError("ExecutionDraft执行摘要不能为空")
        async with self.database.sessions.begin() as transaction:
            draft = await transaction.get(ExecutionDraftRecord, draft_id)
            if draft is None or draft.current_revision_id is None:
                raise GovernanceValidationError("ExecutionDraft不存在")
            current = await transaction.get(ExecutionDraftRevisionRecord, draft.current_revision_id)
            if current is None:
                raise GovernanceConflict("ExecutionDraft当前revision引用损坏")
            # E/第四轮复审P0-2：validation_plan.contract是机器冻结合同（Plan
            # revision + Capability编译+argv/hash绑定），其权威还派生自本轮
            # Context/Project/Repository Fence绑定。规则：
            # 1) 区分key存在性：absent与null不同，增删contract键必须拒绝；
            # 2) contract非null时，context_binding/project_work_binding/
            #    runtime_target必须逐字节一致——任何会改变subject、project、
            #    repository fence或运行模式的修订都必须回Context/Plan重新生成Draft。
            raw_incoming_plan = value.get("validation_plan")
            raw_current_plan = dict(current.payload_json).get("validation_plan")
            if raw_incoming_plan is not None and not isinstance(raw_incoming_plan, Mapping):
                raise GovernanceValidationError("validation_plan必须是对象或null")
            if raw_current_plan is not None and not isinstance(raw_current_plan, Mapping):
                raise GovernanceConflict("既有Draft的validation_plan结构损坏")
            current_plan = dict(raw_current_plan or {})
            incoming_plan = dict(raw_incoming_plan or {})
            current_has_contract = "contract" in current_plan
            incoming_has_contract = "contract" in incoming_plan
            if current_has_contract != incoming_has_contract:
                raise GovernanceValidationError(
                    "validation_plan.contract键不能增删；请修订Plan后重新生成ExecutionDraft"
                )
            current_contract = current_plan.get("contract")
            incoming_contract = incoming_plan.get("contract")
            if incoming_contract != current_contract:
                raise GovernanceValidationError(
                    "validation_plan.contract是机器冻结的Validation Contract，不能手工增删改；"
                    "请修订Plan后重新生成ExecutionDraft"
                )
            if current_contract is not None:
                current_payload = dict(current.payload_json)
                for bound_key in ("context_binding", "project_work_binding", "runtime_target"):
                    if not isinstance(value.get(bound_key), Mapping):
                        raise GovernanceValidationError(f"{bound_key}必须是对象")
                    if value.get(bound_key) != current_payload.get(bound_key):
                        raise GovernanceValidationError(
                            f"冻结Validation Contract仍绑定当前{bound_key}；"
                            "修改subject/Project/Repository绑定必须回Context或Plan重新生成ExecutionDraft"
                        )
        context_hash = str(
            value["context_binding"].get("context_hash") or _hash("context", "v1", value["context_binding"])
        )
        draft_hash = _hash(
            "execution-draft",
            EXECUTION_DRAFT_SCHEMA_VERSION,
            value | {"execution_brief": brief},
        )
        async with self.database.sessions.begin() as transaction:
            draft = await transaction.get(ExecutionDraftRecord, draft_id)
            if draft is None or draft.current_revision_id is None:
                raise GovernanceValidationError("ExecutionDraft不存在")
            current = await transaction.get(ExecutionDraftRevisionRecord, draft.current_revision_id)
            if current is None:
                raise GovernanceConflict("ExecutionDraft当前revision引用损坏")
            if (
                draft.row_version != expected_row_version
                or current.id != expected_revision_id
                or current.draft_hash != expected_draft_hash
            ):
                raise GovernanceConflict("ExecutionDraft已变化，请重新加载后再编辑")
            if draft.status not in {"reviewable", "building"} or current.status != "reviewable":
                raise GovernanceConflict("只有等待审核的ExecutionDraft可以编辑")
            if draft_hash == current.draft_hash:
                return {
                    "id": draft.id,
                    "status": draft.status,
                    "row_version": draft.row_version,
                    "revision_id": current.id,
                    "revision": current.revision,
                    "revision_status": current.status,
                    "draft_hash": current.draft_hash,
                    "context_hash": current.context_hash,
                    "execution_brief": current.execution_brief_text,
                    "payload": dict(current.payload_json),
                }
            old_subject = await transaction.get(DecisionSubjectRecord, current.subject_id)
            if old_subject is None:
                raise GovernanceConflict("ExecutionDraft Decision Subject不存在")
            revision_no = current.revision + 1
            subject = DecisionSubjectRecord(
                id=_id(),
                subject_kind="execution_draft",
                resource_id=draft.id,
                resource_revision=str(revision_no),
                subject_hash=draft_hash,
                session_id=draft.session_id,
                interaction_id=draft.interaction_id,
                run_id=old_subject.run_id,
                run_attempt_id=old_subject.run_attempt_id,
                workflow_definition_id=draft.workflow_definition_id,
                workflow_version=draft.workflow_version,
                node_id=old_subject.node_id,
                decision_view_json={"execution_brief": brief, "draft_hash": draft_hash},
            )
            revision = ExecutionDraftRevisionRecord(
                id=_id(),
                draft_id=draft.id,
                revision=revision_no,
                previous_revision_id=current.id,
                subject_id=subject.id,
                schema_version=EXECUTION_DRAFT_SCHEMA_VERSION,
                payload_json=value,
                execution_brief_text=brief,
                context_hash=context_hash,
                draft_hash=draft_hash,
                author_type="human",
                author_id=author_id,
                status="reviewable",
            )
            current.status = "superseded"
            transaction.add(subject)
            await transaction.flush()
            transaction.add(revision)
            await transaction.flush()
            draft.current_revision_id = revision.id
            draft.accepted_revision_id = None
            draft.acceptance_decision_record_id = None
            draft.status = "reviewable"
            draft.row_version += 1
            draft.updated_at = utc_now()
        with bind_context(
            session_id=draft.session_id,
            product_run_id=old_subject.run_id,
            workflow_id=draft.workflow_definition_id,
        ):
            logger.info(
                "execution_draft_revised draft_id=%s revision_id=%s revision=%d",
                draft.id,
                revision.id,
                revision.revision,
            )
        return {
            "id": draft.id,
            "status": draft.status,
            "row_version": draft.row_version,
            "revision_id": revision.id,
            "revision": revision.revision,
            "revision_status": revision.status,
            "draft_hash": revision.draft_hash,
            "context_hash": revision.context_hash,
            "execution_brief": revision.execution_brief_text,
            "payload": dict(revision.payload_json),
        }

    async def compile_run_spec(
        self,
        *,
        draft_revision_id: str,
        scopes: Sequence[Mapping[str, str]],
        spec_payload: Mapping[str, Any],
        run_id: str,
    ) -> RunSpecRecord:
        value = _validate_payload(
            spec_payload,
            RUN_SPEC_KEYS,
            RUN_SPEC_SCHEMA_VERSION,
        )
        snapshot = await self.create_policy_snapshot(scopes=scopes)
        run_spec_hash = run_spec_content_hash(value)
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
                schema_version=RUN_SPEC_SCHEMA_VERSION,
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
        with bind_context(session_id=run.session_id, product_run_id=run.id):
            logger.info(
                "run_spec_compiled run_spec_id=%s draft_revision_id=%s policy_snapshot_id=%s",
                spec.id,
                revision.id,
                snapshot.id,
            )
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
        raw_execution_context = review_card.get("execution_context")
        execution_context: Mapping[str, Any] = (
            raw_execution_context if isinstance(raw_execution_context, Mapping) else {}
        )
        node_id = str(
            execution_context.get("executor_id") or execution_context.get("agent_id") or "model_call"
        )
        call_ordinal = int(
            execution_context.get("call_ordinal") or execution_context.get("call_position") or 1
        )
        provider_request = review_card.get("provider_request")
        if not isinstance(provider_request, Mapping):
            raise GovernanceValidationError("ModelCallDraft缺少Provider请求")
        body = canonical_json_bytes(provider_request)
        body_hash = hashlib.sha256(body).hexdigest()
        if body_hash != review_card.get("body_sha256"):
            raise GovernanceValidationError("Provider Body与审批Hash不一致")
        raw_effective_context = review_card.get("effective_context")
        effective_context: Mapping[str, Any] = (
            raw_effective_context if isinstance(raw_effective_context, Mapping) else {}
        )
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
                previous = (
                    await transaction.get(ModelCallDraftRevisionRecord, slot.current_revision_id)
                    if slot.current_revision_id
                    else None
                )
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
                effective_context_json=dict(effective_context),
                context_source_annotations_json=list(effective_context.get("history_and_knowledge") or []),
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
                "tokens": {"estimated": effective_context.get("token_estimate")},
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
        with bind_context(
            session_id=subject.session_id,
            interaction_id=subject.interaction_id,
            product_run_id=subject.run_id,
            attempt_id=subject.run_attempt_id,
            workflow_id=subject.workflow_definition_id,
            execution_request_id=revision.id,
            decision_request_id=request.id if request else None,
        ):
            logger.info(
                "model_call_registered node_id=%s call_ordinal=%d revision=%d policy_action=%s",
                node_id,
                call_ordinal,
                revision.revision,
                preview["final_action"],
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
            persisted_consumption = await transaction.get(AuthorizationConsumptionRecord, consumption.id)
            if persisted_consumption is None:
                raise GovernanceValidationError("ModelCall授权消费不存在")
            attempt_number = (
                int(
                    await transaction.scalar(
                        select(func.max(ModelCallAttemptRecord.attempt_number)).where(
                            ModelCallAttemptRecord.model_call_draft_revision_id == revision.id
                        )
                    )
                    or 0
                )
                + 1
            )
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
        with bind_context(
            product_run_id=value.run_id,
            attempt_id=value.run_attempt_id,
            execution_request_id=revision.id,
        ):
            logger.info(
                "model_call_attempt_started model_call_attempt_id=%s attempt_number=%d",
                value.id,
                value.attempt_number,
            )
        return value

    async def finish_model_call_attempt(
        self,
        *,
        attempt_id: str,
        status: str,
        failure_code: str | None = None,
        output_text: str | None = None,
    ) -> None:
        await self.model_call_audit.finish_attempt(
            attempt_id=attempt_id,
            status=status,
            failure_code=failure_code,
            output_text=output_text,
        )

    async def record_model_call_transport_event(
        self,
        *,
        attempt_id: str,
        stage: str,
        status: str,
        details: Mapping[str, Any],
    ) -> None:
        await self.model_call_audit.record_transport_event(
            attempt_id=attempt_id,
            stage=stage,
            status=status,
            details=details,
        )

    async def record_model_output_disposition(
        self,
        *,
        attempt_id: str,
        disposition: str,
        reason: str,
    ) -> None:
        await self.model_call_audit.record_output_disposition(
            attempt_id=attempt_id,
            disposition=disposition,
            reason=reason,
        )

    async def governance_for_run(self, run_id: str) -> dict[str, Any]:
        """Return the read-only designer projection for one Product Run."""

        return await self.run_queries.governance_for_run(run_id)

    async def recent_turn_summaries(
        self,
        session_id: str,
        *,
        limit: int = 8,
    ) -> list[dict[str, Any]]:
        """Return bounded summary candidates without mutating governance state."""

        return await self.run_queries.recent_turn_summaries(session_id, limit=limit)

    async def save_turn_summary(
        self,
        *,
        session_id: str,
        run_id: str,
        summary: Mapping[str, Any],
        source_model_call_revision_id: str | None,
        product_fact_refs: Sequence[Mapping[str, Any]] = (),
    ) -> dict[str, Any]:
        async with self.database.sessions.begin() as transaction:
            run = await transaction.get(RunRecord, run_id)
            if run is None or run.session_id != session_id:
                raise GovernanceValidationError("Turn Summary关联的Run不存在")
            digest = normalize_turn_digest(
                summary,
                run_id=run.id,
                user_message_id=run.current_user_message_id,
                source_model_call_revision_id=source_model_call_revision_id,
                product_fact_refs=product_fact_refs,
            )
            topic = str(digest["topic"])
            summary_hash = _hash("turn-digest", "v1", digest)
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
                    summary_json=digest,
                    project_hint=str(digest.get("project_hint") or "").strip()[:240] or None,
                    extraction_status="candidate",
                    source_model_call_revision_id=source_model_call_revision_id,
                    summary_hash=summary_hash,
                )
                transaction.add(value)
        with bind_context(session_id=session_id, product_run_id=run_id):
            logger.info(
                "turn_summary_saved summary_id=%s status=%s",
                value.id,
                value.extraction_status,
            )
        return {
            "id": value.id,
            "topic": value.topic,
            "summary": value.summary_json,
            "project_hint": value.project_hint,
            "status": value.extraction_status,
            "summary_hash": value.summary_hash,
        }
