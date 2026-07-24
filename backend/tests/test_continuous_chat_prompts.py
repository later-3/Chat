from __future__ import annotations

import json

from backend.app.workflows.continuous_chat_contracts import (
    CollaborationState,
    apply_summary_writeback_policy,
)
from backend.app.workflows.continuous_chat_prompts import summary_task


def test_summary_task_uses_the_same_content_free_source_references_for_digest() -> None:
    repository_body = "PRIVATE_FULL_GOVERNANCE_BODY_MUST_NOT_BE_REPEATED"
    state = CollaborationState(
        origin_prompt="继续开发 Chat",
        intent={"scenario": "continue_project", "goal": "推进SD1-D"},
        response="已核对当前Project和仓库状态。",
        context_items=(
            {
                "source_kind": "repository_governance",
                "source_id": "binding-1:AGENTS.md",
                "source_revision": "semantic-hash-1",
                "title": "Chat · AGENTS.md",
                "content": repository_body,
                "adopted": True,
                "reason": "当前请求涉及仓库开发规则",
                "selection_origin": "workflow_default",
            },
            {
                "source_kind": "repository_governance_manifest",
                "source_id": "binding-1:PROJECT_STATE.md",
                "source_revision": "semantic-hash-1",
                "title": "Chat · PROJECT_STATE.md",
                "content": "manifest only",
                "adopted": False,
                "reason": "未采用",
            },
        ),
    )

    payload = json.loads(summary_task(state))
    serialized = json.dumps(payload, ensure_ascii=False)

    assert "accepted_context_items" not in payload
    assert repository_body not in serialized
    assert payload["accepted_context_source_refs"] == [
        {
            "kind": "repository_governance",
            "id": "binding-1:AGENTS.md",
            "revision": "semantic-hash-1",
            "title": "Chat · AGENTS.md",
            "adoption_reason": "当前请求涉及仓库开发规则",
            "selection_origin": "workflow_default",
        }
    ]


def test_read_only_prompt_blocks_model_proposed_work_and_memory_candidates() -> None:
    summary, suppressions = apply_summary_writeback_policy(
        {
            "topic": "Chat只读复核",
            "work_state_candidates": [{"text": "把SD1-D标记完成"}],
            "memory_candidates": [{"text": "长期保存治理规则"}],
        },
        origin_prompt=("请只读复核当前Chat Project；不要创建或修改任何Project、Work、Memory或文件。"),
    )

    assert summary["work_state_candidates"] == []
    assert summary["memory_candidates"] == []
    assert [value["category"] for value in suppressions] == [
        "suppressed_work_state_candidate",
        "suppressed_memory_candidate",
    ]
    assert summary["discarded"] == suppressions
