"""SD4-C Result Commit Gate wiring tests for the continuous collaboration Workflow.

Covers the approved §14 gap: the main Workflow turns a succeeded governed pi
workspace execution into frozen ValidationContract -> CompletionClaim +
mandatory Requirements -> deterministic ValidationRun -> Observation ->
Assessment -> Adoption(created by the gate from the frozen map) -> precisely
bound result_commit Decision -> ResultCommitCoordinator.

Scenarios:

A. accepted chain: Action completed, parent Work still in_progress; Adoption
   rows exist only after the commit transaction.
B. failed / timeout / outcome_unknown Validation never produces supports,
   Adoption or completion; the decision card only offers reject; post-spawn
   exceptions converge outcome_unknown while pre-spawn failures report error
   and fail the Run.
C. reject path is independent: subject and Artifact are resolved without
   migrating the Action; stale Context/subject versions fail closed.
D. tampered RunSpec payload or draft-level contract edits fail closed.
E. replaying the same prepare/commit commands duplicates nothing.
F. missing store/compiler/frozen contract fails the Run instead of silently
   completing the answer (P1-4).
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from dataclasses import replace
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.app.config import ArtifactStoreSettings
from backend.app.evidence.validation_runtime import ValidationProcessResult
from backend.app.main import create_app
from backend.app.model_call_review import InMemoryModelCallReviewStore
from backend.tests.test_continuous_pi_readonly import (
    SequencedTransport,
    _approve_intent_and_plan,
    _card,
    _catalog,
    _create_project_and_binding,
    _events,
    _repository,
    _request,
    _resume,
    _settings,
)
from backend.tests.test_continuous_pi_workspace import (
    FakeWorkspacePiManager,
    _workspace_transport_responses,
)

_PYTEST_RULE = {
    "capability_key": "pytest-suite",
    "capability_version": "1.0.0",
    "params": {"targets": ["tests"], "extra_args": ["-q"]},
}


def _write_test_suite(repository: Path, *, passing: bool) -> None:
    tests_dir = repository / "tests"
    tests_dir.mkdir(exist_ok=True)
    body = (
        "def test_workspace_gate():\n    assert True\n"
        if passing
        else ("def test_workspace_gate():\n    assert False, 'deterministic failure'\n")
    )
    (tests_dir / "test_workspace_gate.py").write_text(body, encoding="utf-8")


def _sd4_settings(tmp_path: Path):
    settings = _settings(tmp_path)
    return replace(
        settings,
        execution_workspace_root=tmp_path / "managed-workspaces",
        artifact_store=ArtifactStoreSettings(
            root=tmp_path / "artifact-store",
            scope_key_secret=b"s" * 32,
        ),
    )


def _query(database_path: Path, sql: str, args: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    connection = sqlite3.connect(database_path)
    try:
        return list(connection.execute(sql, args))
    finally:
        connection.close()


def _setup_work_plan_action(
    client: TestClient,
    project: dict[str, Any],
    *,
    with_contract: bool = True,
) -> tuple[dict[str, Any], dict[str, Any]]:
    work_response = client.post(
        "/api/harness/work-items",
        json={
            "command_id": "sd4-work",
            "project_id": project["id"],
            "kind": "task",
            "title": "隔离实现并验证",
            "objective": "在隔离Workspace完成一次精确edit并通过确定性Validation",
            "status": "ready",
        },
    )
    assert work_response.status_code == 201, work_response.text
    work = work_response.json()
    plan_response = client.post(
        f"/api/harness/work-items/{work['id']}/plan-revisions",
        json={
            "command_id": "sd4-plan",
            "expected_work_row_version": work["row_version"],
            "summary": "edit -> validate -> commit",
            "nodes": [
                {
                    "key": "implement",
                    "title": "隔离实现",
                    "objective": "在受管worktree精确edit目标文件",
                    "assignee_kind": "agent",
                }
            ],
            "validation_contract": {"rules": [_PYTEST_RULE]} if with_contract else {},
            "accept": True,
        },
    )
    assert plan_response.status_code == 201, plan_response.text
    work_view = client.get(f"/api/harness/work-items/{work['id']}").json()
    transition = client.post(
        f"/api/harness/work-items/{work['id']}/transition",
        json={
            "command_id": "sd4-work-start",
            "expected_row_version": work_view["work_item"]["row_version"],
            "target_status": "in_progress",
            "reason": "开始隔离执行与验证",
        },
    )
    assert transition.status_code == 200, transition.text
    action_response = client.post(
        "/api/harness/action-items",
        json={
            "command_id": "sd4-action",
            "project_id": project["id"],
            "work_item_id": work["id"],
            "title": "在隔离Workspace中实现并验证结果",
            "assignee_kind": "agent",
            "status": "ready",
        },
    )
    assert action_response.status_code == 201, action_response.text
    return work, action_response.json()


def _run_workspace_flow(
    client: TestClient,
    app: Any,
    session_id: str,
    *,
    prefix: str,
) -> dict[str, Any]:
    """Drive the flow up to the result Claim decision card."""

    intent_card = _card(
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_request(
                    session_id,
                    f"{prefix}-start",
                    "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                ),
            )
        )
    )
    first_model = _approve_intent_and_plan(
        client,
        session_id=session_id,
        intent_card=intent_card,
        prefix=prefix,
    )
    assert first_model["execution_context"]["executor_id"] == "pi_workspace_dispatch"
    app.state.continuous_workflow.clear_thread_workflow(session_id)
    edit_card = _card(
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, f"{prefix}-model-one", first_model, "approve"),
            )
        )
    )
    assert edit_card["review_kind"] == "tool_execution"
    app.state.continuous_workflow.clear_thread_workflow(session_id)
    second_model = _card(
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, f"{prefix}-edit", edit_card, "approve"),
            )
        )
    )
    app.state.continuous_workflow.clear_thread_workflow(session_id)
    claim_card = _card(
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, f"{prefix}-model-two", second_model, "approve"),
            )
        )
    )
    assert claim_card["review_kind"] == "product_decision"
    assert claim_card["decision_point_key"] == "result_commit"
    app.state.continuous_workflow.clear_thread_workflow(session_id)
    return claim_card


async def _replay_prepare(
    app: Any,
    *,
    session_id: str,
    run_id: str,
) -> dict[str, Any]:
    """Re-run the same prepare command before the user decision (恢复重放)。"""

    pipeline = app.state.result_pipeline
    from sqlalchemy import select

    from backend.app.product_sessions.database import ToolExecutionRecord

    async with pipeline.database.sessions() as transaction:
        execution = await transaction.scalar(
            select(ToolExecutionRecord).where(ToolExecutionRecord.run_id == run_id)
        )
        assert execution is not None
    return await pipeline.prepare(
        session_id=session_id,
        run_id=run_id,
        tool_execution_id=str(execution.id),
    )


def _count(database_path: Path, table: str) -> int:
    return int(_query(database_path, f"SELECT COUNT(*) FROM {table}")[0][0])


def _build_app(tmp_path: Path, *, passing: bool):
    repository = _repository(tmp_path / "repo")
    _write_test_suite(repository, passing=passing)
    from backend.tests.test_continuous_pi_readonly import _git

    _git(repository, "add", "tests")
    _git(repository, "commit", "-qm", "add validation suite")
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    transport = SequencedTransport(_workspace_transport_responses())
    manager = FakeWorkspacePiManager(catalog.get("provider-a"), store)
    app = create_app(
        _sd4_settings(tmp_path),
        model_call_store=store,
        model_call_transport=transport,
        pi_runtime_manager=manager,  # type: ignore[arg-type]
    )
    return app


def test_result_commit_gate_completes_action_after_accepted_validation(tmp_path: Path) -> None:
    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        claim_card = _run_workspace_flow(client, app, session_id, prefix="sd4")
        assert claim_card["committable"] is True
        assert claim_card["allowed_actions"] == ["accept", "reject"]
        claim_id = claim_card["claim"]["claim_id"]

        # 恢复重放：用户决定前重复同一prepare命令，不产生第二份事实。
        [active_run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        replay = asyncio.run(
            _replay_prepare(
                app,
                session_id=session_id,
                run_id=active_run["id"],
            )
        )
        assert replay["status"] == "prepared"
        assert replay["claim_id"] == claim_id
        # A：决定前没有任何Adoption；Adoption只由Gate在result_commit事务内创建。
        assert _count(database_path, "claim_evidence_adoptions") == 0

        summary_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-claim", claim_card, "accept"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-summary", summary_card, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        claim_view = client.get(f"/api/evidence/claims/{claim_id}").json()
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()

    assert run["status"] == "succeeded"
    assert claim_view["status"] == "committed"
    assert claim_view["result_commit"]["commit_status"] == "accepted"
    assert claim_view["result_commit"]["artifact_disposition"] == "accepted"
    assert claim_view["result_commit"]["pre_commit_validity_check_passed"] is True
    assert claim_view["result_commit"]["committed_subject_state"] == "completed"
    resolutions = {item["requirement_kind"]: item["resolution"] for item in claim_view["requirements"]}
    assert resolutions == {"validation_result": "adoption", "file_hash_match": "adoption"}
    assert work_view["work_item"]["status"] == "in_progress"
    actions = _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    )
    assert actions == [("completed",)]
    # 恰好一条链：Contract、Claim、ValidationRun、ResultCommit各一；
    # Observation/Assessment/Adoption覆盖validation_result与file_hash_match两条Requirement。
    assert _count(database_path, "validation_contracts") == 1
    assert _count(database_path, "completion_claims") == 1
    assert _count(database_path, "validation_runs") == 1
    assert _count(database_path, "result_commits") == 1
    assert _count(database_path, "evidence_observations") == 2
    assert _count(database_path, "evidence_assessments") == 2
    assert _count(database_path, "claim_evidence_adoptions") == 2
    assert _count(database_path, "artifact_records") == 1
    assert _count(database_path, "artifact_revisions") == 1
    assert _query(database_path, "SELECT status FROM validation_runs") == [("passed",)]
    # F：持久化的working_dir只能是安全相对locator，绝不包含宿主绝对路径。
    assert _query(database_path, "SELECT working_dir FROM validation_runs") == [(".",)]
    assert _query(
        database_path,
        "SELECT COUNT(*) FROM evidence_observations WHERE payload_json LIKE '%/Users/%'",
    ) == [(0,)]
    assert _query(database_path, "SELECT status FROM artifact_records") == [("accepted",)]
    assert _query(database_path, "SELECT verdict FROM evidence_assessments") == [
        ("supports",),
        ("supports",),
    ]
    # 同一人工响应/Outbox重投两次：冻结身份+同一command_id的两次commit
    # 返回完全相同的结果，只有1个ResultCommit和1次Action迁移。
    first_replay = asyncio.run(
        app.state.result_pipeline.commit(
            claim_id=claim_id,
            claim_hash=claim_card["claim"]["claim_hash"],
            expected_claim_row_version=int(claim_card["claim"]["claim_row_version"]),
            decision_record_id=claim_view["decision_record_id"],
            commit_status="accepted",
            artifact_disposition="accepted",
            command_id=f"sd4:{run['id']}:commit-result",
        )
    )
    second_replay = asyncio.run(
        app.state.result_pipeline.commit(
            claim_id=claim_id,
            claim_hash=claim_card["claim"]["claim_hash"],
            expected_claim_row_version=int(claim_card["claim"]["claim_row_version"]),
            decision_record_id=claim_view["decision_record_id"],
            commit_status="accepted",
            artifact_disposition="accepted",
            command_id=f"sd4:{run['id']}:commit-result",
        )
    )
    assert first_replay == second_replay
    assert first_replay["result_commit_id"] == claim_view["result_commit"]["id"]
    assert first_replay["claim"]["status"] == "committed"
    assert _count(database_path, "result_commits") == 1
    assert _query(
        database_path,
        "SELECT row_version FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [(3,)]
    assert binding["snapshot"]["id"] == claim_view["repository_snapshot_id"]


def test_failed_validation_only_allows_reject_and_never_completes(tmp_path: Path) -> None:
    app = _build_app(tmp_path, passing=False)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        claim_card = _run_workspace_flow(client, app, session_id, prefix="sd4-fail")
        assert claim_card["committable"] is False
        assert claim_card["allowed_actions"] == ["reject"]
        claim_id = claim_card["claim"]["claim_id"]

        summary_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-fail-claim", claim_card, "reject"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-fail-summary", summary_card, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        claim_view = client.get(f"/api/evidence/claims/{claim_id}").json()
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()

    assert run["status"] == "succeeded"
    assert claim_view["status"] == "rejected"
    assert claim_view["result_commit"]["commit_status"] == "rejected"
    assert claim_view["result_commit"]["pre_commit_validity_check_passed"] is False
    assert claim_view["result_commit"]["committed_subject_state"] is None
    assert work_view["work_item"]["status"] == "in_progress"
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("in_progress",)]
    assert _query(database_path, "SELECT status FROM validation_runs") == [("failed",)]
    assert _query(database_path, "SELECT verdict FROM evidence_assessments") == [
        ("refutes",),
        ("supports",),
    ]
    # A：rejected路径不创建任何Adoption；Assessment保留审计。
    assert _count(database_path, "claim_evidence_adoptions") == 0
    assert _query(database_path, "SELECT status FROM artifact_records") == [("rejected",)]


def test_unknown_validation_outcome_produces_no_supports_or_completion(tmp_path: Path) -> None:
    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    original_run = app.state.validation_runner.run

    async def fake_run(compiled, *, workspace):  # noqa: ANN001, ANN202
        return ValidationProcessResult(
            status="outcome_unknown",
            exit_code=None,
            duration_ms=3,
            stdout_tail="",
            stderr_tail="",
        )

    app.state.validation_runner.run = fake_run  # type: ignore[method-assign]
    try:
        with TestClient(app) as client:
            project, _binding = _create_project_and_binding(client)
            work, action = _setup_work_plan_action(client, project)
            session_id = client.post("/api/sessions", json={}).json()["id"]
            claim_card = _run_workspace_flow(client, app, session_id, prefix="sd4-unknown")
            assert claim_card["committable"] is False
            assert claim_card["allowed_actions"] == ["reject"]
            claim_id = claim_card["claim"]["claim_id"]
            summary_card = _card(
                _events(
                    client.post(
                        "/api/workflows/continuous-collaboration/run",
                        json=_resume(session_id, "sd4-unknown-claim", claim_card, "reject"),
                    )
                )
            )
            app.state.continuous_workflow.clear_thread_workflow(session_id)
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-unknown-summary", summary_card, "approve"),
                )
            )
            [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
            claim_view = client.get(f"/api/evidence/claims/{claim_id}").json()
            work_view = client.get(f"/api/harness/work-items/{work['id']}").json()
    finally:
        app.state.validation_runner.run = original_run  # type: ignore[method-assign]

    assert run["status"] == "succeeded"
    assert claim_view["status"] == "rejected"
    assert work_view["work_item"]["status"] == "in_progress"
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("in_progress",)]
    assert _query(database_path, "SELECT status FROM validation_runs") == [("outcome_unknown",)]
    # outcome_unknown不产生validation_result Observation、supports Assessment或Adoption。
    assert _query(
        database_path,
        "SELECT kind, COUNT(*) FROM evidence_observations GROUP BY kind",
    ) == [("file_hash_match", 1)]
    assert _query(database_path, "SELECT COUNT(*) FROM claim_evidence_adoptions") == [(0,)]
    assert _query(
        database_path,
        "SELECT verdict FROM evidence_assessments",
    ) == [("supports",)]


def test_stale_subject_version_fails_closed_without_partial_commit(tmp_path: Path) -> None:
    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        claim_card = _run_workspace_flow(client, app, session_id, prefix="sd4-stale")
        assert claim_card["committable"] is True
        claim_id = claim_card["claim"]["claim_id"]
        # 决策卡已签发后，另一个会话推进了同一Action：Claim期望版本随之陈旧。
        stale = client.post(
            f"/api/harness/action-items/{action['id']}/transition",
            json={
                "command_id": "sd4-stale-block",
                "expected_row_version": 2,
                "target_status": "blocked",
                "reason": "并发会话抢先处理该Action",
            },
        )
        assert stale.status_code == 200, stale.text
        events = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-stale-claim", claim_card, "accept"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        claim_view = client.get(f"/api/evidence/claims/{claim_id}").json()
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()

    assert events
    assert run["status"] == "failed"
    assert claim_view["status"] == "candidate"
    assert claim_view["result_commit"] is None
    assert work_view["work_item"]["status"] == "in_progress"
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("blocked",)]
    assert _count(database_path, "result_commits") == 0
    assert _query(database_path, "SELECT status FROM artifact_records") == [("candidate",)]


def test_workspace_run_without_frozen_contract_fails_closed(tmp_path: Path) -> None:
    """P1-4：有subject但Plan没有Validation Contract时，Draft冻结即失败，pi不执行。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project, with_contract=False)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "sd4-none-start",
                        "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                    ),
                )
            )
        )
        plan_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-none-intent", intent_card, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-none-plan", plan_card, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()

    assert run["status"] == "failed"
    assert run["failure_code"] == "RESULT_EVIDENCE_PREREQUISITE_MISSING"
    assert work_view["work_item"]["status"] == "in_progress"
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("ready",)]
    assert _count(database_path, "tool_executions") == 0
    assert _count(database_path, "completion_claims") == 0
    assert _count(database_path, "validation_runs") == 0
    assert _count(database_path, "result_commits") == 0
    assert _count(database_path, "artifact_records") == 0


def test_workspace_run_without_artifact_store_fails_closed(tmp_path: Path) -> None:
    """P1-4：Artifact Store未配置时，有edit的workspace Run不能以成功绕过结果门。"""

    repository = _repository(tmp_path / "repo")
    _write_test_suite(repository, passing=True)
    from backend.tests.test_continuous_pi_readonly import _git

    _git(repository, "add", "tests")
    _git(repository, "commit", "-qm", "add validation suite")
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    transport = SequencedTransport(_workspace_transport_responses())
    manager = FakeWorkspacePiManager(catalog.get("provider-a"), store)
    settings = replace(
        _settings(tmp_path),
        execution_workspace_root=tmp_path / "managed-workspaces",
    )
    app = create_app(
        settings,
        model_call_store=store,
        model_call_transport=transport,
        pi_runtime_manager=manager,  # type: ignore[arg-type]
    )
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "sd4-nostore-start",
                        "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                    ),
                )
            )
        )
        first_model = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent_card,
            prefix="sd4-nostore",
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        edit_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-nostore-model-one", first_model, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        second_model = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-nostore-edit", edit_card, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-nostore-model-two", second_model, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()

    assert run["status"] == "failed"
    assert run["failure_code"] == "RESULT_EVIDENCE_PREREQUISITE_MISSING"
    assert work_view["work_item"]["status"] == "in_progress"
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("ready",)]
    assert _count(database_path, "completion_claims") == 0
    assert _count(database_path, "result_commits") == 0
    assert _count(database_path, "artifact_records") == 0


def test_frozen_contract_and_plan_advanced_after_authorization_fails_closed(tmp_path: Path) -> None:
    """P0-1/P0-2合并语义：Run只用RunSpec冻结合同（不读最新Plan），但授权后
    Plan/Work一旦被推进，旧合同不再被允许完成——必须稳定失败要求新授权，
    而不是静默继续或静默换新合同。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        [plan_row] = _query(
            tmp_path / "continuous-pi.db",
            "SELECT current_revision_id FROM task_plans WHERE work_item_id = ?",
            (work["id"],),
        )
        frozen_plan_revision_id = plan_row[0]
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "sd4-p01-start",
                        "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                    ),
                )
            )
        )
        first_model = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent_card,
            prefix="sd4-p01",
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _advance_plan(client, work, "sd4-p01-plan-advance")
        edit_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-p01-model-one", first_model, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        second_model = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-p01-edit", edit_card, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-p01-model-two", second_model, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]

    assert run["status"] == "failed"
    assert run["failure_code"] == "RESOURCE_VERSION_CONFLICT"
    assert _count(database_path, "completion_claims") == 0
    assert _count(database_path, "validation_runs") == 0
    assert _count(database_path, "result_commits") == 0
    assert frozen_plan_revision_id
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("ready",)]


def test_concurrent_action_mutation_fails_closed_before_prepare(tmp_path: Path) -> None:
    """P0-2：冻结后其他Session推进Action，prepare必须fail closed而不是纳入新版本。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "sd4-p02-start",
                        "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                    ),
                )
            )
        )
        first_model = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent_card,
            prefix="sd4-p02",
        )
        # 冻结之后、prepare之前：另一会话把该Action推进到blocked。
        mutated = client.post(
            f"/api/harness/action-items/{action['id']}/transition",
            json={
                "command_id": "sd4-p02-block",
                "expected_row_version": 1,
                "target_status": "blocked",
                "reason": "并发会话抢先处理该Action",
            },
        )
        assert mutated.status_code == 200, mutated.text
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        edit_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-p02-model-one", first_model, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        second_model = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-p02-edit", edit_card, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-p02-model-two", second_model, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()

    assert run["status"] == "failed"
    assert run["failure_code"] == "RESOURCE_VERSION_CONFLICT"
    assert work_view["work_item"]["status"] == "in_progress"
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("blocked",)]
    assert _count(database_path, "completion_claims") == 0
    assert _count(database_path, "result_commits") == 0


def test_stale_context_action_revision_fails_draft_freeze(tmp_path: Path) -> None:
    """C：Context装配后Action被推进，Draft冻结必须fail closed而不是纳入新版本。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "sd4-c-start",
                        "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                    ),
                )
            )
        )
        plan_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-c-intent", intent_card, "approve"),
                )
            )
        )
        # 详情Context已装配（Action revision=1）；此时另一会话推进该Action。
        mutated = client.post(
            f"/api/harness/action-items/{action['id']}/transition",
            json={
                "command_id": "sd4-c-block",
                "expected_row_version": 1,
                "target_status": "blocked",
                "reason": "并发会话抢先处理该Action",
            },
        )
        assert mutated.status_code == 200, mutated.text
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-c-plan", plan_card, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()

    assert run["status"] == "failed"
    assert run["failure_code"] == "RESOURCE_VERSION_CONFLICT"
    assert work_view["work_item"]["status"] == "in_progress"
    assert _count(database_path, "completion_claims") == 0


def test_tampered_run_spec_payload_fails_closed(tmp_path: Path) -> None:
    """D：spec_json被篡改后run_spec_hash不再匹配，prepare必须fail closed。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, _action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "sd4-d-start",
                        "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                    ),
                )
            )
        )
        first_model = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent_card,
            prefix="sd4-d",
        )
        # 篡改run_specs.spec_json中的冻结argv（不改run_spec_hash字段）。
        connection = sqlite3.connect(database_path)
        try:
            (spec_json,) = connection.execute("SELECT spec_json FROM run_specs").fetchone()
            payload = json.loads(spec_json)
            payload["validation_evidence"]["contract"]["rules"][0]["expanded_argv_hash"] = "0" * 64
            connection.execute(
                "UPDATE run_specs SET spec_json = ?",
                (json.dumps(payload),),
            )
            connection.commit()
        finally:
            connection.close()
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        edit_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-d-model-one", first_model, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        second_model = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-d-edit", edit_card, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-d-model-two", second_model, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()

    assert run["status"] == "failed"
    assert run["failure_code"] == "VALIDATION_CONTRACT_MISMATCH"
    assert work_view["work_item"]["status"] == "in_progress"
    assert _count(database_path, "completion_claims") == 0
    assert _count(database_path, "validation_runs") == 0


def test_draft_revision_cannot_tamper_frozen_contract(tmp_path: Path) -> None:
    """E：Workbench不能把机器冻结的contract改成自编合同；只能改文本检查项。"""

    app = _build_app(tmp_path, passing=True)
    with TestClient(app) as client:
        policy = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "rules": [
                    {
                        "decision_point_key": "execution_authorization",
                        "mode": "require_human",
                        "reason": "让Draft在授权前处于可编辑状态",
                    }
                ],
            },
        )
        assert policy.status_code == 200, policy.text
        project, _binding = _create_project_and_binding(client)
        _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "sd4-e-start",
                        "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                    ),
                )
            )
        )
        plan_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-e-intent", intent_card, "approve"),
                )
            )
        )
        auth_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-e-plan", plan_card, "approve"),
                )
            )
        )
        assert auth_card["decision_point_key"] == "execution_authorization"
        connection = sqlite3.connect(tmp_path / "continuous-pi.db")
        try:
            draft_id, revision_id, draft_hash, row_version = connection.execute(
                "SELECT id, current_revision_id, "
                "(SELECT draft_hash FROM execution_draft_revisions WHERE id = current_revision_id), "
                "row_version FROM execution_drafts"
            ).fetchone()
        finally:
            connection.close()
        view = client.get(f"/api/execution-drafts/{draft_id}").json()
        payload = dict(view["payload"])
        contract = dict(payload["validation_plan"]["contract"])
        tampered = json.loads(json.dumps(payload))
        tampered["validation_plan"]["contract"]["rules"][0]["params"]["targets"] = ["../../etc/passwd"]
        rejected = client.put(
            f"/api/execution-drafts/{draft_id}",
            json={
                "expected_revision_id": revision_id,
                "expected_draft_hash": draft_hash,
                "expected_row_version": row_version,
                "execution_brief": "tamper contract",
                "payload": tampered,
            },
        )
        assert rejected.status_code == 422, rejected.text
        # 畸形validation_plan结构（string/list）必须稳定422而不是500。
        for malformed in ("not-an-object", ["contract"]):
            malformed_payload = json.loads(json.dumps(payload))
            malformed_payload["validation_plan"] = malformed
            malformed_response = client.put(
                f"/api/execution-drafts/{draft_id}",
                json={
                    "expected_revision_id": revision_id,
                    "expected_draft_hash": draft_hash,
                    "expected_row_version": row_version,
                    "execution_brief": "malformed validation_plan",
                    "payload": malformed_payload,
                },
            )
            assert malformed_response.status_code == 422, (
                malformed,
                malformed_response.status_code,
                malformed_response.text,
            )
        # 删除contract键（presence变化）同样拒绝。
        key_removed = json.loads(json.dumps(payload))
        del key_removed["validation_plan"]["contract"]
        removed_response = client.put(
            f"/api/execution-drafts/{draft_id}",
            json={
                "expected_revision_id": revision_id,
                "expected_draft_hash": draft_hash,
                "expected_row_version": row_version,
                "execution_brief": "remove contract key",
                "payload": key_removed,
            },
        )
        assert removed_response.status_code == 422, removed_response.text
        # 保持contract不变但修改context/project/runtime绑定也拒绝（P0-2）。
        for bound_key, mutate in (
            ("context_binding", lambda value: value.update({"context_hash": "0" * 64})),
            (
                "project_work_binding",
                lambda value: value.update({"project_id": "00000000-0000-0000-0000-000000000000"}),
            ),
            ("runtime_target", lambda value: value.update({"mode": "readonly"})),
        ):
            variant = json.loads(json.dumps(payload))
            mutate(variant[bound_key])
            response = client.put(
                f"/api/execution-drafts/{draft_id}",
                json={
                    "expected_revision_id": revision_id,
                    "expected_draft_hash": draft_hash,
                    "expected_row_version": row_version,
                    "execution_brief": f"mutate {bound_key}",
                    "payload": variant,
                },
            )
            assert response.status_code == 422, (bound_key, response.text)
        # 只修改文本检查项（contract保持原样）允许形成新revision。
        edited = json.loads(json.dumps(payload))
        edited["validation_plan"]["checks"] = [*edited["validation_plan"]["checks"], "user note"]
        accepted = client.put(
            f"/api/execution-drafts/{draft_id}",
            json={
                "expected_revision_id": revision_id,
                "expected_draft_hash": draft_hash,
                "expected_row_version": row_version,
                "execution_brief": "edit checks only",
                "payload": edited,
            },
        )
        assert accepted.status_code == 200, accepted.text
        revised = client.get(f"/api/execution-drafts/{draft_id}").json()
        assert revised["payload"]["validation_plan"]["contract"] == contract
        assert "user note" in revised["payload"]["validation_plan"]["checks"]


def test_spawn_started_exception_converges_outcome_unknown(tmp_path: Path) -> None:
    """B：子进程已启动后的异常只能收敛outcome_unknown，绝不能报error或完成。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    original_run = app.state.validation_runner.run

    async def raising_run(compiled, *, workspace):  # noqa: ANN001, ANN202
        from backend.app.evidence.contracts import ValidationOutcomeUnknownError

        raise ValidationOutcomeUnknownError("injected post-spawn failure")

    app.state.validation_runner.run = raising_run  # type: ignore[method-assign]
    try:
        with TestClient(app) as client:
            project, _binding = _create_project_and_binding(client)
            work, action = _setup_work_plan_action(client, project)
            session_id = client.post("/api/sessions", json={}).json()["id"]
            claim_card = _run_workspace_flow(client, app, session_id, prefix="sd4-b1")
            assert claim_card["committable"] is False
            assert claim_card["allowed_actions"] == ["reject"]
            claim_id = claim_card["claim"]["claim_id"]
            summary_card = _card(
                _events(
                    client.post(
                        "/api/workflows/continuous-collaboration/run",
                        json=_resume(session_id, "sd4-b1-claim", claim_card, "reject"),
                    )
                )
            )
            app.state.continuous_workflow.clear_thread_workflow(session_id)
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-b1-summary", summary_card, "approve"),
                )
            )
            [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
            claim_view = client.get(f"/api/evidence/claims/{claim_id}").json()
            work_view = client.get(f"/api/harness/work-items/{work['id']}").json()
    finally:
        app.state.validation_runner.run = original_run  # type: ignore[method-assign]

    assert run["status"] == "succeeded"
    assert claim_view["status"] == "rejected"
    assert work_view["work_item"]["status"] == "in_progress"
    assert _query(database_path, "SELECT status FROM validation_runs") == [("outcome_unknown",)]
    assert _query(
        database_path,
        "SELECT COUNT(*) FROM evidence_observations WHERE kind = 'validation_result'",
    ) == [(0,)]
    assert _count(database_path, "claim_evidence_adoptions") == 0


def test_pre_spawn_failure_reports_error_and_fails_run(tmp_path: Path) -> None:
    """P1-5/B：可证明未启动的验证前置失败回报error并让Product Run失败。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    original_run = app.state.validation_runner.run

    async def failing_run(compiled, *, workspace):  # noqa: ANN001, ANN202
        from backend.app.evidence.contracts import ValidationCapabilityUnavailable

        raise ValidationCapabilityUnavailable("injected pre-spawn sandbox failure")

    app.state.validation_runner.run = failing_run  # type: ignore[method-assign]
    try:
        with TestClient(app) as client:
            project, _binding = _create_project_and_binding(client)
            work, action = _setup_work_plan_action(client, project)
            session_id = client.post("/api/sessions", json={}).json()["id"]
            intent_card = _card(
                _events(
                    client.post(
                        "/api/workflows/continuous-collaboration/run",
                        json=_request(
                            session_id,
                            "sd4-b2-start",
                            "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                        ),
                    )
                )
            )
            first_model = _approve_intent_and_plan(
                client,
                session_id=session_id,
                intent_card=intent_card,
                prefix="sd4-b2",
            )
            app.state.continuous_workflow.clear_thread_workflow(session_id)
            edit_card = _card(
                _events(
                    client.post(
                        "/api/workflows/continuous-collaboration/run",
                        json=_resume(session_id, "sd4-b2-model-one", first_model, "approve"),
                    )
                )
            )
            app.state.continuous_workflow.clear_thread_workflow(session_id)
            second_model = _card(
                _events(
                    client.post(
                        "/api/workflows/continuous-collaboration/run",
                        json=_resume(session_id, "sd4-b2-edit", edit_card, "approve"),
                    )
                )
            )
            app.state.continuous_workflow.clear_thread_workflow(session_id)
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-b2-model-two", second_model, "approve"),
                )
            )
            [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
            work_view = client.get(f"/api/harness/work-items/{work['id']}").json()
    finally:
        app.state.validation_runner.run = original_run  # type: ignore[method-assign]

    assert run["status"] == "failed"
    assert run["failure_code"] == "VALIDATION_CAPABILITY_UNAVAILABLE"
    assert work_view["work_item"]["status"] == "in_progress"
    assert _query(database_path, "SELECT status FROM validation_runs") == [("error",)]
    assert _count(database_path, "completion_claims") == 1
    assert _count(database_path, "result_commits") == 0
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("in_progress",)]


def test_workspace_run_without_validation_compiler_fails_closed(tmp_path: Path) -> None:
    """P1-4：Validation Compiler缺失（Store已配置）同样不能让Run成功绕门。"""

    app = _build_app(tmp_path, passing=True)
    app.state.result_pipeline._compiler = None  # noqa: SLF001
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "sd4-nocompiler-start",
                        "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                    ),
                )
            )
        )
        first_model = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent_card,
            prefix="sd4-nocompiler",
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        edit_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-nocompiler-model-one", first_model, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        second_model = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-nocompiler-edit", edit_card, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-nocompiler-model-two", second_model, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()

    assert run["status"] == "failed"
    assert run["failure_code"] == "RESULT_EVIDENCE_PREREQUISITE_MISSING"
    assert work_view["work_item"]["status"] == "in_progress"
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("ready",)]
    assert _count(database_path, "completion_claims") == 0
    assert _count(database_path, "result_commits") == 0


def test_prepare_replay_after_external_action_bump_fails_closed(tmp_path: Path) -> None:
    """G收紧：既有Claim后外部推进Action版本，重放prepare必须fail closed零新写入。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        claim_card = _run_workspace_flow(client, app, session_id, prefix="sd4-g")
        assert claim_card["committable"] is True
        claim_id = claim_card["claim"]["claim_id"]
        [active_run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        # 第一次重放安全：既有Claim绑定当前权威版本与from_state。
        first = asyncio.run(_replay_prepare(app, session_id=session_id, run_id=active_run["id"]))
        assert first["claim_id"] == claim_id
        # 外部并发把Action推进到blocked（row_version与状态都越过Claim绑定）。
        bumped = client.post(
            f"/api/harness/action-items/{action['id']}/transition",
            json={
                "command_id": "sd4-g-bump",
                "expected_row_version": 2,
                "target_status": "blocked",
                "reason": "并发会话抢先处理该Action",
            },
        )
        assert bumped.status_code == 200, bumped.text
        from backend.app.evidence.contracts import EvidenceConflict

        try:
            asyncio.run(_replay_prepare(app, session_id=session_id, run_id=active_run["id"]))
            raise AssertionError("外部推进后的prepare重放必须失败")
        except EvidenceConflict:
            pass
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()

    assert work_view["work_item"]["status"] == "in_progress"
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("blocked",)]
    # 零新写入：仍只有第一次prepare的1个Claim/1个ValidationRun，没有第二次执行。
    assert _count(database_path, "completion_claims") == 1
    assert _count(database_path, "validation_runs") == 1
    assert _count(database_path, "evidence_observations") == 2
    assert _count(database_path, "result_commits") == 0


def test_reject_decision_cannot_create_adoption(tmp_path: Path) -> None:
    """P0复审：reject outcome的Decision（映射为空）不能被挪用来采用证据。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        claim_card = _run_workspace_flow(client, app, session_id, prefix="sd4-p0r")
        assert claim_card["committable"] is True
        claim_id = claim_card["claim"]["claim_id"]
        summary_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-p0r-claim", claim_card, "reject"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-p0r-summary", summary_card, "approve"),
            )
        )
        claim_view = client.get(f"/api/evidence/claims/{claim_id}").json()

    assert claim_view["status"] == "rejected"

    # reject Decision已经解决Claim；任何直接create_adoption都必须失败且零写。
    async def attack() -> None:
        from sqlalchemy import select

        from backend.app.evidence.contracts import EvidenceError
        from backend.app.evidence.models import (
            CompletionClaimRequirementRecord,
            EvidenceAssessmentRecord,
        )
        from backend.app.evidence.service import EvidenceRepository

        pipeline = app.state.result_pipeline
        repo = EvidenceRepository(scope_id="local-user", principal_id="local-user")
        async with pipeline.database.sessions.begin() as transaction:
            requirements = list(
                (
                    await transaction.scalars(
                        select(CompletionClaimRequirementRecord).where(
                            CompletionClaimRequirementRecord.completion_claim_id == claim_id
                        )
                    )
                ).all()
            )
            requirement = requirements[0]
            assessment = await transaction.scalar(
                select(EvidenceAssessmentRecord).where(
                    EvidenceAssessmentRecord.requirement_id == requirement.id
                )
            )
            assert assessment is not None
            try:
                await repo.create_adoption(
                    transaction,
                    claim_id=claim_id,
                    requirement_id=requirement.id,
                    assessment_id=assessment.id,
                    decision_record_id=claim_view["decision_record_id"],
                    command_id="sd4-p0r-attack",
                )
                raise AssertionError("reject Decision不能被挪用来创建Adoption")
            except EvidenceError:
                pass

    asyncio.run(attack())
    assert _count(database_path, "claim_evidence_adoptions") == 0


def test_adoption_binding_rejects_wrong_assessment_and_cross_claim(tmp_path: Path) -> None:
    """P0复审：错assessment与跨claim的Adoption Decision全部失败且零写。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        claim_card = _run_workspace_flow(client, app, session_id, prefix="sd4-p0a")
        assert claim_card["committable"] is True
        claim_id = claim_card["claim"]["claim_id"]

    async def run_attacks() -> None:
        from sqlalchemy import select

        from backend.app.evidence.contracts import ResultCommitDecisionInvalid
        from backend.app.evidence.models import (
            CompletionClaimRequirementRecord,
            EvidenceAssessmentRecord,
        )
        from backend.app.evidence.service import EvidenceRepository
        from backend.app.governance.models import DecisionRecord
        from backend.tests.test_result_commit import (
            _bind_decision_record,
            _make_adoption_decision,
        )

        pipeline = app.state.result_pipeline
        repo = EvidenceRepository(scope_id="local-user", principal_id="local-user")
        async with pipeline.database.sessions() as transaction:
            requirements = list(
                (
                    await transaction.scalars(
                        select(CompletionClaimRequirementRecord).where(
                            CompletionClaimRequirementRecord.completion_claim_id == claim_id
                        )
                    )
                ).all()
            )
            assessments = list(
                (
                    await transaction.scalars(
                        select(EvidenceAssessmentRecord).where(
                            EvidenceAssessmentRecord.requirement_id.in_([item.id for item in requirements])
                        )
                    )
                ).all()
            )
            by_requirement = {row.requirement_id: row for row in assessments}
            base = await transaction.scalar(select(DecisionRecord).limit(1))
            assert base is not None
            base_id = base.id
            from backend.app.product_sessions.database import RunRecord

            run_row = await transaction.scalar(select(RunRecord).limit(1))
            assert run_row is not None
            product_run_id = run_row.id
        first = requirements[0]
        # 攻击1的绑定Decision必须在攻击事务外创建（helper自带事务）。
        bound = await _bind_decision_record(
            pipeline.database,
            decision_record_id=base_id,
            claim_id=claim_id,
            commit_status="accepted",
            artifact_disposition="accepted",
        )
        async with pipeline.database.sessions.begin() as transaction:
            # 攻击1：冻结映射指向旧Assessment，重验后调用方试图采用新
            # Assessment——映射与所采用证据不一致，命中记录层守卫。
            claim_record = await repo.get_claim(transaction, claim_id)
            observation = await repo.create_observation(
                transaction,
                kind="validation_result",
                schema_version="validation-result-v1",
                payload={
                    "capability_key": "pytest-suite",
                    "expanded_argv": ["python", "-m", "pytest"],
                    "working_dir": ".",
                    "exit_code": 0,
                    "summary": "revalidated",
                    "duration_ms": 5,
                },
                subject_kind="action_item",
                subject_id=claim_record.subject_id,
                statement="重验通过",
                product_run_id=product_run_id,
                command_id="sd4-p0a-revalidate-obs",
            )
            older = by_requirement[first.id]
            newer = await repo.create_assessment(
                transaction,
                observation_id=observation.id,
                requirement_id=first.id,
                verdict="supports",
                supersedes_assessment_id=older.id,
                assessor_kind="validator",
                assessor_run_id=product_run_id,
                rationale="重验后新结论",
                command_id="sd4-p0a-revalidate-assess",
            )
            try:
                await repo.create_adoption(
                    transaction,
                    claim_id=claim_id,
                    requirement_id=first.id,
                    assessment_id=newer.id,
                    decision_record_id=bound.id,
                    command_id="sd4-p0a-wrong",
                )
                raise AssertionError("错assessment不能被采用")
            except ResultCommitDecisionInvalid:
                pass
            # 攻击2：跨claim。同一Action创建第二个无Artifact的candidate Claim，
            # 绑定它的Decision不能为第一个Claim采用证据。
            other_claim = await repo.create_claim(
                transaction,
                subject_kind="action_item",
                subject_id=claim_record.subject_id,
                from_state="in_progress",
                target_transition="action_result_accepted",
                expected_subject_version=claim_record.expected_subject_version,
                target_state="completed",
                validation_contract_id=claim_record.validation_contract_id,
                requirements=[
                    {
                        "requirement_kind": "validation_result",
                        "mandatory": True,
                        "description": "other claim requirement",
                        "contract_rule_ordinal": 1,
                        "params_json": {},
                        "schema_version": "validation-result-v1",
                    }
                ],
                command_id="sd4-p0a-other-claim",
            )
            cross = await _make_adoption_decision(
                transaction,
                base_decision_record_id=base_id,
                claim_id=other_claim.id,
                requirement_id=first.id,
                assessment_id=by_requirement[first.id].id,
            )
            try:
                await repo.create_adoption(
                    transaction,
                    claim_id=claim_id,
                    requirement_id=first.id,
                    assessment_id=by_requirement[first.id].id,
                    decision_record_id=cross.id,
                    command_id="sd4-p0a-cross",
                )
                raise AssertionError("跨claim Decision不能被采用")
            except ResultCommitDecisionInvalid:
                pass

    asyncio.run(run_attacks())
    assert _count(database_path, "claim_evidence_adoptions") == 0


def test_two_adopted_actions_fail_draft_freeze(tmp_path: Path) -> None:
    """P0-1：两个adopted Action不是“无主体”，Draft冻结必须稳定失败。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        second = client.post(
            "/api/harness/action-items",
            json={
                "command_id": "sd4-two-action",
                "project_id": project["id"],
                "work_item_id": work["id"],
                "title": "第二个并行Action",
                "assignee_kind": "agent",
                "status": "ready",
            },
        )
        assert second.status_code == 201, second.text
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "sd4-two-start",
                        "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                    ),
                )
            )
        )
        plan_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-two-intent", intent_card, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-two-plan", plan_card, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]

    assert run["status"] == "failed"
    assert run["failure_code"] == "REQUEST_VALIDATION_FAILED"
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("ready",)]
    assert _count(database_path, "completion_claims") == 0
    assert _count(database_path, "tool_executions") == 0


def test_parent_work_cancelled_after_claim_blocks_commit(tmp_path: Path) -> None:
    """P0-1：Claim后父Work离开in_progress，commit必须fail closed，Action不完成。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        claim_card = _run_workspace_flow(client, app, session_id, prefix="sd4-pw")
        assert claim_card["committable"] is True
        claim_id = claim_card["claim"]["claim_id"]
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()
        cancelled = client.post(
            f"/api/harness/work-items/{work['id']}/transition",
            json={
                "command_id": "sd4-pw-cancel",
                "expected_row_version": work_view["work_item"]["row_version"],
                "target_status": "cancelled",
                "reason": "用户取消了父Work",
            },
        )
        assert cancelled.status_code == 200, cancelled.text
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-pw-claim", claim_card, "accept"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        claim_view = client.get(f"/api/evidence/claims/{claim_id}").json()
        work_view = client.get(f"/api/harness/work-items/{work['id']}").json()

    assert run["status"] == "failed"
    assert run["failure_code"] == "RESOURCE_VERSION_CONFLICT"
    assert claim_view["status"] == "candidate"
    assert claim_view["result_commit"] is None
    assert work_view["work_item"]["status"] == "cancelled"
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("in_progress",)]
    assert _count(database_path, "result_commits") == 0
    assert _count(database_path, "claim_evidence_adoptions") == 0


def _advance_plan(client: TestClient, work: dict[str, Any], command_id: str) -> None:
    work_view = client.get(f"/api/harness/work-items/{work['id']}").json()
    advanced = client.post(
        f"/api/harness/work-items/{work['id']}/plan-revisions",
        json={
            "command_id": command_id,
            "expected_work_row_version": work_view["work_item"]["row_version"],
            "summary": "advance contract after authorization",
            "nodes": [
                {
                    "key": "implement",
                    "title": "隔离实现",
                    "objective": "推进后的Plan不应影响本Run",
                    "assignee_kind": "agent",
                }
            ],
            "validation_contract": {
                "rules": [
                    {
                        "capability_key": "pytest-suite",
                        "capability_version": "1.0.0",
                        "params": {"targets": ["tests/test_workspace_gate.py"], "extra_args": ["-q"]},
                    }
                ]
            },
            "accept": True,
        },
    )
    assert advanced.status_code == 201, advanced.text


def test_plan_advanced_after_authorization_fails_prepare(tmp_path: Path) -> None:
    """P0-2：授权后prepare前换Plan/推进Work，旧合同不得继续执行（零Claim/零验证）。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "sd4-p02b-start",
                        "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                    ),
                )
            )
        )
        first_model = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent_card,
            prefix="sd4-p02b",
        )
        _advance_plan(client, work, "sd4-p02b-advance")
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        edit_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-p02b-model-one", first_model, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        second_model = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "sd4-p02b-edit", edit_card, "approve"),
                )
            )
        )
        app.state.continuous_workflow.clear_thread_workflow(session_id)
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-p02b-model-two", second_model, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]

    assert run["status"] == "failed"
    assert run["failure_code"] == "RESOURCE_VERSION_CONFLICT"
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("ready",)]
    assert _count(database_path, "completion_claims") == 0
    assert _count(database_path, "validation_runs") == 0
    assert _count(database_path, "result_commits") == 0


def test_plan_advanced_after_claim_fails_commit(tmp_path: Path) -> None:
    """P0-2：Claim后commit前换Plan，Gate必须fail closed（无ResultCommit/Action不完成）。"""

    app = _build_app(tmp_path, passing=True)
    database_path = tmp_path / "continuous-pi.db"
    with TestClient(app) as client:
        project, _binding = _create_project_and_binding(client)
        work, action = _setup_work_plan_action(client, project)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        claim_card = _run_workspace_flow(client, app, session_id, prefix="sd4-p02c")
        assert claim_card["committable"] is True
        claim_id = claim_card["claim"]["claim_id"]
        _advance_plan(client, work, "sd4-p02c-advance")
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "sd4-p02c-claim", claim_card, "accept"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        claim_view = client.get(f"/api/evidence/claims/{claim_id}").json()

    assert run["status"] == "failed"
    assert run["failure_code"] == "RESOURCE_VERSION_CONFLICT"
    assert claim_view["status"] == "candidate"
    assert claim_view["result_commit"] is None
    assert _query(
        database_path,
        "SELECT status FROM action_items WHERE id = ?",
        (action["id"],),
    ) == [("in_progress",)]
    assert _count(database_path, "result_commits") == 0
    assert _count(database_path, "claim_evidence_adoptions") == 0
