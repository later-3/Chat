"""Versioned governance catalogs and policy defaults.

These values describe stable product contracts. They do not open database
transactions or evaluate a concrete decision, which keeps the catalog
reviewable independently from the application service.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

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
    DecisionPointSeed(
        "intent_binding",
        "understanding",
        "理解用户意图",
        "确认系统对本轮目标和场景的理解。",
        "intent",
        "conditional",
        ("accept", "revise", "split", "cancel"),
    ),
    DecisionPointSeed(
        "project_work_binding",
        "context",
        "关联 Project / Work",
        "确认本轮属于哪个项目、工作或不关联。",
        "work_binding",
        "conditional",
        ("accept", "reselect", "unbound", "cancel"),
    ),
    DecisionPointSeed(
        "context_adoption",
        "context",
        "采用 Context",
        "确认哪些背景、历史、知识和资源进入本轮。",
        "context_package",
        "conditional",
        ("accept", "revise", "cancel"),
    ),
    DecisionPointSeed(
        "plan_acceptance",
        "planning",
        "接受 Plan",
        "确认任务拆分、顺序、负责人和验证方式。",
        "task_plan",
        "conditional",
        ("accept", "revise", "skip", "cancel"),
    ),
    DecisionPointSeed(
        "execution_authorization",
        "execution",
        "授权 ExecutionDraft",
        "确认准备执行的目标、范围、能力和完成门。",
        "execution_draft",
        "conditional",
        ("execute", "revise", "cancel"),
    ),
    DecisionPointSeed(
        "model_call_authorization",
        "model",
        "发送 ModelCallDraft",
        "确认将要发送给模型的完整请求。",
        "model_call_draft",
        "require_human",
        ("approve", "revise", "abandon"),
    ),
    DecisionPointSeed(
        "tool_execution_authorization",
        "tool",
        "执行 Tool",
        "确认真实工具、参数、目标和副作用。",
        "tool_call_request",
        "conditional",
        ("approve", "revise", "deny"),
    ),
    DecisionPointSeed(
        "work_state_commit",
        "commit",
        "提交 Work 状态",
        "确认任务或项目状态的长期变化。",
        "work_state_candidate",
        "conditional",
        ("commit", "revise", "reject"),
    ),
    DecisionPointSeed(
        "memory_commit",
        "commit",
        "提交 Memory",
        "确认哪些候选信息成为可复用记忆。",
        "memory_candidate",
        "require_human",
        ("commit", "revise", "session_only", "reject"),
    ),
    DecisionPointSeed(
        "result_commit",
        "commit",
        "提交 Result",
        "确认结果、证据和完成声明可被接受。",
        "result_candidate",
        "conditional",
        ("accept", "verify_more", "revise"),
    ),
    DecisionPointSeed(
        "runtime_recovery",
        "recovery",
        "Runtime 恢复或干预",
        "确认重试、Restart、新 Run、停止或人工处理。",
        "runtime_recovery",
        "require_human",
        ("retry", "restart", "new_run", "stop"),
    ),
    DecisionPointSeed(
        "unknown_or_high_risk",
        "safety",
        "未知或高风险结果",
        "结果未知、高风险或证据不足时关闭失败。",
        "risk_incident",
        "require_human",
        ("stop", "reconcile", "inspect", "next_step"),
    ),
)

PRODUCT_DEFAULTS = {seed.key: seed.default_mode for seed in DECISION_POINTS}
PRODUCT_DEFAULT_RULES: dict[str, dict[str, Any]] = {
    "intent_binding": {
        "mode": "conditional",
        "condition": {
            "any": [
                {"lte": ["intent.confidence", 0.84]},
                {"eq": ["intent.changes_active_work", True]},
                {"eq": ["intent.ambiguous", True]},
            ]
        },
        "on_match": "require_human",
    },
    "project_work_binding": {
        "mode": "conditional",
        "condition": {
            "any": [
                {"gte": ["project.candidate_count", 2]},
                {"eq": ["project.cross_sensitive_scope", True]},
            ]
        },
        "on_match": "require_human",
    },
    "context_adoption": {
        "mode": "conditional",
        "condition": {
            "any": [
                {"eq": ["context.requires_review", True]},
                {"eq": ["context.cross_project", True]},
                {"eq": ["context.source_invalid", True]},
            ]
        },
        "on_match": "require_human",
    },
    "plan_acceptance": {
        "mode": "conditional",
        "condition": {
            "any": [
                {"gte": ["plan.risk_level", 2]},
                {"eq": ["plan.expands_capability", True]},
                {"eq": ["plan.boundary_unclear", True]},
            ]
        },
        "on_match": "require_human",
    },
    "execution_authorization": {
        "mode": "conditional",
        "condition": {
            "any": [
                {"gte": ["execution.risk_level", 2]},
                {"eq": ["execution.has_side_effects", True]},
                {"eq": ["execution.goal_incomplete", True]},
            ]
        },
        "on_match": "require_human",
    },
    "model_call_authorization": {"mode": "require_human"},
    "tool_execution_authorization": {
        "mode": "conditional",
        "condition": {
            "any": [
                {"gte": ["tool.risk_level", 2]},
                {"eq": ["tool.has_side_effects", True]},
                {"eq": ["tool.outside_capability", True]},
            ]
        },
        "on_match": "require_human",
    },
    "work_state_commit": {
        "mode": "conditional",
        "condition": {
            "any": [
                {"eq": ["work.creates_or_deletes", True]},
                {"eq": ["work.claims_completion_without_evidence", True]},
            ]
        },
        "on_match": "require_human",
    },
    "memory_commit": {"mode": "require_human"},
    "result_commit": {
        "mode": "conditional",
        "condition": {
            "any": [
                {"eq": ["result.evidence_sufficient", False]},
                {"eq": ["result.external_delivery", True]},
                {"eq": ["result.changes_long_term_state", True]},
            ]
        },
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
