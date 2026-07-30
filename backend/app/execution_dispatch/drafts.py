"""Deterministic ExecutionDraft and RunSpec v2 compilers.

The model may propose an intent or plan, but these compilers own the executable
contract.  They never infer new permissions and never inspect private paths.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Mapping, Sequence

from ..governance.catalog import (
    COMPILER_VERSION,
    EXECUTION_DRAFT_SCHEMA_VERSION,
    RUN_SPEC_SCHEMA_VERSION,
)
from ..harness.contracts import content_hash
from .contracts import RepositoryFence

if TYPE_CHECKING:
    from ..workflows.continuous_chat_contracts import CollaborationState

PI_READONLY_TERMS = (
    "检查代码",
    "查看代码",
    "分析代码",
    "审查代码",
    "阅读代码",
    "读代码",
    "源码",
    "代码库",
    "仓库",
    "codebase",
    "inspect code",
    "review code",
    "read code",
    "analyze code",
    "analyse code",
    "repository",
)
PI_OPT_OUT_TERMS = (
    "不调用pi",
    "不要调用pi",
    "不用pi",
    "不使用pi",
    "只回答",
    "仅回答",
)
PI_READONLY_TOOLS = ("read", "grep", "find", "ls")
PI_WORKSPACE_EDIT_TERMS = (
    "修改代码",
    "改代码",
    "修复代码",
    "实现功能",
    "实现这个功能",
    "修复bug",
    "修复 bug",
    "编辑文件",
    "更新文件",
    "精确修改",
    "精确编辑",
    "workspace_edit",
    "隔离executionworkspace",
    "隔离 execution workspace",
    "使用edit",
    "只允许edit",
    "change the code",
    "modify the code",
    "edit the file",
    "edit this file",
    "implement the feature",
    "fix the bug",
)
PI_WRITE_OPT_OUT_TERMS = (
    "不要修改任何文件",
    "不修改任何文件",
    "禁止修改任何文件",
    "不要写入",
    "禁止写入",
    "只读",
    "read-only",
    "read only",
    "do not modify any files",
    "do not write",
)
PI_WORKSPACE_TOOLS = (*PI_READONLY_TOOLS, "edit")


def execution_routing_text(state: CollaborationState) -> str:
    """Return the exact text the route recommendation derives from.

    Extracted so the draft executor can make the same pi_workspace decision
    as the pure compiler without duplicating string assembly (single source
    of truth for route-affecting input).
    """

    intent = state.intent or {}
    intent_set = list(state.intents or (intent,))
    return "\n".join(
        [
            state.origin_prompt,
            *(
                "\n".join(
                    [
                        str(value.get("goal") or ""),
                        str(value.get("expected_outcome") or ""),
                        *(str(item) for item in value.get("constraints") or ()),
                    ]
                )
                for value in intent_set
            ),
        ]
    )


def adopted_repository_source(
    context_items: Sequence[Mapping[str, Any]],
) -> dict[str, str] | None:
    """Return the single adopted default Repository Snapshot identity."""

    for item in context_items:
        if item.get("adopted", True) is not True:
            continue
        if str(item.get("source_kind") or "") != "repository_snapshot":
            continue
        binding_id = str(item.get("source_id") or "")
        semantic_hash = str(item.get("source_revision") or "")
        if binding_id and semantic_hash:
            return {
                "binding_id": binding_id,
                "semantic_hash": semantic_hash,
            }
    return None


def recommends_pi_readonly(
    *,
    prompt: str,
    selected_project_id: str | None,
    repository_fence: RepositoryFence | None,
    pi_available: bool,
) -> bool:
    """Recommend pi only for explicit repository-reading requests.

    This is a pre-approval recommendation, not the execution router.  Users can
    edit it in the ExecutionDraft workbench; after acceptance the immutable
    RunSpec is authoritative.
    """

    lowered = prompt.lower().replace(" ", "")
    opted_out = any(term.replace(" ", "") in lowered for term in PI_OPT_OUT_TERMS)
    explicit_read = any(term.replace(" ", "") in lowered for term in PI_READONLY_TERMS)
    return bool(
        pi_available
        and selected_project_id
        and repository_fence is not None
        and explicit_read
        and not opted_out
    )


# BP-23 触发：判断是否推荐使用pi工作区编辑。作为route_from_run_spec的辅助判断。
# 仅在RunSpec涉及工作区编辑类操作时才有意义。
# 跨边界：RunSpec草稿->pi工作区编辑路由的辅助判定。
# 对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S4-执行草稿授权与运行路由.md
def recommends_pi_workspace_edit(
    *,
    prompt: str,
    selected_project_id: str | None,
    repository_fence: RepositoryFence | None,
    pi_available: bool,
) -> bool:
    """判断是否推荐使用pi工作区编辑。作为route_from_run_spec的辅助判断。

    仅在RunSpec涉及工作区编辑类操作时才有意义。Recommend isolated editing only for
    an explicit code-change request.

    跨边界：RunSpec草稿->pi工作区编辑路由的辅助判定。
    对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S4-执行草稿授权与运行路由.md
    """

    # DEBUG-BREAKPOINT-NOTE: BP-23
    # DEBUG-BREAKPOINT-NOTE: 触发: 判断是否推荐使用pi工作区编辑。
    # DEBUG-BREAKPOINT-NOTE: 触发: 作为BP-22 route_from_run_spec的辅助判断。
    # DEBUG-BREAKPOINT-NOTE: 触发: 仅在RunSpec涉及工作区编辑类操作时才有意义。
    # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：学习阶段S4-执行草稿授权与运行路由。
    # DEBUG-BREAKPOINT-NOTE: 频率: 每个Run分发时触发1次（条件性）
    breakpoint()  # DEBUG-BREAKPOINT: BP-23
    lowered = prompt.lower().replace(" ", "")
    explicit_edit = any(term.replace(" ", "") in lowered for term in PI_WORKSPACE_EDIT_TERMS)
    opted_out = any(term.replace(" ", "") in lowered for term in PI_WRITE_OPT_OUT_TERMS)
    return bool(
        pi_available
        and selected_project_id
        and repository_fence is not None
        and repository_fence.head_oid
        and repository_fence.worktree_fingerprint
        and explicit_edit
        and not opted_out
    )


VALIDATION_CONTRACT_UNSET: Any = object()


def compile_execution_draft_v2(
    *,
    state: CollaborationState,
    thread_id: str,
    run_id: str,
    workflow_id: str,
    workflow_version: str,
    repository_fence: RepositoryFence | None,
    pi_available: bool,
    validation_contract: Any = VALIDATION_CONTRACT_UNSET,
) -> tuple[dict[str, Any], str]:
    """Compile an editable, public and fully versioned execution proposal.

    ``validation_contract`` is the frozen section produced by
    ``ValidationContractPlanner`` (exact plan revision, subject Action
    identity + revision and compiled argv/hash/capability binding), embedded
    inside the existing ``validation_plan`` section so the 17-part draft
    schema does not change.  For pi workspace runs the executor always passes
    it explicitly: the frozen section, or ``None`` to record "no completion
    subject this turn" — the pipeline fails closed if the key is absent (D).
    """

    intent = state.intent or {}
    intent_set = list(state.intents or (intent,))
    context_manifest = [
        {
            "source_kind": value.get("source_kind"),
            "source_id": value.get("source_id"),
            "source_revision": value.get("source_revision"),
            "title": value.get("title"),
            "adoption_reason": value.get("reason"),
            "token_estimate": value.get("token_estimate"),
        }
        for value in state.context_items
    ]
    context_hash = content_hash(context_manifest)
    goals = "\n".join(
        f"{index + 1}. {value.get('goal')} → {value.get('expected_outcome')}"
        for index, value in enumerate(intent_set)
    )
    # Execution routing may use the user request plus the accepted Intent Set,
    # but never a model-generated Plan alone: a plan is not an authority source
    # and therefore cannot silently escalate a read-only request into a write.
    routing_text = execution_routing_text(state)
    use_pi_workspace = recommends_pi_workspace_edit(
        prompt=routing_text,
        selected_project_id=state.selected_project_id,
        repository_fence=repository_fence,
        pi_available=pi_available,
    )
    if validation_contract is not VALIDATION_CONTRACT_UNSET and not use_pi_workspace:
        raise ValueError("Validation Contract只能冻结在pi隔离编辑执行草稿中")
    use_pi = not use_pi_workspace and recommends_pi_readonly(
        prompt=state.origin_prompt,
        selected_project_id=state.selected_project_id,
        repository_fence=repository_fence,
        pi_available=pi_available,
    )
    runtime_target: dict[str, Any]
    capability_grant: dict[str, Any]
    validation_checks = ["structured intent", "scenario branch", "no false completion"]
    if use_pi_workspace:
        assert repository_fence is not None
        runtime_target = {
            "runtime": "pi",
            "mode": "workspace_edit",
            "isolation": "managed_git_worktree",
            "repository_fence": repository_fence.public_view(),
        }
        capability_grant = {
            "tools": [
                {
                    "name": name,
                    "mode": "workspace_write" if name == "edit" else "readonly",
                    "side_effects": "managed_workspace_only" if name == "edit" else "none",
                }
                for name in PI_WORKSPACE_TOOLS
            ],
            "side_effects": "managed_workspace_only",
            "network": ["model-provider", "chat-workspace-tool-gateway"],
        }
        validation_checks.extend(
            [
                "repository snapshot freshness",
                "managed worktree base revision",
                "exact edit operation hash and diff approval",
                "active repository remains unchanged",
                "workspace retained without commit or push",
            ]
        )
    elif use_pi:
        assert repository_fence is not None
        runtime_target = {
            "runtime": "pi",
            "mode": "readonly",
            "isolation": "subprocess",
            "repository_fence": repository_fence.public_view(),
        }
        capability_grant = {
            "tools": [
                {"name": name, "mode": "readonly", "side_effects": "none"} for name in PI_READONLY_TOOLS
            ],
            "side_effects": "none",
            "network": ["model-provider", "chat-readonly-tool-gateway"],
        }
        validation_checks.extend(
            [
                "repository snapshot freshness",
                "custom read-only tools only",
                "deterministic pi result assembly",
            ]
        )
    else:
        runtime_target = {
            "runtime": "maf-workflow",
            "mode": "answer_only",
            "isolation": "in_process",
            "repository_fence": None,
        }
        capability_grant = {
            "tools": [],
            "side_effects": "none",
            "network": ["model-provider"],
        }
    brief = (
        f"目标：\n{goals}\n"
        f"场景：{state.scenario}\n"
        f"项目提示：{intent.get('project_hint') or '未关联'}\n"
        f"计划：{state.plan or '本轮不需要独立计划'}\n"
        "执行方式："
        f"{'pi隔离工作区精确编辑' if use_pi_workspace else ('pi只读检查仓库' if use_pi else 'Chat回答')}\n"
        "完成门：只提交当前回答或只读检查能够支持的结论；"
        "任务、项目、Memory变化保持候选，等待相应决策点。"
    )
    payload = {
        "identity_lineage": {
            "schema_version": EXECUTION_DRAFT_SCHEMA_VERSION,
            "session_id": thread_id,
            "run_id": run_id,
            "workflow_id": workflow_id,
            "workflow_version": workflow_version,
        },
        "intent_goal": {
            "intent_set_id": state.intent_set_id,
            "intent_set_revision_id": state.intent_set_revision_id,
            "intent_set_revision_hash": state.intent_set_revision_hash,
            "combination_policy": "single" if len(intent_set) == 1 else "sequential",
            "intents": intent_set,
        },
        "project_work_binding": {
            "project_id": state.selected_project_id,
            "project_hint": intent.get("project_hint"),
            "status": "accepted" if state.selected_project_id else "not_applicable",
            "repository_binding_id": repository_fence.binding_id if repository_fence else None,
            "repository_snapshot_id": repository_fence.snapshot_id if repository_fence else None,
        },
        "authoritative_product_facts": {
            "project_catalog": state.project_catalog_result,
        },
        "collaboration_protocol_binding": dict(state.protocol_selection or {}),
        "background": context_manifest,
        "accepted_decisions": [],
        "scope": {
            "included": ["answer current user request"],
            "excluded": (
                ["unapproved long-term state mutation", "active repository writes", "commit", "push"]
                if use_pi_workspace
                else ["unapproved long-term state mutation", "repository writes"]
            ),
        },
        "plan": {"text": state.plan, "mode": "explicit" if state.plan else "direct"},
        "context_binding": {
            "manifest": context_manifest,
            "context_hash": context_hash,
            "context_package_id": (state.detail_context_package_id or state.directory_context_package_id),
            "excluded": "raw full history by default",
        },
        "resource_manifest": {
            "project_catalog": (
                {
                    "source_kind": state.project_catalog_result["source_kind"],
                    "source_id": state.project_catalog_result["source_id"],
                    "query_status": state.project_catalog_result["query_status"],
                }
                if state.project_catalog_result
                else None
            ),
            "repository": repository_fence.public_view() if repository_fence else None,
        },
        "runtime_target": runtime_target,
        "capability_grant": capability_grant,
        "model_envelope": {
            "store": False,
            "continuation": False,
            "provider_and_model": "profile-bound",
        },
        "prompt_assembly_plan": {
            "blocks": [
                "agent_instructions",
                "user_request",
                "intent",
                "collaboration_protocol",
                "accepted_context",
                "project_work",
                "plan",
                "constraints",
                "output_contract",
            ],
            "history_policy": "selective summaries, never implicit full history",
        },
        "hitl_plan": {
            "decision_points": [
                "model_call_authorization",
                "tool_execution_authorization",
                "result_commit",
                "memory_commit",
                "work_state_commit",
            ]
        },
        "validation_plan": {
            "checks": validation_checks,
            "evidence": "workflow trace, runtime journal and provider attempts",
            **(
                {"contract": (dict(validation_contract) if validation_contract is not None else None)}
                if validation_contract is not VALIDATION_CONTRACT_UNSET
                else {}
            ),
        },
        "output_commit_contract": {
            "chat_result": "candidate until finalization",
            "work": "candidate",
            "memory": "candidate",
        },
        "stop_escalation": {
            "provider_failure": "stop",
            "repository_stale": "new authorization",
            "outcome_unknown": "require human",
            "capability_expansion": "new decision",
        },
    }
    return payload, brief


def compile_run_spec_v2(
    *,
    accepted: Mapping[str, Any],
    state: CollaborationState,
    thread_id: str,
    run_id: str,
    workflow_id: str,
    workflow_version: str,
) -> dict[str, Any]:
    """Compile the accepted Draft byte-for-byte into an immutable RunSpec."""

    payload = dict(accepted["payload"])
    context_binding = dict(payload["context_binding"])
    runtime_target = dict(payload["runtime_target"])
    return {
        "identity": {
            "schema_version": RUN_SPEC_SCHEMA_VERSION,
            "compiler_version": COMPILER_VERSION,
        },
        "source_binding": {
            "draft_id": accepted["draft_id"],
            "draft_revision_id": accepted["revision_id"],
            "draft_hash": accepted["draft_hash"],
        },
        "principal_scope": {"principal_id": "local-user", "channel": "web"},
        "workflow_binding": {
            "definition_id": workflow_id,
            "version": workflow_version,
            "entry": "input_acceptance",
        },
        "execution_brief": {
            "text": accepted["execution_brief"],
            "draft_hash": accepted["draft_hash"],
        },
        "context_manifest": {
            "items": list(context_binding.get("manifest") or []),
            "context_hash": context_binding.get("context_hash"),
        },
        "plan": {"text": payload["plan"].get("text"), "scenario": state.scenario},
        "collaboration_protocol": dict(payload.get("collaboration_protocol_binding") or {}),
        "authoritative_product_facts": dict(payload.get("authoritative_product_facts") or {}),
        "prompt_assembly_contract": payload["prompt_assembly_plan"],
        "runtime_agent": {
            **runtime_target,
            "agent_profiles": (
                ["pi_workspace" if runtime_target.get("mode") == "workspace_edit" else "pi_readonly"]
                if runtime_target.get("runtime") == "pi"
                else ["intent_router", "task_planner", "response_agent", "turn_summarizer"]
            ),
        },
        "capability_envelope": payload["capability_grant"],
        "model_envelope": payload["model_envelope"],
        "hitl_policy_snapshot": {
            "resolver": "hitl-resolver-v1",
            "binding": "compiled after Draft authorization",
        },
        "validation_evidence": payload["validation_plan"],
        "output_commit": payload["output_commit_contract"],
        "control": {
            "cancel": True,
            "retry": "new authorization",
            "outcome_unknown": "human reconciliation",
        },
        "correlation_idempotency": {
            "product_run_id": run_id,
            "agui_thread_id": thread_id,
        },
    }
