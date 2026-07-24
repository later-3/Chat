from __future__ import annotations

from backend.app.governance.turn_digest import normalize_turn_digest


def test_turn_digest_keeps_only_source_bound_facts_and_decisions() -> None:
    digest = normalize_turn_digest(
        {
            "topic": "继续贪吃蛇项目",
            "confirmed_facts": [
                "模型猜测碰撞检测已完成",
                {
                    "text": "用户明确要求先验证移动端手势",
                    "source_refs": [{"kind": "product_message", "id": "message-1"}],
                },
            ],
            "decisions": [
                "按三步计划执行",
                {
                    "text": "采用计划revision 2",
                    "decision_record_id": "decision-2",
                },
            ],
            "open_questions": ["移动端真机是否可用？"],
            "work_state_candidates": [{"title": "验证手势"}],
            "memory_candidates": [],
        },
        run_id="run-1",
        user_message_id="message-1",
        source_model_call_revision_id="model-call-1",
    )

    assert digest["digest_version"] == 1
    assert digest["confirmed_facts"] == [
        {
            "text": "用户明确要求先验证移动端手势",
            "source_refs": [{"kind": "product_message", "id": "message-1"}],
        }
    ]
    assert digest["unverified_fact_candidates"][0]["text"] == "模型猜测碰撞检测已完成"
    assert digest["decisions"][0]["decision_record_id"] == "decision-2"
    assert digest["decision_candidates"][0]["text"] == "按三步计划执行"
    assert digest["source_refs"] == [
        {"kind": "product_message", "id": "message-1"},
        {"kind": "product_run", "id": "run-1"},
        {"kind": "model_call_revision", "id": "model-call-1"},
    ]
    assert len(digest["discarded"]) == 2


def test_turn_digest_is_bounded_deduplicated_and_records_committed_refs() -> None:
    digest = normalize_turn_digest(
        {
            "topic": "学习Outbox",
            "confirmed_facts": [],
            "decisions": [],
            "source_refs": [
                {"kind": "product_run", "id": "run-2"},
                {"kind": "", "id": "invalid"},
            ],
            "product_fact_refs": [
                {"kind": "unknown", "id": "invalid"},
            ],
        },
        run_id="run-2",
        user_message_id="message-2",
        source_model_call_revision_id=None,
        product_fact_refs=[
            {"kind": "work_item", "id": "work-1", "revision": 3},
            {"kind": "work_item", "id": "work-1", "revision": 3},
            {"kind": "accepted_memory", "id": "memory-1", "revision": 1},
        ],
    )

    assert digest["source_refs"] == [
        {"kind": "product_message", "id": "message-2"},
        {"kind": "product_run", "id": "run-2"},
    ]
    assert digest["product_fact_refs"] == [
        {"kind": "work_item", "id": "work-1", "revision": "3"},
        {"kind": "accepted_memory", "id": "memory-1", "revision": "1"},
    ]
    assert "无效product_fact_refs已丢弃" in digest["extraction_warning"]
