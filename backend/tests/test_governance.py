from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.governance.models import GovernanceOutboxRecord
from backend.app.governance.outbox import GovernanceOutboxWorker
from backend.app.main import create_app
from backend.app.product_sessions.database import ProductDatabase


def _preview(client: TestClient, decision_point_key: str, facts: dict) -> dict:
    response = client.post(
        "/api/hitl/policy-preview",
        json={
            "decision_point_key": decision_point_key,
            "scopes": [
                {"kind": "product_default", "ref_id": "*"},
                {"kind": "principal", "ref_id": "local-user"},
            ],
            "facts": facts,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_hitl_catalog_and_conditional_defaults_are_explainable() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        points = client.get("/api/hitl/decision-points")
        policies = client.get("/api/hitl/policy-sets")
        high_confidence = _preview(
            client,
            "intent_binding",
            {"intent": {"confidence": 0.95, "changes_active_work": False, "ambiguous": False}},
        )
        ambiguous = _preview(
            client,
            "intent_binding",
            {"intent": {"confidence": 0.40, "changes_active_work": False, "ambiguous": True}},
        )
        missing_fact = _preview(client, "intent_binding", {"intent": {"confidence": 0.95}})

    assert points.status_code == 200
    assert len(points.json()["decision_points"]) == 12
    assert {value["authority"] for value in policies.json()["policy_sets"]} == {
        "product_default",
        "system_safety",
    }
    assert high_confidence["final_action"] == "auto_continue"
    assert high_confidence["result_status"] == "resolved"
    assert ambiguous["final_action"] == "require_human"
    assert missing_fact["final_action"] == "require_human"
    assert missing_fact["result_status"] == "failed_closed"


def test_user_scope_can_skip_model_review_but_not_system_safety_floor() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        first = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "expected_active_revision_id": None,
                "change_summary": "在我的默认范围自动发送模型请求",
                "rules": [
                    {
                        "decision_point_key": "model_call_authorization",
                        "mode": "auto_continue",
                        "reason": "用户明确配置",
                    },
                    {
                        "decision_point_key": "unknown_or_high_risk",
                        "mode": "auto_continue",
                        "reason": "尝试放宽系统下限",
                    },
                ],
            },
        )
        assert first.status_code == 200, first.text
        revision_id = first.json()["active_revision"]["id"]

        model_call = _preview(client, "model_call_authorization", {"model": {"call_ordinal": 1}})
        unknown = _preview(client, "unknown_or_high_risk", {"risk": {"outcome_unknown": True}})
        stale = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "expected_active_revision_id": None,
                "change_summary": "过期页面覆盖",
                "rules": [
                    {
                        "decision_point_key": "model_call_authorization",
                        "mode": "require_human",
                    }
                ],
            },
        )
        second = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "expected_active_revision_id": revision_id,
                "change_summary": "恢复每次询问",
                "rules": [
                    {
                        "decision_point_key": "model_call_authorization",
                        "mode": "require_human",
                    }
                ],
            },
        )

    assert model_call["final_action"] == "auto_continue"
    assert unknown["floor_action"] == "require_human"
    assert unknown["final_action"] == "require_human"
    assert stale.status_code == 409
    assert second.status_code == 200
    assert second.json()["active_revision"]["revision"] == 2


def test_policy_activation_rejects_raw_or_incomplete_conditional_dsl() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        missing_condition = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "rules": [
                    {
                        "decision_point_key": "intent_binding",
                        "mode": "conditional",
                    }
                ],
            },
        )
        script_like = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "rules": [
                    {
                        "decision_point_key": "intent_binding",
                        "mode": "conditional",
                        "condition": {"eval": ["intent.confidence", "< 0.8"]},
                        "on_match": "require_human",
                    }
                ],
            },
        )

    assert missing_condition.status_code == 422
    assert script_like.status_code == 422


def test_inherit_rule_does_not_override_product_default() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        activated = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "expected_active_revision_id": None,
                "rules": [
                    {
                        "decision_point_key": "model_call_authorization",
                        "mode": "inherit",
                    }
                ],
            },
        )
        assert activated.status_code == 200, activated.text
        model_call = _preview(
            client,
            "model_call_authorization",
            {"model": {"call_ordinal": 1}},
        )

    assert model_call["preference_action"] == "require_human"
    assert model_call["final_action"] == "require_human"
    assert all(rule["mode"] != "inherit" for rule in model_call["matched_rules"])


def test_outbox_lease_allows_only_one_worker_and_dead_letters_at_limit(tmp_path) -> None:
    async def scenario() -> None:
        database = ProductDatabase(f"sqlite+aiosqlite:///{tmp_path / 'outbox.db'}")
        await database.initialize()
        async with database.sessions.begin() as transaction:
            transaction.add(
                GovernanceOutboxRecord(
                    id="event-once",
                    aggregate_kind="test",
                    aggregate_id="aggregate",
                    event_type="test.once",
                    payload_json={"value": 1},
                    dedupe_key="test.once:aggregate:1",
                )
            )
        handled: list[str] = []

        async def handle(event) -> None:
            handled.append(event.id)

        first = GovernanceOutboxWorker(database, worker_id="worker-a", handler=handle)
        second = GovernanceOutboxWorker(database, worker_id="worker-b", handler=handle)
        assert sum(await asyncio.gather(first.run_once(), second.run_once())) == 1
        assert handled == ["event-once"]

        async with database.sessions.begin() as transaction:
            transaction.add(
                GovernanceOutboxRecord(
                    id="event-dead",
                    aggregate_kind="test",
                    aggregate_id="dead",
                    event_type="test.fail",
                    payload_json={},
                    dedupe_key="test.fail:dead:1",
                )
            )

        async def fail(_event) -> None:
            raise RuntimeError("injected failure")

        dead_worker = GovernanceOutboxWorker(
            database,
            worker_id="worker-dead",
            handler=fail,
            max_attempts=1,
        )
        assert await dead_worker.run_once() is True
        async with database.sessions() as transaction:
            dead = await transaction.get(GovernanceOutboxRecord, "event-dead")
            published = await transaction.get(GovernanceOutboxRecord, "event-once")
        assert dead is not None and dead.status == "dead_letter"
        assert dead.last_error_code == "outbox_dispatch_failed"
        assert published is not None and published.status == "published"
        await database.close()

    asyncio.run(scenario())
