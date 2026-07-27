"""Deterministic validation execution and Evidence recording for the SD4-C gate.

``ResultValidationRunner`` is a collaborator of ``ResultPipelineCoordinator``
(split by change reason, AGENTS.md §7.1: process execution vs claim
orchestration).  It owns the per-step transactions of the validation use case
— ValidationRun creation/outcome, Observation and Assessment — while the
coordinator keeps Claim/Contract/subject orchestration.  Adoptions are NOT
created here (二次审核A)：它们由 Result Commit Gate 在 result_commit 事务内
按 Decision 冻结映射创建，Adoption不再有任何独立的自动决定。

Failure semantics (B/§9.4 + 第九轮P1-2并发边界): an outcome is reported
exactly once per rule.  Within ONE backend process, a per-command asyncio
lock serializes re-entrant executions of the same ValidationRun: an active
first execution is awaited and its terminal outcome reused — never polluted
into ``outcome_unknown``.  Only when no active execution owns the command in
this process (the previous owner provably crashed) does a ``running`` row
converge to ``outcome_unknown``.  This boundary is exact for the current
single-process deployment; distinguishing an active execution owned by
*another* OS process requires execution-ownership routing (F05) and is
explicitly NOT claimed here.
"""

from __future__ import annotations

import asyncio
import logging
import weakref
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..product_sessions.database import ProductDatabase
from ..runtime_execution.service import RuntimeExecutionService
from .contracts import EvidenceConflict, EvidenceNotFound, ValidationOutcomeUnknownError
from .models import (
    CompletionClaimRecord,
    CompletionClaimRequirementRecord,
    EvidenceAssessmentRecord,
    EvidenceObservationRecord,
    ValidationContractRecord,
    ValidationRunRecord,
)
from .service import EvidenceRepository
from .validation_runtime import CompiledValidation, ValidationProcessRunner

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class FrozenValidationPlan:
    """Everything the runner needs, all derived from the approved RunSpec."""

    run_id: str
    run_attempt_id: str
    session_id: str
    claim: CompletionClaimRecord
    contract: ValidationContractRecord
    contract_hash: str
    frozen_rules: list[Mapping[str, Any]]
    compiled_rules: dict[int, CompiledValidation]
    workspace_id: str
    workspace_path: Path
    snapshot_id: str
    edit_operations: Sequence[Mapping[str, Any]]


class ResultValidationRunner:
    """Execute frozen validation rules and record the Evidence chain."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        scope_id: str,
        principal_id: str,
        clock: Callable[[], datetime],
        recorder: Any,
        validation_runner: ValidationProcessRunner,
        runtime: RuntimeExecutionService,
    ) -> None:
        self.database = database
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock
        self._recorder = recorder
        self._runner = validation_runner
        self._runtime = runtime
        # 第九轮P1-2：同进程内按命令串行化同一ValidationRun的执行；锁由本进程
        # 持有，进程退出即消亡——没有锁所有者时遗留running才是真实崩溃窗口。
        # WeakValue避免按Run永久积累锁对象。
        self._command_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()

    def _command_lock(self, command_id: str) -> asyncio.Lock:
        lock = self._command_locks.get(command_id)
        if lock is None:
            lock = asyncio.Lock()
            self._command_locks[command_id] = lock
        return lock

    async def execute(self, plan: FrozenValidationPlan) -> list[dict[str, Any]]:
        job = await self._runtime.job_for_product_run(plan.run_id)
        if job is None:
            raise EvidenceConflict("结果Validation缺少Runtime Job")
        summary: list[dict[str, Any]] = []
        for rule in plan.frozen_rules:
            ordinal = int(rule["ordinal"])
            summary.append(
                await self._run_validation_rule(
                    plan=plan,
                    rule=rule,
                    compiled=plan.compiled_rules[ordinal],
                    runtime_job_id=str(job["id"]),
                    runtime_lease_epoch=int(job["lease_epoch"]),
                )
            )
        for operation in plan.edit_operations:
            summary.append(
                await self._record_file_hash_evidence(
                    plan=plan,
                    operation=operation,
                )
            )
        return summary

    # ------------------------------------------------------------------
    # validation rules
    # ------------------------------------------------------------------

    async def _run_validation_rule(
        self,
        *,
        plan: FrozenValidationPlan,
        rule: Mapping[str, Any],
        compiled: CompiledValidation,
        runtime_job_id: str,
        runtime_lease_epoch: int,
    ) -> dict[str, Any]:
        """Drive one frozen rule from claim to terminal outcome and Evidence.

        规模审查（102行，工程规范§4）：本函数保持“锁内单线性状态机”——
        get-or-create、freshly_started判定、并发等待/崩溃收敛、执行回报与
        Evidence记录必须按同一顺序共享一个命令锁；按子步骤拆函数会让锁的
        获取/释 放边界不再一目了然（第九轮P1-2曾在此产生TOCTOU）。
        测试边界：backend/tests/test_result_validation_concurrency.py的事件
        精确并发与崩溃收敛用例，及result_pipeline主Workflow端到端场景。
        """
        run_id = plan.run_id
        ordinal = int(rule["ordinal"])
        command_id = f"sd4:{run_id}:validation-run:{ordinal}"
        terminal_statuses = {"passed", "failed", "timeout", "error", "cancelled", "outcome_unknown"}
        # 第九轮P1-2：锁覆盖完整路径——ValidationRun读取/执行/回报直到Evidence
        # 记录与summary返回。同进程并发重入在锁上排队：活动执行被等待并复用其
        # 终态与同一Evidence行；持锁时仍running意味着上一所有者已崩溃（进程
        # 死亡锁即消亡），按§9.4诚实收敛outcome_unknown，绝不污染活动执行。
        async with self._command_lock(command_id):
            freshly_started = False
            async with self.database.sessions.begin() as transaction:
                repository = self._repository()
                run = await transaction.scalar(
                    select(ValidationRunRecord).where(
                        ValidationRunRecord.scope_id == self.scope_id,
                        ValidationRunRecord.command_id == command_id,
                    )
                )
                if run is None:
                    run = await repository.create_validation_run(
                        transaction,
                        workspace_id=plan.workspace_id,
                        repository_snapshot_id=plan.snapshot_id,
                        validation_contract_id=plan.contract.id,
                        contract_hash=plan.contract_hash,
                        rule_ordinal=ordinal,
                        capability_key=str(rule["capability_key"]),
                        capability_version=str(rule["capability_version"]),
                        capability_hash=str(rule["capability_hash"]),
                        resolved_executable_hash=str(rule["resolved_executable_hash"]),
                        environment_fingerprint=str(rule["environment_fingerprint"]),
                        expanded_argv_json=list(rule["expanded_argv"]),
                        expanded_argv_hash=str(rule["expanded_argv_hash"]),
                        # F：持久化只用安全相对locator，绝对私有路径只留进程内。
                        working_dir=".",
                        runtime_job_id=runtime_job_id,
                        run_attempt_id=plan.run_attempt_id,
                        runtime_lease_epoch=runtime_lease_epoch,
                        command_id=command_id,
                    )
                if run.status == "pending":
                    run = await repository.mark_validation_run_running(
                        transaction,
                        validation_run_id=run.id,
                        runtime_lease_epoch=runtime_lease_epoch,
                    )
                    freshly_started = True
            if run.status not in terminal_statuses:
                if freshly_started:
                    run = await self._execute_and_report(
                        run=run,
                        compiled=compiled,
                        plan=plan,
                        ordinal=ordinal,
                        runtime_lease_epoch=runtime_lease_epoch,
                    )
                elif run.status == "running":
                    async with self.database.sessions.begin() as transaction:
                        repository = self._repository()
                        run = await repository.report_validation_outcome(
                            transaction,
                            validation_run_id=run.id,
                            outcome_command_id=f"sd4:{run_id}:validation-outcome:{ordinal}",
                            status="outcome_unknown",
                            runtime_lease_epoch=runtime_lease_epoch,
                        )
                else:
                    raise EvidenceConflict(f"ValidationRun {run.id} 状态{run.status}无法安全推进")
            status = run.status
            exit_code = run.exit_code
            duration_ms = run.duration_ms or 0
            stdout_tail = run.stdout_tail or ""
            evidence: dict[str, Any] = {"recorded": False}
            if status in {"passed", "failed"} and exit_code is not None:
                evidence = await self._record_validation_evidence(
                    plan=plan,
                    ordinal=ordinal,
                    validation_run_id=run.id,
                    compiled=compiled,
                    status=status,
                    exit_code=exit_code,
                    duration_ms=duration_ms,
                    stdout_tail=stdout_tail,
                )
        return {
            "kind": "validation_result",
            "rule_ordinal": ordinal,
            "validation_run_id": run.id,
            "status": status,
            "exit_code": exit_code,
            "evidence": evidence,
        }

    async def _execute_and_report(
        self,
        *,
        run: ValidationRunRecord,
        compiled: CompiledValidation,
        plan: FrozenValidationPlan,
        ordinal: int,
        runtime_lease_epoch: int,
    ) -> ValidationRunRecord:
        """Spawn the frozen validation and report its terminal outcome exactly once.

        Runs inside the per-command lock: pre-spawn failures are reported as
        ``error`` and re-raised (Product Run fails); a started child with an
        unconfirmable result is reported ``outcome_unknown`` without retry.
        """

        try:
            result = await self._runner.run(compiled, workspace=plan.workspace_path)
        except ValidationOutcomeUnknownError:
            async with self.database.sessions.begin() as transaction:
                repository = self._repository()
                return await repository.report_validation_outcome(
                    transaction,
                    validation_run_id=run.id,
                    outcome_command_id=f"sd4:{plan.run_id}:validation-outcome:{ordinal}",
                    status="outcome_unknown",
                    runtime_lease_epoch=runtime_lease_epoch,
                )
        except Exception:
            async with self.database.sessions.begin() as transaction:
                repository = self._repository()
                await repository.report_validation_outcome(
                    transaction,
                    validation_run_id=run.id,
                    outcome_command_id=f"sd4:{plan.run_id}:validation-outcome:{ordinal}",
                    status="error",
                    runtime_lease_epoch=runtime_lease_epoch,
                )
            raise
        async with self.database.sessions.begin() as transaction:
            repository = self._repository()
            return await repository.report_validation_outcome(
                transaction,
                validation_run_id=run.id,
                outcome_command_id=f"sd4:{plan.run_id}:validation-outcome:{ordinal}",
                status=result.status,
                runtime_lease_epoch=runtime_lease_epoch,
                exit_code=result.exit_code,
                duration_ms=result.duration_ms,
                stdout_tail=result.stdout_tail,
                stderr_tail=result.stderr_tail,
            )

    # ------------------------------------------------------------------
    # evidence recording
    # ------------------------------------------------------------------

    async def _record_validation_evidence(
        self,
        *,
        plan: FrozenValidationPlan,
        ordinal: int,
        validation_run_id: str,
        compiled: CompiledValidation,
        status: str,
        exit_code: int,
        duration_ms: int,
        stdout_tail: str,
    ) -> dict[str, Any]:
        requirement = await self._requirement_for_ordinal(plan.claim.id, ordinal)
        verdict = "supports" if status == "passed" else "refutes"
        async with self.database.sessions.begin() as transaction:
            repository = self._repository()
            observation = await self._get_or_create_observation(
                transaction,
                repository=repository,
                command_id=f"sd4:{plan.run_id}:observation:validation:{ordinal}",
                kind="validation_result",
                schema_version="validation-result-v1",
                payload={
                    "capability_key": compiled.capability_key,
                    "expanded_argv": list(compiled.expanded_argv),
                    "working_dir": ".",
                    "exit_code": exit_code,
                    "signal": None,
                    "summary": (stdout_tail or "")[-480:],
                    "duration_ms": duration_ms,
                },
                subject_kind="action_item",
                subject_id=plan.claim.subject_id,
                statement=(f"确定性Validation规则{ordinal}在受管Workspace执行，退出码{exit_code}（期望0）"),
                validation_run_id=validation_run_id,
                product_run_id=plan.run_id,
                run_attempt_id=plan.run_attempt_id,
                repository_snapshot_id=plan.snapshot_id,
                verification_method="validation-runtime-v1",
            )
            assessment = await self._get_or_create_assessment(
                transaction,
                repository=repository,
                command_id=f"sd4:{plan.run_id}:assessment:validation:{ordinal}",
                observation_id=observation.id,
                requirement_id=requirement.id,
                verdict=verdict,
                assessor_kind="validator",
                assessor_run_id=plan.run_id,
                rationale=f"ValidationRun {validation_run_id} 终态 {status}",
            )
        return {
            "recorded": True,
            "observation_id": observation.id,
            "assessment_id": assessment.id,
            "verdict": verdict,
        }

    async def _record_file_hash_evidence(
        self,
        *,
        plan: FrozenValidationPlan,
        operation: Mapping[str, Any],
    ) -> dict[str, Any]:
        operation_id = str(operation["id"])
        requirement = await self._requirement_for_operation(plan.claim.id, operation_id)
        observed = operation.get("observed_hash")
        match = bool(observed) and observed == operation["expected_postimage_hash"]
        verdict = "supports" if match else "refutes"
        ordinal_key = operation_id[:12]
        async with self.database.sessions.begin() as transaction:
            repository = self._repository()
            observation = await self._get_or_create_observation(
                transaction,
                repository=repository,
                command_id=f"sd4:{plan.run_id}:observation:file-hash:{ordinal_key}",
                kind="file_hash_match",
                schema_version="file-hash-match-v1",
                payload={
                    "path": str(operation["target_path"]),
                    "preimage_hash": str(operation["expected_preimage_hash"]),
                    "postimage_hash": str(operation["expected_postimage_hash"]),
                    "observed_hash": str(observed or ""),
                    "match": match,
                },
                subject_kind="action_item",
                subject_id=plan.claim.subject_id,
                statement=(
                    f"ToolOperation {operation_id} 的文件Hash对账："
                    f"observed {'等于' if match else '不等于'}已批准postimage"
                ),
                tool_operation_id=operation_id,
                product_run_id=plan.run_id,
                run_attempt_id=plan.run_attempt_id,
                repository_snapshot_id=plan.snapshot_id,
                verification_method="tool-operation-ledger-v1",
            )
            assessment = await self._get_or_create_assessment(
                transaction,
                repository=repository,
                command_id=f"sd4:{plan.run_id}:assessment:file-hash:{ordinal_key}",
                observation_id=observation.id,
                requirement_id=requirement.id,
                verdict=verdict,
                assessor_kind="validator",
                assessor_run_id=plan.run_id,
                rationale="Tool Operation Ledger观察Hash与已批准postimage对比",
            )
        return {
            "kind": "file_hash_match",
            "tool_operation_id": operation_id,
            "match": match,
            "observation_id": observation.id,
            "assessment_id": assessment.id,
            "verdict": verdict,
        }

    # ------------------------------------------------------------------
    # idempotent record helpers
    # ------------------------------------------------------------------

    async def _requirement_for_ordinal(self, claim_id: str, ordinal: int) -> CompletionClaimRequirementRecord:
        async with self.database.sessions() as transaction:
            requirement = await transaction.scalar(
                select(CompletionClaimRequirementRecord).where(
                    CompletionClaimRequirementRecord.completion_claim_id == claim_id,
                    CompletionClaimRequirementRecord.contract_rule_ordinal == ordinal,
                )
            )
        if requirement is None:
            raise EvidenceNotFound(f"Claim缺少规则{ordinal}对应的Requirement")
        return requirement

    async def _requirement_for_operation(
        self, claim_id: str, operation_id: str
    ) -> CompletionClaimRequirementRecord:
        async with self.database.sessions() as transaction:
            rows = list(
                (
                    await transaction.scalars(
                        select(CompletionClaimRequirementRecord).where(
                            CompletionClaimRequirementRecord.completion_claim_id == claim_id,
                            CompletionClaimRequirementRecord.requirement_kind == "file_hash_match",
                        )
                    )
                ).all()
            )
        for requirement in rows:
            if str((requirement.params_json or {}).get("tool_operation_id")) == operation_id:
                return requirement
        raise EvidenceNotFound(f"Claim缺少ToolOperation {operation_id}对应的Requirement")

    async def _get_or_create_observation(
        self,
        transaction: AsyncSession,
        *,
        repository: EvidenceRepository,
        command_id: str,
        **kwargs: Any,
    ) -> EvidenceObservationRecord:
        existing = await transaction.scalar(
            select(EvidenceObservationRecord).where(
                EvidenceObservationRecord.scope_id == self.scope_id,
                EvidenceObservationRecord.command_id == command_id,
            )
        )
        if existing is not None:
            return existing
        return await repository.create_observation(transaction, command_id=command_id, **kwargs)

    async def _get_or_create_assessment(
        self,
        transaction: AsyncSession,
        *,
        repository: EvidenceRepository,
        command_id: str,
        **kwargs: Any,
    ) -> EvidenceAssessmentRecord:
        existing = await transaction.scalar(
            select(EvidenceAssessmentRecord).where(
                EvidenceAssessmentRecord.scope_id == self.scope_id,
                EvidenceAssessmentRecord.command_id == command_id,
            )
        )
        if existing is not None:
            return existing
        return await repository.create_assessment(transaction, command_id=command_id, **kwargs)

    def _repository(self) -> EvidenceRepository:
        return EvidenceRepository(
            scope_id=self.scope_id,
            principal_id=self.principal_id,
            clock=self._clock,
            command_recorder=self._recorder,
        )


__all__ = ["FrozenValidationPlan", "ResultValidationRunner"]
