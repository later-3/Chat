"""第九轮P1-2：ResultValidationRunner同进程并发边界攻击测试。"""

from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path
from typing import Any

from backend.app.evidence.contracts import content_hash
from backend.app.evidence.models import (
    ClaimEvidenceAdoptionRecord,
    EvidenceAssessmentRecord,
    EvidenceObservationRecord,
    ValidationRunRecord,
)
from backend.app.evidence.result_validation import FrozenValidationPlan, ResultValidationRunner
from backend.app.evidence.service import EvidenceRepository
from backend.app.evidence.validation_runtime import (
    ValidationCompiler,
    ValidationProcessResult,
    default_validation_capabilities,
)
from backend.app.harness.commands import HarnessCommandRecorder
from backend.app.harness.models import ActionItemRecord
from backend.app.runtime_execution.service import RuntimeExecutionService
from backend.tests.test_result_commit import (
    _make_project_work_action,
    _start_action,
)
from backend.tests.test_tool_operation_workspaces import _runtime


class _BlockingRunner:
    """A runner whose single execution is gated by an Event for exact interleaving."""

    def __init__(self, gate: asyncio.Event) -> None:
        self.gate = gate
        self.calls = 0

    async def run(self, compiled: Any, *, workspace: Path) -> ValidationProcessResult:
        self.calls += 1
        await self.gate.wait()
        return ValidationProcessResult(
            status="passed",
            exit_code=0,
            duration_ms=5,
            stdout_tail="1 passed",
            stderr_tail="",
        )


async def _plan_fixture(tmp_path: Path, database, workspaces, ownership, fence):
    from backend.app.harness.service import HarnessService

    harness = HarnessService(database)
    _, work_id, action_id = await _make_project_work_action(harness)
    work_view = await harness.get_work_item(work_id)
    await harness.create_plan_revision(
        command_id=str(uuid.uuid4()),
        work_item_id=work_id,
        expected_work_row_version=work_view["work_item"]["row_version"],
        summary="validation plan",
        nodes=[{"key": "n1", "title": "n1", "objective": "o"}],
        validation_contract={
            "rules": [
                {
                    "capability_key": "pytest-suite",
                    "capability_version": "1.0.0",
                    "params": {"targets": ["tests"]},
                }
            ]
        },
        accept=True,
    )
    # Plan revision与Action权威版本先在事务外取好，Claim事务内不再开第二个
    # Session（夹具纪律：不允许嵌套Session）。
    work_view = await harness.get_work_item(work_id)
    assert work_view["plan"] is not None
    plan_revision_id = work_view["plan"]["revision"]["id"]
    repo = EvidenceRepository(scope_id="local-user", principal_id="local-user")
    async with database.sessions.begin() as txn:
        await _start_action(txn, action_id)
        action = await txn.get(ActionItemRecord, action_id)
        assert action is not None
        expected_subject_version = action.row_version
        contract = await repo.create_validation_contract(
            txn,
            plan_revision_id=plan_revision_id,
            contract_hash=content_hash({"rules": [1]}),
            schema_version="validation-contract-v2",
            rules_json={"rules": [{"ordinal": 1}]},
            command_id=str(uuid.uuid4()),
        )
        claim = await repo.create_claim(
            txn,
            subject_kind="action_item",
            subject_id=action_id,
            from_state="in_progress",
            target_transition="action_result_accepted",
            expected_subject_version=expected_subject_version,
            target_state="completed",
            validation_contract_id=contract.id,
            requirements=[
                {
                    "requirement_kind": "validation_result",
                    "mandatory": True,
                    "description": "pytest必须通过",
                    "contract_rule_ordinal": 1,
                    "params_json": {},
                    "schema_version": "validation-result-v1",
                }
            ],
            command_id=str(uuid.uuid4()),
        )
    workspace = await workspaces.create(ownership=ownership, fence=fence)
    workspace_path = await workspaces.private_path(workspace["id"])
    definition = default_validation_capabilities()[0]
    compiler = ValidationCompiler(project_python=Path(sys.executable))
    compiled = compiler.compile(
        definition,
        params={"targets": ["tests"]},
        workspace=workspace_path,
    )
    rule = {
        "ordinal": 1,
        "capability_key": compiled.capability_key,
        "capability_version": compiled.capability_version,
        "capability_hash": compiled.capability_hash,
        "resolved_executable_hash": compiled.resolved_executable_hash,
        "environment_fingerprint": compiled.environment_fingerprint,
        "expanded_argv": list(compiled.expanded_argv),
        "expanded_argv_hash": compiled.expanded_argv_hash,
    }
    job = await RuntimeExecutionService(database).job_for_product_run(ownership.product_run_id)
    assert job is not None
    plan = FrozenValidationPlan(
        run_id=ownership.product_run_id,
        run_attempt_id=ownership.run_attempt_id,
        session_id="session-1",
        claim=claim,
        contract=contract,
        contract_hash=contract.contract_hash,
        frozen_rules=[rule],
        compiled_rules={1: compiled},
        workspace_id=workspace["id"],
        workspace_path=workspace_path,
        snapshot_id=fence.snapshot_id,
        edit_operations=[],
    )
    return plan, int(job["lease_epoch"]), str(job["id"])


def _runner(database) -> ResultValidationRunner:
    from datetime import datetime, timezone

    clock = lambda: datetime.now(timezone.utc)  # noqa: E731
    recorder = HarnessCommandRecorder(scope_id="local-user", principal_id="local-user", clock=clock)
    return ResultValidationRunner(
        database,
        scope_id="local-user",
        principal_id="local-user",
        clock=clock,
        recorder=recorder,
        validation_runner=None,  # type: ignore[arg-type]
        runtime=RuntimeExecutionService(database),
    )


def test_concurrent_reentry_executes_once_and_shares_terminal_evidence(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, workspaces, _, ownership, fence, _ = await _runtime(tmp_path)
        try:
            plan, lease_epoch, job_id = await _plan_fixture(tmp_path, database, workspaces, ownership, fence)
            gate = asyncio.Event()
            blocking = _BlockingRunner(gate)
            runner = _runner(database)
            runner._runner = blocking  # noqa: SLF001
            rule = plan.frozen_rules[0]
            compiled = plan.compiled_rules[1]
            first = asyncio.create_task(
                runner._run_validation_rule(  # noqa: SLF001
                    plan=plan,
                    rule=rule,
                    compiled=compiled,
                    runtime_job_id=job_id,
                    runtime_lease_epoch=lease_epoch,
                )
            )
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            second = asyncio.create_task(
                runner._run_validation_rule(  # noqa: SLF001
                    plan=plan,
                    rule=rule,
                    compiled=compiled,
                    runtime_job_id=job_id,
                    runtime_lease_epoch=lease_epoch,
                )
            )
            # 第一个执行被Event卡住期间：第二个只能等待，runner仍只被调用一次。
            await asyncio.sleep(0.05)
            assert not first.done()
            assert not second.done()
            assert blocking.calls == 1
            gate.set()
            first_result, second_result = await asyncio.gather(first, second)
            assert first_result["status"] == "passed"
            assert second_result["status"] == "passed"
            assert first_result["validation_run_id"] == second_result["validation_run_id"]
            assert first_result["evidence"]["observation_id"] == (second_result["evidence"]["observation_id"])
            assert first_result["evidence"]["assessment_id"] == (second_result["evidence"]["assessment_id"])
            async with database.sessions() as txn:
                from sqlalchemy import func, select

                runs = await txn.scalar(select(func.count()).select_from(ValidationRunRecord))
                observations = await txn.scalar(select(func.count()).select_from(EvidenceObservationRecord))
                assessments = await txn.scalar(select(func.count()).select_from(EvidenceAssessmentRecord))
                adoptions = await txn.scalar(select(func.count()).select_from(ClaimEvidenceAdoptionRecord))
                unknowns = await txn.scalar(
                    select(func.count())
                    .select_from(ValidationRunRecord)
                    .where(ValidationRunRecord.status == "outcome_unknown")
                )
            assert runs == 1
            assert observations == 1
            assert assessments == 1
            assert adoptions == 0
            assert unknowns == 0
        finally:
            await database.close()

    asyncio.run(scenario())


def test_orphaned_running_converges_outcome_unknown_without_execution(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, workspaces, _, ownership, fence, _ = await _runtime(tmp_path)
        try:
            plan, lease_epoch, job_id = await _plan_fixture(tmp_path, database, workspaces, ownership, fence)
            # 模拟上一所有者崩溃：直接留下running行，本进程没有任何锁所有者。
            repo = EvidenceRepository(scope_id="local-user", principal_id="local-user")
            async with database.sessions.begin() as txn:
                run = await repo.create_validation_run(
                    txn,
                    workspace_id=plan.workspace_id,
                    repository_snapshot_id=plan.snapshot_id,
                    validation_contract_id=plan.contract.id,
                    contract_hash=plan.contract_hash,
                    rule_ordinal=1,
                    capability_key="pytest-suite",
                    capability_version="1.0.0",
                    capability_hash="h" * 64,
                    resolved_executable_hash="h" * 64,
                    environment_fingerprint="h" * 64,
                    expanded_argv_json=["-m", "pytest"],
                    expanded_argv_hash="h" * 64,
                    working_dir=".",
                    runtime_job_id=job_id,
                    run_attempt_id=plan.run_attempt_id,
                    runtime_lease_epoch=lease_epoch,
                    command_id=f"sd4:{plan.run_id}:validation-run:1",
                )
                await repo.mark_validation_run_running(
                    txn,
                    validation_run_id=run.id,
                    runtime_lease_epoch=lease_epoch,
                )
            gate = asyncio.Event()
            gate.set()
            blocking = _BlockingRunner(gate)
            runner = _runner(database)
            runner._runner = blocking  # noqa: SLF001
            result = await runner._run_validation_rule(  # noqa: SLF001
                plan=plan,
                rule=plan.frozen_rules[0],
                compiled=plan.compiled_rules[1],
                runtime_job_id=job_id,
                runtime_lease_epoch=lease_epoch,
            )
            assert result["status"] == "outcome_unknown"
            assert blocking.calls == 0
            assert result["evidence"]["recorded"] is False
        finally:
            await database.close()

    asyncio.run(scenario())
