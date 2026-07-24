"""Code-reviewed built-in collaboration protocol revisions.

The catalog is synchronized into the Product Store at startup. Runtime code
resolves persisted definition IDs and hashes; it never treats these Python
constants as a substitute for the selected product revision.
"""

from __future__ import annotations

from typing import Any


def _rule(
    key: str,
    name: str,
    description: str,
    *,
    category: str,
    enforcement: str = "deterministic",
    severity: str = "required",
    overridable: bool = False,
    validator: dict[str, Any] | None = None,
    failure_action: str = "block",
) -> dict[str, Any]:
    return {
        "rule_key": key,
        "name": name,
        "description": description,
        "category": category,
        "enforcement": enforcement,
        "severity": severity,
        "overridable": overridable,
        "condition": {},
        "validator": validator or {},
        "failure_action": failure_action,
    }


BUILTIN_PROTOCOLS: tuple[dict[str, Any], ...] = (
    {
        "protocol_key": "simple-answer",
        "revision": 1,
        "name": "直接回答",
        "description": "用于简单问答和权威产品查询；只采用回答所需的最少上下文，不创建长期工作。",
        "status": "active",
        "scenario_kinds": ["simple_question"],
        "phases": [
            {"key": "understand", "name": "理解问题"},
            {"key": "answer", "name": "直接回答"},
            {"key": "digest", "name": "保留本轮重点"},
        ],
        "context_policy": {
            "required_source_families": ["current_input"],
            "optional_source_families": ["recent_turn_digest", "product_directory"],
            "default_token_budget": 1800,
        },
        "hitl_policy": {"method_defaults_skippable": True, "recommended_points": []},
        "execution_policy": {
            "planner": "disabled",
            "allowed_roles": ["intent", "response", "turn_digest"],
            "tool_mode": "read_only_when_needed",
        },
        "validation_policy": {"deterministic_first": True, "max_repairs": 0},
        "writeback_policy": {
            "allowed_candidates": ["turn_digest"],
            "forbidden_automatic_facts": ["project", "work_item", "accepted_memory"],
        },
        "ui_schema": {"summary": "最少上下文，直接回答", "accent": "neutral"},
        "rules": [
            _rule(
                "authoritative-query-first",
                "权威查询优先",
                "Project、Work等产品目录查询直接读取Product Store，不先调用模型。",
                category="routing",
                validator={"kind": "route_guard"},
            ),
            _rule(
                "no-implicit-work",
                "不擅自创建事项",
                "简单问答不得自动创建Project、Work或Accepted Memory。",
                category="writeback",
                validator={"kind": "product_patch_allowlist"},
            ),
        ],
    },
    {
        "protocol_key": "software-delivery",
        "revision": 1,
        "name": "软件交付",
        "description": "用于软件项目与功能开发；从现状和目标开始，经方案、实现、验证、交付和状态回写。",
        "status": "active",
        "scenario_kinds": ["software_delivery"],
        "phases": [
            {"key": "inspect", "name": "读取现状"},
            {"key": "design", "name": "形成方案"},
            {"key": "implement", "name": "实现变更"},
            {"key": "verify", "name": "验证与回归"},
            {"key": "deliver", "name": "交付并回写"},
        ],
        "context_policy": {
            "required_source_families": [
                "current_input",
                "project",
                "open_work",
                "accepted_plan",
                "rules",
            ],
            "optional_source_families": ["notes", "accepted_memory", "evidence", "file_index"],
            "default_token_budget": 7200,
        },
        "hitl_policy": {
            "method_defaults_skippable": True,
            "recommended_points": ["intent_binding", "plan_acceptance", "execution_authorization"],
        },
        "execution_policy": {
            "planner": "when_multi_step",
            "allowed_roles": ["intent", "planner", "executor", "reviewer", "turn_digest"],
            "tool_mode": "run_spec_allowlist",
        },
        "validation_policy": {
            "deterministic_first": True,
            "reviewer_when": ["semantic_quality", "cross_file_contract"],
            "max_repairs": 2,
        },
        "writeback_policy": {
            "allowed_candidates": ["work_state", "note", "memory", "evidence", "artifact"],
            "completion_requires_evidence": True,
        },
        "ui_schema": {"summary": "现状、方案、实现、验证、交付", "accent": "delivery"},
        "rules": [
            _rule(
                "inspect-before-change",
                "先读取事实",
                "修改前先读取相关代码、项目规则和当前状态，不能只凭Prompt猜实现。",
                category="context",
                validator={"kind": "required_source_family", "families": ["project", "file_index"]},
            ),
            _rule(
                "verification-required",
                "完成必须有验证",
                "声称完成前必须运行与风险相称的测试并保存Evidence。",
                category="validation",
                validator={"kind": "evidence_required"},
            ),
            _rule(
                "preserve-user-changes",
                "保留用户已有修改",
                "不得覆盖或重置不属于当前Run的工作区修改。",
                category="permission",
                validator={"kind": "workspace_diff_guard"},
            ),
        ],
    },
    {
        "protocol_key": "general-project",
        "revision": 1,
        "name": "通用项目推进",
        "description": "用于非软件类长期项目；把目标、里程碑、工作、检查点和复盘持续维护。",
        "status": "active",
        "scenario_kinds": ["project"],
        "phases": [
            {"key": "goal", "name": "确认目标"},
            {"key": "milestones", "name": "拆分里程碑"},
            {"key": "work", "name": "推进工作"},
            {"key": "review", "name": "检查与复盘"},
        ],
        "context_policy": {
            "required_source_families": ["current_input", "project", "open_work"],
            "optional_source_families": ["accepted_plan", "notes", "accepted_memory", "evidence"],
            "default_token_budget": 6000,
        },
        "hitl_policy": {
            "method_defaults_skippable": True,
            "recommended_points": ["intent_binding", "plan_acceptance"],
        },
        "execution_policy": {
            "planner": "when_multi_step",
            "allowed_roles": ["intent", "planner", "executor", "reviewer", "turn_digest"],
            "tool_mode": "run_spec_allowlist",
        },
        "validation_policy": {"deterministic_first": True, "max_repairs": 1},
        "writeback_policy": {
            "allowed_candidates": ["project", "work_state", "note", "memory", "evidence"],
            "completion_requires_evidence": True,
        },
        "ui_schema": {"summary": "目标、里程碑、推进、复盘", "accent": "project"},
        "rules": [
            _rule(
                "goal-before-plan",
                "目标先于计划",
                "目标或完成标准不清楚时先澄清，不生成伪精确计划。",
                category="planning",
                validator={"kind": "goal_completeness"},
                failure_action="rehitl",
            ),
            _rule(
                "milestone-evidence",
                "里程碑可验证",
                "里程碑完成必须绑定结果或Evidence。",
                category="validation",
                validator={"kind": "evidence_required"},
            ),
        ],
    },
    {
        "protocol_key": "standalone-task",
        "revision": 1,
        "name": "独立任务",
        "description": "用于不需要Project的有限任务；明确结果、步骤、验证和停止条件。",
        "status": "active",
        "scenario_kinds": ["task"],
        "phases": [
            {"key": "scope", "name": "明确范围"},
            {"key": "execute", "name": "执行"},
            {"key": "verify", "name": "验证"},
        ],
        "context_policy": {
            "required_source_families": ["current_input"],
            "optional_source_families": ["recent_turn_digest", "rules", "resource_refs"],
            "default_token_budget": 4200,
        },
        "hitl_policy": {
            "method_defaults_skippable": True,
            "recommended_points": ["execution_authorization"],
        },
        "execution_policy": {
            "planner": "when_multi_step",
            "allowed_roles": ["intent", "planner", "executor", "reviewer", "turn_digest"],
            "tool_mode": "run_spec_allowlist",
        },
        "validation_policy": {"deterministic_first": True, "max_repairs": 1},
        "writeback_policy": {"allowed_candidates": ["work_state", "note", "evidence"]},
        "ui_schema": {"summary": "范围、执行、验证", "accent": "task"},
        "rules": [
            _rule(
                "explicit-stop-condition",
                "明确停止条件",
                "执行前声明完成、询问和停止条件，避免无限扩展。",
                category="execution",
                validator={"kind": "stop_condition_required"},
            )
        ],
    },
    {
        "protocol_key": "learning-loop",
        "revision": 1,
        "name": "学习闭环",
        "description": "用于持续学习；结合诊断、讲解、练习、验证和复习维护学习进度。",
        "status": "active",
        "scenario_kinds": ["learning"],
        "phases": [
            {"key": "diagnose", "name": "诊断基础"},
            {"key": "learn", "name": "理解知识"},
            {"key": "practice", "name": "完成练习"},
            {"key": "assess", "name": "验证掌握"},
            {"key": "review", "name": "安排复习"},
        ],
        "context_policy": {
            "required_source_families": ["current_input", "project", "open_work"],
            "optional_source_families": ["learning_notes", "failed_evidence", "accepted_memory"],
            "default_token_budget": 6200,
        },
        "hitl_policy": {
            "method_defaults_skippable": True,
            "recommended_points": ["intent_binding", "plan_acceptance", "memory_commit"],
        },
        "execution_policy": {
            "planner": "enabled",
            "allowed_roles": ["intent", "planner", "tutor", "assessor", "turn_digest"],
            "tool_mode": "read_only_plus_assessment",
        },
        "validation_policy": {
            "deterministic_first": True,
            "reviewer_when": ["open_response_assessment"],
            "max_repairs": 1,
        },
        "writeback_policy": {
            "allowed_candidates": ["work_state", "learning_note", "memory", "evidence", "schedule"]
        },
        "ui_schema": {"summary": "诊断、学习、练习、验证、复习", "accent": "learning"},
        "rules": [
            _rule(
                "evidence-based-progress",
                "用练习证明进度",
                "薄弱点和掌握状态优先来自练习Evidence，不从聊天语气猜。",
                category="validation",
                validator={"kind": "learning_evidence"},
            ),
            _rule(
                "spaced-review",
                "保留复习动作",
                "需要长期掌握的内容在验证后形成可见复习Action或Schedule候选。",
                category="writeback",
                enforcement="reviewer",
                overridable=True,
                validator={"kind": "schedule_candidate"},
                failure_action="warn",
            ),
        ],
    },
    {
        "protocol_key": "research-with-sources",
        "revision": 1,
        "name": "有来源研究",
        "description": "用于研究与资料分析；围绕问题、来源、提取、交叉验证和可追溯结论推进。",
        "status": "active",
        "scenario_kinds": ["research"],
        "phases": [
            {"key": "question", "name": "固定研究问题"},
            {"key": "sources", "name": "收集来源"},
            {"key": "extract", "name": "提取事实"},
            {"key": "cross_check", "name": "交叉验证"},
            {"key": "synthesize", "name": "形成结论"},
        ],
        "context_policy": {
            "required_source_families": ["current_input", "research_question"],
            "optional_source_families": ["notes", "sources", "accepted_memory"],
            "default_token_budget": 7000,
        },
        "hitl_policy": {
            "method_defaults_skippable": True,
            "recommended_points": ["intent_binding", "plan_acceptance", "result_commit"],
        },
        "execution_policy": {
            "planner": "enabled",
            "allowed_roles": ["intent", "researcher", "reviewer", "turn_digest"],
            "tool_mode": "source_read_allowlist",
        },
        "validation_policy": {
            "deterministic_first": True,
            "reviewer_when": ["source_conflict", "synthesis_quality"],
            "max_repairs": 2,
        },
        "writeback_policy": {"allowed_candidates": ["research_note", "memory", "evidence", "artifact"]},
        "ui_schema": {"summary": "问题、来源、提取、验证、结论", "accent": "research"},
        "rules": [
            _rule(
                "source-required",
                "结论必须有来源",
                "可验证事实必须关联来源revision和访问状态。",
                category="validation",
                validator={"kind": "source_ref_required"},
            ),
            _rule(
                "conflict-visible",
                "来源冲突可见",
                "来源冲突不能静默合并为单一结论。",
                category="validation",
                enforcement="reviewer",
                validator={"kind": "source_conflict"},
                failure_action="rehitl",
            ),
        ],
    },
    {
        "protocol_key": "recurring-brief",
        "revision": 1,
        "name": "周期简报",
        "description": "用于定期资讯和日常工作；按Schedule检索、去重、验证、交付并保存回执。",
        "status": "active",
        "scenario_kinds": ["recurring"],
        "phases": [
            {"key": "schedule", "name": "确认周期"},
            {"key": "collect", "name": "收集内容"},
            {"key": "deduplicate", "name": "去重"},
            {"key": "verify", "name": "验证来源"},
            {"key": "deliver", "name": "交付并记录回执"},
        ],
        "context_policy": {
            "required_source_families": ["current_input", "schedule", "work"],
            "optional_source_families": ["previous_deliveries", "sources", "accepted_memory"],
            "default_token_budget": 6800,
        },
        "hitl_policy": {
            "method_defaults_skippable": True,
            "recommended_points": ["plan_acceptance", "delivery_authorization"],
        },
        "execution_policy": {
            "planner": "enabled",
            "allowed_roles": ["intent", "collector", "reviewer", "turn_digest"],
            "tool_mode": "scheduled_read_and_delivery_allowlist",
        },
        "validation_policy": {"deterministic_first": True, "max_repairs": 1},
        "writeback_policy": {
            "allowed_candidates": ["work_state", "note", "evidence", "delivery", "schedule"]
        },
        "ui_schema": {"summary": "周期、收集、去重、验证、交付", "accent": "recurring"},
        "rules": [
            _rule(
                "delivery-idempotency",
                "交付必须幂等",
                "相同周期和接收方不得因重试重复发送。",
                category="delivery",
                validator={"kind": "delivery_idempotency"},
            ),
            _rule(
                "unknown-before-retry",
                "结果未知先对账",
                "外部发送结果未知时必须查询或人工处理，不能盲目重发。",
                category="recovery",
                validator={"kind": "delivery_reconciliation"},
            ),
        ],
    },
)

DEFAULT_PROTOCOL_BY_SCENARIO: dict[str, str] = {
    "simple_question": "simple-answer",
    "software_delivery": "software-delivery",
    "project": "general-project",
    "task": "standalone-task",
    "learning": "learning-loop",
    "research": "research-with-sources",
    "recurring": "recurring-brief",
}
