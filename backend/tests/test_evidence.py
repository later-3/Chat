"""F02/SD4-A contract tests for the Evidence/Artifact/Provenance lifecycle."""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select

# Import every model module so the in-memory create_all schema is complete and
# deterministic regardless of test execution order.
from backend.app.collaboration_intents import models as _ci  # noqa: F401
from backend.app.collaboration_protocols import models as _cp  # noqa: F401
from backend.app.evidence import models as _ev  # noqa: F401
from backend.app.evidence.contracts import (
    ARTIFACT_TRANSITIONS,
    CLAIM_TRANSITIONS,
    VALIDATION_RUN_TRANSITIONS,
    ArtifactHashMismatch,
    ArtifactRevisionSuperseded,
    AssessmentNotSupporting,
    CompletionClaimAlreadyResolved,
    EvidenceConflict,
    EvidenceNotFound,
    EvidenceValidationError,
    RuntimeLeaseFenceMismatch,
    WaiverBlockedByFailedRequirement,
    validate_observation_payload,
)
from backend.app.evidence.models import (
    CompletionClaimRequirementRecord,
    ValidationRunRecord,
)
from backend.app.evidence.service import EvidenceRepository
from backend.app.execution_workspaces import models as _ew  # noqa: F401
from backend.app.execution_workspaces.models import ExecutionWorkspaceRecord
from backend.app.governance import models as _gov  # noqa: F401
from backend.app.governance.models import (
    DecisionPointDefinitionRecord,
    DecisionRecord,
    DecisionSubjectRecord,
    PolicyEvaluationRecord,
)
from backend.app.harness import models as _har  # noqa: F401
from backend.app.harness.commands import HarnessCommandRecorder
from backend.app.harness.models import (
    ActionItemRecord,
    TaskPlanRecord,
    TaskPlanRevisionRecord,
    WorkItemRecord,
)
from backend.app.harness.participant import HarnessTransitionParticipant
from backend.app.harness.service import HarnessService
from backend.app.product_sessions.database import (
    InteractionRecord,
    ProductDatabase,
    RunAttemptRecord,
    RunRecord,
    SessionRecord,
    ToolExecutionRecord,
    utc_now,
)
from backend.app.product_sessions.service import ProductSessionService
from backend.app.project_resources import models as _pr  # noqa: F401
from backend.app.project_resources.models import (
    ProjectRepositoryBindingRecord,
    RepositorySnapshotRecord,
)
from backend.app.runtime_execution import models as _re  # noqa: F401
from backend.app.runtime_execution.models import RuntimeJobRecord
from backend.app.step_inputs import models as _si  # noqa: F401
from backend.app.tool_execution import models as _te  # noqa: F401


def _new_id() -> str:
    return str(uuid.uuid4())


def _hash64() -> str:
    return uuid.uuid4().hex * 2


async def _runtime():
    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    await database.initialize()
    sessions = ProductSessionService(database)
    await sessions.initialize()
    recorder = HarnessCommandRecorder(
        scope_id="local-user",
        principal_id="local-user",
        clock=utc_now,
    )
    repo = EvidenceRepository(
        scope_id="local-user",
        principal_id="local-user",
        command_recorder=recorder,
    )
    harness = HarnessService(database)
    return database, sessions, harness, repo


async def _make_project_work_action(
    harness: HarnessService,
) -> tuple[str, str, str]:
    """Create project -> ready work -> ready action; return (project, work, action) ids."""

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
    database: ProductDatabase, session_id: str
) -> DecisionRecord:
    """Persist the minimal governance chain so Evidence rows can bind a Decision."""

    point = DecisionPointDefinitionRecord(
        id=_new_id(),
        key=f"evidence-test-{_new_id()}",
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
        authorization_effect="allow",
        reason="test",
        bound_subject_hash=_hash64(),
        policy_rule_refs_json=[],
        input_hash=_hash64(),
        record_hash=_hash64(),
    )
    # Persist each FK layer before its dependants, matching coordinator order.
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
    """Persist session -> interaction -> run -> attempt -> job -> tool_execution."""

    ids = {
        key: _new_id()
        for key in ("session", "interaction", "run", "attempt", "job", "execution")
    }
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
    async with database.sessions.begin() as txn:
        txn.add(
            RuntimeJobRecord(
                id=ids["job"],
                scope_id="local-user",
                product_run_id=ids["run"],
                run_attempt_id=ids["attempt"],
                endpoint_key="/api/workflows/continuous",
                workflow_definition_id="continuous-collaboration",
                workflow_version="1.7.0",
                status="running",
                recoverability="checkpoint",
                input_payload_json={},
                input_hash="i" * 64,
                external_dispatch_state="dispatching",
            )
        )
    async with database.sessions.begin() as txn:
        txn.add(
            ToolExecutionRecord(
                id=ids["execution"],
                session_id=ids["session"],
                run_id=ids["run"],
                run_attempt_id=ids["attempt"],
                runtime_job_id=ids["job"],
                tool_id="pi_agent",
                execution_ordinal=1,
                mode="workspace_edit",
                config_revision=1,
                status="starting",
                metrics={},
            )
        )
    return ids


async def _make_validation_run(
    database: ProductDatabase,
    harness: HarnessService,
    repo: EvidenceRepository,
) -> ValidationRunRecord:
    """Persist the full FK chain and create one pending ValidationRun."""

    project_id, work_id, _ = await _make_project_work_action(harness)
    runs = await _make_run_chain(database)
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
    workspace = ExecutionWorkspaceRecord(
        id=_new_id(),
        scope_id="local-user",
        product_run_id=runs["run"],
        run_attempt_id=runs["attempt"],
        runtime_job_id=runs["job"],
        tool_execution_id=runs["execution"],
        repository_binding_id=binding.id,
        repository_snapshot_id=snapshot.id,
        workspace_key=f"ws-{_new_id()}",
        root_key="code",
        source_relative_path=".",
        base_revision="a" * 40,
        status="ready",
        changed_paths_json=[],
        row_version=1,
        created_at=now,
    )
    plan = TaskPlanRecord(
        id=_new_id(),
        scope_id="local-user",
        project_id=project_id,
        work_item_id=work_id,
        status="accepted",
        row_version=1,
        created_by="local-user",
        created_at=now,
        updated_at=now,
    )
    plan_revision = TaskPlanRevisionRecord(
        id=_new_id(),
        task_plan_id=plan.id,
        revision=1,
        summary="s",
        validation_contract_json={},
        status="accepted",
        created_by="local-user",
        created_at=now,
    )
    # Persist each FK layer before its dependants, matching coordinator order.
    async with database.sessions.begin() as txn:
        txn.add(binding)
    async with database.sessions.begin() as txn:
        txn.add(snapshot)
    async with database.sessions.begin() as txn:
        txn.add(workspace)
    async with database.sessions.begin() as txn:
        txn.add(plan)
    async with database.sessions.begin() as txn:
        txn.add(plan_revision)
    async with database.sessions.begin() as txn:
        contract = await repo.create_validation_contract(
            txn,
            plan_revision_id=plan_revision.id,
            contract_hash=_hash64(),
            schema_version="validation-contract-v2",
            rules_json={"rules": []},
            command_id=_new_id(),
        )
        run = await repo.create_validation_run(
            txn,
            workspace_id=workspace.id,
            repository_snapshot_id=snapshot.id,
            validation_contract_id=contract.id,
            contract_hash=contract.contract_hash,
            rule_ordinal=1,
            capability_key="pytest-suite",
            capability_version="1.0.0",
            capability_hash=_hash64(),
            resolved_executable_hash=_hash64(),
            environment_fingerprint=_hash64(),
            expanded_argv_json=["-m", "pytest"],
            expanded_argv_hash=_hash64(),
            working_dir=".",
            runtime_job_id=runs["job"],
            run_attempt_id=runs["attempt"],
            runtime_lease_epoch=1,
            command_id=_new_id(),
        )
    return run


async def _make_claim_with_requirement(
    database: ProductDatabase,
    harness: HarnessService,
    repo: EvidenceRepository,
    txn,
    *,
    action_id: str,
    requirement_kind: str = "file_hash_match",
) -> tuple[str, str, str]:
    """Create a candidate Claim with one Requirement; return (claim, requirement, action) ids."""

    claim = await repo.create_claim(
        txn,
        subject_kind="action_item",
        subject_id=action_id,
        from_state="in_progress",
        target_transition="action_result_accepted",
        expected_subject_version=1,
        target_state="completed",
        applicability_policy="record_only",
        requirements=[
            {
                "requirement_kind": requirement_kind,
                "description": "d",
                "schema_version": f"{requirement_kind.replace('_', '-')}-v1",
                "params_json": {},
            }
        ],
        command_id=_new_id(),
    )
    requirement = (
        await txn.scalars(
            select(CompletionClaimRequirementRecord).where(
                CompletionClaimRequirementRecord.completion_claim_id == claim.id
            )
        )
    ).first()
    return claim.id, requirement.id, action_id


class TestEvidenceContracts:
    def test_artifact_state_machine_allows_only_documented_transitions(self):
        assert ARTIFACT_TRANSITIONS["candidate"] == {
            "accepted",
            "rejected",
            "not_adopted",
            "discarded",
        }
        assert ARTIFACT_TRANSITIONS["accepted"] == {"retained", "discarded"}
        assert ARTIFACT_TRANSITIONS["retained"] == {"discarded"}
        assert ARTIFACT_TRANSITIONS["discarded"] == set()
        assert "candidate" not in ARTIFACT_TRANSITIONS["accepted"]

    def test_claim_state_machine_is_terminal_after_resolution(self):
        assert CLAIM_TRANSITIONS["candidate"] == {"committed", "rejected", "superseded"}
        assert CLAIM_TRANSITIONS["committed"] == set()

    def test_validation_run_state_machine_matches_design(self):
        assert VALIDATION_RUN_TRANSITIONS["pending"] == {"running", "error", "cancelled"}
        assert VALIDATION_RUN_TRANSITIONS["running"] == {
            "passed",
            "failed",
            "timeout",
            "error",
            "outcome_unknown",
            "cancelled",
        }
        assert VALIDATION_RUN_TRANSITIONS["outcome_unknown"] == set()

    def test_observation_payload_validator_rejects_unknown_schema(self):
        with pytest.raises(EvidenceValidationError):
            validate_observation_payload(
                kind="validation_result",
                schema_version="unknown",
                payload={},
            )


class TestEvidenceRepository:
    def test_create_artifact_and_revision(self):
        async def scenario():
            database, _, _, repo = await _runtime()
            async with database.sessions.begin() as txn:
                blob = await repo.create_artifact_blob(
                    txn, sha256="a" * 64, size_bytes=100, storage_path="blobs/lu/aa/aaaa"
                )
                artifact = await repo.create_artifact_record(
                    txn,
                    kind="diff_patch",
                    title="test diff",
                    media_type="text/x-diff",
                    command_id="cmd-1",
                )
                revision = await repo.create_artifact_revision(
                    txn,
                    artifact_id=artifact.id,
                    storage_blob_id=blob.id,
                    sha256="a" * 64,
                    size_bytes=100,
                    command_id="cmd-2",
                )
            assert revision.revision_number == 1
            assert revision.artifact_id == artifact.id
            assert revision.storage_blob_id == blob.id
            async with database.sessions() as txn:
                current = await repo.get_current_artifact_revision(txn, artifact.id)
            assert current is not None
            assert current.id == revision.id

        asyncio.run(scenario())

    def test_artifact_record_rejects_unknown_kind(self):
        async def scenario():
            database, _, _, repo = await _runtime()
            async with database.sessions.begin() as txn:
                with pytest.raises(EvidenceValidationError):
                    await repo.create_artifact_record(
                        txn,
                        kind="diff",
                        title="t",
                        media_type="text/x-diff",
                        command_id="cmd-1",
                    )

        asyncio.run(scenario())

    def test_revision_append_blocked_by_candidate_claim(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                blob = await repo.create_artifact_blob(
                    txn, sha256="a" * 64, size_bytes=1, storage_path="p1"
                )
                artifact = await repo.create_artifact_record(
                    txn, kind="diff_patch", title="t", media_type="text/x-diff", command_id="c1"
                )
                revision = await repo.create_artifact_revision(
                    txn,
                    artifact_id=artifact.id,
                    storage_blob_id=blob.id,
                    sha256="a" * 64,
                    size_bytes=1,
                    command_id="c2",
                )
                await repo.create_claim(
                    txn,
                    subject_kind="action_item",
                    subject_id=action_id,
                    from_state="in_progress",
                    target_transition="action_result_accepted",
                    expected_subject_version=1,
                    target_state="completed",
                    artifact_revision_id=revision.id,
                    expected_artifact_record_version=1,
                    applicability_policy="record_only",
                    requirements=[],
                    command_id="c3",
                )
                with pytest.raises(ArtifactRevisionSuperseded):
                    await repo.create_artifact_revision(
                        txn,
                        artifact_id=artifact.id,
                        storage_blob_id=blob.id,
                        sha256="a" * 64,
                        size_bytes=1,
                        command_id="c4",
                    )

        asyncio.run(scenario())

    def test_revision_rejects_blob_hash_mismatch(self):
        async def scenario():
            database, _, _, repo = await _runtime()
            async with database.sessions.begin() as txn:
                blob = await repo.create_artifact_blob(
                    txn, sha256="a" * 64, size_bytes=1, storage_path="p1"
                )
                artifact = await repo.create_artifact_record(
                    txn, kind="diff_patch", title="t", media_type="text/x-diff", command_id="c1"
                )
                with pytest.raises(ArtifactHashMismatch) as excinfo:
                    await repo.create_artifact_revision(
                        txn,
                        artifact_id=artifact.id,
                        storage_blob_id=blob.id,
                        sha256="b" * 64,
                        size_bytes=1,
                        command_id="c2",
                    )
            assert excinfo.value.code == "ARTIFACT_HASH_MISMATCH"

        asyncio.run(scenario())

    def test_artifact_status_transition_rejects_illegal_moves(self):
        async def scenario():
            database, _, _, repo = await _runtime()
            async with database.sessions.begin() as txn:
                artifact = await repo.create_artifact_record(
                    txn, kind="diff_patch", title="t", media_type="text/x-diff", command_id="cmd-1"
                )
            async with database.sessions.begin() as txn:
                with pytest.raises(EvidenceValidationError):
                    await repo.transition_artifact_status(
                        txn,
                        artifact_id=artifact.id,
                        expected_row_version=1,
                        target_status="retained",
                        command_id="cmd-2",
                    )

        asyncio.run(scenario())

    def test_claim_with_requirements_round_trip(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim = await repo.create_claim(
                    txn,
                    subject_kind="action_item",
                    subject_id=action_id,
                    from_state="in_progress",
                    target_transition="action_result_accepted",
                    expected_subject_version=1,
                    target_state="completed",
                    applicability_policy="record_only",
                    requirements=[
                        {
                            "requirement_kind": "file_hash_match",
                            "mandatory": True,
                            "description": "README.md内容匹配",
                            "schema_version": "file-hash-match-v1",
                            "params_json": {"path": "README.md"},
                        }
                    ],
                    command_id="cmd-claim",
                )
            async with database.sessions() as txn:
                reqs = (
                    await txn.scalars(
                        select(CompletionClaimRequirementRecord).where(
                            CompletionClaimRequirementRecord.completion_claim_id == claim.id
                        )
                    )
                ).all()
            assert len(reqs) == 1
            assert reqs[0].requirement_kind == "file_hash_match"

        asyncio.run(scenario())

    def test_claim_rejects_missing_subject(self):
        async def scenario():
            database, _, _, repo = await _runtime()
            async with database.sessions.begin() as txn:
                with pytest.raises(Exception) as excinfo:
                    await repo.create_claim(
                        txn,
                        subject_kind="action_item",
                        subject_id=_new_id(),
                        from_state="in_progress",
                        target_transition="action_result_accepted",
                        expected_subject_version=1,
                        target_state="completed",
                        applicability_policy="record_only",
                        requirements=[],
                        command_id="cmd-claim",
                    )
            assert "不存在" in str(excinfo.value)

        asyncio.run(scenario())

    def test_observation_requires_locatable_source(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, work_id, _ = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                with pytest.raises(EvidenceValidationError):
                    await repo.create_observation(
                        txn,
                        kind="file_hash_match",
                        schema_version="file-hash-match-v1",
                        payload={
                            "path": "README.md",
                            "preimage_hash": "a" * 64,
                            "postimage_hash": "b" * 64,
                            "observed_hash": "b" * 64,
                            "match": True,
                        },
                        subject_kind="work_item",
                        subject_id=work_id,
                        statement="无来源",
                        command_id="c1",
                    )

        asyncio.run(scenario())

    def test_observation_rejects_missing_subject(self):
        async def scenario():
            database, _, _, repo = await _runtime()
            async with database.sessions.begin() as txn:
                with pytest.raises(EvidenceNotFound):
                    await repo.create_observation(
                        txn,
                        kind="file_hash_match",
                        schema_version="file-hash-match-v1",
                        payload={
                            "path": "README.md",
                            "preimage_hash": "a" * 64,
                            "postimage_hash": "b" * 64,
                            "observed_hash": "b" * 64,
                            "match": True,
                        },
                        subject_kind="work_item",
                        subject_id=_new_id(),
                        statement="主体不存在",
                        product_run_id=_new_id(),
                        command_id=_new_id(),
                    )

        asyncio.run(scenario())

    def test_adoption_only_allows_supporting_assessment(self):
        async def scenario():
            database, sessions, harness, repo = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_id, action_id = await _make_claim_with_requirement(
                    database, harness, repo, txn, action_id=action_id
                )
                observation = await repo.create_observation(
                    txn,
                    kind="file_hash_match",
                    schema_version="file-hash-match-v1",
                    payload={
                        "path": "README.md",
                        "preimage_hash": "a" * 64,
                        "postimage_hash": "b" * 64,
                        "observed_hash": "b" * 64,
                        "match": True,
                    },
                    subject_kind="action_item",
                    subject_id=action_id,
                    statement="文件匹配",
                    product_run_id=runs["run"],
                    command_id=_new_id(),
                )
                assessment = await repo.create_assessment(
                    txn,
                    observation_id=observation.id,
                    requirement_id=requirement_id,
                    verdict="refutes",
                    assessor_kind="validator",
                    assessor_run_id=runs["run"],
                    command_id=_new_id(),
                )
                with pytest.raises(AssessmentNotSupporting):
                    await repo.create_adoption(
                        txn,
                        claim_id=claim_id,
                        requirement_id=requirement_id,
                        assessment_id=assessment.id,
                        decision_record_id=decision.id,
                        command_id=_new_id(),
                    )

        asyncio.run(scenario())

    def test_human_assessment_requires_principal_and_decision(self):
        async def scenario():
            database, sessions, harness, repo = await _runtime()
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                _, requirement_id, action_id = await _make_claim_with_requirement(
                    database, harness, repo, txn, action_id=action_id
                )
                observation = await repo.create_observation(
                    txn,
                    kind="file_hash_match",
                    schema_version="file-hash-match-v1",
                    payload={
                        "path": "README.md",
                        "preimage_hash": "a" * 64,
                        "postimage_hash": "b" * 64,
                        "observed_hash": "b" * 64,
                        "match": True,
                    },
                    subject_kind="action_item",
                    subject_id=action_id,
                    statement="文件匹配",
                    product_run_id=runs["run"],
                    command_id=_new_id(),
                )
                # 人工 Assessment 缺 principal/decision
                with pytest.raises(EvidenceValidationError):
                    await repo.create_assessment(
                        txn,
                        observation_id=observation.id,
                        requirement_id=requirement_id,
                        verdict="supports",
                        assessor_kind="human",
                        command_id=_new_id(),
                    )
                # validator Assessment 缺 assessor_run_id
                with pytest.raises(EvidenceValidationError):
                    await repo.create_assessment(
                        txn,
                        observation_id=observation.id,
                        requirement_id=requirement_id,
                        verdict="supports",
                        assessor_kind="validator",
                        command_id=_new_id(),
                    )

        asyncio.run(scenario())

    def test_waiver_blocked_by_current_refutes(self):
        async def scenario():
            database, sessions, harness, repo = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            runs = await _make_run_chain(database)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                _, requirement_id, action_id = await _make_claim_with_requirement(
                    database, harness, repo, txn, action_id=action_id
                )
                observation = await repo.create_observation(
                    txn,
                    kind="file_hash_match",
                    schema_version="file-hash-match-v1",
                    payload={
                        "path": "README.md",
                        "preimage_hash": "a" * 64,
                        "postimage_hash": "b" * 64,
                        "observed_hash": "b" * 64,
                        "match": True,
                    },
                    subject_kind="action_item",
                    subject_id=action_id,
                    statement="文件匹配",
                    product_run_id=runs["run"],
                    command_id=_new_id(),
                )
                await repo.create_assessment(
                    txn,
                    observation_id=observation.id,
                    requirement_id=requirement_id,
                    verdict="refutes",
                    assessor_kind="validator",
                    assessor_run_id=runs["run"],
                    command_id=_new_id(),
                )
                with pytest.raises(WaiverBlockedByFailedRequirement):
                    await repo.create_waiver(
                        txn,
                        requirement_id=requirement_id,
                        decision_record_id=decision.id,
                        reason="想绕过失败",
                        command_id=_new_id(),
                    )

        asyncio.run(scenario())

    def test_waiver_rejected_after_claim_resolved(self):
        async def scenario():
            database, sessions, harness, repo = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, requirement_id, _ = await _make_claim_with_requirement(
                    database, harness, repo, txn, action_id=action_id
                )
                await repo.create_result_commit(
                    txn,
                    claim_id=claim_id,
                    commit_status="rejected",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                    command_id=_new_id(),
                )
                with pytest.raises(EvidenceConflict, match="candidate"):
                    await repo.create_waiver(
                        txn,
                        requirement_id=requirement_id,
                        decision_record_id=decision.id,
                        reason="已解决的Claim不能再豁免",
                        command_id=_new_id(),
                    )

        asyncio.run(scenario())

    def test_claim_rejects_stale_subject_version(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                with pytest.raises(EvidenceConflict, match="期望subject版本"):
                    await repo.create_claim(
                        txn,
                        subject_kind="action_item",
                        subject_id=action_id,
                        from_state="in_progress",
                        target_transition="action_result_accepted",
                        expected_subject_version=99,
                        target_state="completed",
                        applicability_policy="record_only",
                        requirements=[],
                        command_id=_new_id(),
                    )

        asyncio.run(scenario())

    def test_result_commit_three_outcomes_and_decision_binding(self):
        async def scenario():
            database, sessions, harness, repo = await _runtime()
            session = await sessions.create_session()
            outcomes = (
                ("accepted", "committed"),
                ("rejected", "rejected"),
                ("waived", "committed"),
            )
            for commit_status, claim_status in outcomes:
                decision = await _make_decision_record(database, session["id"])
                _, _, action_id = await _make_project_work_action(harness)
                async with database.sessions.begin() as txn:
                    claim_id, _, _ = await _make_claim_with_requirement(
                        database, harness, repo, txn, action_id=action_id
                    )
                    commit = await repo.create_result_commit(
                        txn,
                        claim_id=claim_id,
                        commit_status=commit_status,
                        artifact_disposition="none",
                        decision_record_id=decision.id,
                        command_id=_new_id(),
                        committed_subject_state=(
                            "completed" if claim_status == "committed" else None
                        ),
                    )
                assert commit.commit_status == commit_status
                async with database.sessions() as txn:
                    claim = await repo.get_claim(txn, claim_id)
                assert claim.status == claim_status
                assert claim.decision_record_id == decision.id

        asyncio.run(scenario())

    def test_result_commit_rejects_already_resolved_claim(self):
        async def scenario():
            database, sessions, harness, repo = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, _, _ = await _make_claim_with_requirement(
                    database, harness, repo, txn, action_id=action_id
                )
                await repo.create_result_commit(
                    txn,
                    claim_id=claim_id,
                    commit_status="accepted",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                    command_id=_new_id(),
                    committed_subject_state="completed",
                )
                with pytest.raises(CompletionClaimAlreadyResolved):
                    await repo.create_result_commit(
                        txn,
                        claim_id=claim_id,
                        commit_status="rejected",
                        artifact_disposition="none",
                        decision_record_id=decision.id,
                        command_id=_new_id(),
                    )

        asyncio.run(scenario())

    def test_validation_outcome_state_machine_fence_and_replay(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            run = await _make_validation_run(database, harness, repo)
            async with database.sessions.begin() as txn:
                # pending 不能直接跳 passed
                with pytest.raises(EvidenceValidationError):
                    await repo.report_validation_outcome(
                        txn,
                        validation_run_id=run.id,
                        outcome_command_id="out-1",
                        status="passed",
                        runtime_lease_epoch=1,
                        exit_code=0,
                    )
            async with database.sessions.begin() as txn:
                # lease fence 不匹配即拒收
                with pytest.raises(RuntimeLeaseFenceMismatch):
                    await repo.mark_validation_run_running(
                        txn, validation_run_id=run.id, runtime_lease_epoch=99
                    )
                await repo.mark_validation_run_running(
                    txn, validation_run_id=run.id, runtime_lease_epoch=1
                )
                reported = await repo.report_validation_outcome(
                    txn,
                    validation_run_id=run.id,
                    outcome_command_id="out-1",
                    status="passed",
                    runtime_lease_epoch=1,
                    exit_code=0,
                    duration_ms=12,
                )
            assert reported.status == "passed"
            assert reported.started_at is not None
            async with database.sessions.begin() as txn:
                # 同幂等键 + 同内容 -> 返回原结果
                replay = await repo.report_validation_outcome(
                    txn,
                    validation_run_id=run.id,
                    outcome_command_id="out-1",
                    status="passed",
                    runtime_lease_epoch=1,
                    exit_code=0,
                    duration_ms=12,
                )
                assert replay.id == run.id
                # 同幂等键 + 不同内容 -> 冲突
                with pytest.raises(EvidenceConflict):
                    await repo.report_validation_outcome(
                        txn,
                        validation_run_id=run.id,
                        outcome_command_id="out-1",
                        status="failed",
                        runtime_lease_epoch=1,
                        exit_code=1,
                    )

        asyncio.run(scenario())

    def test_provenance_relation_matrix_rejects_reverse_write(self):
        async def scenario():
            database, _, _, repo = await _runtime()
            async with database.sessions.begin() as txn:
                with pytest.raises(EvidenceValidationError):
                    await repo.create_provenance_edge(
                        txn,
                        source_kind="work_item",
                        source_id=_new_id(),
                        relation="used",
                        target_kind="artifact_revision",
                        target_id=_new_id(),
                    )
                edge = await repo.create_provenance_edge(
                    txn,
                    source_kind="artifact_revision",
                    source_id=_new_id(),
                    relation="attributed_to",
                    target_kind="work_item",
                    target_id=_new_id(),
                )
            assert edge.relation == "attributed_to"

        asyncio.run(scenario())

    def test_source_invalidation_invariants(self):
        async def scenario():
            database, sessions, _, repo = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            source_id = _new_id()
            async with database.sessions.begin() as txn:
                # stale 必须携带真实指纹变化
                with pytest.raises(EvidenceValidationError):
                    await repo.create_source_invalidation(
                        txn,
                        source_kind="artifact_revision",
                        source_id=source_id,
                        invalidation_kind="stale",
                        previous_fingerprint="a",
                        current_fingerprint="a",
                        command_id=_new_id(),
                    )
                stale = await repo.create_source_invalidation(
                    txn,
                    source_kind="artifact_revision",
                    source_id=source_id,
                    invalidation_kind="stale",
                    previous_fingerprint="a",
                    current_fingerprint="b",
                    command_id=_new_id(),
                )
                # recovered 必须指向同一来源事件
                with pytest.raises(EvidenceValidationError):
                    await repo.create_source_invalidation(
                        txn,
                        source_kind="artifact_revision",
                        source_id=_new_id(),
                        invalidation_kind="recovered",
                        recovers_invalidation_id=stale.id,
                        command_id=_new_id(),
                    )
                recovered = await repo.create_source_invalidation(
                    txn,
                    source_kind=stale.source_kind,
                    source_id=stale.source_id,
                    invalidation_kind="recovered",
                    recovers_invalidation_id=stale.id,
                    command_id=_new_id(),
                )
                # revoked 必须绑定 DecisionRecord
                with pytest.raises(EvidenceValidationError):
                    await repo.create_source_invalidation(
                        txn,
                        source_kind="artifact_blob",
                        source_id=_new_id(),
                        invalidation_kind="revoked",
                        command_id=_new_id(),
                    )
                revoked = await repo.create_source_invalidation(
                    txn,
                    source_kind="artifact_blob",
                    source_id=_new_id(),
                    invalidation_kind="revoked",
                    resolution_decision_record_id=decision.id,
                    command_id=_new_id(),
                )
            assert stale.sequence == 1
            assert recovered.sequence == 2
            assert revoked.resolution_decision_record_id == decision.id

        asyncio.run(scenario())


class TestHarnessTransitionParticipant:
    def test_transition_action_item_inside_caller_session(self):
        async def scenario():
            database, _, harness, _ = await _runtime()
            _, work_id, action_id = await _make_project_work_action(harness)

            recorder = HarnessCommandRecorder(
                scope_id="local-user", principal_id="local-user", clock=utc_now
            )
            participant = HarnessTransitionParticipant(
                scope_id="local-user",
                principal_id="local-user",
                clock=utc_now,
                command_recorder=recorder,
            )

            async with database.sessions.begin() as txn:
                await participant.transition_action_item(
                    txn,
                    action_item_id=action_id,
                    command_id="start-action",
                    request_hash="hash-start",
                    target_status="in_progress",
                    reason="开始执行",
                )
                result = await participant.transition_action_item(
                    txn,
                    action_item_id=action_id,
                    command_id="complete-action",
                    request_hash="hash",
                    target_status="completed",
                    reason="完成",
                    evidence=[{"result_commit_id": "rc1"}],
                )
            assert result["status"] == "completed"
            async with database.sessions() as txn:
                row = await txn.get(ActionItemRecord, action_id)
                work = await txn.get(WorkItemRecord, work_id)
            assert row.status == "completed"
            # 验收：Action 完成与父 Work 不变在同一事务，父 Work 保持 ready
            assert work.status == "ready"

        asyncio.run(scenario())

    def test_action_completion_rolls_back_atomically_with_caller_transaction(self):
        async def scenario():
            database, _, harness, _ = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            recorder = HarnessCommandRecorder(
                scope_id="local-user", principal_id="local-user", clock=utc_now
            )
            participant = HarnessTransitionParticipant(
                scope_id="local-user",
                principal_id="local-user",
                clock=utc_now,
                command_recorder=recorder,
            )

            with pytest.raises(RuntimeError):
                async with database.sessions.begin() as txn:
                    await participant.transition_action_item(
                        txn,
                        action_item_id=action_id,
                        command_id="start-action",
                        request_hash="hash-start",
                        target_status="in_progress",
                        reason="开始执行",
                    )
                    raise RuntimeError("调用方事务失败，participant 写入必须一起回滚")
            async with database.sessions() as txn:
                row = await txn.get(ActionItemRecord, action_id)
            assert row.status == "ready"

        asyncio.run(scenario())
