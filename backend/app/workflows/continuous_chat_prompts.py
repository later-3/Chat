"""Provider-facing task compilers for the collaboration Workflow."""

from __future__ import annotations

import json

from .continuous_chat_contracts import (
    CollaborationState,
    context_source_references,
    summary_writeback_policy,
)


def intent_task(state: CollaborationState) -> str:
    return json.dumps(
        {
            "current_user_request": state.origin_prompt,
            "candidate_prior_turn_summaries": list(state.recent_turn_summaries),
            "formal_project_directory_matches": list(state.project_matches),
            "context_package_id": state.directory_context_package_id,
            "accepted_context_items": list(state.context_items),
            "pending_clarification": state.pending_clarification,
            "output_contract": {
                "intents": [
                    {
                        "branch_key": "单轮唯一、稳定、可读的分支键，例如learn_topic",
                        "scenario": (
                            "simple_question/continue_project/new_task/plan_request/learning/clarify之一"
                        ),
                        "query_kind": "project_catalog或null",
                        "goal": "本分支目标",
                        "expected_outcome": "用户可验证的预期结果",
                        "confidence": "0到1",
                        "project_hint": "Project名称提示或null",
                        "needs_plan": "boolean",
                        "needs_clarification": "boolean",
                        "clarification_question": "需要澄清时的问题，否则null",
                        "answers_clarification_id": (
                            "若当前输入明确回答pending_clarification，则填写其id，否则null"
                        ),
                        "context_keywords": ["用于渐进式Context召回"],
                        "dependency_branch_keys": ["只能引用数组中更早的branch_key"],
                        "constraints": ["本分支明确边界"],
                        "reason_summary": "只写可公开的判断摘要，不写隐藏推理",
                    }
                ],
                "combination_policy": "single或sequential；默认sequential",
            },
            "rules": [
                "候选摘要不是已采用事实；只有与当前请求直接相关时才引用。",
                "若候选摘要标记awaiting_user_answer=true，当前输入可能是对该开放问题的回答，必须结合两者判断。",
                "若项目匹配不唯一或用户目标不完整，scenario必须为clarify。",
                "‘我有哪些项目/查看项目列表’属于明确产品查询，不得改问用户是否新建；应标记query_kind=project_catalog。",
                "简单问答不创建Project或Task。",
                "一句输入确有多个独立目标时拆为最多4个intents，并给出顺序依赖；不得为凑数量强拆。",
                "若当前输入没有回答开放澄清，而是开始了新目标，answers_clarification_id必须为null。",
                "Project目录来自Product Harness权威查询；不能把摘要候选冒充正式Project。",
                "Repository目录只提供当前代码基线的轻量事实，不包含未明确采用的文件正文。",
                "只输出规定JSON，不要解释。",
            ],
        },
        ensure_ascii=False,
    )


def plan_task(state: CollaborationState) -> str:
    return json.dumps(
        {
            "user_request": state.origin_prompt,
            "accepted_intent": state.intent,
            "accepted_intent_set": list(state.intents),
            "intent_set_revision_id": state.intent_set_revision_id,
            "selected_context_summaries": list(state.recent_turn_summaries),
            "selected_project_id": state.selected_project_id,
            "accepted_context_items": list(state.context_items),
            "authoritative_product_facts": {
                "project_catalog": state.project_catalog_result,
            },
            "collaboration_protocol": _model_protocol_view(state),
            "request": (
                "为每个Intent形成步骤、依赖、HITL检查点、验证方式和停止条件；"
                "多Intent必须按dependency_branch_keys给出可恢复的推进顺序；"
                "authoritative_product_facts中的completed查询已经执行，不得再次规划为工具调用；"
                "不要执行工具。"
            ),
        },
        ensure_ascii=False,
    )


def response_task(state: CollaborationState) -> str:
    return json.dumps(
        {
            "user_request": state.origin_prompt,
            "accepted_intent": state.intent,
            "accepted_intent_set": list(state.intents),
            "intent_set_revision_id": state.intent_set_revision_id,
            "selected_context_summaries": list(state.recent_turn_summaries),
            "selected_project_id": state.selected_project_id,
            "accepted_context_items": list(state.context_items),
            "authoritative_product_facts": {
                "project_catalog": state.project_catalog_result,
            },
            "collaboration_protocol": _model_protocol_view(state),
            "plan": state.plan,
            "execution_contract": {
                "draft_revision_id": state.execution_draft_revision_id,
                "run_spec_id": state.run_spec_id,
                "tools_allowed": [],
            },
            "request": (
                "逐项覆盖Intent Set中的每个目标，并明确尚未完成或需要后续执行的部分；"
                "给出本轮可直接提交给用户的答复。不要声称未执行的动作已经完成。"
            ),
        },
        ensure_ascii=False,
    )


def _model_protocol_view(state: CollaborationState) -> dict[str, object]:
    """Expose reviewed public rules without leaking binding administration fields."""

    selection = state.protocol_selection or {}
    return {
        "protocol_key": selection.get("protocol_key"),
        "name": selection.get("protocol_name"),
        "revision": selection.get("revision"),
        "phases": list(selection.get("phases") or []),
        "applicable_rules": list(selection.get("applicable_rules") or []),
        "source_selection_hash": selection.get("selection_hash"),
        "effective_selection_hash": selection.get(
            "effective_selection_hash",
            selection.get("selection_hash"),
        ),
        "source_execution_policy": dict(
            selection.get("base_execution_policy") or selection.get("execution_policy") or {}
        ),
        "execution_policy": dict(selection.get("execution_policy") or {}),
        "composition_overlay": dict(selection.get("composition_overlay") or {}),
        "validation_policy": dict(selection.get("validation_policy") or {}),
        "writeback_policy": dict(selection.get("writeback_policy") or {}),
    }


def summary_task(state: CollaborationState) -> str:
    return json.dumps(
        {
            "user_request": state.origin_prompt,
            "intent": state.intent,
            "assistant_response": state.response,
            "plan": state.plan,
            "accepted_context_source_refs": context_source_references(state.context_items),
            "writeback_policy": summary_writeback_policy(state.origin_prompt),
            "rules": [
                "只提取本轮重点，丢弃无关寒暄。",
                (
                    "用户或Product事实明确确认的内容才进入confirmed_facts，"
                    "每项使用{text,source_refs:[{kind,id}]}；无法给来源则不要冒充事实。"
                ),
                "只能引用accepted_context_source_refs中给出的来源；这里的引用不代表重新读取了来源正文。",
                ("decisions每项使用{text,decision_record_id}或{text,product_ref}；无法绑定引用则保持为空。"),
                (
                    "任务和Memory变化只进入candidate数组，不能自动提交；"
                    "若writeback_policy禁止对应候选，则该数组必须为空。"
                ),
                "只输出规定JSON。",
            ],
        },
        ensure_ascii=False,
    )
