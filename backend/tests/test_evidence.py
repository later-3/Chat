"""F02/SD4-A contract tests for the Evidence/Artifact/Provenance lifecycle.

The suite intentionally keeps the complete-schema builders and cross-object
transaction fixtures in one module: splitting them would duplicate a large,
easy-to-drift authoritative setup.  Test classes below still separate Artifact,
Claim, Assessment, Result Commit, Validation and Provenance responsibilities so
failures and future extraction boundaries remain easy to locate.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable

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
    ClaimGateRecheck,
    CompletionClaimAlreadyResolved,
    EvidenceConflict,
    EvidenceNotFound,
    EvidenceValidationError,
    RuntimeLeaseFenceMismatch,
    SubjectTransitionNotAllowed,
    WaiverBlockedByFailedRequirement,
    claim_hash,
    validate_observation_payload,
)
from backend.app.evidence.models import (
    CompletionClaimRequirementRecord,
    EvidenceAssessmentRecord,
    RequirementWaiverRecord,
    ResultCommitRecord,
    ValidationRunRecord,
)
from backend.app.evidence.service import (
    EvidenceRepository,
    _issue_result_commit_gate_nonce,
    result_commit_decision_view,
)
from backend.app.execution_workspaces import models as _ew  # noqa: F401
from backend.app.execution_workspaces.models import ExecutionWorkspaceRecord
from backend.app.governance import models as _gov  # noqa: F401
from backend.app.governance.models import (
    DecisionPointDefinitionRecord,
    DecisionRecord,
    DecisionSubjectRecord,
    PolicyEvaluationRecord,
)
from backend.app.governance.service import decision_subject_content_hash
from backend.app.harness import models as _har  # noqa: F401
from backend.app.harness.commands import HarnessCommandRecorder
from backend.app.harness.contracts import HarnessValidationError
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


_OPEN_DATABASES: list[ProductDatabase] = []


def _run_scenario(scenario: Callable[[], Awaitable[None]]) -> None:
    """Run one async scenario and close every in-memory database it opened.

    Aiosqlite owns a worker thread per connection.  Closing the event loop while
    those workers are still returning results creates misleading thread errors,
    so test cleanup is part of the verification contract rather than warning
    suppression.
    """

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


async def _runtime():
    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    await database.initialize()
    _OPEN_DATABASES.append(database)
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


async def _make_decision_record(database: ProductDatabase, session_id: str) -> DecisionRecord:
    """Persist the minimal governance chain so Evidence rows can bind a Decision."""

    async with database.sessions() as txn:
        point = await txn.scalar(
            select(DecisionPointDefinitionRecord).where(
                DecisionPointDefinitionRecord.key == "result_commit",
                DecisionPointDefinitionRecord.version == 1,
            )
        )
    if point is None:
        point = DecisionPointDefinitionRecord(
            id=_new_id(),
            key="result_commit",
            version=1,
            category="evidence",
            label="t",
            description="d",
            subject_kind="result_candidate",
            default_mode="require_approval",
            allowed_human_actions_json=["approve", "reject"],
            applicability_schema_json={},
            response_schema_json={},
            active=True,
            definition_hash=_hash64(),
        )
        async with database.sessions.begin() as txn:
            txn.add(point)
    subject = DecisionSubjectRecord(
        id=_new_id(),
        subject_kind="result_candidate",
        resource_id=_new_id(),
        resource_revision="1",
        subject_hash=_hash64(),
        session_id=session_id,
        decision_view_json={},
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
        bound_subject_hash=subject.subject_hash,
        policy_rule_refs_json=[],
        input_hash=_hash64(),
        record_hash=_hash64(),
    )
    # Persist each FK layer before its dependants, matching coordinator order.
    async with database.sessions.begin() as txn:
        txn.add(subject)
    async with database.sessions.begin() as txn:
        txn.add(evaluation)
    async with database.sessions.begin() as txn:
        txn.add(record)
    return record


async def _make_run_chain(database: ProductDatabase) -> dict[str, str]:
    """Persist session -> interaction -> run -> attempt -> job -> tool_execution."""

    ids = {key: _new_id() for key in ("session", "interaction", "run", "attempt", "job", "execution")}
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


async def _make_artifact_with_revision(
    repo: EvidenceRepository,
    txn,
    *,
    sha256: str | None = None,
) -> tuple:
    """Create blob + artifact + first revision; return (blob, artifact, revision).

    After this helper the ArtifactRecord row_version is 2 (create + revision
    append), which matters for expected-version assertions.
    """

    digest = sha256 or "a" * 64
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


async def _start_action(txn, action_id: str) -> None:
    """Move an ActionItem ready -> in_progress inside the caller transaction."""

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


async def _make_repository_snapshot(
    database: ProductDatabase,
    harness: HarnessService,
) -> RepositorySnapshotRecord:
    """Persist binding + snapshot so Claims/Observations can bind a real baseline."""

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
    return snapshot


async def _make_claim_with_requirement(
    database: ProductDatabase,
    harness: HarnessService,
    repo: EvidenceRepository,
    txn,
    *,
    action_id: str,
    requirement_kind: str = "file_hash_match",
) -> tuple[str, str, str]:
    """Create a candidate Claim with one Requirement; return (claim, requirement, action) ids.

    The action is moved to in_progress first so the Claim's from_state matches
    the authoritative subject state (E04); row_version becomes 2.
    """

    await _start_action(txn, action_id)
    claim = await repo.create_claim(
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


async def _current_adoption_map(txn, claim_id: str) -> dict[str, str]:
    """Map adoptable mandatory Requirements to their current supports Assessment."""

    requirements = list(
        (
            await txn.scalars(
                select(CompletionClaimRequirementRecord).where(
                    CompletionClaimRequirementRecord.completion_claim_id == claim_id,
                    CompletionClaimRequirementRecord.mandatory.is_(True),
                )
            )
        ).all()
    )
    mapping: dict[str, str] = {}
    for requirement in requirements:
        waived = await txn.scalar(
            select(RequirementWaiverRecord.id)
            .where(RequirementWaiverRecord.requirement_id == requirement.id)
            .limit(1)
        )
        if waived is not None:
            continue
        current = await txn.scalar(
            select(EvidenceAssessmentRecord)
            .where(EvidenceAssessmentRecord.requirement_id == requirement.id)
            .order_by(EvidenceAssessmentRecord.assessment_sequence.desc())
            .limit(1)
        )
        if current is not None and current.verdict == "supports":
            mapping[requirement.id] = current.id
    return mapping


async def _bind_decision_record(
    repo: EvidenceRepository,
    txn,
    *,
    claim_id: str,
    commit_status: str,
    artifact_disposition: str,
    decision_record_id: str,
) -> DecisionRecord:
    """Create a fresh Decision bound at creation time to the exact outcome view.

    Append-only fixture mirroring the production contract (治理§6.3)；不
    改写既有subject或decision。
    """

    claim = await repo.get_claim(txn, claim_id)
    original = await txn.get(DecisionRecord, decision_record_id)
    assert original is not None
    original_subject = await txn.get(DecisionSubjectRecord, original.subject_id)
    assert original_subject is not None
    point = await txn.scalar(
        select(DecisionPointDefinitionRecord).where(
            DecisionPointDefinitionRecord.key == "result_commit",
            DecisionPointDefinitionRecord.version == 1,
        )
    )
    assert point is not None
    has_artifact = claim.artifact_revision_id is not None
    view = result_commit_decision_view(
        claim_id=claim.id,
        claim_hash=claim.claim_hash,
        claim_row_version=claim.row_version,
        action_outcomes={
            "accept": {
                "commit_status": "accepted",
                "artifact_disposition": "accepted" if has_artifact else "none",
                "adoptions": await _current_adoption_map(txn, claim.id),
            },
            "waive": {
                "commit_status": "waived",
                "artifact_disposition": "accepted" if has_artifact else "none",
                "adoptions": await _current_adoption_map(txn, claim.id),
            },
            "reject": {
                "commit_status": "rejected",
                "artifact_disposition": "rejected" if has_artifact else "none",
                "adoptions": {},
            },
        },
    )
    decision_code = {"accepted": "accept", "waived": "waive"}.get(commit_status, "reject")
    subject_hash = decision_subject_content_hash(view)
    subject = await txn.scalar(
        select(DecisionSubjectRecord).where(
            DecisionSubjectRecord.subject_kind == "result_candidate",
            DecisionSubjectRecord.resource_id == claim.id,
            DecisionSubjectRecord.resource_revision == str(claim.row_version),
            DecisionSubjectRecord.subject_hash == subject_hash,
        )
    )
    if subject is None:
        subject = DecisionSubjectRecord(
            id=_new_id(),
            subject_kind="result_candidate",
            resource_id=claim.id,
            resource_revision=str(claim.row_version),
            subject_hash=subject_hash,
            session_id=original_subject.session_id,
            decision_view_json=view,
        )
        txn.add(subject)
        await txn.flush()
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
    decision = DecisionRecord(
        id=_new_id(),
        policy_evaluation_id=evaluation.id,
        subject_id=subject.id,
        source=original.source,
        actor_principal_id=original.actor_principal_id,
        decision_code=decision_code,
        authorization_effect=original.authorization_effect,
        reason=original.reason,
        bound_subject_hash=subject.subject_hash,
        policy_rule_refs_json=[],
        input_hash=_hash64(),
        record_hash=_hash64(),
    )
    txn.add(evaluation)
    await txn.flush()
    txn.add(decision)
    await txn.flush()
    return decision


async def _create_result_commit(
    repo: EvidenceRepository,
    txn,
    *,
    claim_id: str,
    commit_status: str,
    artifact_disposition: str,
    decision_record_id: str,
    command_id: str,
    committed_subject_state: str | None = None,
    gate_recheck: ClaimGateRecheck | None = None,
) -> ResultCommitRecord:
    """Bind a test commit command to the exact Claim revision it observed."""

    decision = await _bind_decision_record(
        repo,
        txn,
        claim_id=claim_id,
        commit_status=commit_status,
        artifact_disposition=artifact_disposition,
        decision_record_id=decision_record_id,
    )
    claim = await repo.get_claim(txn, claim_id)
    return await repo.create_result_commit(
        txn,
        claim_id=claim_id,
        claim_hash=claim.claim_hash,
        expected_claim_row_version=claim.row_version,
        commit_status=commit_status,
        artifact_disposition=artifact_disposition,
        decision_record_id=decision.id,
        command_id=command_id,
        committed_subject_state=committed_subject_state,
        gate_recheck=gate_recheck,
    )


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


class TestClaimHash:
    """E01：所有会改变批准后果的字段都必须绑定进 claim_hash（逐字段变异）。"""

    def _baseline(self) -> dict:
        return {
            "subject_kind": "action_item",
            "subject_id": "action-1",
            "expected_subject_version": 2,
            "from_state": "in_progress",
            "target_transition": "action_result_accepted",
            "target_state": "completed",
            "validation_contract_id": "contract-1",
            "artifact_revision_id": "revision-1",
            "expected_artifact_record_version": 2,
            "repository_snapshot_id": "snapshot-1",
            "applicability_policy": "record_only",
            "requirements": [
                {
                    "requirement_index": 0,
                    "requirement_kind": "validation_result",
                    "mandatory": True,
                    "description": "d",
                    "contract_rule_ordinal": 1,
                    "params_json": {"targets": ["backend/tests"]},
                    "schema_version": "validation-result-v1",
                }
            ],
        }

    def test_same_content_produces_stable_hash(self):
        baseline = self._baseline()
        assert claim_hash(**baseline) == claim_hash(**self._baseline())

    def test_requirements_order_does_not_change_hash(self):
        baseline = self._baseline()
        extra = dict(baseline["requirements"][0])
        extra["requirement_index"] = 1
        extra["description"] = "second"
        forward = {**baseline, "requirements": [baseline["requirements"][0], extra]}
        backward = {**baseline, "requirements": [extra, baseline["requirements"][0]]}
        assert claim_hash(**forward) == claim_hash(**backward)

    @pytest.mark.parametrize(
        ("field", "mutated"),
        [
            ("validation_contract_id", "contract-2"),
            ("expected_subject_version", 3),
            ("from_state", "ready"),
            ("target_state", "blocked"),
            ("expected_artifact_record_version", 3),
        ],
    )
    def test_hash_binds_approval_consequence_fields(self, field, mutated):
        baseline = self._baseline()
        changed = {**baseline, field: mutated}
        assert claim_hash(**changed) != claim_hash(**baseline)

    def test_hash_binds_none_to_value_transitions(self):
        baseline = self._baseline()
        for field in ("validation_contract_id", "expected_artifact_record_version"):
            changed = {**baseline, field: None}
            assert claim_hash(**changed) != claim_hash(**baseline)


class TestArtifactRepository:
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
                    expected_artifact_record_version=1,
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

        _run_scenario(scenario)

    def test_revision_append_rejects_stale_expected_version(self):
        async def scenario():
            database, _, _, repo = await _runtime()
            async with database.sessions.begin() as txn:
                _, artifact, _ = await _make_artifact_with_revision(repo, txn)
                # Artifact 现在 row_version=2；基于旧版本 1 的追加必须稳定冲突
                with pytest.raises(EvidenceConflict, match="期望版本"):
                    await repo.create_artifact_revision(
                        txn,
                        artifact_id=artifact.id,
                        expected_artifact_record_version=1,
                        storage_blob_id=(
                            await repo.get_current_artifact_revision(txn, artifact.id)
                        ).storage_blob_id,
                        sha256="a" * 64,
                        size_bytes=100,
                        command_id=_new_id(),
                    )

        _run_scenario(scenario)

    def test_revision_append_duplicate_command_id_is_stable_conflict(self):
        async def scenario():
            database, _, _, repo = await _runtime()
            async with database.sessions.begin() as txn:
                blob, artifact, _ = await _make_artifact_with_revision(repo, txn)
                # 同一 command_id 重放追加：唯一约束是最后防线，必须翻译为
                # 稳定领域冲突，不能让原始数据库异常穿透或伪装成功
                with pytest.raises(EvidenceConflict, match="竞争冲突"):
                    await repo.create_artifact_revision(
                        txn,
                        artifact_id=artifact.id,
                        expected_artifact_record_version=2,
                        storage_blob_id=blob.id,
                        sha256="a" * 64,
                        size_bytes=100,
                        command_id=(await repo.get_current_artifact_revision(txn, artifact.id)).command_id,
                    )

        _run_scenario(scenario)

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

        _run_scenario(scenario)

    def test_revision_append_blocked_by_candidate_claim(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                blob, artifact, revision = await _make_artifact_with_revision(repo, txn)
                await _start_action(txn, action_id)
                await repo.create_claim(
                    txn,
                    subject_kind="action_item",
                    subject_id=action_id,
                    from_state="in_progress",
                    target_transition="action_result_accepted",
                    expected_subject_version=2,
                    target_state="completed",
                    artifact_revision_id=revision.id,
                    expected_artifact_record_version=2,
                    applicability_policy="record_only",
                    requirements=[],
                    command_id="c3",
                )
                with pytest.raises(ArtifactRevisionSuperseded):
                    await repo.create_artifact_revision(
                        txn,
                        artifact_id=artifact.id,
                        expected_artifact_record_version=2,
                        storage_blob_id=blob.id,
                        sha256="a" * 64,
                        size_bytes=100,
                        command_id="c4",
                    )

        _run_scenario(scenario)

    def test_revision_rejects_blob_hash_mismatch(self):
        async def scenario():
            database, _, _, repo = await _runtime()
            async with database.sessions.begin() as txn:
                blob = await repo.create_artifact_blob(txn, sha256="a" * 64, size_bytes=1, storage_path="p1")
                artifact = await repo.create_artifact_record(
                    txn, kind="diff_patch", title="t", media_type="text/x-diff", command_id="c1"
                )
                with pytest.raises(ArtifactHashMismatch) as excinfo:
                    await repo.create_artifact_revision(
                        txn,
                        artifact_id=artifact.id,
                        expected_artifact_record_version=1,
                        storage_blob_id=blob.id,
                        sha256="b" * 64,
                        size_bytes=1,
                        command_id="c2",
                    )
            assert excinfo.value.code == "ARTIFACT_HASH_MISMATCH"

        _run_scenario(scenario)

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

        _run_scenario(scenario)


class TestClaimRepository:
    def test_claim_with_requirements_round_trip(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                await _start_action(txn, action_id)
                claim = await repo.create_claim(
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

        _run_scenario(scenario)

    def test_claim_rejects_narrated_from_state(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                # Action 实际为 ready，调用方却声称 in_progress：必须稳定冲突
                with pytest.raises(EvidenceConflict, match="from_state"):
                    await repo.create_claim(
                        txn,
                        subject_kind="action_item",
                        subject_id=action_id,
                        from_state="in_progress",
                        target_transition="action_result_accepted",
                        expected_subject_version=1,
                        target_state="completed",
                        applicability_policy="record_only",
                        requirements=[],
                        command_id=_new_id(),
                    )

        _run_scenario(scenario)

    def test_claim_rejects_transition_not_allowed_for_current_state(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                # from_state 与实际一致（ready），但 action_result_accepted
                # 只允许 in_progress -> completed
                with pytest.raises(SubjectTransitionNotAllowed):
                    await repo.create_claim(
                        txn,
                        subject_kind="action_item",
                        subject_id=action_id,
                        from_state="ready",
                        target_transition="action_result_accepted",
                        expected_subject_version=1,
                        target_state="completed",
                        applicability_policy="record_only",
                        requirements=[],
                        command_id=_new_id(),
                    )

        _run_scenario(scenario)

    def test_claim_rejects_wrong_target_state(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                await _start_action(txn, action_id)
                with pytest.raises(SubjectTransitionNotAllowed):
                    await repo.create_claim(
                        txn,
                        subject_kind="action_item",
                        subject_id=action_id,
                        from_state="in_progress",
                        target_transition="action_result_accepted",
                        expected_subject_version=2,
                        target_state="blocked",
                        applicability_policy="record_only",
                        requirements=[],
                        command_id=_new_id(),
                    )

        _run_scenario(scenario)

    def test_claim_rejects_transition_for_wrong_subject_kind(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, work_id, _ = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                recorder = HarnessCommandRecorder(
                    scope_id="local-user", principal_id="local-user", clock=utc_now
                )
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
                # work_item 不允许 action_result_accepted
                with pytest.raises(SubjectTransitionNotAllowed):
                    await repo.create_claim(
                        txn,
                        subject_kind="work_item",
                        subject_id=work_id,
                        from_state="in_progress",
                        target_transition="action_result_accepted",
                        expected_subject_version=2,
                        target_state="completed",
                        applicability_policy="record_only",
                        requirements=[],
                        command_id=_new_id(),
                    )
                # work_completed 对 in_progress Work 合法
                claim = await repo.create_claim(
                    txn,
                    subject_kind="work_item",
                    subject_id=work_id,
                    from_state="in_progress",
                    target_transition="work_completed",
                    expected_subject_version=2,
                    target_state="completed",
                    applicability_policy="record_only",
                    requirements=[],
                    command_id=_new_id(),
                )
            assert claim.target_transition == "work_completed"

        _run_scenario(scenario)

    def test_claim_action_acceptance_rejects_must_match_policy(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            snapshot = await _make_repository_snapshot(database, harness)
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                await _start_action(txn, action_id)
                with pytest.raises(EvidenceValidationError, match="record_only"):
                    await repo.create_claim(
                        txn,
                        subject_kind="action_item",
                        subject_id=action_id,
                        from_state="in_progress",
                        target_transition="action_result_accepted",
                        expected_subject_version=2,
                        target_state="completed",
                        repository_snapshot_id=snapshot.id,
                        applicability_policy="must_match_current_target",
                        requirements=[],
                        command_id=_new_id(),
                    )

        _run_scenario(scenario)

    def test_claim_rejects_stale_artifact_record_version(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                _, _, revision = await _make_artifact_with_revision(repo, txn)
                await _start_action(txn, action_id)
                # Artifact 已前进到 row_version=2，声称 1 的 Claim 必须冲突
                with pytest.raises(EvidenceConflict, match="期望Artifact版本"):
                    await repo.create_claim(
                        txn,
                        subject_kind="action_item",
                        subject_id=action_id,
                        from_state="in_progress",
                        target_transition="action_result_accepted",
                        expected_subject_version=2,
                        target_state="completed",
                        artifact_revision_id=revision.id,
                        expected_artifact_record_version=1,
                        applicability_policy="record_only",
                        requirements=[],
                        command_id=_new_id(),
                    )

        _run_scenario(scenario)

    def test_claim_rejects_missing_validation_contract(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                await _start_action(txn, action_id)
                with pytest.raises(EvidenceNotFound):
                    await repo.create_claim(
                        txn,
                        subject_kind="action_item",
                        subject_id=action_id,
                        from_state="in_progress",
                        target_transition="action_result_accepted",
                        expected_subject_version=2,
                        target_state="completed",
                        applicability_policy="record_only",
                        validation_contract_id=_new_id(),
                        requirements=[],
                        command_id=_new_id(),
                    )

        _run_scenario(scenario)

    def test_claim_rejects_stale_subject_version(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                await _start_action(txn, action_id)
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

        _run_scenario(scenario)

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

        _run_scenario(scenario)


class TestEvidenceAssessmentRepository:
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

        _run_scenario(scenario)

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

        _run_scenario(scenario)

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

        _run_scenario(scenario)

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

        _run_scenario(scenario)

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

        _run_scenario(scenario)

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
                await _create_result_commit(
                    repo,
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

        _run_scenario(scenario)


class TestResultCommitRepository:
    def test_result_commit_rejected_outcome_records_without_touching_subject(self):
        async def scenario():
            database, sessions, harness, repo = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, _, _ = await _make_claim_with_requirement(
                    database, harness, repo, txn, action_id=action_id
                )
                commit = await _create_result_commit(
                    repo,
                    txn,
                    claim_id=claim_id,
                    commit_status="rejected",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                    command_id=_new_id(),
                )
            assert commit.commit_status == "rejected"
            assert commit.pre_commit_validity_check_passed is False
            assert commit.committed_subject_state is None
            async with database.sessions() as txn:
                claim = await repo.get_claim(txn, claim_id)
                action = await txn.get(ActionItemRecord, action_id)
            assert claim.status == "rejected"
            assert claim.decision_record_id == commit.decision_record_id
            # rejected 不得推进 Harness 主体：Action 仍是 in_progress / row_version=2
            assert action.status == "in_progress"
            assert action.row_version == 2

        _run_scenario(scenario)

    def test_result_commit_accepted_and_waived_fail_closed(self):
        async def scenario():
            database, sessions, harness, repo = await _runtime()
            session = await sessions.create_session()
            for commit_status in ("accepted", "waived"):
                decision = await _make_decision_record(database, session["id"])
                _, _, action_id = await _make_project_work_action(harness)
                async with database.sessions.begin() as txn:
                    claim_id, _, _ = await _make_claim_with_requirement(
                        database, harness, repo, txn, action_id=action_id
                    )
                    # SD4-C：没有 Coordinator 复检证明，成功路径必须 fail closed
                    with pytest.raises(EvidenceValidationError, match="复检证明"):
                        await _create_result_commit(
                            repo,
                            txn,
                            claim_id=claim_id,
                            commit_status=commit_status,
                            artifact_disposition="none",
                            decision_record_id=decision.id,
                            command_id=_new_id(),
                            committed_subject_state="completed",
                        )
                    # 伪造不属于当前 Claim 版本的复检证明同样被拒绝
                    claim = await repo.get_claim(txn, claim_id)
                    fake_recheck = ClaimGateRecheck(
                        claim_id=claim_id,
                        claim_hash="0" * 64,
                        claim_row_version=claim.row_version,
                        commit_status=commit_status,
                        mandatory_requirement_ids=(),
                        adoption_ids=(),
                        waiver_ids=(),
                        artifact_record_id=None,
                        artifact_revision_id=None,
                        artifact_record_version=None,
                        _gate_nonce=_issue_result_commit_gate_nonce(txn),
                    )
                    with pytest.raises(EvidenceConflict, match="复检证明"):
                        await _create_result_commit(
                            repo,
                            txn,
                            claim_id=claim_id,
                            commit_status=commit_status,
                            artifact_disposition="none",
                            decision_record_id=decision.id,
                            command_id=_new_id(),
                            committed_subject_state="completed",
                            gate_recheck=fake_recheck,
                        )
                async with database.sessions() as txn:
                    claim = await repo.get_claim(txn, claim_id)
                    commits = (
                        await txn.scalars(
                            select(ResultCommitRecord).where(
                                ResultCommitRecord.completion_claim_id == claim_id
                            )
                        )
                    ).all()
                # Claim 仍是 candidate，且没有任何 ResultCommit 半记录
                assert claim.status == "candidate"
                assert commits == []

        _run_scenario(scenario)

    def test_result_commit_rejects_stale_binding_and_cross_scope_decision(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            local_sessions = ProductSessionService(database, scope_id="local-user")
            other_sessions = ProductSessionService(database, scope_id="other-scope")
            local_session = await local_sessions.create_session()
            other_session = await other_sessions.create_session()
            local_decision = await _make_decision_record(database, local_session["id"])
            other_decision = await _make_decision_record(database, other_session["id"])
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, _, _ = await _make_claim_with_requirement(
                    database, harness, repo, txn, action_id=action_id
                )
                claim = await repo.get_claim(txn, claim_id)
                common = {
                    "claim_id": claim_id,
                    "commit_status": "rejected",
                    "artifact_disposition": "none",
                    "command_id": _new_id(),
                }
                with pytest.raises(EvidenceConflict, match="claim_hash"):
                    await repo.create_result_commit(
                        txn,
                        claim_hash="0" * 64,
                        expected_claim_row_version=claim.row_version,
                        decision_record_id=local_decision.id,
                        **common,
                    )
                with pytest.raises(EvidenceConflict, match="期望Claim版本"):
                    await repo.create_result_commit(
                        txn,
                        claim_hash=claim.claim_hash,
                        expected_claim_row_version=claim.row_version + 1,
                        decision_record_id=local_decision.id,
                        **common,
                    )
                with pytest.raises(EvidenceNotFound):
                    await repo.create_result_commit(
                        txn,
                        claim_hash=claim.claim_hash,
                        expected_claim_row_version=claim.row_version,
                        decision_record_id=other_decision.id,
                        **common,
                    )

        _run_scenario(scenario)

    def test_result_commit_rejected_rejects_subject_state_and_bad_disposition(self):
        async def scenario():
            database, sessions, harness, repo = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, _, _ = await _make_claim_with_requirement(
                    database, harness, repo, txn, action_id=action_id
                )
                # 形状校验先于绑定：同一个合法rejected/none Decision即可覆盖
                # 两条非法请求形状，无需第二个不同视图的Subject（逻辑身份唯一）。
                bound = await _bind_decision_record(
                    repo,
                    txn,
                    claim_id=claim_id,
                    commit_status="rejected",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                )
                with pytest.raises(EvidenceValidationError, match="committed_subject_state"):
                    await repo.create_result_commit(
                        txn,
                        claim_id=claim_id,
                        claim_hash=(await repo.get_claim(txn, claim_id)).claim_hash,
                        expected_claim_row_version=1,
                        commit_status="rejected",
                        artifact_disposition="none",
                        decision_record_id=bound.id,
                        command_id=_new_id(),
                        committed_subject_state="completed",
                    )
                with pytest.raises(EvidenceValidationError, match="artifact_disposition"):
                    await repo.create_result_commit(
                        txn,
                        claim_id=claim_id,
                        claim_hash=(await repo.get_claim(txn, claim_id)).claim_hash,
                        expected_claim_row_version=1,
                        commit_status="rejected",
                        artifact_disposition="accepted",
                        decision_record_id=bound.id,
                        command_id=_new_id(),
                    )

        _run_scenario(scenario)

    def test_result_commit_failure_leaves_no_half_written_rows(self):
        async def scenario():
            database, sessions, harness, repo = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            _, _, action_id = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                claim_id, _, _ = await _make_claim_with_requirement(
                    database, harness, repo, txn, action_id=action_id
                )
            with pytest.raises(RuntimeError):
                async with database.sessions.begin() as txn:
                    await _create_result_commit(
                        repo,
                        txn,
                        claim_id=claim_id,
                        commit_status="rejected",
                        artifact_disposition="none",
                        decision_record_id=decision.id,
                        command_id=_new_id(),
                    )
                    raise RuntimeError("调用方事务失败，ResultCommit必须整体回滚")
            async with database.sessions() as txn:
                claim = await repo.get_claim(txn, claim_id)
                commits = (
                    await txn.scalars(
                        select(ResultCommitRecord).where(ResultCommitRecord.completion_claim_id == claim_id)
                    )
                ).all()
            assert claim.status == "candidate"
            assert commits == []

        _run_scenario(scenario)

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
                await _create_result_commit(
                    repo,
                    txn,
                    claim_id=claim_id,
                    commit_status="rejected",
                    artifact_disposition="none",
                    decision_record_id=decision.id,
                    command_id=_new_id(),
                )
                with pytest.raises(CompletionClaimAlreadyResolved):
                    await _create_result_commit(
                        repo,
                        txn,
                        claim_id=claim_id,
                        commit_status="rejected",
                        artifact_disposition="none",
                        decision_record_id=decision.id,
                        command_id=_new_id(),
                    )

        _run_scenario(scenario)


class TestValidationRepository:
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
                await repo.mark_validation_run_running(txn, validation_run_id=run.id, runtime_lease_epoch=1)
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

        _run_scenario(scenario)


class TestProvenanceAndInvalidationRepository:
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

        _run_scenario(scenario)

    def test_provenance_edge_rejects_nonexistent_and_cross_scope_references(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            other_repo = EvidenceRepository(scope_id="other-scope", principal_id="other-principal")
            _, work_id, _ = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                _, _, revision = await _make_artifact_with_revision(repo, txn)
                # 随机 UUID 必须失败
                with pytest.raises(EvidenceNotFound):
                    await repo.create_provenance_edge(
                        txn,
                        source_kind="artifact_revision",
                        source_id=_new_id(),
                        relation="attributed_to",
                        target_kind="work_item",
                        target_id=work_id,
                    )
                # 错误 kind + 真实 ID 组合必须失败（不能碰巧命中另一张表）
                with pytest.raises(EvidenceNotFound):
                    await repo.create_provenance_edge(
                        txn,
                        source_kind="evidence_observation",
                        source_id=revision.id,
                        relation="derived_from",
                        target_kind="artifact_revision",
                        target_id=revision.id,
                    )
                # 跨 scope：other-scope 的写入者不能引用本 scope 对象
                with pytest.raises(EvidenceNotFound):
                    await other_repo.create_provenance_edge(
                        txn,
                        source_kind="artifact_revision",
                        source_id=revision.id,
                        relation="attributed_to",
                        target_kind="work_item",
                        target_id=work_id,
                    )
                # 真实同 scope 引用成功
                edge = await repo.create_provenance_edge(
                    txn,
                    source_kind="artifact_revision",
                    source_id=revision.id,
                    relation="attributed_to",
                    target_kind="work_item",
                    target_id=work_id,
                )
            assert edge.relation == "attributed_to"

        _run_scenario(scenario)

    def test_source_invalidation_rejects_nonexistent_and_cross_scope_source(self):
        async def scenario():
            database, _, _, repo = await _runtime()
            other_repo = EvidenceRepository(scope_id="other-scope", principal_id="other-principal")
            async with database.sessions.begin() as txn:
                _, _, revision = await _make_artifact_with_revision(repo, txn)
                with pytest.raises(EvidenceNotFound):
                    await repo.create_source_invalidation(
                        txn,
                        source_kind="artifact_revision",
                        source_id=_new_id(),
                        invalidation_kind="stale",
                        previous_fingerprint="a",
                        current_fingerprint="b",
                        command_id=_new_id(),
                    )
                with pytest.raises(EvidenceNotFound):
                    await other_repo.create_source_invalidation(
                        txn,
                        source_kind="artifact_revision",
                        source_id=revision.id,
                        invalidation_kind="stale",
                        previous_fingerprint="a",
                        current_fingerprint="b",
                        command_id=_new_id(),
                    )

        _run_scenario(scenario)

    def test_observation_rejects_nonexistent_optional_source(self):
        async def scenario():
            database, _, harness, repo = await _runtime()
            _, work_id, _ = await _make_project_work_action(harness)
            async with database.sessions.begin() as txn:
                # product_run_id 是硬 FK 之外的 scope 语义：随机 UUID 必须失败
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
                        subject_id=work_id,
                        statement="来源不存在",
                        product_run_id=_new_id(),
                        command_id=_new_id(),
                    )

        _run_scenario(scenario)

    def test_source_invalidation_invariants(self):
        async def scenario():
            database, sessions, _, repo = await _runtime()
            session = await sessions.create_session()
            decision = await _make_decision_record(database, session["id"])
            async with database.sessions.begin() as txn:
                blob, _, revision = await _make_artifact_with_revision(repo, txn)
                _, _, other_revision = await _make_artifact_with_revision(repo, txn, sha256="c" * 64)
                # stale 必须携带真实指纹变化
                with pytest.raises(EvidenceValidationError):
                    await repo.create_source_invalidation(
                        txn,
                        source_kind="artifact_revision",
                        source_id=revision.id,
                        invalidation_kind="stale",
                        previous_fingerprint="a",
                        current_fingerprint="a",
                        command_id=_new_id(),
                    )
                stale = await repo.create_source_invalidation(
                    txn,
                    source_kind="artifact_revision",
                    source_id=revision.id,
                    invalidation_kind="stale",
                    previous_fingerprint="a",
                    current_fingerprint="b",
                    command_id=_new_id(),
                )
                # recovered 必须指向同一来源事件（换一个真实但不同的来源仍失败）
                with pytest.raises(EvidenceValidationError):
                    await repo.create_source_invalidation(
                        txn,
                        source_kind="artifact_revision",
                        source_id=other_revision.id,
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
                        source_id=blob.id,
                        invalidation_kind="revoked",
                        command_id=_new_id(),
                    )
                revoked = await repo.create_source_invalidation(
                    txn,
                    source_kind="artifact_blob",
                    source_id=blob.id,
                    invalidation_kind="revoked",
                    resolution_decision_record_id=decision.id,
                    command_id=_new_id(),
                )
            assert stale.sequence == 1
            assert recovered.sequence == 2
            assert revoked.resolution_decision_record_id == decision.id

        _run_scenario(scenario)


class TestHarnessTransitionParticipant:
    def test_transition_action_item_inside_caller_session(self):
        async def scenario():
            database, _, harness, _ = await _runtime()
            _, work_id, action_id = await _make_project_work_action(harness)

            recorder = HarnessCommandRecorder(scope_id="local-user", principal_id="local-user", clock=utc_now)
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
                with pytest.raises(HarnessValidationError, match="Result Commit Gate"):
                    await participant.transition_action_item(
                        txn,
                        action_item_id=action_id,
                        command_id="complete-action",
                        request_hash="hash",
                        target_status="completed",
                        reason="完成",
                        evidence=[{"note": "legacy evidence"}],
                    )
            async with database.sessions() as txn:
                row = await txn.get(ActionItemRecord, action_id)
                work = await txn.get(WorkItemRecord, work_id)
            assert row.status == "in_progress"
            # 旧 Evidence 不能再写完成；父 Work 同样保持 ready。
            assert work.status == "ready"

        _run_scenario(scenario)

    def test_reserved_projection_shape_fails_closed_without_gate_validator(self):
        """SD4-C：公开 participant 未注入 Gate 校验器时，ResultCommit 引用投影被拒。"""

        async def scenario():
            database, _, harness, _ = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            recorder = HarnessCommandRecorder(scope_id="local-user", principal_id="local-user", clock=utc_now)
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
                with pytest.raises(HarnessValidationError, match="只能由Result Commit Gate写入"):
                    await participant.transition_action_item(
                        txn,
                        action_item_id=action_id,
                        command_id="complete-action",
                        request_hash="hash",
                        target_status="completed",
                        reason="完成",
                        evidence=[{"result_commit_id": "rc1", "claim_id": "c1"}],
                        expected_row_version=2,
                    )
                with pytest.raises(HarnessValidationError, match="唯一result_commit_id/claim_id"):
                    await participant.transition_action_item(
                        txn,
                        action_item_id=action_id,
                        command_id="complete-action-mixed",
                        request_hash="hash",
                        target_status="completed",
                        reason="完成",
                        evidence=[{"result_commit_id": "rc1", "claim_id": "c1", "note": "x"}],
                        expected_row_version=2,
                    )
                with pytest.raises(HarnessValidationError, match="必须携带expected_row_version"):
                    await participant.transition_action_item(
                        txn,
                        action_item_id=action_id,
                        command_id="complete-action-no-cas",
                        request_hash="hash",
                        target_status="completed",
                        reason="完成",
                        evidence=[{"result_commit_id": "rc1", "claim_id": "c1"}],
                    )
            async with database.sessions() as txn:
                row = await txn.get(ActionItemRecord, action_id)
            # 伪造投影没有推进任何状态
            assert row.status == "in_progress"
            assert row.evidence_json == []

        _run_scenario(scenario)

    def test_action_completion_rolls_back_atomically_with_caller_transaction(self):
        async def scenario():
            database, _, harness, _ = await _runtime()
            _, _, action_id = await _make_project_work_action(harness)
            recorder = HarnessCommandRecorder(scope_id="local-user", principal_id="local-user", clock=utc_now)
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

        _run_scenario(scenario)
