"""SD4-C Result Commit Gate tests: single-transaction completion claims.

Covers design doc §9.1 and failure matrix 6-11, 13, 17, 19-20: accepted /
waived / rejected outcomes, evidence and artifact re-checks, applicability
branches, subject CAS, decision binding, forge protection and rollback
atomicity.  Real ArtifactStore bytes back the blob re-check tests; the gate
never mocks the hash it claims to verify.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend.app.collaboration_intents import models as _ci  # noqa: F401
from backend.app.collaboration_protocols import models as _cp  # noqa: F401

# Import every model module so the in-memory create_all schema is complete and
# deterministic regardless of test execution order (反例035).
from backend.app.config import Settings
from backend.app.evidence import models as _ev  # noqa: F401
from backend.app.evidence.artifact_store import ArtifactCoordinator, ArtifactStore
from backend.app.evidence.contracts import (
    ArtifactApplicabilityStale,
    ArtifactHashMismatch,
    ArtifactRevisionSuperseded,
    CompletionClaimAlreadyResolved,
    CompletionRequirementUnsatisfied,
    EvidenceConflict,
    EvidenceInvalid,
    EvidenceNotFound,
    EvidenceValidationError,
    ResultCommitDecisionInvalid,
)
from backend.app.evidence.models import (
    ArtifactBlobRecord,
    CompletionClaimRequirementRecord,
    EvidenceObservationRecord,
    ProvenanceEdgeRecord,
    ResultCommitRecord,
    SourceInvalidationRecord,
)
from backend.app.evidence.result_commit import ResultCommitCoordinator
from backend.app.evidence.service import EvidenceRepository
from backend.app.execution_workspaces import models as _ew  # noqa: F401
from backend.app.governance import models as _gov  # noqa: F401
from backend.app.governance.models import (
    DecisionPointDefinitionRecord,
    DecisionRecord,
    DecisionSubjectRecord,
    PolicyEvaluationRecord,
)
from backend.app.harness import models as _har  # noqa: F401
from backend.app.harness.commands import HarnessCommandRecorder
from backend.app.harness.contracts import HarnessConflict, HarnessValidationError
from backend.app.harness.models import ActionItemRecord, WorkItemRecord
from backend.app.harness.participant import HarnessTransitionParticipant
from backend.app.harness.service import HarnessService
from backend.app.main import create_app
from backend.app.product_sessions.database import (
    InteractionRecord,
    ProductDatabase,
    RunAttemptRecord,
    RunRecord,
    SessionRecord,
    utc_now,
)
from backend.app.product_sessions.service import ProductSessionService
from backend.app.project_resources import models as _pr  # noqa: F401
from backend.app.project_resources.models import (
    ProjectRepositoryBindingRecord,
    RepositorySnapshotRecord,
)
from backend.app.runtime_execution import models as _re  # noqa: F401
from backend.app.step_inputs import models as _si  # noqa: F401
from backend.app.tool_execution import models as _te  # noqa: F401


def _new_id() -> str:
    return str(uuid.uuid4())


def _hash64() -> str:
    return uuid.uuid4().hex * 2


_OPEN_DATABASES: list[ProductDatabase] = []


def _run_scenario(scenario: Callable[[], Awaitable[None]]) -> None:
    """Run one async scenario and close every in-memory database it opened."""

    async def run_and_close() -> None:
        first_database = len(_OPEN_DATABASES)
        try:
            await scenario()
        finally:
            databases = _OPEN_DATABASES[first_database:]
            del _OPEN_DATABASES[first_database:]
            for database in reversed(databases):
                await database.close()

    asyncio.run(run_and_close())


async def _runtime(tmp_path: Path | None = None, *, with_store: bool = False):
    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    await database.initialize()
    _OPEN_DATABASES.append(database)
    sessions = ProductSessionService(database)
    await sessions.initialize()
    recorder = HarnessCommandRecorder(scope_id="local-user", principal_id="local-user", clock=utc_now)
    repo = EvidenceRepository(
        scope_id="local-user",
        principal_id="local-user",
        command_recorder=recorder,
    )
    harness = HarnessService(database)
    store = None
    artifact_coordinator = None
    if with_store:
        assert tmp_path is not None
        store = ArtifactStore(tmp_path / "artifacts", scope_key_secret=b"s" * 32)
        artifact_coordinator = ArtifactCoordinator(
            database,
            store=store,
            scope_id="local-user",
            principal_id="local-user",
        )
    coordinator = ResultCommitCoordinator(
        database,
        store=store,
        scope_id="local-user",
        principal_id="local-user",
    )
    return database, sessions, harness, repo, coordinator, artifact_coordinator


async def _make_project_work_action(harness: HarnessService) -> tuple[str, str, str]:
    project = await harness.create_project(
        command_id=_new_id(), kind="delivery", title="t", goal="g", status="active"
    )
    work = await harness.create_work_item(
        command_id=_new_id(),
        project_id=project["id"],
        kind="task",
        title="task",
        objective="o",
        status="ready",
    )
    action = await harness.create_action_item(
        command_id=_new_id(),
        work_item_id=work["id"],
        title="action",
        assignee_kind="agent",
        status="ready",
    )
    return project["id"], work["id"], action["id"]


async def _make_decision_record(
    database: ProductDatabase,
    session_id: str,
    *,
    effect: str = "allow",
) -> DecisionRecord:
    point = DecisionPointDefinitionRecord(
        id=_new_id(),
        key=f"result-commit-test-{_new_id()}",
        version=1,
        category="evidence",
        label="t",
        description="d",
        subject_kind="work_item",
        default_mode="require_approval",
        allowed_human_actions_json=["approve", "reject"],
        applicability_schema_json={},
        response_schema_json={},
        active=True,
        definition_hash=_hash64(),
    )
    subject = DecisionSubjectRecord(
        id=_new_id(),
        subject_kind="work_item",
        resource_id=_new_id(),
        resource_revision="1",
        subject_hash=_hash64(),
        session_id=session_id,
    )
    evaluation = PolicyEvaluationRecord(
        id=_new_id(),
        subject_id=subject.id,
        decision_point_definition_id=point.id,
        principal_id="local-user",
        applicability_status="applicable",
        facts_json={},
        facts_hash=_hash64(),
        matched_rule_refs_json=[],
        floor_action="allow",
        preference_action="allow",
        final_action="allow",
        result_status="allowed",
        reason_codes_json=[],
        resolver_version="v1",
    )
    record = DecisionRecord(
        id=_new_id(),
        policy_evaluation_id=evaluation.id,
        subject_id=subject.id,
        source="human",
        actor_principal_id="local-user",
        decision_code="approve",
        authorization_effect=effect,
        reason="test",
        bound_subject_hash=_hash64(),
        policy_rule_refs_json=[],
        input_hash=_hash64(),
        record_hash=_hash64(),
    )
    async with database.sessions.begin() as txn:
        txn.add(point)
    async with database.sessions.begin() as txn:
        txn.add(subject)
    async with database.sessions.begin() as txn:
        txn.add(evaluation)
    async with database.sessions.begin() as txn:
        txn.add(record)
    return record


async def _make_run_chain(database: ProductDatabase) -> dict[str, str]:
    ids = {key: _new_id() for key in ("session", "interaction", "run", "attempt")}
    async with database.sessions.begin() as txn:
        txn.add(
            SessionRecord(
                id=ids["session"],
                scope_id="local-user",
                channel="web",
                title="t",
                status="running",
                revision=1,
                active_run_id=ids["run"],
            )
        )
    async with database.sessions.begin() as txn:
        txn.add(
            InteractionRecord(
                id=ids["interaction"],
                session_id=ids["session"],
                user_message_id="message-1",
                status="accepted",
            )
        )
    async with database.sessions.begin() as txn:
        txn.add(
            RunRecord(
                id=ids["run"],
                session_id=ids["session"],
                interaction_id=ids["interaction"],
                initial_agui_run_id=_new_id(),
                request_hash="r" * 64,
                status="running",
                current_user_message_id="message-1",
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


async def _start_action(txn, action_id: str) -> None:
    recorder = HarnessCommandRecorder(scope_id="local-user", principal_id="local-user", clock=utc_now)
    participant = HarnessTransitionParticipant(
        scope_id="local-user",
        principal_id="local-user",
        clock=utc_now,
        command_recorder=recorder,
    )
    await participant.transition_action_item(
        txn,
        action_item_id=action_id,
        command_id=_new_id(),
        request_hash=_hash64(),
        target_status="in_progress",
        reason="开始执行",
    )


async def _make_artifact_with_revision(repo: EvidenceRepository, txn) -> tuple:
    """Repository-level artifact (no real bytes); record row_version ends at 2."""

    digest = _hash64()
    blob = await repo.create_artifact_blob(
        txn, sha256=digest, size_bytes=100, storage_path=f"blobs/{_new_id()}"
    )
    artifact = await repo.create_artifact_record(
        txn,
        kind="diff_patch",
        title="test diff",
        media_type="text/x-diff",
        command_id=_new_id(),
    )
    revision = await repo.create_artifact_revision(
        txn,
        artifact_id=artifact.id,
        expected_artifact_record_version=1,
        storage_blob_id=blob.id,
        sha256=digest,
        size_bytes=100,
        command_id=_new_id(),
    )
    return blob, artifact, revision


async def _make_repository_snapshot(
    database: ProductDatabase,
    harness: HarnessService,
) -> tuple[ProjectRepositoryBindingRecord, RepositorySnapshotRecord]:
    project_id, _, _ = await _make_project_work_action(harness)
    now = utc_now()
    binding = ProjectRepositoryBindingRecord(
        id=_new_id(),
        scope_id="local-user",
        project_id=project_id,
        alias="main",
        display_name="main",
        role="primary",
        root_key="code",
        root_identity_hash=_hash64(),
        relative_path=".",
        locator_hash=_hash64(),
        generation=1,
        status="active",
        latest_snapshot_sequence=1,
        row_version=1,
        created_by="local-user",
        updated_by="local-user",
        created_at=now,
        updated_at=now,
    )
    snapshot = RepositorySnapshotRecord(
        id=_new_id(),
        scope_id="local-user",
        binding_id=binding.id,
        binding_generation=1,
        sequence=1,
        capture_status="available",
        observed_at=now,
        root_identity_hash=_hash64(),
        relative_path=".",
        locator_hash=_hash64(),
        head_oid="a" * 40,
        head_ref="refs/heads/main",
        governance_manifest_hash=_hash64(),
        semantic_hash=_hash64(),
        inspector_version="v1",
    )
    async with database.sessions.begin() as txn:
        txn.add(binding)
    async with database.sessions.begin() as txn:
        txn.add(snapshot)
    return binding, snapshot


async def _advance_snapshot(
    database: ProductDatabase,
    binding: ProjectRepositoryBindingRecord,
) -> RepositorySnapshotRecord:
    """Publish a newer snapshot and make it the binding's current target."""

    now = utc_now()
    snapshot = RepositorySnapshotRecord(
        id=_new_id(),
        scope_id="local-user",
        binding_id=binding.id,
        binding_generation=1,
        sequence=2,
        capture_status="available",
        observed_at=now,
        root_identity_hash=_hash64(),
        relative_path=".",
        locator_hash=_hash64(),
        head_oid="b" * 40,
        head_ref="refs/heads/main",
        governance_manifest_hash=_hash64(),
        semantic_hash=_hash64(),
        inspector_version="v1",
    )
    async with database.sessions.begin() as txn:
        txn.add(snapshot)
        current = await txn.get(ProjectRepositoryBindingRecord, binding.id)
        current.latest_snapshot_sequence = 2
        current.row_version += 1
    return snapshot


async def _make_claim(
    repo: EvidenceRepository,
    txn,
    *,
    action_id: str,
    requirement_kinds: tuple[str, ...] = ("validation_result",),
    artifact_revision_id: str | None = None,
    expected_artifact_record_version: int | None = None,
    repository_snapshot_id: str | None = None,
    applicability_policy: str = "record_only",
) -> tuple[str, list[str]]:
    """Create a candidate Claim against an in_progress Action; versions are 2."""

    await _start_action(txn, action_id)
    requirements = [
        {
            "requirement_kind": kind,
            "description": f"need {kind}",
            "schema_version": f"{kind.replace('_', '-')}-v1",
            "params_json": {},
        }
        for kind in requirement_kinds
    ]
    claim = await repo.create_claim(
        txn,
        subject_kind="action_item",
        subject_id=action_id,
        from_state="in_progress",
        target_transition="action_result_accepted",
        expected_subject_version=2,
        target_state="completed",
        artifact_revision_id=artifact_revision_id,
        expected_artifact_record_version=expected_artifact_record_version,
        repository_snapshot_id=repository_snapshot_id,
        applicability_policy=applicability_policy,
        requirements=requirements,
        command_id=_new_id(),
    )
    requirement_ids = [
        row.id
        for row in (
            await txn.scalars(
                select(CompletionClaimRequirementRecord).where(
                    CompletionClaimRequirementRecord.completion_claim_id == claim.id
                )
            )
        ).all()
    ]
    return claim.id, requirement_ids


async def _make_project_work(harness: HarnessService) -> tuple[str, str]:
    """Project + Work without Actions: the happy path for work_completed."""

    project = await harness.create_project(
        command_id=_new_id(), kind="delivery", title="t", goal="g", status="active"
    )
    work = await harness.create_work_item(
        command_id=_new_id(),
        project_id=project["id"],
        kind="task",
        title="task",
        objective="o",
        status="ready",
    )
    return project["id"], work["id"]


async def _start_work(txn, work_id: str) -> None:
    recorder = HarnessCommandRecorder(scope_id="local-user", principal_id="local-user", clock=utc_now)
    participant = HarnessTransitionParticipant(
        scope_id="local-user",
        principal_id="local-user",
        clock=utc_now,
        command_recorder=recorder,
    )
    await participant.transition_work_item(
        txn,
        work_item_id=work_id,
        command_id=_new_id(),
        request_hash=_hash64(),
        target_status="in_progress",
        reason="开始执行",
    )


async def _make_work_claim(
    repo: EvidenceRepository,
    txn,
    *,
    work_id: str,
    requirement_kinds: tuple[str, ...] = ("validation_result",),
    repository_snapshot_id: str | None = None,
    applicability_policy: str = "record_only",
) -> tuple[str, list[str]]:
    """Create a candidate Claim against an in_progress Work; versions are 2.

    must_match_current_target is only legal on work_completed Claims: §4.6
    forbids it on action_result_accepted, so applicability tests live here.
    """

    await _start_work(txn, work_id)
    requirements = [
        {
            "requirement_kind": kind,
            "description": f"need {kind}",
            "schema_version": f"{kind.replace('_', '-')}-v1",
            "params_json": {},
        }
        for kind in requirement_kinds
    ]
    claim = await repo.create_claim(
        txn,
        subject_kind="work_item",
        subject_id=work_id,
        from_state="in_progress",
        target_transition="work_completed",
        expected_subject_version=2,
        target_state="completed",
        repository_snapshot_id=repository_snapshot_id,
        applicability_policy=applicability_policy,
        requirements=requirements,
        command_id=_new_id(),
    )
    requirement_ids = [
        row.id
        for row in (
            await txn.scalars(
                select(CompletionClaimRequirementRecord).where(
                    CompletionClaimRequirementRecord.completion_claim_id == claim.id
                )
            )
        ).all()
    ]
    return claim.id, requirement_ids


async def _satisfy_requirement(
    repo: EvidenceRepository,
    txn,
    *,
    requirement_id: str,
    subject_kind: str = "action_item",
    subject_id: str,
    run_id: str,
    decision_record_id: str,
    kind: str = "validation_result",
) -> str:
    """Create valid Observation + current supports Assessment + Adoption."""

    payload = (
        {
            "capability_key": "pytest-suite",
            "expanded_argv": ["python", "-m", "pytest"],
            "working_dir": "/workspace",
            "exit_code": 0,
            "summary": "passed",
            "duration_ms": 10,
        }
        if kind == "validation_result"
        else {
            "path": "README.md",
            "preimage_hash": _hash64(),
            "postimage_hash": _hash64(),
            "observed_hash": _hash64(),
            "match": True,
        }
    )
    observation = await repo.create_observation(
        txn,
        kind=kind,
        schema_version=f"{kind.replace('_', '-')}-v1",
        payload=payload,
        subject_kind=subject_kind,
        subject_id=subject_id,
        statement="verified",
        product_run_id=run_id,
        command_id=_new_id(),
    )
    assessment = await repo.create_assessment(
        txn,
        observation_id=observation.id,
        requirement_id=requirement_id,
        verdict="supports",
        assessor_kind="validator",
        assessor_run_id=run_id,
        command_id=_new_id(),
    )
    requirement = await repo.get_requirement(txn, requirement_id)
    await repo.create_adoption(
        txn,
        claim_id=requirement.completion_claim_id,
        requirement_id=requirement_id,
        assessment_id=assessment.id,
        decision_record_id=decision_record_id,
        command_id=_new_id(),
    )
    return observation.id


async def _waive_requirement(
    repo: EvidenceRepository,
    txn,
    *,
    requirement_id: str,
    decision_record_id: str,
) -> None:
    await repo.create_waiver(
        txn,
        requirement_id=requirement_id,
        decision_record_id=decision_record_id,
        reason="人工豁免",
        command_id=_new_id(),
    )


async def _commit(
    coordinator: ResultCommitCoordinator,
    repo: EvidenceRepository,
    database: ProductDatabase,
    *,
    claim_id: str,
    commit_status: str,
    artifact_disposition: str,
    decision_record_id: str,
    command_id: str | None = None,
) -> dict:
    async with database.sessions() as txn:
        claim = await repo.get_claim(txn, claim_id)
        claim_hash = claim.claim_hash
        row_version = claim.row_version
    return await coordinator.commit_result(
        claim_id=claim_id,
        claim_hash=claim_hash,
        expected_claim_row_version=row_version,
        decision_record_id=decision_record_id,
        commit_status=commit_status,
        artifact_disposition=artifact_disposition,
        command_id=command_id or _new_id(),
    )


async def _assert_nothing_committed(
    database: ProductDatabase,
    repo: EvidenceRepository,
    *,
    claim_id: str,
    action_id: str | None = None,
    work_id: str | None = None,
    expected_action: tuple[str, int] = ("in_progress", 2),
    expected_work: tuple[str, int] = ("in_progress", 2),
) -> None:
    """A failed gate attempt must leave zero partial state (failure matrix 9)."""

    async with database.sessions() as txn:
        claim = await repo.get_claim(txn, claim_id)
        action = await txn.get(ActionItemRecord, action_id) if action_id else None
        work = await txn.get(WorkItemRecord, work_id) if work_id else None
        commits = list(
            (
                await txn.scalars(
                    select(ResultCommitRecord).where(ResultCommitRecord.completion_claim_id == claim_id)
                )
            ).all()
        )
    assert claim.status == "candidate"
    assert claim.decision_record_id is None
    assert commits == []
    if action is not None:
        assert action.status == expected_action[0]
        assert action.row_version == expected_action[1]
    if work is not None:
        assert work.status == expected_work[0]
        assert work.row_version == expected_work[1]


class TestAcceptedCommit:
    def test_accepted_commits_everything_in_one_transaction(self, tmp_path):
        async def scenario():
            database, sessions, harness, repo, coordinator, artifacts = await _runtime(
                tmp_path, with_store=True
            )
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, work_id, action_id = await _make_project_work_action(harness)
            written = await artifacts.create_artifact(
                kind="diff_patch",
                title="real diff",
                media_type="text/x-diff",
                content=b"diff --git a/README.md b/README.md\n",
                command_id=_new_id(),
            )
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    requirement_kinds=("validation_result", "file_hash_match"),
                    artifact_revision_id=written.artifact_revision_id,
                    expected_artifact_record_version=2,
                )
                for index, requirement_id in enumerate(requirement_ids):
                    await _satisfy_requirement(
                        repo,
                        txn,
                        requirement_id=requirement_id,
                        subject_id=action_id,
                        run_id=runs["run"],
                        decision_record_id=decision.id,
                        kind=("validation_result", "file_hash_match")[index],
                    )
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="accepted",
                artifact_disposition="accepted",
                decision_record_id=decision.id,
            )
            assert result["commit_status"] == "accepted"
            assert result["pre_commit_validity_check_passed"] is True
            assert result["committed_subject_state"] == "completed"
            assert result["claim"]["status"] == "committed"
            assert result["artifact"] == {
                "id": written.artifact_id,
                "status": "accepted",
                "row_version": 3,
            }
            assert result["subject"]["status"] == "completed"
            assert result["subject"]["row_version"] == 3

            async with database.sessions() as txn:
                claim = await repo.get_claim(txn, claim_id)
                action = await txn.get(ActionItemRecord, action_id)
                work = await txn.get(WorkItemRecord, work_id)
                commits = list(
                    (
                        await txn.scalars(
                            select(ResultCommitRecord).where(
                                ResultCommitRecord.completion_claim_id == claim_id
                            )
                        )
                    ).all()
                )
                edges = list(
                    (
                        await txn.scalars(
                            select(ProvenanceEdgeRecord).where(
                                ProvenanceEdgeRecord.source_kind == "result_commit",
                                ProvenanceEdgeRecord.source_id == result["result_commit_id"],
                            )
                        )
                    ).all()
                )
            assert claim.decision_record_id == decision.id
            assert len(commits) == 1
            assert commits[0].decision_record_id == decision.id
            # subject 迁移与投影 Evidence（D12）：只携带 ResultCommit/Claim 引用
            assert action.status == "completed"
            assert action.row_version == 3
            assert action.evidence_json == [
                {"result_commit_id": result["result_commit_id"], "claim_id": claim_id}
            ]
            # 父 Work 不因隔离执行 Action 完成而提前完成（§4.6）
            assert work.status == "ready"
            assert len(edges) == 1
            assert edges[0].relation == "attributed_to"
            assert edges[0].target_kind == "action_item"
            assert edges[0].target_id == action_id

        _run_scenario(scenario)

    def test_accepted_without_artifact_uses_none_disposition(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(repo, txn, action_id=action_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="accepted",
                artifact_disposition="none",
                decision_record_id=decision.id,
            )
            assert result["artifact"] is None
            assert result["subject"]["status"] == "completed"

        _run_scenario(scenario)


class TestApplicability:
    def test_record_only_ignores_snapshot_advance(self):
        """§9.1 step 6：record_only 只记录基线，合入目标前进不阻断提交。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            binding, snapshot = await _make_repository_snapshot(database, harness)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    repository_snapshot_id=snapshot.id,
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            await _advance_snapshot(database, binding)
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="accepted",
                artifact_disposition="none",
                decision_record_id=decision.id,
            )
            assert result["commit_status"] == "accepted"

        _run_scenario(scenario)

    def test_must_match_stale_snapshot_blocks(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            binding, snapshot = await _make_repository_snapshot(database, harness)
            _, work_id = await _make_project_work(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_work_claim(
                    repo,
                    txn,
                    work_id=work_id,
                    repository_snapshot_id=snapshot.id,
                    applicability_policy="must_match_current_target",
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_kind="work_item",
                    subject_id=work_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            await _advance_snapshot(database, binding)
            with pytest.raises(ArtifactApplicabilityStale, match="当前合入目标"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, work_id=work_id)

        _run_scenario(scenario)

    def test_must_match_current_snapshot_passes(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, snapshot = await _make_repository_snapshot(database, harness)
            _, work_id = await _make_project_work(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_work_claim(
                    repo,
                    txn,
                    work_id=work_id,
                    repository_snapshot_id=snapshot.id,
                    applicability_policy="must_match_current_target",
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_kind="work_item",
                    subject_id=work_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="accepted",
                artifact_disposition="none",
                decision_record_id=decision.id,
            )
            assert result["commit_status"] == "accepted"
            assert result["committed_subject_state"] == "completed"

        _run_scenario(scenario)


class TestWorkCompletion:
    def test_work_completed_happy_path(self):
        """§9.1 step 7：无 open Action、无待合入 Artifact 时 Work 可以关闭。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, work_id = await _make_project_work(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_work_claim(repo, txn, work_id=work_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_kind="work_item",
                    subject_id=work_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="accepted",
                artifact_disposition="none",
                decision_record_id=decision.id,
            )
            assert result["subject"]["kind"] == "work_item"
            assert result["subject"]["status"] == "completed"
            assert result["subject"]["row_version"] == 3
            async with database.sessions() as txn:
                work = await txn.get(WorkItemRecord, work_id)
            assert work.status == "completed"
            assert work.completion_evidence_json == [
                {"result_commit_id": result["result_commit_id"], "claim_id": claim_id}
            ]

        _run_scenario(scenario)

    def test_open_action_blocks_work_completion(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            # ready Action 仍是 open 状态（§4.6）
            _, work_id, _ = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_work_claim(repo, txn, work_id=work_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_kind="work_item",
                    subject_id=work_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            with pytest.raises(CompletionRequirementUnsatisfied, match="未解决"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, work_id=work_id)

        _run_scenario(scenario)

    def test_pending_integration_artifact_blocks_work_completion(self, tmp_path):
        """Action 交付的 Artifact 仍处 accepted（待 SD5 合入）时父 Work 不能关闭。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, artifacts = await _runtime(
                tmp_path, with_store=True
            )
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, work_id, action_id = await _make_project_work_action(harness)
            written = await artifacts.create_artifact(
                kind="diff_patch",
                title="real diff",
                media_type="text/x-diff",
                content=b"diff --git a/README.md b/README.md\n",
                command_id=_new_id(),
            )
            async with database.sessions.begin() as txn:
                action_claim_id, action_requirements = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    artifact_revision_id=written.artifact_revision_id,
                    expected_artifact_record_version=2,
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=action_requirements[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            accepted = await _commit(
                coordinator,
                repo,
                database,
                claim_id=action_claim_id,
                commit_status="accepted",
                artifact_disposition="accepted",
                decision_record_id=decision.id,
            )
            assert accepted["artifact"]["status"] == "accepted"
            async with database.sessions.begin() as txn:
                work_claim_id, work_requirements = await _make_work_claim(repo, txn, work_id=work_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=work_requirements[0],
                    subject_kind="work_item",
                    subject_id=work_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            with pytest.raises(CompletionRequirementUnsatisfied, match="待合入Artifact"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=work_claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=work_claim_id, work_id=work_id)

        _run_scenario(scenario)


class TestDecisionAndForge:
    def test_non_allow_decision_blocks_accepted_but_allows_rejected(self):
        """accepted/waived 必须绑定 allow Decision；rejected 只绑定审计。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            deny = await _make_decision_record(database, session["id"], effect="deny")
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(repo, txn, action_id=action_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=deny.id,
                )
            with pytest.raises(ResultCommitDecisionInvalid, match="allow"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=deny.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)
            rejected = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="rejected",
                artifact_disposition="none",
                decision_record_id=deny.id,
            )
            assert rejected["commit_status"] == "rejected"

        _run_scenario(scenario)

    def test_cross_scope_decision_is_not_found(self):
        """跨 scope Decision 与不存在不可区分（矩阵19：不能探测他人ID）。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            foreign_session_id = _new_id()
            async with database.sessions.begin() as txn:
                txn.add(
                    SessionRecord(
                        id=foreign_session_id,
                        scope_id="other-user",
                        channel="web",
                        title="t",
                        status="running",
                        revision=1,
                    )
                )
            foreign = await _make_decision_record(database, foreign_session_id)
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(repo, txn, action_id=action_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            with pytest.raises(EvidenceNotFound):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=foreign.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)

        _run_scenario(scenario)

    def test_public_transition_cannot_forge_result_commit_projection(self):
        """公开 Harness 路径无校验器：保留形状投影一律 fail closed。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                await _start_action(txn, action_id)
            forged = [{"result_commit_id": _new_id(), "claim_id": _new_id()}]
            with pytest.raises(HarnessValidationError, match="只能由Result Commit Gate写入"):
                await harness.transition_action_item(
                    action_item_id=action_id,
                    command_id=_new_id(),
                    expected_row_version=2,
                    target_status="completed",
                    reason="伪造完成",
                    evidence=forged,
                )
            with pytest.raises(HarnessValidationError, match="唯一Evidence元素"):
                await harness.transition_action_item(
                    action_item_id=action_id,
                    command_id=_new_id(),
                    expected_row_version=2,
                    target_status="completed",
                    reason="伪造完成",
                    evidence=[{**forged[0], "note": "extra"}],
                )
            with pytest.raises(HarnessValidationError, match="唯一Evidence元素"):
                await harness.transition_action_item(
                    action_item_id=action_id,
                    command_id=_new_id(),
                    expected_row_version=2,
                    target_status="completed",
                    reason="伪造完成",
                    evidence=[{"legacy": "ok"}, *forged],
                )
            async with database.sessions() as txn:
                action = await txn.get(ActionItemRecord, action_id)
            assert action.status == "in_progress"
            assert action.row_version == 2

        _run_scenario(scenario)

    def test_consumed_commit_reference_cannot_be_replayed(self):
        """ResultCommit 引用只能消费一次：subject 版本前进后重放确定性失败。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, work_id = await _make_project_work(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_work_claim(repo, txn, work_id=work_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_kind="work_item",
                    subject_id=work_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="accepted",
                artifact_disposition="none",
                decision_record_id=decision.id,
            )
            assert result["commit_status"] == "accepted"
            reference = [{"result_commit_id": result["result_commit_id"], "claim_id": claim_id}]
            # 白盒：只有 Gate 内部 participant 携带链校验器，公开路径无此能力。
            gate_participant = coordinator._participant
            async with database.sessions.begin() as txn:
                await gate_participant.transition_work_item(
                    txn,
                    work_item_id=work_id,
                    command_id=_new_id(),
                    request_hash=_hash64(),
                    target_status="in_progress",
                    reason="返工重新打开",
                    expected_row_version=3,
                )
            with pytest.raises(HarnessValidationError, match="已被消费"):
                async with database.sessions.begin() as txn:
                    await gate_participant.transition_work_item(
                        txn,
                        work_item_id=work_id,
                        command_id=_new_id(),
                        request_hash=_hash64(),
                        target_status="completed",
                        reason="重放同一引用",
                        evidence=reference,
                        expected_row_version=4,
                    )
            async with database.sessions() as txn:
                work = await txn.get(WorkItemRecord, work_id)
            assert work.status == "in_progress"
            assert work.row_version == 4

        _run_scenario(scenario)


class _FailingParticipant(HarnessTransitionParticipant):
    """Injected failure at subject migration time (failure matrix 9)."""

    async def transition_action_item(self, transaction, **kwargs):
        raise RuntimeError("injected participant failure")


class TestRollbackAtomicity:
    def test_participant_failure_rolls_back_everything_and_allows_retry(self, tmp_path):
        """step 10 失败必须回滚 step 8/9 的 Commit 与 Artifact 写入，且不污染幂等记录。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, artifacts = await _runtime(
                tmp_path, with_store=True
            )
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            written = await artifacts.create_artifact(
                kind="diff_patch",
                title="real diff",
                media_type="text/x-diff",
                content=b"diff --git a/README.md b/README.md\n",
                command_id=_new_id(),
            )
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    artifact_revision_id=written.artifact_revision_id,
                    expected_artifact_record_version=2,
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            healthy = coordinator._participant
            coordinator._participant = _FailingParticipant(
                scope_id="local-user",
                principal_id="local-user",
                clock=utc_now,
                command_recorder=HarnessCommandRecorder(
                    scope_id="local-user", principal_id="local-user", clock=utc_now
                ),
            )
            command_id = _new_id()
            with pytest.raises(RuntimeError, match="injected participant failure"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="accepted",
                    decision_record_id=decision.id,
                    command_id=command_id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)
            async with database.sessions() as txn:
                artifact = await repo.get_artifact_record(txn, written.artifact_id)
                edges = list(
                    (
                        await txn.scalars(
                            select(ProvenanceEdgeRecord).where(
                                ProvenanceEdgeRecord.source_kind == "result_commit"
                            )
                        )
                    ).all()
                )
            assert artifact.status == "candidate"
            assert artifact.row_version == 2
            assert edges == []
            # 同一 command_id 重试：失败事务没有留下幂等记录，可以完整重放
            coordinator._participant = healthy
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="accepted",
                artifact_disposition="accepted",
                decision_record_id=decision.id,
                command_id=command_id,
            )
            assert result["commit_status"] == "accepted"
            assert result["subject"]["status"] == "completed"

        _run_scenario(scenario)


class TestResultCommitRest:
    """REST 边界：commit 端点是唯一用户可达的 Evidence 写入口（§13.1）。"""

    @staticmethod
    def _seed(database_url: str) -> dict[str, Any]:
        async def seed() -> dict[str, Any]:
            database = ProductDatabase(database_url)
            await database.initialize()
            try:
                sessions = ProductSessionService(database)
                session = await sessions.create_session()
                decision = await _make_decision_record(database, session["id"])
                runs = await _make_run_chain(database)
                harness = HarnessService(database)
                _, _, action_id = await _make_project_work_action(harness)
                recorder = HarnessCommandRecorder(
                    scope_id="local-user", principal_id="local-user", clock=utc_now
                )
                repo = EvidenceRepository(
                    scope_id="local-user",
                    principal_id="local-user",
                    command_recorder=recorder,
                )
                async with database.sessions.begin() as txn:
                    claim_id, requirement_ids = await _make_claim(repo, txn, action_id=action_id)
                    await _satisfy_requirement(
                        repo,
                        txn,
                        requirement_id=requirement_ids[0],
                        subject_id=action_id,
                        run_id=runs["run"],
                        decision_record_id=decision.id,
                    )
                    claim = await repo.get_claim(txn, claim_id)
                return {
                    "claim_id": claim_id,
                    "claim_hash": claim.claim_hash,
                    "row_version": claim.row_version,
                    "decision_record_id": decision.id,
                }
            finally:
                await database.close()

        return asyncio.run(seed())

    def test_commit_and_read_claim_via_rest(self, tmp_path):
        database_url = f"sqlite+aiosqlite:///{tmp_path / 'rest.db'}"
        seeded = self._seed(database_url)
        settings = replace(Settings.for_test(), database_url=database_url)
        with TestClient(create_app(settings)) as client:
            committed = client.post(
                f"/api/evidence/claims/{seeded['claim_id']}/commit",
                json={
                    "command_id": _new_id(),
                    "claim_hash": seeded["claim_hash"],
                    "expected_claim_row_version": seeded["row_version"],
                    "decision_record_id": seeded["decision_record_id"],
                    "commit_status": "accepted",
                    "artifact_disposition": "none",
                },
            )
            assert committed.status_code == 200
            body = committed.json()
            assert body["commit_status"] == "accepted"
            assert body["pre_commit_validity_check_passed"] is True
            assert body["committed_subject_state"] == "completed"
            assert body["subject"]["status"] == "completed"
            viewed = client.get(f"/api/evidence/claims/{seeded['claim_id']}")
            assert viewed.status_code == 200
            view = viewed.json()
            assert view["status"] == "committed"
            assert view["requirements"][0]["resolution"] == "adoption"
            assert view["result_commit"]["commit_status"] == "accepted"
            assert view["result_commit"]["pre_commit_validity_check_passed"] is True

    def test_commit_with_unknown_decision_returns_404(self, tmp_path):
        database_url = f"sqlite+aiosqlite:///{tmp_path / 'rest404.db'}"
        seeded = self._seed(database_url)
        settings = replace(Settings.for_test(), database_url=database_url)
        with TestClient(create_app(settings)) as client:
            response = client.post(
                f"/api/evidence/claims/{seeded['claim_id']}/commit",
                json={
                    "command_id": _new_id(),
                    "claim_hash": seeded["claim_hash"],
                    "expected_claim_row_version": seeded["row_version"],
                    "decision_record_id": _new_id(),
                    "commit_status": "accepted",
                    "artifact_disposition": "none",
                },
            )
            assert response.status_code == 404
            missing = client.get(f"/api/evidence/claims/{_new_id()}")
            assert missing.status_code == 404

    def test_internal_evidence_kinds_have_no_public_route(self, tmp_path):
        settings = replace(Settings.for_test(), database_url=f"sqlite+aiosqlite:///{tmp_path / 'x.db'}")
        with TestClient(create_app(settings)) as client:
            for kind in ("observations", "assessments", "validation-runs", "artifacts"):
                response = client.post(f"/api/evidence/{kind}", json={})
                assert response.status_code == 404

    def test_accepted_rejects_any_waiver(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    requirement_kinds=("validation_result", "file_hash_match"),
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
                await _waive_requirement(
                    repo, txn, requirement_id=requirement_ids[1], decision_record_id=decision.id
                )
            with pytest.raises(CompletionRequirementUnsatisfied, match="不能含Waiver"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)

        _run_scenario(scenario)

    def test_missing_resolution_blocks_and_preserves_candidate(self):
        """失败矩阵13：模型自述不能替代验证 Evidence；无 Adoption/Waiver 即拒绝。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, _ = await _make_claim(repo, txn, action_id=action_id)
                # pi 文本自述只形成 model_output_adoption 材料，不构成采用
                await repo.create_observation(
                    txn,
                    kind="model_output_adoption",
                    schema_version="model-output-adoption-v1",
                    payload={
                        "model_call_attempt_id": runs["attempt"],
                        "output_disposition": "candidate_only",
                        "adopted_text_hash": _hash64(),
                        "adoption_scope": "turn",
                    },
                    subject_kind="action_item",
                    subject_id=action_id,
                    statement="模型自述完成",
                    product_run_id=runs["run"],
                    command_id=_new_id(),
                )
            with pytest.raises(CompletionRequirementUnsatisfied, match="缺少Adoption或Waiver"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)

        _run_scenario(scenario)


class TestWaivedCommit:
    def test_waived_mixed_adoption_and_waiver(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    requirement_kinds=("validation_result", "file_hash_match"),
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
                await _waive_requirement(
                    repo, txn, requirement_id=requirement_ids[1], decision_record_id=decision.id
                )
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="waived",
                artifact_disposition="none",
                decision_record_id=decision.id,
            )
            assert result["commit_status"] == "waived"
            assert result["pre_commit_validity_check_passed"] is True
            assert result["subject"]["status"] == "completed"

        _run_scenario(scenario)

    def test_waived_requires_at_least_one_waiver(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(repo, txn, action_id=action_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            with pytest.raises(CompletionRequirementUnsatisfied, match="至少一条"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="waived",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)

        _run_scenario(scenario)


class TestEvidenceRecheck:
    def test_superseded_adoption_blocks(self):
        """Adoption 后出现更新 Assessment：复检必须失败而非沿用旧批准。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(repo, txn, action_id=action_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
                # 重新验证产生新 Observation + 新 refutes Assessment 取代旧结论
                observation = await repo.create_observation(
                    txn,
                    kind="validation_result",
                    schema_version="validation-result-v1",
                    payload={
                        "capability_key": "pytest-suite",
                        "expanded_argv": ["python", "-m", "pytest"],
                        "working_dir": "/workspace",
                        "exit_code": 1,
                        "summary": "failed",
                        "duration_ms": 12,
                    },
                    subject_kind="action_item",
                    subject_id=action_id,
                    statement="重验失败",
                    product_run_id=runs["run"],
                    command_id=_new_id(),
                )
                current = await repo.get_current_assessment(txn, requirement_ids[0])
                await repo.create_assessment(
                    txn,
                    observation_id=observation.id,
                    requirement_id=requirement_ids[0],
                    verdict="refutes",
                    supersedes_assessment_id=current.id,
                    assessor_kind="validator",
                    assessor_run_id=runs["run"],
                    command_id=_new_id(),
                )
            with pytest.raises(EvidenceConflict, match="已被更新结论取代"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)

        _run_scenario(scenario)

    def test_invalid_observation_validity_blocks(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(repo, txn, action_id=action_id)
                observation_id = await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
                # 来源失效（SD4-D 事件机制之外，直接模拟已降级状态）
                observation = await txn.get(EvidenceObservationRecord, observation_id)
                observation.validity = "unavailable"
            with pytest.raises(EvidenceInvalid, match="已失效"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)

        _run_scenario(scenario)

    def test_pending_invalidation_blocks(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(repo, txn, action_id=action_id)
                observation_id = await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
                txn.add(
                    SourceInvalidationRecord(
                        id=_new_id(),
                        scope_id="local-user",
                        source_kind="evidence_observation",
                        source_id=observation_id,
                        sequence=1,
                        invalidation_kind="unavailable",
                        resolution="pending",
                        command_id=_new_id(),
                        created_at=utc_now(),
                    )
                )
            with pytest.raises(EvidenceInvalid, match="pending失效事件"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)

        _run_scenario(scenario)


class TestArtifactRecheck:
    def test_revision_superseded_blocks_and_keeps_new_revision_unadopted(self):
        """失败矩阵20：新 Revision 不得借旧批准被接受。

        正规追加路径已被记录层 candidate-Claim 护栏阻断；本测试用 ORM 直写
        模拟护栏之外的写入（直接更新、未来 supersede 流），证明提交门复检
        仍是最后防线。
        """

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                _, artifact, revision = await _make_artifact_with_revision(repo, txn)
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    artifact_revision_id=revision.id,
                    expected_artifact_record_version=2,
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
                # 护栏之外的直写：同一 Artifact 出现新当前 Revision，Record -> rv3
                from backend.app.evidence.models import ArtifactRevisionRecord

                artifact_row = await repo.get_artifact_record(txn, artifact.id)
                artifact_row.row_version += 1
                txn.add(
                    ArtifactRevisionRecord(
                        id=_new_id(),
                        artifact_id=artifact.id,
                        revision_number=2,
                        storage_blob_id=revision.storage_blob_id,
                        sha256=_hash64(),
                        size_bytes=120,
                        created_by="local-user",
                        command_id=_new_id(),
                        created_at=utc_now(),
                    )
                )
            with pytest.raises(ArtifactRevisionSuperseded):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="accepted",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)
            async with database.sessions() as txn:
                artifact_row = await repo.get_artifact_record(txn, artifact.id)
                current = await repo.get_current_artifact_revision(txn, artifact.id)
            assert artifact_row.status == "candidate"
            assert artifact_row.row_version == 3
            assert current.id != revision.id

        _run_scenario(scenario)

    def test_real_store_blob_recheck_passes(self, tmp_path):
        """真实 Store：accepted 提交前重算 Blob Hash；全 Waiver 也不跳过。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, artifacts = await _runtime(
                tmp_path, with_store=True
            )
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            written = await artifacts.create_artifact(
                kind="diff_patch",
                title="real diff",
                media_type="text/x-diff",
                content=b"diff --git a/README.md b/README.md\n",
                command_id=_new_id(),
            )
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    artifact_revision_id=written.artifact_revision_id,
                    expected_artifact_record_version=2,
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="accepted",
                artifact_disposition="accepted",
                decision_record_id=decision.id,
            )
            assert result["artifact"]["status"] == "accepted"
            assert result["subject"]["status"] == "completed"

        _run_scenario(scenario)

    def test_real_store_blob_corruption_blocks(self, tmp_path):
        """真实 Store：磁盘字节被篡改后重算 Hash 失败，整事务回滚。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, artifacts = await _runtime(
                tmp_path, with_store=True
            )
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            written = await artifacts.create_artifact(
                kind="diff_patch",
                title="real diff",
                media_type="text/x-diff",
                content=b"original bytes",
                command_id=_new_id(),
            )
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    artifact_revision_id=written.artifact_revision_id,
                    expected_artifact_record_version=2,
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            # 篡改已发布 Blob 字节
            async with database.sessions() as txn:
                from backend.app.evidence.models import ArtifactRevisionRecord

                revision = await txn.get(ArtifactRevisionRecord, written.artifact_revision_id)
                blob = await txn.get(ArtifactBlobRecord, revision.storage_blob_id)
                storage_path = blob.storage_path
            blob_file = coordinator.store.resolve_storage_path(storage_path)
            blob_file.write_bytes(b"tampered bytes!!")
            with pytest.raises(ArtifactHashMismatch):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="accepted",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)
            async with database.sessions() as txn:
                artifact_row = await repo.get_artifact_record(txn, written.artifact_id)
            assert artifact_row.status == "candidate"

        _run_scenario(scenario)

    def test_blob_integrity_unavailable_blocks(self, tmp_path):
        async def scenario():
            database, sessions, harness, repo, coordinator, artifacts = await _runtime(
                tmp_path, with_store=True
            )
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            written = await artifacts.create_artifact(
                kind="diff_patch",
                title="real diff",
                media_type="text/x-diff",
                content=b"original bytes",
                command_id=_new_id(),
            )
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    artifact_revision_id=written.artifact_revision_id,
                    expected_artifact_record_version=2,
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
                from backend.app.evidence.models import ArtifactRevisionRecord

                revision = await txn.get(ArtifactRevisionRecord, written.artifact_revision_id)
                blob = await txn.get(ArtifactBlobRecord, revision.storage_blob_id)
                blob.integrity_status = "corrupt"
            with pytest.raises(EvidenceInvalid, match="不可用于复检"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="accepted",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)

        _run_scenario(scenario)

    def test_missing_store_fails_closed_for_artifact_claims(self):
        """Artifact Store 未配置：绑定 Artifact 的 Claim 不得假装已复检。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                _, _, revision = await _make_artifact_with_revision(repo, txn)
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    artifact_revision_id=revision.id,
                    expected_artifact_record_version=2,
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            with pytest.raises(EvidenceConflict, match="Artifact Store未配置"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="accepted",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)

        _run_scenario(scenario)

    def test_disposition_none_with_current_artifact_rejected(self):
        """有当前 Artifact 的 Claim 不能记录 none；accepted 也不得伪造处置。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                _, _, revision = await _make_artifact_with_revision(repo, txn)
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    artifact_revision_id=revision.id,
                    expected_artifact_record_version=2,
                )
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            with pytest.raises(EvidenceValidationError, match="不能记录artifact_disposition=none"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(database, repo, claim_id=claim_id, action_id=action_id)

        _run_scenario(scenario)


class TestSubjectConcurrency:
    def test_stale_subject_version_blocks_second_claim(self):
        """失败矩阵11/S9：A 提交后，基于同一旧版本的 B 必须 CAS 失败。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_a, requirements_a = await _make_claim(repo, txn, action_id=action_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirements_a[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_a,
                commit_status="accepted",
                artifact_disposition="none",
                decision_record_id=decision.id,
            )
            assert result["subject"]["row_version"] == 3
            # B 仍绑定旧版本 2（A 提交前读到的值）
            async with database.sessions() as txn:
                stale_claim = await repo.get_claim(txn, claim_a)
            with pytest.raises(CompletionClaimAlreadyResolved):
                await coordinator.commit_result(
                    claim_id=claim_a,
                    claim_hash=stale_claim.claim_hash,
                    expected_claim_row_version=stale_claim.row_version,
                    decision_record_id=decision.id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    command_id=_new_id(),
                )

        _run_scenario(scenario)

    def test_subject_advanced_by_other_claim_blocks(self):
        """同一 subject 的两个独立 Claim：先提交者推进版本，后者 CAS 失败。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_a, requirements_a = await _make_claim(repo, txn, action_id=action_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirements_a[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
                # 第二个 Claim 基于同一 subject 版本 2（需要不同 Requirement 集合
                # 使 claim_hash 不同；subject 仍是 in_progress）
                claim_b = await repo.create_claim(
                    txn,
                    subject_kind="action_item",
                    subject_id=action_id,
                    from_state="in_progress",
                    target_transition="action_result_accepted",
                    expected_subject_version=2,
                    target_state="completed",
                    applicability_policy="record_only",
                    requirements=[
                        {
                            "requirement_kind": "human_confirmation",
                            "description": "need confirmation",
                            "schema_version": "human-confirmation-v1",
                            "params_json": {},
                        }
                    ],
                    command_id=_new_id(),
                )
            await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_a,
                commit_status="accepted",
                artifact_disposition="none",
                decision_record_id=decision.id,
            )
            async with database.sessions() as txn:
                claim_b_row = await repo.get_claim(txn, claim_b.id)
            with pytest.raises(EvidenceConflict, match="subject版本已变化"):
                await coordinator.commit_result(
                    claim_id=claim_b.id,
                    claim_hash=claim_b_row.claim_hash,
                    expected_claim_row_version=claim_b_row.row_version,
                    decision_record_id=decision.id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    command_id=_new_id(),
                )
            await _assert_nothing_committed(
                database, repo, claim_id=claim_b.id, action_id=action_id, expected_action=("completed", 3)
            )

        _run_scenario(scenario)

    def test_idempotent_replay_returns_same_commit_without_side_effects(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(repo, txn, action_id=action_id)
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            command_id = _new_id()
            async with database.sessions() as txn:
                claim = await repo.get_claim(txn, claim_id)
                claim_hash, row_version = claim.claim_hash, claim.row_version
            first = await coordinator.commit_result(
                claim_id=claim_id,
                claim_hash=claim_hash,
                expected_claim_row_version=row_version,
                decision_record_id=decision.id,
                commit_status="accepted",
                artifact_disposition="none",
                command_id=command_id,
            )
            replayed = await coordinator.commit_result(
                claim_id=claim_id,
                claim_hash=claim_hash,
                expected_claim_row_version=row_version,
                decision_record_id=decision.id,
                commit_status="accepted",
                artifact_disposition="none",
                command_id=command_id,
            )
            assert replayed == first
            async with database.sessions() as txn:
                commits = list(
                    (
                        await txn.scalars(
                            select(ResultCommitRecord).where(
                                ResultCommitRecord.completion_claim_id == claim_id
                            )
                        )
                    ).all()
                )
                action = await txn.get(ActionItemRecord, action_id)
            assert len(commits) == 1
            assert action.row_version == 3
            # 相同 command_id 绑定不同请求必须冲突
            with pytest.raises(HarnessConflict, match="不同请求"):
                await coordinator.commit_result(
                    claim_id=claim_id,
                    claim_hash=claim_hash,
                    expected_claim_row_version=row_version,
                    decision_record_id=decision.id,
                    commit_status="rejected",
                    artifact_disposition="none",
                    command_id=command_id,
                )

        _run_scenario(scenario)


class TestRejectedPath:
    def test_rejected_with_artifact_keeps_subject_untouched(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                _, artifact, revision = await _make_artifact_with_revision(repo, txn)
                claim_id, _ = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    artifact_revision_id=revision.id,
                    expected_artifact_record_version=2,
                )
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="rejected",
                artifact_disposition="rejected",
                decision_record_id=decision.id,
            )
            assert result["commit_status"] == "rejected"
            assert result["pre_commit_validity_check_passed"] is False
            assert result["committed_subject_state"] is None
            assert result["artifact"]["status"] == "rejected"
            assert result["subject"] is None
            async with database.sessions() as txn:
                action = await txn.get(ActionItemRecord, action_id)
                artifact_row = await repo.get_artifact_record(txn, artifact.id)
                claim = await repo.get_claim(txn, claim_id)
            assert action.status == "in_progress"
            assert action.row_version == 2
            assert artifact_row.status == "rejected"
            assert claim.status == "rejected"
            assert claim.decision_record_id == decision.id

        _run_scenario(scenario)

    def test_rejected_ignores_invalid_evidence_and_open_requirements(self):
        """失败矩阵17/S10：Evidence 失效、Snapshot 前进、Requirement 未满足
        都不能卡住用户的拒绝。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            binding, snapshot = await _make_repository_snapshot(database, harness)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_ids = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id,
                    repository_snapshot_id=snapshot.id,
                )
                observation_id = await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement_ids[0],
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
                observation = await txn.get(EvidenceObservationRecord, observation_id)
                observation.validity = "unavailable"
            await _advance_snapshot(database, binding)
            # mandatory Requirement 全空的新 Claim 同样可直接拒绝
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_id,
                commit_status="rejected",
                artifact_disposition="none",
                decision_record_id=decision.id,
            )
            assert result["commit_status"] == "rejected"
            async with database.sessions() as txn:
                action = await txn.get(ActionItemRecord, action_id)
            assert action.status == "in_progress"

        _run_scenario(scenario)

    def test_rejected_disposition_combinations(self):
        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            _, _, action_id = await _make_project_work_action(harness)
            # 无 Artifact 的 Claim 不能用 none 之外的处置
            async with database.sessions.begin() as txn:
                claim_no_artifact, _ = await _make_claim(repo, txn, action_id=action_id)
            with pytest.raises(EvidenceValidationError, match="只能使用artifact_disposition=none"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_no_artifact,
                    commit_status="rejected",
                    artifact_disposition="rejected",
                    decision_record_id=decision.id,
                )
            # 有当前 Artifact 的 Claim 不能用 none
            _, _, action_id_2 = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                _, _, revision = await _make_artifact_with_revision(repo, txn)
                claim_with_artifact, _ = await _make_claim(
                    repo,
                    txn,
                    action_id=action_id_2,
                    artifact_revision_id=revision.id,
                    expected_artifact_record_version=2,
                )
            with pytest.raises(EvidenceValidationError, match="只能使用rejected"):
                await _commit(
                    coordinator,
                    repo,
                    database,
                    claim_id=claim_with_artifact,
                    commit_status="rejected",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
            await _assert_nothing_committed(
                database, repo, claim_id=claim_with_artifact, action_id=action_id_2
            )

        _run_scenario(scenario)

    def test_rejected_then_new_claim_can_commit(self):
        """S2 基础：旧 Claim 拒绝不阻断同一 subject 的新 Claim。"""

        async def scenario():
            database, sessions, harness, repo, coordinator, _ = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_first, _ = await _make_claim(repo, txn, action_id=action_id)
            await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_first,
                commit_status="rejected",
                artifact_disposition="none",
                decision_record_id=decision.id,
            )
            # subject 未被拒绝路径推进，新 Claim 仍基于版本 2
            async with database.sessions.begin() as txn:
                claim_second = await repo.create_claim(
                    txn,
                    subject_kind="action_item",
                    subject_id=action_id,
                    from_state="in_progress",
                    target_transition="action_result_accepted",
                    expected_subject_version=2,
                    target_state="completed",
                    applicability_policy="record_only",
                    requirements=[
                        {
                            "requirement_kind": "validation_result",
                            "description": "need validation",
                            "schema_version": "validation-result-v1",
                            "params_json": {},
                        }
                    ],
                    command_id=_new_id(),
                )
                requirement = (
                    await txn.scalars(
                        select(CompletionClaimRequirementRecord).where(
                            CompletionClaimRequirementRecord.completion_claim_id == claim_second.id
                        )
                    )
                ).first()
                await _satisfy_requirement(
                    repo,
                    txn,
                    requirement_id=requirement.id,
                    subject_id=action_id,
                    run_id=runs["run"],
                    decision_record_id=decision.id,
                )
            result = await _commit(
                coordinator,
                repo,
                database,
                claim_id=claim_second.id,
                commit_status="accepted",
                artifact_disposition="none",
                decision_record_id=decision.id,
            )
            assert result["subject"]["status"] == "completed"

        _run_scenario(scenario)
