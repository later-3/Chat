"""第四轮复审P1-4：治理写入重入复用（Evaluation/Request/Decision/Grant）。"""

from __future__ import annotations

import asyncio
import uuid

from sqlalchemy import func, select

from backend.app.collaboration_intents import models as _ci  # noqa: F401
from backend.app.collaboration_protocols import models as _cp  # noqa: F401
from backend.app.evidence import models as _ev  # noqa: F401
from backend.app.execution_workspaces import models as _ew  # noqa: F401
from backend.app.governance import models as _gov  # noqa: F401
from backend.app.governance.models import (
    AuthorizationGrantRecord,
    DecisionRecord,
    HumanDecisionRequestRecord,
    PolicyEvaluationRecord,
)
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


def _run(coroutine) -> None:  # noqa: ANN001, ANN202
    asyncio.run(coroutine)


async def _seed_run(database: ProductDatabase) -> dict[str, str]:
    ids = {key: str(uuid.uuid4()) for key in ("session", "interaction", "run", "attempt")}
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
                initial_agui_run_id=str(uuid.uuid4()),
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
    return ids


def test_subject_evaluation_request_and_decision_are_reentrant() -> None:
    async def scenario() -> None:
        database = ProductDatabase("sqlite+aiosqlite:///:memory:")
        await database.initialize()
        try:
            governance = ExecutionGovernanceService(database)
            await governance.initialize()
            ids = await _seed_run(database)
            view = {
                "claim_id": str(uuid.uuid4()),
                "claim_hash": "a" * 64,
                "claim_row_version": 1,
                "action_outcomes": {
                    "accept": {
                        "commit_status": "accepted",
                        "artifact_disposition": "accepted",
                        "adoptions": {},
                    }
                },
            }
            subject_first = await governance.register_subject(
                subject_kind="result_candidate",
                resource_id=view["claim_id"],
                resource_revision="1",
                subject_content=view,
                session_id=ids["session"],
                interaction_id=ids["interaction"],
                run_id=ids["run"],
                run_attempt_id=ids["attempt"],
                workflow_definition_id="continuous-collaboration",
                workflow_version="1.8.0",
                node_id="result_claim_decision",
                decision_view=view,
            )
            subject_second = await governance.register_subject(
                subject_kind="result_candidate",
                resource_id=view["claim_id"],
                resource_revision="1",
                subject_content=view,
                session_id=ids["session"],
                interaction_id=ids["interaction"],
                run_id=ids["run"],
                run_attempt_id=ids["attempt"],
                workflow_definition_id="continuous-collaboration",
                workflow_version="1.8.0",
                node_id="result_claim_decision",
                decision_view=view,
            )
            assert subject_first.id == subject_second.id
            scopes = [
                {"kind": "product_default", "ref_id": "*"},
                {"kind": "principal", "ref_id": "local-user"},
                {"kind": "run", "ref_id": ids["run"]},
            ]
            facts = {
                "result": {
                    "evidence_sufficient": True,
                    "external_delivery": False,
                    "changes_long_term_state": True,
                }
            }
            evaluation_first, _ = await governance.evaluate_subject(
                subject=subject_first,
                decision_point_key="result_commit",
                scopes=scopes,
                facts=facts,
            )
            evaluation_second, _ = await governance.evaluate_subject(
                subject=subject_first,
                decision_point_key="result_commit",
                scopes=scopes,
                facts=facts,
            )
            assert evaluation_first.id == evaluation_second.id
            request_first = await governance.create_human_request(
                evaluation=evaluation_first,
                subject=subject_first,
                decision_point_key="result_commit",
                title="确认结果",
                reason="测试",
                evidence={},
                consequence={},
                allowed_actions=["accept", "reject"],
            )
            request_second = await governance.create_human_request(
                evaluation=evaluation_second,
                subject=subject_first,
                decision_point_key="result_commit",
                title="确认结果",
                reason="测试",
                evidence={},
                consequence={},
                allowed_actions=["accept", "reject"],
            )
            assert request_first.id == request_second.id
            assert request_first.request_hash == request_second.request_hash
            record_first, grant_first = await governance.record_automatic_decision(
                evaluation=evaluation_first,
                subject=subject_first,
                decision_code="accept",
                grant_kind="commit_result",
                binding_hash=subject_first.subject_hash,
            )
            record_second, grant_second = await governance.record_automatic_decision(
                evaluation=evaluation_first,
                subject=subject_first,
                decision_code="accept",
                grant_kind="commit_result",
                binding_hash=subject_first.subject_hash,
            )
            assert record_first.id == record_second.id
            assert grant_first is not None and grant_second is not None
            assert grant_first.id == grant_second.id
            async with database.sessions() as txn:
                evaluations = await txn.scalar(select(func.count()).select_from(PolicyEvaluationRecord))
                requests = await txn.scalar(select(func.count()).select_from(HumanDecisionRequestRecord))
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
            assert evaluations == 1
            assert requests == 1
            assert decisions == 1
            assert grants == 1
        finally:
            await database.close()

    _run(scenario())


def test_reentry_conflicts_fail_closed() -> None:
    async def scenario() -> None:
        database = ProductDatabase("sqlite+aiosqlite:///:memory:")
        await database.initialize()
        try:
            import pytest

            from backend.app.governance.errors import GovernanceConflict

            governance = ExecutionGovernanceService(database)
            await governance.initialize()
            ids = await _seed_run(database)
            view = {
                "claim_id": str(uuid.uuid4()),
                "claim_hash": "a" * 64,
                "claim_row_version": 1,
                "action_outcomes": {
                    "accept": {
                        "commit_status": "accepted",
                        "artifact_disposition": "accepted",
                        "adoptions": {},
                    }
                },
            }
            subject = await governance.register_subject(
                subject_kind="result_candidate",
                resource_id=view["claim_id"],
                resource_revision="1",
                subject_content=view,
                session_id=ids["session"],
                interaction_id=ids["interaction"],
                run_id=ids["run"],
                run_attempt_id=ids["attempt"],
                workflow_definition_id="continuous-collaboration",
                workflow_version="1.8.0",
                node_id="result_claim_decision",
                decision_view=view,
            )
            # 同Hash但不同运行归属：冲突而不是误复用。
            with pytest.raises(GovernanceConflict):
                await governance.register_subject(
                    subject_kind="result_candidate",
                    resource_id=view["claim_id"],
                    resource_revision="1",
                    subject_content=view,
                    session_id=ids["session"],
                    interaction_id=ids["interaction"],
                    run_id=str(uuid.uuid4()),
                    run_attempt_id=ids["attempt"],
                    workflow_definition_id="continuous-collaboration",
                    workflow_version="1.8.0",
                    node_id="result_claim_decision",
                    decision_view=view,
                )
            scopes = [
                {"kind": "product_default", "ref_id": "*"},
                {"kind": "principal", "ref_id": "local-user"},
                {"kind": "run", "ref_id": ids["run"]},
            ]
            facts = {
                "result": {
                    "evidence_sufficient": True,
                    "external_delivery": False,
                    "changes_long_term_state": True,
                }
            }
            evaluation, _ = await governance.evaluate_subject(
                subject=subject,
                decision_point_key="result_commit",
                scopes=scopes,
                facts=facts,
            )
            # facts漂移：旧Evaluation不能被新事实复用。
            with pytest.raises(GovernanceConflict):
                await governance.evaluate_subject(
                    subject=subject,
                    decision_point_key="result_commit",
                    scopes=scopes,
                    facts={"result": {"evidence_sufficient": False}},
                )
            request = await governance.create_human_request(
                evaluation=evaluation,
                subject=subject,
                decision_point_key="result_commit",
                title="确认结果",
                reason="测试",
                evidence={"a": 1},
                consequence={"accept": "ok"},
                allowed_actions=["accept", "reject"],
            )
            with pytest.raises(GovernanceConflict):
                await governance.create_human_request(
                    evaluation=evaluation,
                    subject=subject,
                    decision_point_key="result_commit",
                    title="确认结果",
                    reason="测试",
                    evidence={"a": 1},
                    consequence={"accept": "ok"},
                    allowed_actions=["reject"],
                )
            record, grant = await governance.record_automatic_decision(
                evaluation=evaluation,
                subject=subject,
                decision_code="accept",
                grant_kind="commit_result",
                binding_hash=subject.subject_hash,
            )
            assert grant is not None
            # evaluation不一致（伪造另一份Evaluation）必须冲突。
            other_evaluation, _ = await governance.evaluate_subject(
                subject=await governance.register_subject(
                    subject_kind="result_candidate",
                    resource_id=str(uuid.uuid4()),
                    resource_revision="1",
                    subject_content=view,
                    session_id=ids["session"],
                    interaction_id=ids["interaction"],
                    run_id=ids["run"],
                    run_attempt_id=ids["attempt"],
                    workflow_definition_id="continuous-collaboration",
                    workflow_version="1.8.0",
                    node_id="result_claim_decision",
                    decision_view=view,
                ),
                decision_point_key="result_commit",
                scopes=scopes,
                facts=facts,
            )
            with pytest.raises(GovernanceConflict):
                await governance.record_automatic_decision(
                    evaluation=other_evaluation,
                    subject=subject,
                    decision_code="accept",
                    grant_kind="commit_result",
                    binding_hash=subject.subject_hash,
                )
            assert request.id
            assert record.id
        finally:
            await database.close()

    _run(scenario())


def test_exact_reentry_attacks_hit_every_drift_dimension() -> None:
    async def scenario() -> None:
        database = ProductDatabase("sqlite+aiosqlite:///:memory:")
        await database.initialize()
        try:
            import pytest

            from backend.app.governance.errors import GovernanceConflict

            governance = ExecutionGovernanceService(database)
            await governance.initialize()
            ids = await _seed_run(database)
            view = {
                "claim_id": str(uuid.uuid4()),
                "claim_hash": "a" * 64,
                "claim_row_version": 1,
                "action_outcomes": {
                    "accept": {
                        "commit_status": "accepted",
                        "artifact_disposition": "accepted",
                        "adoptions": {},
                    }
                },
            }
            subject = await governance.register_subject(
                subject_kind="result_candidate",
                resource_id=view["claim_id"],
                resource_revision="1",
                subject_content=view,
                session_id=ids["session"],
                interaction_id=ids["interaction"],
                run_id=ids["run"],
                run_attempt_id=ids["attempt"],
                workflow_definition_id="continuous-collaboration",
                workflow_version="1.8.0",
                node_id="result_claim_decision",
                decision_view=view,
            )
            # 1) subject_content hash漂移：同资源revision、不同内容——冲突而不是第二个Subject。
            with pytest.raises(GovernanceConflict):
                await governance.register_subject(
                    subject_kind="result_candidate",
                    resource_id=view["claim_id"],
                    resource_revision="1",
                    subject_content={**view, "claim_hash": "b" * 64},
                    session_id=ids["session"],
                    interaction_id=ids["interaction"],
                    run_id=ids["run"],
                    run_attempt_id=ids["attempt"],
                    workflow_definition_id="continuous-collaboration",
                    workflow_version="1.8.0",
                    node_id="result_claim_decision",
                    decision_view=view,
                )
            scopes = [
                {"kind": "product_default", "ref_id": "*"},
                {"kind": "principal", "ref_id": "local-user"},
                {"kind": "run", "ref_id": ids["run"]},
            ]
            facts = {
                "result": {
                    "evidence_sufficient": True,
                    "external_delivery": False,
                    "changes_long_term_state": False,
                }
            }
            # Run作用域自动规则：两次评估final_action相同，但matched rules引用不同。
            await governance.activate_policy(
                scope_kind="run",
                scope_ref_id=ids["run"],
                scope_ref_revision=None,
                rules=[
                    {
                        "decision_point_key": "result_commit",
                        "mode": "auto_continue",
                        "reason": "规则引用漂移攻击",
                    }
                ],
                expected_active_revision_id=None,
                change_summary="规则引用漂移攻击",
            )
            evaluation, _ = await governance.evaluate_subject(
                subject=subject,
                decision_point_key="result_commit",
                scopes=scopes,
                facts=facts,
            )
            # 2) scope漂移：final_action相同但matched rules引用不同——冲突。
            with pytest.raises(GovernanceConflict):
                await governance.evaluate_subject(
                    subject=subject,
                    decision_point_key="result_commit",
                    scopes=[{"kind": "product_default", "ref_id": "*"}],
                    facts=facts,
                )
            record, grant = await governance.record_automatic_decision(
                evaluation=evaluation,
                subject=subject,
                decision_code="accept",
                grant_kind="commit_result",
                binding_hash=subject.subject_hash,
            )
            assert grant is not None
            # 3) binding_hash漂移：Grant绑定不一致——冲突。
            with pytest.raises(GovernanceConflict):
                await governance.record_automatic_decision(
                    evaluation=evaluation,
                    subject=subject,
                    decision_code="accept",
                    grant_kind="commit_result",
                    binding_hash="f" * 64,
                )
            # 4) constraints漂移：Grant constraints不一致——冲突。
            with pytest.raises(GovernanceConflict):
                await governance.record_automatic_decision(
                    evaluation=evaluation,
                    subject=subject,
                    decision_code="accept",
                    grant_kind="commit_result",
                    binding_hash=subject.subject_hash,
                    constraints={"max_cost": 1},
                )
            # 5) evaluation与Subject不匹配——直接冲突。
            other_subject = await governance.register_subject(
                subject_kind="result_candidate",
                resource_id=str(uuid.uuid4()),
                resource_revision="1",
                subject_content=view,
                session_id=ids["session"],
                interaction_id=ids["interaction"],
                run_id=ids["run"],
                run_attempt_id=ids["attempt"],
                workflow_definition_id="continuous-collaboration",
                workflow_version="1.8.0",
                node_id="result_claim_decision",
                decision_view=view,
            )
            with pytest.raises(GovernanceConflict):
                await governance.record_automatic_decision(
                    evaluation=evaluation,
                    subject=other_subject,
                    decision_code="accept",
                    grant_kind=None,
                    binding_hash=other_subject.subject_hash,
                )
            assert record.id
        finally:
            await database.close()

    _run(scenario())


def test_decision_subject_identity_unique_at_schema_and_translation() -> None:
    async def scenario() -> None:
        database = ProductDatabase("sqlite+aiosqlite:///:memory:")
        await database.initialize()
        try:
            import pytest
            from sqlalchemy import text
            from sqlalchemy.exc import IntegrityError

            from backend.app.governance.models import DecisionSubjectRecord

            # Schema级：迁移后的逻辑身份唯一索引存在于内存Schema。
            async with database.sessions() as txn:
                indexes = await txn.execute(text("PRAGMA index_list('decision_subjects')"))
                names = {row[1] for row in indexes.fetchall()}
            assert "uq_decision_subjects_identity" in names

            governance = ExecutionGovernanceService(database)
            await governance.initialize()
            ids = await _seed_run(database)
            view = {
                "claim_id": str(uuid.uuid4()),
                "claim_hash": "a" * 64,
                "claim_row_version": 1,
                "action_outcomes": {
                    "accept": {
                        "commit_status": "accepted",
                        "artifact_disposition": "accepted",
                        "adoptions": {},
                    }
                },
            }
            subject = await governance.register_subject(
                subject_kind="result_candidate",
                resource_id=view["claim_id"],
                resource_revision="1",
                subject_content=view,
                session_id=ids["session"],
                interaction_id=ids["interaction"],
                run_id=ids["run"],
                run_attempt_id=ids["attempt"],
                workflow_definition_id="continuous-collaboration",
                workflow_version="1.8.0",
                node_id="result_claim_decision",
                decision_view=view,
            )

            # 约束级：同逻辑身份不同hash的并发形状直接INSERT被数据库拒绝。
            async def raw_insert() -> None:
                async with database.sessions.begin() as txn:
                    txn.add(
                        DecisionSubjectRecord(
                            id=str(uuid.uuid4()),
                            subject_kind="result_candidate",
                            resource_id=view["claim_id"],
                            resource_revision="1",
                            subject_hash="c" * 64,
                            session_id=ids["session"],
                            decision_view_json={},
                        )
                    )

            with pytest.raises(IntegrityError):
                await raw_insert()
            # 应用层内容漂移冲突已由
            # test_exact_reentry_attacks_hit_every_drift_dimension覆盖；
            # 新唯一索引下同身份不同内容已无法落库，翻译路径只服务真实并发竞争。
            assert subject.id
        finally:
            await database.close()

    _run(scenario())


def test_register_subject_flush_race_translates_to_governance_conflict(tmp_path) -> None:
    """受控flush竞争：另一连接在同一逻辑身份下抢先落库，register_subject稳定翻译。

    通过生产 ``register_subject`` 的真实flush路径：第一个连接SELECT时看不到
    竞争行，flush前由第二个独立连接插入同逻辑身份的不同内容Subject，
    唯一索引触发IntegrityError，服务层必须翻译为稳定的GovernanceConflict。
    """

    async def scenario() -> None:
        import pytest

        from backend.app.governance.errors import GovernanceConflict
        from backend.app.governance.models import DecisionSubjectRecord

        url = f"sqlite+aiosqlite:///{tmp_path / 'identity-race.db'}"
        database = ProductDatabase(url)
        competitor = ProductDatabase(url)
        await database.initialize()
        await competitor.initialize()
        try:
            governance = ExecutionGovernanceService(database)
            await governance.initialize()
            ids = await _seed_run(database)
            view = {
                "claim_id": str(uuid.uuid4()),
                "claim_hash": "a" * 64,
                "claim_row_version": 1,
                "action_outcomes": {
                    "accept": {
                        "commit_status": "accepted",
                        "artifact_disposition": "accepted",
                        "adoptions": {},
                    }
                },
            }
            async with competitor.sessions.begin() as txn:
                from backend.app.product_sessions.database import SessionRecord

                txn.add(
                    SessionRecord(
                        id="competitor-session",
                        scope_id="local-user",
                        channel="web",
                        title="t",
                        status="running",
                        revision=1,
                    )
                )

            original_begin = database.sessions.begin

            def hooked_begin():
                context = original_begin()

                class _HookedSession:
                    def __init__(self, session) -> None:
                        self._session = session
                        self._injected = False

                    def __getattr__(self, name: str):
                        return getattr(self._session, name)

                    async def flush(self) -> None:
                        if not self._injected:
                            self._injected = True
                            # 竞争写入者：同逻辑身份、不同内容/Hash，先于我们落库。
                            async with competitor.sessions.begin() as other:
                                other.add(
                                    DecisionSubjectRecord(
                                        id=str(uuid.uuid4()),
                                        subject_kind="result_candidate",
                                        resource_id=view["claim_id"],
                                        resource_revision="1",
                                        subject_hash="c" * 64,
                                        session_id="competitor-session",
                                        decision_view_json={"competitor": True},
                                    )
                                )
                        await self._session.flush()

                class _HookedContext:
                    async def __aenter__(self):
                        self._hooked = _HookedSession(await context.__aenter__())
                        return self._hooked

                    async def __aexit__(self, *args):
                        return await context.__aexit__(*args)

                return _HookedContext()

            database.sessions.begin = hooked_begin  # type: ignore[method-assign]
            try:
                with pytest.raises(GovernanceConflict, match="并发注册冲突"):
                    await governance.register_subject(
                        subject_kind="result_candidate",
                        resource_id=view["claim_id"],
                        resource_revision="1",
                        subject_content=view,
                        session_id=ids["session"],
                        interaction_id=ids["interaction"],
                        run_id=ids["run"],
                        run_attempt_id=ids["attempt"],
                        workflow_definition_id="continuous-collaboration",
                        workflow_version="1.8.0",
                        node_id="result_claim_decision",
                        decision_view=view,
                    )
            finally:
                database.sessions.begin = original_begin  # type: ignore[method-assign]
        finally:
            await database.close()
            await competitor.close()

    _run(scenario())


def test_non_identity_integrity_error_is_not_mistranslated() -> None:
    async def scenario() -> None:
        import pytest
        from sqlalchemy.exc import IntegrityError

        database = ProductDatabase("sqlite+aiosqlite:///:memory:")
        await database.initialize()
        try:
            governance = ExecutionGovernanceService(database)
            await governance.initialize()
            ids = await _seed_run(database)
            view = {
                "claim_id": str(uuid.uuid4()),
                "claim_hash": "a" * 64,
                "claim_row_version": 1,
                "action_outcomes": {
                    "accept": {
                        "commit_status": "accepted",
                        "artifact_disposition": "accepted",
                        "adoptions": {},
                    }
                },
            }
            # session_id指向不存在的会话：FK IntegrityError必须原样抛出，
            # 不能被误报成“相同Subject并发注册冲突”。
            with pytest.raises(IntegrityError):
                await governance.register_subject(
                    subject_kind="result_candidate",
                    resource_id=view["claim_id"],
                    resource_revision="1",
                    subject_content=view,
                    session_id=str(uuid.uuid4()),
                    interaction_id=ids["interaction"],
                    run_id=ids["run"],
                    run_attempt_id=ids["attempt"],
                    workflow_definition_id="continuous-collaboration",
                    workflow_version="1.8.0",
                    node_id="result_claim_decision",
                    decision_view=view,
                )
        finally:
            await database.close()

    _run(scenario())
