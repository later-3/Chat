"""P1-6 failure-boundary tests for the result claim prepare executor."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

import backend.app.main  # noqa: F401  # 先初始化完整应用包，避免直接导入Executor的循环依赖
from backend.app.execution_dispatch.result_gate import (
    ResultClaimDecisionExecutor,
    ResultClaimPrepareExecutor,
)
from backend.app.workflows.continuous_chat_contracts import CollaborationState


class _StubSessions:
    database = None

    def __init__(self) -> None:
        self.failures: list[dict[str, Any]] = []

    async def fail_active_run(self, thread_id: str, *, error_code: str, message: str) -> None:
        self.failures.append({"thread_id": thread_id, "error_code": error_code, "message": message})


class _StubPipeline:
    def __init__(self, error: Exception) -> None:
        self._error = error

    async def prepare(self, **kwargs: Any) -> dict[str, Any]:
        raise self._error


class _StubContext:
    async def send_message(self, message: Any) -> None:  # pragma: no cover - never reached
        raise AssertionError("失败边界不应继续发送状态")


def _run(coroutine) -> None:  # noqa: ANN001, ANN202
    asyncio.run(coroutine)


def test_missing_execution_id_fails_run_with_stable_code() -> None:
    sessions = _StubSessions()
    executor = ResultClaimPrepareExecutor(
        thread_id="thread-1",
        run_id=lambda: "run-1",
        sessions=sessions,  # type: ignore[arg-type]
        result_pipeline=_StubPipeline(RuntimeError("unused")),  # type: ignore[arg-type]
    )
    state = CollaborationState(origin_prompt="test", execution_workspace=None)
    with pytest.raises(Exception, match="结果证据门缺少pi ToolExecution"):
        _run(executor.prepare(state, _StubContext()))
    assert sessions.failures == [
        {
            "thread_id": "thread-1",
            "error_code": "RESULT_GATE_EXECUTION_MISSING",
            "message": "结果证据门缺少pi ToolExecution",
        }
    ]


def test_unknown_exception_uses_stable_code_and_sanitized_message() -> None:
    sessions = _StubSessions()
    secret = RuntimeError("sqlite deadlock at /Users/xulater/private/db.sqlite3: trace xyz")
    executor = ResultClaimPrepareExecutor(
        thread_id="thread-1",
        run_id=lambda: "run-1",
        sessions=sessions,  # type: ignore[arg-type]
        result_pipeline=_StubPipeline(secret),  # type: ignore[arg-type]
    )
    state = CollaborationState(
        origin_prompt="test",
        execution_workspace={"execution_id": "exec-1"},
    )
    with pytest.raises(RuntimeError):
        _run(executor.prepare(state, _StubContext()))
    assert len(sessions.failures) == 1
    failure = sessions.failures[0]
    assert failure["error_code"] == "RESULT_CLAIM_PREPARE_FAILED"
    assert "/Users/" not in failure["message"]
    assert "sqlite" not in failure["message"]


def test_domain_error_code_is_preserved_with_original_message() -> None:
    from backend.app.evidence.contracts import ResultEvidencePrerequisiteMissing

    sessions = _StubSessions()
    executor = ResultClaimPrepareExecutor(
        thread_id="thread-1",
        run_id=lambda: "run-1",
        sessions=sessions,  # type: ignore[arg-type]
        result_pipeline=_StubPipeline(  # type: ignore[arg-type]
            ResultEvidencePrerequisiteMissing("Artifact Store未配置，不能形成完成Artifact")
        ),
    )
    state = CollaborationState(
        origin_prompt="test",
        execution_workspace={"execution_id": "exec-1"},
    )
    with pytest.raises(ResultEvidencePrerequisiteMissing):
        _run(executor.prepare(state, _StubContext()))
    assert sessions.failures == [
        {
            "thread_id": "thread-1",
            "error_code": "RESULT_EVIDENCE_PREREQUISITE_MISSING",
            "message": "Artifact Store未配置，不能形成完成Artifact",
        }
    ]


class _StubPipeline:
    def __init__(
        self,
        error: Exception | None = None,
        *,
        fail_first_commit: bool = False,
        snapshot_overrides: dict[str, Any] | None = None,
    ) -> None:
        self._error = error
        self._fail_first = fail_first_commit
        self._overrides = snapshot_overrides or {}
        self.commit_calls: list[dict[str, Any]] = []

    async def prepare(self, **kwargs: Any) -> dict[str, Any]:
        if self._error is None:
            raise AssertionError("prepare不应被调用")
        raise self._error

    async def claim_snapshot(self, claim_id: str) -> dict[str, Any]:
        snapshot = {
            "claim_id": claim_id,
            "claim_hash": "a" * 64,
            "claim_row_version": 1,
            "status": "candidate",
            "artifact_revision_id": None,
            "artifact_revision_current": None,
        }
        snapshot.update(self._overrides)
        return snapshot

    async def committable(self, claim_id: str) -> bool:
        return True

    async def adoption_map(self, claim_id: str) -> dict[str, str]:
        return {}

    async def claim_outcome(self, claim_id: str) -> dict[str, Any]:
        return {"result_commit": None}

    async def commit(self, **kwargs: Any) -> dict[str, Any]:
        self.commit_calls.append(kwargs)
        if self._fail_first and len(self.commit_calls) == 1:
            raise RuntimeError("simulated crash after Decision/Grant write at /Users/xulater/private/db")
        return {
            "result_commit_id": "rc-1",
            "claim": {"status": "committed"},
            "commit_status": "accepted",
            "committed_subject_state": "completed",
        }


class _GateSessions(_StubSessions):
    async def mark_waiting_approval(self, thread_id: str, **kwargs: Any) -> None:
        return None

    async def record_trace(self, *args: Any, **kwargs: Any) -> None:
        return None


class _GateContext:
    def __init__(self) -> None:
        self.messages: list[Any] = []
        self.requests: list[Any] = []

    async def send_message(self, message: Any) -> None:
        self.messages.append(message)

    async def request_info(self, card: Any, _type: Any, request_id: str | None = None) -> None:
        self.requests.append(card)


async def _seed_governance_runtime():
    import uuid as _uuid

    from backend.app.collaboration_intents import models as _ci  # noqa: F401
    from backend.app.collaboration_protocols import models as _cp  # noqa: F401
    from backend.app.evidence import models as _ev  # noqa: F401
    from backend.app.execution_workspaces import models as _ew  # noqa: F401
    from backend.app.governance import models as _gov  # noqa: F401
    from backend.app.governance.service import ExecutionGovernanceService
    from backend.app.harness import models as _har  # noqa: F401
    from backend.app.product_sessions.database import (
        InteractionRecord,
        ProductDatabase,
        RunAttemptRecord,
        RunRecord,
        SessionRecord,
    )
    from backend.app.project_resources import models as _pr  # noqa: F401
    from backend.app.runtime_execution import models as _re  # noqa: F401
    from backend.app.step_inputs import models as _si  # noqa: F401
    from backend.app.tool_execution import models as _te  # noqa: F401

    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    await database.initialize()
    governance = ExecutionGovernanceService(database)
    await governance.initialize()
    ids = {key: str(_uuid.uuid4()) for key in ("session", "interaction", "run", "attempt")}
    async with database.sessions.begin() as txn:
        txn.add(
            SessionRecord(
                id=ids["session"],
                scope_id="local-user",
                channel="web",
                title="t",
                status="running",
                revision=1,
            )
        )
    async with database.sessions.begin() as txn:
        txn.add(
            InteractionRecord(
                id=ids["interaction"],
                session_id=ids["session"],
                user_message_id="m-1",
                status="accepted",
            )
        )
    async with database.sessions.begin() as txn:
        txn.add(
            RunRecord(
                id=ids["run"],
                session_id=ids["session"],
                interaction_id=ids["interaction"],
                initial_agui_run_id=str(_uuid.uuid4()),
                request_hash="r" * 64,
                status="running",
                current_user_message_id="m-1",
            )
        )
    async with database.sessions.begin() as txn:
        txn.add(
            RunAttemptRecord(
                id=ids["attempt"],
                run_id=ids["run"],
                attempt_number=1,
                runtime_kind="workflow",
                status="running",
            )
        )
    return database, governance, ids


def _gate_state() -> CollaborationState:
    return CollaborationState(
        origin_prompt="test",
        scenario="continue_project",
        result_claim={"claim_id": "claim-1", "committable": True},
    )


def test_decide_twice_reuses_single_evaluation_and_request() -> None:
    async def scenario() -> None:
        from sqlalchemy import func, select

        from backend.app.governance.models import (
            HumanDecisionRequestRecord,
            PolicyEvaluationRecord,
        )

        database, governance, ids = await _seed_governance_runtime()
        try:
            executor = ResultClaimDecisionExecutor(
                thread_id=ids["session"],
                run_id=lambda: ids["run"],
                sessions=_GateSessions(),  # type: ignore[arg-type]
                governance=governance,
                result_pipeline=_StubPipeline(),  # type: ignore[arg-type]
            )
            first_ctx = _GateContext()
            await executor.decide(_gate_state(), first_ctx)
            second_ctx = _GateContext()
            await executor.decide(_gate_state(), second_ctx)
            assert len(first_ctx.requests) == 1
            assert len(second_ctx.requests) == 1
            assert (
                first_ctx.requests[0]["decision_request_id"]
                == (second_ctx.requests[0]["decision_request_id"])
            )
            assert first_ctx.requests[0]["request_hash"] == second_ctx.requests[0]["request_hash"]
            async with database.sessions() as txn:
                evaluations = await txn.scalar(select(func.count()).select_from(PolicyEvaluationRecord))
                requests = await txn.scalar(select(func.count()).select_from(HumanDecisionRequestRecord))
            assert evaluations == 1
            assert requests == 1
        finally:
            await database.close()

    _run(scenario())


def test_auto_path_crash_reentry_reuses_decision_grant_and_commit() -> None:
    async def scenario() -> None:
        from sqlalchemy import func, select

        from backend.app.governance.models import AuthorizationGrantRecord, DecisionRecord

        database, governance, ids = await _seed_governance_runtime()
        try:
            await governance.activate_policy(
                scope_kind="principal",
                scope_ref_id="local-user",
                scope_ref_revision=None,
                rules=[
                    {
                        "decision_point_key": "result_commit",
                        "mode": "auto_continue",
                        "reason": "自动路径重入测试",
                    }
                ],
                expected_active_revision_id=None,
                change_summary="自动路径重入测试",
            )
            sessions = _GateSessions()
            pipeline = _StubPipeline(fail_first_commit=True)
            executor = ResultClaimDecisionExecutor(
                thread_id=ids["session"],
                run_id=lambda: ids["run"],
                sessions=sessions,  # type: ignore[arg-type]
                governance=governance,
                result_pipeline=pipeline,  # type: ignore[arg-type]
            )
            with pytest.raises(RuntimeError):
                await executor.decide(_gate_state(), _GateContext())
            assert sessions.failures, "故障后应记录Run失败边界"
            failure = sessions.failures[0]
            assert failure["error_code"] == "RESULT_CLAIM_DECISION_FAILED"
            assert "/Users/" not in failure["message"]
            assert "sqlite" not in failure["message"]
            ctx = _GateContext()
            await executor.decide(_gate_state(), ctx)
            assert len(pipeline.commit_calls) == 2
            assert (
                pipeline.commit_calls[0]["decision_record_id"]
                == (pipeline.commit_calls[1]["decision_record_id"])
            )
            async with database.sessions() as txn:
                decisions = await txn.scalar(
                    select(func.count())
                    .select_from(DecisionRecord)
                    .where(DecisionRecord.decision_code == "accept")
                )
                grants = await txn.scalar(
                    select(func.count())
                    .select_from(AuthorizationGrantRecord)
                    .where(AuthorizationGrantRecord.grant_kind == "commit_result")
                )
            assert decisions == 1
            assert grants == 1
            assert ctx.messages, "重进后应完成提交流程"
        finally:
            await database.close()

    _run(scenario())


class _StubRepositoryContext:
    async def resolve_fence(self, **kwargs: Any) -> Any:
        raise RuntimeError("git probe leaked /Users/xulater/private/repo onto stderr")


def test_draft_compiler_unknown_error_uses_stable_code_and_sanitized_message() -> None:
    from backend.app.workflows.continuous_chat import ExecutionDraftCompilerExecutor

    sessions = _StubSessions()
    executor = ExecutionDraftCompilerExecutor(
        thread_id="thread-1",
        run_id=lambda: "run-1",
        sessions=sessions,  # type: ignore[arg-type]
        governance=None,  # type: ignore[arg-type]
        repository_execution_context=_StubRepositoryContext(),  # type: ignore[arg-type]
        pi_available=True,
        validation_planner=None,  # type: ignore[arg-type]
    )
    state = CollaborationState(
        origin_prompt="修改代码",
        selected_project_id="project-1",
        context_items=(
            {
                "source_kind": "repository_snapshot",
                "source_id": "binding-1",
                "source_revision": "a" * 64,
                "adopted": True,
            },
        ),
    )

    class _Ctx:
        async def send_message(self, message: Any) -> None:
            raise AssertionError("失败边界不应继续发送状态")

    with pytest.raises(RuntimeError):
        _run(executor.compile(state, _Ctx()))
    assert len(sessions.failures) == 1
    failure = sessions.failures[0]
    assert failure["error_code"] == "EXECUTION_DRAFT_COMPILE_FAILED"
    assert "/Users/" not in failure["message"]


def test_decision_view_uses_authoritative_snapshot_not_workflow_state() -> None:
    """P1：state丢失artifact_revision_id时，disposition仍按DB权威Claim形成。"""

    async def scenario() -> None:
        database, governance, ids = await _seed_governance_runtime()
        try:
            from sqlalchemy import select

            from backend.app.governance.models import DecisionSubjectRecord

            pipeline = _StubPipeline(
                snapshot_overrides={
                    "artifact_revision_id": "revision-1",
                    "artifact_revision_current": True,
                }
            )
            executor = ResultClaimDecisionExecutor(
                thread_id=ids["session"],
                run_id=lambda: ids["run"],
                sessions=_GateSessions(),  # type: ignore[arg-type]
                governance=governance,
                result_pipeline=pipeline,  # type: ignore[arg-type]
            )
            # Workflow state被篡改/丢失：没有artifact_revision_id。
            state = CollaborationState(
                origin_prompt="test",
                scenario="continue_project",
                result_claim={"claim_id": "claim-1", "committable": True},
            )
            ctx = _GateContext()
            await executor.decide(state, ctx)
            async with database.sessions() as txn:
                subject = await txn.scalar(select(DecisionSubjectRecord))
                assert subject is not None
                view = subject.decision_view_json
            assert view["action_outcomes"]["accept"]["artifact_disposition"] == "accepted"
            assert view["action_outcomes"]["reject"]["artifact_disposition"] == "rejected"
        finally:
            await database.close()

    _run(scenario())


def test_superseded_revision_freezes_reject_none_and_commits() -> None:
    """P1：绑定Revision已替代时reject冻结none，独立拒绝路径成功。"""

    async def scenario() -> None:
        database, governance, ids = await _seed_governance_runtime()
        try:
            from sqlalchemy import select

            from backend.app.governance.models import DecisionSubjectRecord

            pipeline = _StubPipeline(
                snapshot_overrides={
                    "artifact_revision_id": "revision-1",
                    "artifact_revision_current": False,
                }
            )
            executor = ResultClaimDecisionExecutor(
                thread_id=ids["session"],
                run_id=lambda: ids["run"],
                sessions=_GateSessions(),  # type: ignore[arg-type]
                governance=governance,
                result_pipeline=pipeline,  # type: ignore[arg-type]
            )
            ctx = _GateContext()
            await executor.decide(_gate_state(), ctx)
            assert len(ctx.requests) == 1
            async with database.sessions() as txn:
                subject = await txn.scalar(select(DecisionSubjectRecord))
                assert subject is not None
                view = subject.decision_view_json
            assert view["action_outcomes"]["reject"]["artifact_disposition"] == "none"
            # 用户拒绝：以冻结的none处置走独立拒绝路径。
            resolved = {"decision": "reject", "decision_record_id": "d-1", "binding_hash": "b"}
            original_request = dict(ctx.requests[0])
            original_request["decision_recorded"] = True

            class _ResolvedGovernance:
                def __init__(self, inner):
                    self._inner = inner

                def __getattr__(self, name):
                    return getattr(self._inner, name)

                async def resolved_human_request(self, request_id):
                    return [resolved]

            executor._governance = _ResolvedGovernance(governance)  # noqa: SLF001
            resume_ctx = _GateContext()
            await executor.resolve(original_request, {"decision": "reject"}, resume_ctx)
            [commit_call] = pipeline.commit_calls
            assert commit_call["commit_status"] == "rejected"
            assert commit_call["artifact_disposition"] == "none"
        finally:
            await database.close()

    _run(scenario())


def test_no_artifact_claim_accept_freezes_none_and_commits() -> None:
    """P1：无Artifact Claim的accept冻结none；state伪装有artifact也以DB为准。"""

    async def scenario() -> None:
        database, governance, ids = await _seed_governance_runtime()
        try:
            from sqlalchemy import select

            from backend.app.governance.models import DecisionSubjectRecord

            pipeline = _StubPipeline(
                snapshot_overrides={
                    "artifact_revision_id": None,
                    "artifact_revision_current": None,
                }
            )
            executor = ResultClaimDecisionExecutor(
                thread_id=ids["session"],
                run_id=lambda: ids["run"],
                sessions=_GateSessions(),  # type: ignore[arg-type]
                governance=governance,
                result_pipeline=pipeline,  # type: ignore[arg-type]
            )
            # Workflow state伪装“有artifact”：decision view仍按DB冻结accept→none。
            state = CollaborationState(
                origin_prompt="test",
                scenario="continue_project",
                result_claim={
                    "claim_id": "claim-1",
                    "committable": True,
                    "artifact_revision_id": "forged-by-state",
                },
            )
            ctx = _GateContext()
            await executor.decide(state, ctx)
            async with database.sessions() as txn:
                subject = await txn.scalar(select(DecisionSubjectRecord))
                assert subject is not None
                view = subject.decision_view_json
            assert view["action_outcomes"]["accept"]["artifact_disposition"] == "none"
            assert view["action_outcomes"]["reject"]["artifact_disposition"] == "none"

            resolved = {"decision": "accept", "decision_record_id": "d-1", "binding_hash": "b"}
            original_request = dict(ctx.requests[0])
            original_request["decision_recorded"] = True

            class _ResolvedGovernance:
                def __init__(self, inner):
                    self._inner = inner

                def __getattr__(self, name):
                    return getattr(self._inner, name)

                async def resolved_human_request(self, request_id):
                    return [resolved]

            executor._governance = _ResolvedGovernance(governance)  # noqa: SLF001
            resume_ctx = _GateContext()
            await executor.resolve(original_request, {"decision": "accept"}, resume_ctx)
            [commit_call] = pipeline.commit_calls
            assert commit_call["commit_status"] == "accepted"
            assert commit_call["artifact_disposition"] == "none"
        finally:
            await database.close()

    _run(scenario())


class _GrantSpyingGovernance:
    def __init__(self, inner, resolved: dict[str, Any]) -> None:
        self._inner = inner
        self._resolved = resolved
        self.grant_consumptions = 0

    def __getattr__(self, name: str):
        return getattr(self._inner, name)

    async def resolved_human_request(self, request_id: str):
        return [self._resolved]

    async def claim_grant(self, **kwargs: Any):
        self.grant_consumptions += 1
        return await self._inner.claim_grant(**kwargs)


def _forged_card(claim: dict[str, Any]) -> dict[str, Any]:
    return {
        "decision_request_id": "req-1",
        "request_hash": "h" * 64,
        "row_version": 1,
        "claim": claim,
        "execution_context": {
            "workflow_state": {
                "origin_prompt": "test",
                "scenario": "continue_project",
                "result_claim": {"claim_id": "claim-1", "committable": True},
            }
        },
    }


@pytest.mark.parametrize(
    ("decision", "claim_patch"),
    (
        ("accept", {"accept_artifact_disposition": None}),
        ("accept", {"accept_artifact_disposition": "rejected"}),
        ("accept", {}),
        ("reject", {"reject_artifact_disposition": None}),
        ("reject", {"reject_artifact_disposition": "accepted"}),
        ("reject", {}),
    ),
)
def test_missing_or_illegal_frozen_disposition_never_commits(decision, claim_patch) -> None:
    async def scenario() -> None:
        database, governance, ids = await _seed_governance_runtime()
        try:
            from backend.app.execution_dispatch.result_gate import ExecutionDispatchError

            pipeline = _StubPipeline(
                snapshot_overrides={
                    "artifact_revision_id": "revision-1",
                    "artifact_revision_current": True,
                }
            )
            executor = ResultClaimDecisionExecutor(
                thread_id=ids["session"],
                run_id=lambda: ids["run"],
                sessions=_GateSessions(),  # type: ignore[arg-type]
                governance=governance,
                result_pipeline=pipeline,  # type: ignore[arg-type]
            )
            state = _gate_state()
            ctx = _GateContext()
            await executor.decide(state, ctx)
            assert len(ctx.requests) == 1
            card = dict(ctx.requests[0])
            # 纂改冻结卡：删除或伪造处置字段。
            claim = dict(card["claim"])
            claim.pop("accept_artifact_disposition", None)
            claim.pop("reject_artifact_disposition", None)
            claim.update(claim_patch)
            forged = _forged_card(claim)
            spying = _GrantSpyingGovernance(
                governance,
                {
                    "decision": decision,
                    "decision_record_id": "d-1",
                    "binding_hash": "b",
                    "authorization_grant_id": "g-1",
                },
            )
            executor._governance = spying  # noqa: SLF001
            with pytest.raises(ExecutionDispatchError) as raised:
                await executor.resolve(
                    forged,
                    {"decision": decision, "decision_recorded": True},
                    _GateContext(),
                )
            assert raised.value.code == "RESULT_CLAIM_FROZEN_DISPOSITION_INVALID"
            assert pipeline.commit_calls == []
            assert spying.grant_consumptions == 0
        finally:
            await database.close()

    _run(scenario())
