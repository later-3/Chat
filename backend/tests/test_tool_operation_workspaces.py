"""F01/SD3 contract, filesystem and reconciliation tests."""

from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

import pytest

from backend.app.collaboration_protocols import (
    models as _collaboration_protocol_models,  # noqa: F401
)
from backend.app.config import WorkspaceRootSettings
from backend.app.execution_dispatch.repository_context import (
    RepositoryExecutionContextService,
)
from backend.app.execution_workspaces import (
    ExecutionWorkspaceError,
    ExecutionWorkspaceService,
    WorkspaceOwnership,
)
from backend.app.governance import (
    ExecutionGovernanceService,
)
from backend.app.governance import (
    models as _governance_models,  # noqa: F401
)
from backend.app.harness.models import ProductProjectRecord
from backend.app.product_sessions.database import (
    InteractionRecord,
    ProductDatabase,
    RunAttemptRecord,
    RunRecord,
    SessionRecord,
    ToolExecutionRecord,
    utc_now,
)
from backend.app.project_resources.catalog import WorkspaceRootCatalog
from backend.app.project_resources.git_inspector import ReadOnlyGitInspector
from backend.app.project_resources.models import RepositorySnapshotRecord
from backend.app.project_resources.service import ProjectResourceService
from backend.app.runtime_execution.models import RuntimeJobRecord
from backend.app.step_inputs import models as _step_input_models  # noqa: F401
from backend.app.tool_execution import (
    PreparedToolOperation,
    ToolOperationError,
    ToolOperationService,
)


def _git(cwd: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        check=True,
        text=True,
        capture_output=True,
        env={
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
        },
    ).stdout.strip()


def _repository(path: Path) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q")
    _git(path, "config", "user.name", "Chat Test")
    _git(path, "config", "user.email", "chat-test@example.invalid")
    _git(path, "config", "commit.gpgsign", "false")
    (path / "app.py").write_text("value = 'before'\n", encoding="utf-8")
    _git(path, "add", "app.py")
    _git(path, "commit", "-qm", "initial")
    return path


async def _authorize_operation(
    database: ProductDatabase,
    operations: ToolOperationService,
    prepared: PreparedToolOperation,
    *,
    tool_call_id: str,
) -> None:
    """Use the real Decision/Grant/Consumption chain in filesystem unit tests."""

    governance = ExecutionGovernanceService(database)
    await governance.initialize()
    request, subject = await governance.register_tool_call(
        run_id="run-1",
        workflow_node_id="pi_workspace_dispatch",
        provider_tool_call_id=tool_call_id,
        tool_id="edit",
        tool_definition_revision="chat-exact-edit-v1",
        arguments={
            "operation_hash": prepared.operation_hash,
            "target_path": prepared.target_path,
        },
        target_summary=f"Execution Workspace {prepared.workspace_id}",
        risk_snapshot={
            "tool": {
                "risk_level": 0,
                "has_side_effects": False,
                "outside_capability": False,
            }
        },
        workflow_definition_id="continuous-collaboration",
        workflow_version="1.7.0",
    )
    evaluation, _ = await governance.evaluate_subject(
        subject=subject,
        decision_point_key="tool_execution_authorization",
        scopes=[
            {"kind": "product_default", "ref_id": "*"},
            {"kind": "principal", "ref_id": "local-user"},
            {"kind": "run", "ref_id": "run-1"},
        ],
        facts={
            "tool": {
                "risk_level": 0,
                "has_side_effects": False,
                "outside_capability": False,
            }
        },
    )
    _, grant = await governance.record_automatic_decision(
        evaluation=evaluation,
        subject=subject,
        decision_code="approve",
        grant_kind="execute_tool",
        binding_hash=subject.subject_hash,
    )
    assert grant is not None
    consumption = await governance.claim_grant(
        grant_id=grant.id,
        binding_hash=subject.subject_hash,
        consumer_kind="tool_operation_test",
        consumer_id=prepared.operation_id,
        idempotency_key=f"tool-operation-test:{prepared.operation_id}",
        claimed_by="pytest",
    )
    await governance.mark_tool_call_authorized(
        tool_call_request_id=request.id,
        authorization_consumption_id=consumption.id,
    )
    await operations.authorize(
        prepared.operation_id,
        consumption_id=consumption.id,
    )


async def _runtime(
    tmp_path: Path,
) -> tuple[
    ProductDatabase,
    ExecutionWorkspaceService,
    ToolOperationService,
    WorkspaceOwnership,
    object,
    Path,
]:
    source_root = tmp_path / "sources"
    repository = _repository(source_root / "chat")
    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    await database.initialize()
    project = ProductProjectRecord(
        id="project-1",
        scope_id="local-user",
        kind="delivery",
        title="Chat",
        goal="让Chat开发自己",
        status="active",
        row_version=1,
        created_by="local-user",
        created_at=utc_now(),
        updated_at=utc_now(),
    )
    session = SessionRecord(
        id="session-1",
        scope_id="local-user",
        channel="web",
        title="SD3",
        status="running",
        revision=1,
        active_run_id="run-1",
    )
    interaction = InteractionRecord(
        id="interaction-1",
        session_id=session.id,
        user_message_id="message-1",
        status="accepted",
    )
    run = RunRecord(
        id="run-1",
        session_id=session.id,
        interaction_id=interaction.id,
        initial_agui_run_id="agui-run-1",
        request_hash="r" * 64,
        status="running",
        current_user_message_id="message-1",
    )
    attempt = RunAttemptRecord(
        id="attempt-1",
        run_id=run.id,
        attempt_number=1,
        runtime_kind="workflow",
        status="running",
    )
    job = RuntimeJobRecord(
        id="job-1",
        scope_id="local-user",
        product_run_id=run.id,
        run_attempt_id=attempt.id,
        endpoint_key="/api/workflows/continuous",
        workflow_definition_id="continuous-collaboration",
        workflow_version="1.7.0",
        status="running",
        recoverability="checkpoint",
        input_payload_json={},
        input_hash="i" * 64,
        external_dispatch_state="dispatching",
    )
    execution = ToolExecutionRecord(
        id="execution-1",
        session_id=session.id,
        run_id=run.id,
        run_attempt_id=attempt.id,
        runtime_job_id=job.id,
        tool_id="pi_agent",
        execution_ordinal=1,
        mode="workspace_edit",
        config_revision=1,
        status="starting",
        metrics={},
    )
    # These records intentionally omit ORM relationships. Persist each ownership
    # layer before its dependants so the test exercises the same FK order used by
    # application coordinators instead of relying on SQLAlchemy object sorting.
    async with database.sessions.begin() as transaction:
        transaction.add_all([project, session])
    async with database.sessions.begin() as transaction:
        transaction.add(interaction)
    async with database.sessions.begin() as transaction:
        transaction.add(run)
    async with database.sessions.begin() as transaction:
        transaction.add(attempt)
    async with database.sessions.begin() as transaction:
        transaction.add(job)
    async with database.sessions.begin() as transaction:
        transaction.add(execution)

    catalog = WorkspaceRootCatalog((WorkspaceRootSettings(key="code", label="Code", path=source_root),))
    resources = ProjectResourceService(
        database,
        catalog=catalog,
        inspector=ReadOnlyGitInspector(),
    )
    bound = await resources.bind_repository(
        command_id="bind-1",
        project_id=project.id,
        expected_project_row_version=1,
        alias="primary",
        display_name="Chat",
        role="primary",
        root_key="code",
        relative_path="chat",
    )
    repository_context = RepositoryExecutionContextService(database, catalog=catalog)
    fence = await repository_context.resolve_fence(
        project_id=project.id,
        binding_id=bound["binding"]["id"],
    )
    workspaces = ExecutionWorkspaceService(
        database,
        repository_context=repository_context,
        managed_root=tmp_path / "managed-workspaces",
    )
    operations = ToolOperationService(database, workspaces=workspaces)
    ownership = WorkspaceOwnership(
        scope_id="local-user",
        product_run_id=run.id,
        run_attempt_id=attempt.id,
        runtime_job_id=job.id,
        tool_execution_id=execution.id,
    )
    return database, workspaces, operations, ownership, fence, repository


@pytest.mark.anyio
async def test_managed_worktree_uses_exact_snapshot_and_leaves_source_clean(
    tmp_path: Path,
) -> None:
    database, workspaces, _, ownership, fence, repository = await _runtime(tmp_path)
    try:
        source_head = _git(repository, "rev-parse", "HEAD")
        source_status = _git(repository, "status", "--porcelain")
        workspace = await workspaces.create(ownership=ownership, fence=fence)
        private = await workspaces.private_path(workspace["id"])

        assert workspace["status"] == "ready"
        assert workspace["source"]["base_revision"] == source_head
        assert _git(private, "rev-parse", "HEAD") == source_head
        assert _git(repository, "status", "--porcelain") == source_status == ""
        assert (private / "app.py").read_text(encoding="utf-8") == "value = 'before'\n"
    finally:
        await database.close()


@pytest.mark.anyio
async def test_workspace_rejects_dirty_snapshot(
    tmp_path: Path,
) -> None:
    database, workspaces, _, ownership, fence, _ = await _runtime(tmp_path)
    try:
        async with database.sessions.begin() as transaction:
            snapshot = await transaction.get(RepositorySnapshotRecord, fence.snapshot_id)
            assert snapshot is not None
            snapshot.dirty = True
        with pytest.raises(ExecutionWorkspaceError) as captured:
            await workspaces.create(ownership=ownership, fence=fence)
        assert captured.value.code == "EXECUTION_WORKSPACE_SNAPSHOT_UNSAFE"
    finally:
        await database.close()


@pytest.mark.anyio
async def test_exact_edit_is_ledgered_idempotent_and_only_changes_approved_file(
    tmp_path: Path,
) -> None:
    database, workspaces, operations, ownership, fence, repository = await _runtime(tmp_path)
    try:
        workspace = await workspaces.create(ownership=ownership, fence=fence)
        await workspaces.mark_running(workspace["id"])
        arguments = {
            "path": "app.py",
            "old_text": "value = 'before'",
            "new_text": "value = 'after'",
        }
        prepared = await operations.propose_exact_edit(
            tool_execution_id=ownership.tool_execution_id,
            provider_tool_call_id="tool-call-1",
            arguments=arguments,
        )
        replay = await operations.propose_exact_edit(
            tool_execution_id=ownership.tool_execution_id,
            provider_tool_call_id="tool-call-1",
            arguments=arguments,
        )
        assert replay == prepared
        assert "-value = 'before'" in prepared.diff_preview
        assert "+value = 'after'" in prepared.diff_preview

        await _authorize_operation(
            database,
            operations,
            prepared,
            tool_call_id="tool-call-1",
        )

        first = await operations.execute_exact_edit(
            tool_execution_id=ownership.tool_execution_id,
            provider_tool_call_id="tool-call-1",
            arguments=arguments,
            worker_id="test-worker",
        )
        second = await operations.execute_exact_edit(
            tool_execution_id=ownership.tool_execution_id,
            provider_tool_call_id="tool-call-1",
            arguments=arguments,
            worker_id="test-worker",
        )
        private = await workspaces.private_path(workspace["id"])
        assert first == second
        assert (private / "app.py").read_text(encoding="utf-8") == "value = 'after'\n"
        assert (repository / "app.py").read_text(encoding="utf-8") == "value = 'before'\n"
        assert (await operations.get(prepared.operation_id))["dispatch_epoch"] == 1
        assert (await workspaces.get(workspace["id"]))["changed_paths"] == ["app.py"]
    finally:
        await database.close()


@pytest.mark.anyio
async def test_outcome_unknown_reconciliation_never_replays_edit(
    tmp_path: Path,
) -> None:
    operation_id: str | None = None

    def fault(stage: str, value: str) -> None:
        nonlocal operation_id
        operation_id = value
        if stage == "after_replace":
            raise RuntimeError("simulated process loss after replace")

    database, workspaces, _, ownership, fence, _ = await _runtime(tmp_path)
    operations = ToolOperationService(database, workspaces=workspaces, fault_hook=fault)
    try:
        await workspaces.create(ownership=ownership, fence=fence)
        arguments = {
            "path": "app.py",
            "old_text": "value = 'before'",
            "new_text": "value = 'after'",
        }
        prepared = await operations.propose_exact_edit(
            tool_execution_id=ownership.tool_execution_id,
            provider_tool_call_id="tool-call-crash",
            arguments=arguments,
        )
        await _authorize_operation(
            database,
            operations,
            prepared,
            tool_call_id="tool-call-crash",
        )

        with pytest.raises(RuntimeError, match="simulated process loss"):
            await operations.execute_exact_edit(
                tool_execution_id=ownership.tool_execution_id,
                provider_tool_call_id="tool-call-crash",
                arguments=arguments,
                worker_id="test-worker",
            )
        assert operation_id == prepared.operation_id
        assert (await operations.get(prepared.operation_id))["status"] == "outcome_unknown"

        reconciled = await operations.reconcile(
            prepared.operation_id,
            trigger="fault_injection",
        )
        assert reconciled["status"] == "succeeded"
        assert reconciled["resolution_code"] == "confirmed_succeeded"
        assert reconciled["dispatch_epoch"] == 1
    finally:
        await database.close()


@pytest.mark.anyio
async def test_dispatch_record_survives_process_loss_before_filesystem_write(
    tmp_path: Path,
) -> None:
    def fault(stage: str, _: str) -> None:
        if stage == "after_dispatch_persisted":
            raise RuntimeError("simulated process loss before write")

    database, workspaces, _, ownership, fence, _ = await _runtime(tmp_path)
    operations = ToolOperationService(database, workspaces=workspaces, fault_hook=fault)
    try:
        await workspaces.create(ownership=ownership, fence=fence)
        arguments = {
            "path": "app.py",
            "old_text": "value = 'before'",
            "new_text": "value = 'after'",
        }
        prepared = await operations.propose_exact_edit(
            tool_execution_id=ownership.tool_execution_id,
            provider_tool_call_id="tool-call-before-write-crash",
            arguments=arguments,
        )
        await _authorize_operation(
            database,
            operations,
            prepared,
            tool_call_id="tool-call-before-write-crash",
        )

        with pytest.raises(RuntimeError, match="before write"):
            await operations.execute_exact_edit(
                tool_execution_id=ownership.tool_execution_id,
                provider_tool_call_id="tool-call-before-write-crash",
                arguments=arguments,
                worker_id="test-worker",
            )
        uncertain = await operations.get(prepared.operation_id)
        assert uncertain["status"] == "dispatching"
        assert uncertain["attempts"][0]["status"] == "dispatching"

        reconciled = await operations.reconcile(
            prepared.operation_id,
            trigger="startup",
        )
        assert reconciled["status"] == "failed_not_applied"
        assert reconciled["resolution_code"] == "confirmed_not_applied"
        assert reconciled["reconciliations"][0]["status"] == "resolved"
        assert reconciled["attempts"][0]["status"] == "failed"
    finally:
        await database.close()


@pytest.mark.anyio
async def test_changed_preimage_fails_closed_and_reconciles_not_applied(
    tmp_path: Path,
) -> None:
    database, workspaces, operations, ownership, fence, _ = await _runtime(tmp_path)
    try:
        workspace = await workspaces.create(ownership=ownership, fence=fence)
        arguments = {
            "path": "app.py",
            "old_text": "value = 'before'",
            "new_text": "value = 'after'",
        }
        prepared = await operations.propose_exact_edit(
            tool_execution_id=ownership.tool_execution_id,
            provider_tool_call_id="tool-call-stale",
            arguments=arguments,
        )
        await _authorize_operation(
            database,
            operations,
            prepared,
            tool_call_id="tool-call-stale",
        )
        private = await workspaces.private_path(workspace["id"])
        (private / "app.py").write_text("value = 'third-party'\n", encoding="utf-8")

        with pytest.raises(ToolOperationError) as captured:
            await operations.execute_exact_edit(
                tool_execution_id=ownership.tool_execution_id,
                provider_tool_call_id="tool-call-stale",
                arguments=arguments,
                worker_id="test-worker",
            )
        assert captured.value.code == "TOOL_OPERATION_PREIMAGE_STALE"
        reconciled = await operations.reconcile(prepared.operation_id, trigger="manual")
        assert reconciled["status"] == "manual"
        assert reconciled["resolution_code"] == "manual_required"
    finally:
        await database.close()


@pytest.mark.anyio
async def test_workspace_orphan_is_retained_after_owner_process_is_interrupted(
    tmp_path: Path,
) -> None:
    database, workspaces, _, ownership, fence, _ = await _runtime(tmp_path)
    try:
        workspace = await workspaces.create(ownership=ownership, fence=fence)
        await workspaces.mark_running(workspace["id"])
        private = await workspaces.private_path(workspace["id"])
        (private / "app.py").write_text("value = 'interrupted'\n", encoding="utf-8")
        async with database.sessions.begin() as transaction:
            execution = await transaction.get(
                ToolExecutionRecord,
                ownership.tool_execution_id,
            )
            assert execution is not None
            execution.status = "interrupted"
            execution.failure_code = "process_restarted"

        assert await workspaces.reconcile_orphans() == 1
        retained = await workspaces.get(workspace["id"])
        assert retained["status"] == "retained"
        assert retained["changed_paths"] == ["app.py"]
    finally:
        await database.close()


@pytest.mark.anyio
async def test_cancel_before_dispatch_denies_operation_and_retains_workspace(
    tmp_path: Path,
) -> None:
    database, workspaces, operations, ownership, fence, repository = await _runtime(tmp_path)
    try:
        workspace = await workspaces.create(ownership=ownership, fence=fence)
        await workspaces.mark_running(workspace["id"])
        prepared = await operations.propose_exact_edit(
            tool_execution_id=ownership.tool_execution_id,
            provider_tool_call_id="tool-call-cancel",
            arguments={
                "path": "app.py",
                "old_text": "value = 'before'",
                "new_text": "value = 'after'",
            },
        )
        await operations.mark_waiting_authorization(prepared.operation_id)

        assert (
            await operations.cancel_pending_for_run(
                ownership.product_run_id,
                reason_code="user_cancelled_before_dispatch",
            )
            == 1
        )
        assert await workspaces.retain_for_terminal_run(ownership.product_run_id) == 1

        operation = await operations.get(prepared.operation_id)
        retained = await workspaces.get(workspace["id"])
        assert operation["status"] == "denied"
        assert operation["failure_code"] == "user_cancelled_before_dispatch"
        assert retained["status"] == "retained"
        assert retained["changed_paths"] == []
        assert (repository / "app.py").read_text(encoding="utf-8") == "value = 'before'\n"
    finally:
        await database.close()


@pytest.mark.anyio
async def test_terminal_run_retention_failure_is_visible_but_does_not_break_cancel(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database, workspaces, _operations, ownership, fence, _repository = await _runtime(tmp_path)
    try:
        workspace = await workspaces.create(ownership=ownership, fence=fence)
        await workspaces.mark_running(workspace["id"])

        async def fail_retain(workspace_id: str) -> dict[str, object]:
            assert workspace_id == workspace["id"]
            raise ExecutionWorkspaceError(
                "fixture worktree unavailable",
                code="EXECUTION_WORKSPACE_GIT_FAILED",
            )

        monkeypatch.setattr(workspaces, "retain", fail_retain)

        assert await workspaces.retain_for_terminal_run(ownership.product_run_id) == 1
        failed = await workspaces.get(workspace["id"])
        assert failed["status"] == "failed"
        assert failed["failure_code"] == "execution_workspace_terminal_retain_failed"
    finally:
        await database.close()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("fixture_kind", "code"),
    [
        ("symlink", "TOOL_OPERATION_SYMLINK_REJECTED"),
        ("binary", "TOOL_OPERATION_FILE_NOT_UTF8"),
        ("multiple", "TOOL_OPERATION_MATCH_COUNT_INVALID"),
        ("large", "TOOL_OPERATION_FILE_TOO_LARGE"),
    ],
)
async def test_exact_edit_rejects_unsafe_file_shapes(
    tmp_path: Path,
    fixture_kind: str,
    code: str,
) -> None:
    database, workspaces, operations, ownership, fence, _ = await _runtime(tmp_path)
    try:
        workspace = await workspaces.create(ownership=ownership, fence=fence)
        root = await workspaces.private_path(workspace["id"])
        target_path = "unsafe.txt"
        old_text = "before"
        if fixture_kind == "symlink":
            (root / target_path).symlink_to(root / "app.py")
        elif fixture_kind == "binary":
            (root / target_path).write_bytes(b"before\x00after")
        elif fixture_kind == "multiple":
            (root / target_path).write_text("before\nbefore\n", encoding="utf-8")
        else:
            (root / target_path).write_bytes(b"x" * (1024 * 1024 + 1))

        with pytest.raises(ToolOperationError) as captured:
            await operations.propose_exact_edit(
                tool_execution_id=ownership.tool_execution_id,
                provider_tool_call_id=f"unsafe-shape-{fixture_kind}",
                arguments={
                    "path": target_path,
                    "old_text": old_text,
                    "new_text": "after",
                },
            )
        assert captured.value.code == code
    finally:
        await database.close()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("path", "code"),
    [
        ("../outside.py", "TOOL_OPERATION_PATH_INVALID"),
        ("/tmp/outside.py", "TOOL_OPERATION_PATH_INVALID"),
        ("backend/config.json", "TOOL_OPERATION_SOURCE_PROTECTED"),
        (".env", "TOOL_OPERATION_SOURCE_PROTECTED"),
    ],
)
async def test_exact_edit_rejects_unsafe_paths(
    tmp_path: Path,
    path: str,
    code: str,
) -> None:
    database, workspaces, operations, ownership, fence, _ = await _runtime(tmp_path)
    try:
        await workspaces.create(ownership=ownership, fence=fence)
        with pytest.raises(ToolOperationError) as captured:
            await operations.propose_exact_edit(
                tool_execution_id=ownership.tool_execution_id,
                provider_tool_call_id=f"unsafe-{hashlib.sha256(path.encode()).hexdigest()[:8]}",
                arguments={
                    "path": path,
                    "old_text": "before",
                    "new_text": "after",
                },
            )
        assert captured.value.code == code
    finally:
        await database.close()
