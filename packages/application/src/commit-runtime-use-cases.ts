import {
  computeExecutionInputManifestSha256,
  computeGovernanceReviewInputManifestSha256,
  governanceEvidenceKeys,
  hashCanonical,
  resolvePlanningValidationPolicy,
  transitionRunLifecycle,
  validateExecutionCandidate,
  type RunLifecycle,
} from "@chat/domain";
import type {
  CommandId,
  DecisionId,
  ExecutionCandidateId,
  ExecutionCandidate,
  ExecutionContractId,
  ExecutionContract,
  ExecutionEvidenceVerificationReceipt,
  GovernanceReviewCandidate,
  GovernanceReviewInputDto,
  ApprovalRequestId,
  Message,
  ProductRunId,
  ValidationResultId,
  ProductSnapshot,
} from "@chat/contracts";
import {
  GOVERNANCE_REVIEW_ACTIVE_TIMEOUT_MS,
  GOVERNANCE_REVIEW_MAX_TURNS,
  GOVERNANCE_REVIEW_PROFILE_VERSION,
  GOVERNANCE_REVIEW_TOKEN_BUDGET,
  MODEL_CONFIG_VERSION,
} from "@chat/contracts";
import type {
  PersistExecutionCandidateRequest,
  PersistValidationResultRequest,
} from "@chat/contracts";
import { type ApplicationDeps } from "./deps.js";
import { notFound, revisionConflict } from "./errors.js";
import { readExactCommandReceipt } from "./product-store-port.js";
import { emitProductRunTransition, settleRunWithoutSuccess } from "./run-settlement.js";
import { emitRunEvent, safeErrorType } from "./trace-helpers.js";
import { synchronizePlanningWorkflowProjection } from "./planning-workflow-projection.js";
import { requirePlanningRun } from "./product-run-kind.js";
import { workflowNodePromptFor, workflowNodePromptRefFor } from "./prompt-assembly-use-cases.js";

/**
 * 候选持久化、验证结果与Product Commit（任务书§11三道门）。
 */

function assertGovernanceEvidence(
  candidate: ExecutionCandidate,
  review: GovernanceReviewCandidate,
): void {
  const allowed = new Set(governanceEvidenceKeys(candidate));
  for (const finding of review.findings) {
    for (const evidenceKey of finding.evidenceKeys) {
      if (!allowed.has(evidenceKey)) {
        throw revisionConflict(`治理检查引用了未知执行证据:${evidenceKey}`);
      }
    }
  }
}

function governanceFailures(review: GovernanceReviewCandidate) {
  return review.findings
    .filter((finding) => finding.severity === "blocking")
    .map((finding) => ({
      code: finding.code,
      detail: `${finding.summary}：${finding.detail}`.slice(0, 500),
    }));
}

interface AdoptionEvidenceReceipt {
  readonly receipts: readonly ExecutionEvidenceVerificationReceipt[];
  readonly sha256: string;
}

function stepRequiresRuntimeEvidence(
  contract: ExecutionContract,
  step: ExecutionCandidate["stepResults"][number],
): boolean {
  const contractStep = contract.steps.find((candidate) => candidate.stepId === step.stepId);
  if (contractStep === undefined) throw revisionConflict("Execution Step不在合同中");
  return (
    contractStep.capabilityRefs.some((capability) => capability !== "markdown_text_compose") ||
    (step.executionEvidenceRefs?.length ?? 0) > 0
  );
}

function assertAdoptionEvidenceReceipt(
  contract: ExecutionContract,
  candidate: ExecutionCandidate,
  adoption: AdoptionEvidenceReceipt,
): void {
  const expected = candidate.stepResults
    .filter((step) => stepRequiresRuntimeEvidence(contract, step))
    .map((step) => ({
      executionAttemptId: step.executionAttemptId,
      evidenceRefsSha256: hashCanonical(
        "execution-evidence-refs.v1",
        step.executionEvidenceRefs ?? [],
      ),
    }));
  if (
    adoption.receipts.length !== expected.length ||
    adoption.receipts.some(
      (receipt, index) =>
        receipt.schemaVersion !== "execution-evidence-verification-receipt.v1" ||
        receipt.executionAttemptId !== expected[index]?.executionAttemptId ||
        receipt.evidenceRefsSha256 !== expected[index]?.evidenceRefsSha256 ||
        !/^[a-f0-9]{64}$/u.test(receipt.journalSha256),
    ) ||
    adoption.sha256 !==
      hashCanonical("product-commit-evidence-receipt.v1", {
        executionCandidateId: candidate.executionCandidateId,
        executionCandidateSha256: candidate.sha256,
        receipts: adoption.receipts,
      })
  ) {
    throw revisionConflict("Product Commit的Pi Journal Evidence Receipt不一致");
  }
}

async function verifyAdoptionEvidence(
  deps: ApplicationDeps,
  contract: ExecutionContract,
  candidate: ExecutionCandidate,
): Promise<AdoptionEvidenceReceipt> {
  const steps = candidate.stepResults.filter((step) => stepRequiresRuntimeEvidence(contract, step));
  if (steps.length > 0 && deps.executionEvidenceVerifier === undefined) {
    throw revisionConflict("Product Commit缺少权威Runtime Evidence Port");
  }
  const receipts: ExecutionEvidenceVerificationReceipt[] = [];
  for (const step of steps) {
    try {
      const receipt = await deps.executionEvidenceVerifier!.verify({
        executionAttemptId: step.executionAttemptId,
        evidenceRefs: step.executionEvidenceRefs ?? [],
      });
      receipts.push(receipt);
    } catch {
      throw revisionConflict(`步骤${step.stepId}的Pi Journal Evidence在采用前不可验证`);
    }
  }
  const adoption = {
    receipts,
    sha256: hashCanonical("product-commit-evidence-receipt.v1", {
      executionCandidateId: candidate.executionCandidateId,
      executionCandidateSha256: candidate.sha256,
      receipts,
    }),
  };
  assertAdoptionEvidenceReceipt(contract, candidate, adoption);
  return adoption;
}

/**
 * 治理检查Step只按RunSpec和Product Store读取冻结候选、节点Prompt与证据键。
 * 完整正文只在该Step内交给模型，不写入Workflow checkpoint。
 */
function resolveGovernanceReviewContext(
  snapshot: ProductSnapshot,
  input: {
    readonly productRunId: ProductRunId;
    readonly workflowRunSpecId: string;
    readonly executionCandidateId: ExecutionCandidateId;
  },
): Omit<GovernanceReviewInputDto, "attemptId" | "inputManifestSha256"> & {
  readonly inputManifestSha256: string;
} {
  const storedRun = snapshot.entities.runs[input.productRunId];
  if (storedRun === undefined) throw notFound("Product Run不存在");
  const run = requirePlanningRun(storedRun);
  if (run.workflowRunSpecId !== input.workflowRunSpecId) {
    throw revisionConflict("治理检查绑定了其他Workflow RunSpec");
  }
  const runSpec = snapshot.entities.workflowRunSpecs[input.workflowRunSpecId];
  if (runSpec === undefined || runSpec.productRunId !== input.productRunId) {
    throw notFound("Workflow RunSpec不存在");
  }
  let policy;
  try {
    policy = resolvePlanningValidationPolicy(runSpec);
  } catch {
    throw revisionConflict("治理检查Validation策略无效");
  }
  if (policy.kind !== "governance_review") {
    throw revisionConflict("当前Workflow RunSpec没有治理检查节点");
  }
  const candidate = snapshot.entities.executionCandidates[input.executionCandidateId];
  if (candidate === undefined || candidate.productRunId !== input.productRunId) {
    throw notFound("Execution Candidate不存在");
  }
  const contract = snapshot.entities.executionContracts[candidate.executionContractId];
  if (contract === undefined || contract.productRunId !== input.productRunId) {
    throw notFound("Execution Contract不存在");
  }
  const nodePrompt = workflowNodePromptFor(snapshot, input.productRunId, "agent.governance_check");
  if (
    nodePrompt === undefined ||
    nodePrompt.definitionNodeId !== policy.definitionNodeId ||
    nodePrompt.profileVersion !== GOVERNANCE_REVIEW_PROFILE_VERSION
  ) {
    throw revisionConflict("治理检查节点缺少匹配的冻结Prompt");
  }
  const limits = {
    maxTurns: GOVERNANCE_REVIEW_MAX_TURNS,
    tokenBudget: GOVERNANCE_REVIEW_TOKEN_BUDGET,
    timeoutMs: GOVERNANCE_REVIEW_ACTIVE_TIMEOUT_MS,
  } as const;
  const allowedEvidenceKeys = governanceEvidenceKeys(candidate);
  const base = {
    productRunId: input.productRunId,
    contract,
    candidate,
    nodePrompt,
    strictEvidence: policy.strictEvidence,
    allowedEvidenceKeys,
    limits,
  };
  return {
    ...base,
    inputManifestSha256: computeGovernanceReviewInputManifestSha256({
      ...base,
      workflowRunSpecId: runSpec.workflowRunSpecId,
      workflowRunSpecSha256: runSpec.sha256,
      modelConfigVersion: MODEL_CONFIG_VERSION,
    }),
  };
}

export async function prepareGovernanceReviewInput(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly productRunId: ProductRunId;
    readonly workflowRunSpecId: string;
    readonly executionCandidateId: ExecutionCandidateId;
  },
): Promise<GovernanceReviewInputDto> {
  const now = deps.now();
  const attemptId = deps.ids.attempt();
  const requestSha256 = hashCanonical("command.prepare-governance-review-input.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PrepareGovernanceReviewInput",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const prepared = resolveGovernanceReviewContext(draft, input);
      const existing = Object.values(draft.entities.attempts).find(
        (attempt) =>
          attempt.kind === "governance_review" &&
          attempt.executionCandidateId === input.executionCandidateId,
      );
      if (existing !== undefined) {
        throw revisionConflict("同一Execution Candidate不允许第二个治理检查Attempt");
      }
      draft.entities.attempts[attemptId] = {
        schemaVersion: "run-attempt.v2",
        attemptId,
        productRunId: input.productRunId,
        kind: "governance_review",
        executionContractId: prepared.contract.executionContractId,
        executionCandidateId: prepared.candidate.executionCandidateId,
        inputManifestSha256: prepared.inputManifestSha256,
        promptTemplateVersion: GOVERNANCE_REVIEW_PROFILE_VERSION,
        modelConfigVersion: MODEL_CONFIG_VERSION,
        outcome: "running",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      synchronizePlanningWorkflowProjection(draft, input.productRunId, now);
      return { resultRefs: { attemptId } };
    },
  });
  const committedAttemptId = result.resultRefs["attemptId"];
  if (committedAttemptId === undefined) throw notFound("治理检查Attempt不存在");
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const prepared = resolveGovernanceReviewContext(snapshot, input);
  const attempt = snapshot.entities.attempts[committedAttemptId as never];
  if (
    attempt === undefined ||
    attempt.kind !== "governance_review" ||
    attempt.executionCandidateId !== input.executionCandidateId ||
    attempt.executionContractId !== prepared.contract.executionContractId ||
    attempt.inputManifestSha256 !== prepared.inputManifestSha256 ||
    attempt.promptTemplateVersion !== GOVERNANCE_REVIEW_PROFILE_VERSION ||
    attempt.modelConfigVersion !== MODEL_CONFIG_VERSION
  ) {
    throw revisionConflict("治理检查Attempt与冻结输入不一致");
  }
  return { ...prepared, attemptId: attempt.attemptId };
}

export async function persistExecutionCandidate(
  deps: ApplicationDeps,
  input: Omit<PersistExecutionCandidateRequest, "schemaVersion">,
): Promise<{ executionCandidateId: ExecutionCandidateId; sha256: string }> {
  const requestSha256 = hashCanonical("command.persist-execution-candidate.v1", input);
  const exact = await readExactCommandReceipt(deps.store, () => ({
    commandId: input.commandId,
    commandType: "PersistExecutionCandidate",
    requestSha256,
  }));
  if (exact.receipt !== undefined) {
    const executionCandidateId = exact.receipt.resultRefs[
      "executionCandidateId"
    ] as ExecutionCandidateId;
    const candidate = exact.snapshot.entities.executionCandidates[executionCandidateId];
    if (
      candidate === undefined ||
      candidate.productRunId !== input.productRunId ||
      candidate.executionContractId !== input.executionContractId
    ) {
      throw revisionConflict("Execution Candidate Receipt缺少不可变命令结果");
    }
    return { executionCandidateId: candidate.executionCandidateId, sha256: candidate.sha256 };
  }
  const preflight = await deps.store.read({ kind: "committedSnapshot" });
  const preflightContract =
    preflight.snapshot.entities.executionContracts[input.executionContractId];
  if (preflightContract === undefined || preflightContract.productRunId !== input.productRunId) {
    throw notFound("Execution Contract不存在");
  }
  for (const stepResult of input.stepResults) {
    const contractStep = preflightContract.steps.find((step) => step.stepId === stepResult.stepId);
    if (contractStep === undefined) throw revisionConflict("Execution Step不在合同中");
    const evidenceRefs = stepResult.executionEvidenceRefs ?? [];
    const requiresRuntimeEvidence = contractStep.capabilityRefs.some(
      (capability) => capability !== "markdown_text_compose",
    );
    if (evidenceRefs.some((ref) => ref.outcome !== "completed")) {
      throw revisionConflict(`步骤${stepResult.stepId}包含非成功Tool Evidence`);
    }
    if (
      (requiresRuntimeEvidence || evidenceRefs.length > 0) &&
      deps.executionEvidenceVerifier === undefined
    ) {
      throw revisionConflict(`步骤${stepResult.stepId}缺少权威Runtime Evidence Port`);
    }
    if (
      deps.executionEvidenceVerifier !== undefined &&
      (requiresRuntimeEvidence || evidenceRefs.length > 0)
    ) {
      try {
        await deps.executionEvidenceVerifier.verify({
          executionAttemptId: stepResult.executionAttemptId,
          evidenceRefs,
        });
      } catch {
        throw revisionConflict(`步骤${stepResult.stepId}的Pi Journal Evidence不存在或发生漂移`);
      }
    }
  }
  const now = deps.now();
  const executionCandidateId = deps.ids.executionCandidate();
  const sha256 = hashCanonical("execution-candidate.v1", {
    executionContractId: input.executionContractId,
    evidencePolicyVersion: input.evidencePolicyVersion,
    stepResults: input.stepResults,
    finalOutput: input.finalOutput,
    completionCriteriaEvidence: input.completionCriteriaEvidence,
    warnings: input.warnings,
  });

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PersistExecutionCandidate",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const contract = draft.entities.executionContracts[input.executionContractId];
      if (contract === undefined || contract.productRunId !== input.productRunId) {
        throw notFound("Execution Contract不存在");
      }
      const priorResults = new Map<string, (typeof input.stepResults)[number]>();
      for (const stepResult of input.stepResults) {
        const attempt = draft.entities.attempts[stepResult.executionAttemptId];
        if (
          attempt === undefined ||
          attempt.productRunId !== input.productRunId ||
          attempt.kind !== "execution" ||
          attempt.stepId !== stepResult.stepId ||
          attempt.outcome !== "success" ||
          attempt.inputManifestSha256 !== stepResult.inputManifestSha256 ||
          attempt.promptTemplateVersion === undefined ||
          attempt.modelConfigVersion === undefined
        ) {
          throw revisionConflict(`步骤${stepResult.stepId}的Execution Attempt血缘不合法`);
        }
        const contractStep = contract.steps.find((step) => step.stepId === stepResult.stepId);
        if (contractStep === undefined) throw revisionConflict("Execution Step不在合同中");
        const evidenceRefs = stepResult.executionEvidenceRefs ?? [];
        if (
          new Set(evidenceRefs.map((ref) => ref.toolCallId)).size !== evidenceRefs.length ||
          evidenceRefs.some(
            (ref) =>
              ref.executionAttemptId !== stepResult.executionAttemptId ||
              ref.capabilityId !== `pi_planning:tool:builtin:${ref.localName}`,
          )
        ) {
          throw revisionConflict(`步骤${stepResult.stepId}的Tool Evidence Ref血缘不合法`);
        }
        if (
          stepResult.dependencyRefs.length !== contractStep.dependsOn.length ||
          stepResult.dependencyRefs.some((ref, index) => {
            const expectedId = contractStep.dependsOn[index];
            const dependency = priorResults.get(ref.stepId);
            return (
              expectedId !== ref.stepId ||
              dependency === undefined ||
              dependency.executionAttemptId !== ref.executionAttemptId ||
              dependency.sha256 !== ref.sha256
            );
          })
        ) {
          throw revisionConflict(`步骤${stepResult.stepId}的依赖结果血缘不合法`);
        }
        const promptAssemblyRef = workflowNodePromptRefFor(
          draft,
          input.productRunId,
          "execute.plan",
        );
        const expectedInputManifestSha256 = computeExecutionInputManifestSha256({
          executionContractId: contract.executionContractId,
          approvedPlanSha256: contract.approvedPlanSha256,
          stepId: stepResult.stepId,
          inputRefs: contractStep.inputRefs,
          dependencyRefs: stepResult.dependencyRefs,
          promptTemplateVersion: attempt.promptTemplateVersion,
          modelConfigVersion: attempt.modelConfigVersion,
          ...(promptAssemblyRef === undefined ? {} : { promptAssemblyRef }),
        });
        if (expectedInputManifestSha256 !== stepResult.inputManifestSha256) {
          throw revisionConflict(`步骤${stepResult.stepId}的输入Manifest不一致`);
        }
        const expectedStepSha256 = hashCanonical("execution-step-result.v1", {
          stepId: stepResult.stepId,
          executionAttemptId: stepResult.executionAttemptId,
          inputManifestSha256: stepResult.inputManifestSha256,
          dependencyRefs: stepResult.dependencyRefs,
          output: stepResult.output,
          sections: stepResult.sections,
          successCriteriaEvidence: stepResult.successCriteriaEvidence,
          criteriaEvidence: stepResult.criteriaEvidence,
          ...(stepResult.executionEvidenceRefs === undefined
            ? {}
            : { executionEvidenceRefs: stepResult.executionEvidenceRefs }),
          warnings: stepResult.warnings,
        });
        if (expectedStepSha256 !== stepResult.sha256) {
          throw revisionConflict(`步骤${stepResult.stepId}的结果Hash不一致`);
        }
        priorResults.set(stepResult.stepId, stepResult);
      }
      draft.entities.executionCandidates[executionCandidateId] = {
        schemaVersion: "execution-candidate.v1",
        executionCandidateId,
        productRunId: input.productRunId,
        executionContractId: input.executionContractId,
        evidencePolicyVersion: input.evidencePolicyVersion,
        stepResults: input.stepResults,
        finalOutput: input.finalOutput,
        completionCriteriaEvidence: input.completionCriteriaEvidence,
        warnings: input.warnings,
        sha256,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      synchronizePlanningWorkflowProjection(draft, input.productRunId, now);
      return { resultRefs: { executionCandidateId } };
    },
  });
  return {
    executionCandidateId: result.resultRefs["executionCandidateId"] as ExecutionCandidateId,
    sha256,
  };
}

export async function persistValidationResult(
  deps: ApplicationDeps,
  input: Omit<PersistValidationResultRequest, "schemaVersion">,
): Promise<{
  validationResultId: ValidationResultId;
  outcome: "pass" | "fail";
  failures: { code: string; detail: string }[];
}> {
  const now = deps.now();
  const validationResultId = deps.ids.validationResult();
  const requestSha256 = hashCanonical("command.persist-validation-result.v1", input);

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PersistValidationResult",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const planningRun = requirePlanningRun(run);
      const runSpec =
        planningRun.workflowRunSpecId === undefined
          ? undefined
          : draft.entities.workflowRunSpecs[planningRun.workflowRunSpecId];
      if (runSpec === undefined) throw notFound("Workflow RunSpec不存在");
      let validationPolicy;
      try {
        validationPolicy = resolvePlanningValidationPolicy(runSpec);
      } catch {
        throw revisionConflict("Validation策略无效");
      }
      if (input.strictEvidence !== validationPolicy.strictEvidence) {
        throw revisionConflict("Validation strictEvidence与冻结RunSpec不一致");
      }
      const contract = draft.entities.executionContracts[input.executionContractId];
      if (contract === undefined || contract.productRunId !== input.productRunId) {
        throw notFound("Execution Contract不存在");
      }
      const candidate = draft.entities.executionCandidates[input.executionCandidateId];
      if (candidate === undefined || candidate.executionContractId !== input.executionContractId) {
        throw notFound("Execution Candidate不存在");
      }
      const existingValidation = Object.values(draft.entities.validationResults).find(
        (validation) => validation.executionCandidateId === input.executionCandidateId,
      );
      if (existingValidation !== undefined) {
        throw revisionConflict("同一Execution Candidate不允许第二份Validation事实");
      }
      const deterministicFailures = validatePersistedCandidate(
        contract,
        candidate,
        input.strictEvidence,
      );
      const governanceReview = (() => {
        if (validationPolicy.kind === "deterministic") {
          if (
            input.governanceReview !== undefined ||
            input.governanceReviewAttemptId !== undefined ||
            input.governanceReviewInputManifestSha256 !== undefined
          ) {
            throw revisionConflict("确定性Validation节点不允许提交Governance Review");
          }
          return undefined;
        }
        if (
          input.governanceReview === undefined ||
          input.governanceReviewAttemptId === undefined ||
          input.governanceReviewInputManifestSha256 === undefined
        ) {
          throw revisionConflict("治理检查节点必须提交Review、Attempt与输入Manifest");
        }
        const prepared = resolveGovernanceReviewContext(draft, {
          productRunId: input.productRunId,
          workflowRunSpecId: runSpec.workflowRunSpecId,
          executionCandidateId: input.executionCandidateId,
        });
        const attempt = draft.entities.attempts[input.governanceReviewAttemptId];
        if (
          attempt === undefined ||
          attempt.kind !== "governance_review" ||
          attempt.productRunId !== input.productRunId ||
          attempt.executionContractId !== input.executionContractId ||
          attempt.executionCandidateId !== input.executionCandidateId ||
          attempt.outcome !== "running" ||
          attempt.inputManifestSha256 !== prepared.inputManifestSha256 ||
          input.governanceReviewInputManifestSha256 !== prepared.inputManifestSha256
        ) {
          throw revisionConflict("治理检查Attempt与冻结输入不一致或已终止");
        }
        assertGovernanceEvidence(candidate, input.governanceReview);
        const nodePrompt = workflowNodePromptFor(
          draft,
          input.productRunId,
          "agent.governance_check",
        );
        if (
          nodePrompt === undefined ||
          nodePrompt.profileVersion !== GOVERNANCE_REVIEW_PROFILE_VERSION
        ) {
          throw revisionConflict("治理检查Validation缺少冻结节点Prompt");
        }
        return {
          profileVersion: GOVERNANCE_REVIEW_PROFILE_VERSION,
          attemptId: attempt.attemptId,
          inputManifestSha256: prepared.inputManifestSha256,
          promptAssemblyId: nodePrompt.promptAssemblyId,
          promptAssemblySha256: nodePrompt.promptAssemblySha256,
          nodeAssemblySha256: nodePrompt.nodeAssemblySha256,
          candidate: input.governanceReview,
        } as const;
      })();
      const failures = [
        ...deterministicFailures,
        ...(governanceReview === undefined ? [] : governanceFailures(governanceReview.candidate)),
      ];
      draft.entities.validationResults[validationResultId] = {
        schemaVersion: "validation-result.v2",
        validationResultId,
        productRunId: input.productRunId,
        executionContractId: input.executionContractId,
        executionCandidateId: input.executionCandidateId,
        strictEvidence: input.strictEvidence,
        ...(governanceReview === undefined ? {} : { governanceReview }),
        outcome: failures.length === 0 ? "pass" : "fail",
        failures,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (governanceReview !== undefined) {
        const attempt = draft.entities.attempts[governanceReview.attemptId]!;
        draft.entities.attempts[attempt.attemptId] = {
          ...attempt,
          outcome: "success",
          revision: attempt.revision + 1,
          updatedAt: now,
        };
      }
      synchronizePlanningWorkflowProjection(draft, input.productRunId, now);
      return { resultRefs: { validationResultId } };
    },
  });

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = snapshot.entities.executionCandidates[input.executionCandidateId];
  const validation =
    snapshot.entities.validationResults[
      result.resultRefs["validationResultId"] as ValidationResultId
    ];
  if (validation === undefined) throw notFound("Validation Result不存在");
  const workflowAttempt = findWorkflowAttempt(snapshot.entities, input.productRunId);
  if (!result.replayed && candidate !== undefined && workflowAttempt !== undefined) {
    const eventBase = {
      productRunId: input.productRunId,
      attemptId: workflowAttempt.attemptId,
      candidateRef: {
        objectType: "execution_candidate" as const,
        objectId: candidate.executionCandidateId,
        sha256: candidate.sha256,
      },
    };
    if (validation.outcome === "pass") {
      emitRunEvent(deps, input.productRunId, {
        level: "info",
        eventName: "execution.validated",
        outcome: "success",
        ...eventBase,
      });
    } else {
      emitRunEvent(deps, input.productRunId, {
        level: "warn",
        eventName: "execution.rejected",
        outcome: "rejected",
        ...eventBase,
        error: {
          code: validation.failures[0]?.code ?? "validation_failed",
          type: "ValidationError",
        },
      });
    }
  }
  return {
    validationResultId: validation.validationResultId,
    outcome: validation.outcome,
    failures: validation.failures,
  };
}

export interface CommitExecutionResultCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly executionContractId: ExecutionContractId;
  readonly executionCandidateId: ExecutionCandidateId;
  readonly validationResultId: ValidationResultId;
}

/** Product Commit：原子提交Assistant Message + Run终态 + Receipt；失败三者都不提交。 */
export async function commitExecutionResult(
  deps: ApplicationDeps,
  input: CommitExecutionResultCommand,
): Promise<{ finalMessageId: string; revision: number }> {
  const now = deps.now();
  const startedAt = performance.now();
  const finalMessageId = deps.ids.message();
  const requestSha256 = hashCanonical("command.commit-execution-result.v1", {
    productRunId: input.productRunId,
    executionContractId: input.executionContractId,
    executionCandidateId: input.executionCandidateId,
    validationResultId: input.validationResultId,
  });

  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const workflowAttempt = findWorkflowAttempt(before.entities, input.productRunId);
  const priorReceipt = before.commandReceipts[input.commandId];
  const exactReplay =
    priorReceipt?.commandType === "CommitExecutionResult" &&
    priorReceipt.requestSha256 === requestSha256;
  let adoptionEvidence: AdoptionEvidenceReceipt | undefined;
  if (!exactReplay) {
    const contract = before.entities.executionContracts[input.executionContractId];
    const candidate = before.entities.executionCandidates[input.executionCandidateId];
    if (
      contract === undefined ||
      contract.productRunId !== input.productRunId ||
      candidate === undefined ||
      candidate.executionContractId !== contract.executionContractId
    ) {
      throw notFound("Product Commit缺少Execution Contract或Candidate");
    }
    adoptionEvidence = await verifyAdoptionEvidence(deps, contract, candidate);
  }
  if (workflowAttempt !== undefined && !exactReplay) {
    emitRunEvent(deps, input.productRunId, {
      level: "info",
      eventName: "product_commit.started",
      outcome: "unknown",
      productRunId: input.productRunId,
      attemptId: workflowAttempt.attemptId,
      outputRefs: [],
    });
  }

  const result = await deps.store
    .transact({
      commandId: input.commandId,
      commandType: "CommitExecutionResult",
      requestSha256,
      traceContext: { productRunId: input.productRunId },
      mutate: (draft) => {
        const run = draft.entities.runs[input.productRunId];
        if (run === undefined) throw notFound("Product Run不存在");
        const planningRun = requirePlanningRun(run);
        const runSpec =
          planningRun.workflowRunSpecId === undefined
            ? undefined
            : draft.entities.workflowRunSpecs[planningRun.workflowRunSpecId];
        if (runSpec === undefined) throw notFound("Workflow RunSpec不存在");
        let validationPolicy;
        try {
          validationPolicy = resolvePlanningValidationPolicy(runSpec);
        } catch {
          throw revisionConflict("Product Commit的Validation策略无效");
        }
        const contract = draft.entities.executionContracts[input.executionContractId];
        if (contract === undefined || contract.productRunId !== input.productRunId) {
          throw notFound("Execution Contract不存在");
        }
        const candidate = draft.entities.executionCandidates[input.executionCandidateId];
        if (
          candidate === undefined ||
          candidate.executionContractId !== contract.executionContractId
        ) {
          throw notFound("Execution Candidate不存在");
        }
        const validation = draft.entities.validationResults[input.validationResultId];
        if (
          validation === undefined ||
          validation.executionCandidateId !== candidate.executionCandidateId ||
          validation.executionContractId !== contract.executionContractId
        ) {
          throw notFound("Validation Result不存在");
        }
        if (validation.outcome !== "pass") {
          throw revisionConflict("验证未通过的候选不能提交为正式结果");
        }
        const candidateValidations = Object.values(draft.entities.validationResults).filter(
          (candidateValidation) =>
            candidateValidation.executionCandidateId === candidate.executionCandidateId,
        );
        if (
          candidateValidations.length !== 1 ||
          candidateValidations[0]?.validationResultId !== validation.validationResultId
        ) {
          throw revisionConflict("Execution Candidate没有唯一Validation事实");
        }
        if (validation.strictEvidence !== validationPolicy.strictEvidence) {
          throw revisionConflict("Validation strictEvidence与冻结RunSpec不一致");
        }
        if (
          (validationPolicy.kind === "governance_review") !==
          (validation.governanceReview !== undefined)
        ) {
          throw revisionConflict("Validation类型与冻结RunSpec不一致");
        }
        const deterministicFailures = validatePersistedCandidate(
          contract,
          candidate,
          validationPolicy.strictEvidence,
        );
        if (validation.governanceReview !== undefined) {
          assertGovernanceEvidence(candidate, validation.governanceReview.candidate);
          const nodePrompt = workflowNodePromptFor(
            draft,
            input.productRunId,
            "agent.governance_check",
          );
          if (
            nodePrompt === undefined ||
            nodePrompt.promptAssemblyId !== validation.governanceReview.promptAssemblyId ||
            nodePrompt.promptAssemblySha256 !== validation.governanceReview.promptAssemblySha256 ||
            nodePrompt.nodeAssemblySha256 !== validation.governanceReview.nodeAssemblySha256
          ) {
            throw revisionConflict("Governance Review与冻结Prompt不一致");
          }
          const governanceAttempt = draft.entities.attempts[validation.governanceReview.attemptId];
          if (
            governanceAttempt === undefined ||
            governanceAttempt.kind !== "governance_review" ||
            governanceAttempt.productRunId !== input.productRunId ||
            governanceAttempt.executionContractId !== contract.executionContractId ||
            governanceAttempt.executionCandidateId !== candidate.executionCandidateId ||
            governanceAttempt.outcome !== "success" ||
            governanceAttempt.inputManifestSha256 !==
              validation.governanceReview.inputManifestSha256
          ) {
            throw revisionConflict("Governance Review与独立Attempt不一致");
          }
        }
        const currentFailures = [
          ...deterministicFailures,
          ...(validation.governanceReview === undefined
            ? []
            : governanceFailures(validation.governanceReview.candidate)),
        ];
        if (
          currentFailures.length !== 0 ||
          hashCanonical("validation-failures.v1", validation.failures) !==
            hashCanonical("validation-failures.v1", currentFailures)
        ) {
          throw revisionConflict("Validation Result与当前持久化候选不一致");
        }
        if (adoptionEvidence === undefined) {
          throw revisionConflict("Product Commit缺少采用时Evidence Receipt");
        }
        assertAdoptionEvidenceReceipt(contract, candidate, adoptionEvidence);
        const renderedMarkdown = renderCandidateMarkdown(candidate);

        let lifecycle: RunLifecycle = { status: planningRun.status, phase: planningRun.phase };
        if (lifecycle.status === "running" && lifecycle.phase === "executing") {
          lifecycle = transitionRunLifecycle(lifecycle, { status: "running", phase: "validating" });
        }
        lifecycle = transitionRunLifecycle(lifecycle, { status: "succeeded", phase: "completed" });

        const session = draft.entities.sessions[planningRun.sessionId];
        if (session === undefined) throw notFound("Session不存在");
        const sessionSequence = session.lastMessageSequence + 1;
        const message: Message = {
          schemaVersion: "message.v1",
          messageId: finalMessageId,
          sessionId: planningRun.sessionId,
          sessionSequence,
          role: "assistant",
          content: { format: "markdown", text: renderedMarkdown },
          sourceRunId: input.productRunId,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        draft.entities.messages[finalMessageId] = message;
        draft.entities.sessions[planningRun.sessionId] = {
          ...session,
          lastMessageSequence: sessionSequence,
          revision: session.revision + 1,
          updatedAt: now,
        };
        draft.entities.runs[input.productRunId] = {
          ...planningRun,
          status: lifecycle.status,
          phase: lifecycle.phase,
          finalMessageId,
          revision: planningRun.revision + 1,
          updatedAt: now,
        };
        completeWorkflowAttempt(draft, input.productRunId, "success", now);
        synchronizePlanningWorkflowProjection(draft, input.productRunId, now);
        return {
          resultRefs: {
            finalMessageId,
            productRunId: input.productRunId,
            evidenceReceiptSha256: adoptionEvidence.sha256,
            messageSha256: hashCanonical("message.v1", {
              messageId: finalMessageId,
              sessionId: planningRun.sessionId,
              sessionSequence,
              role: "assistant",
              content: message.content,
            }),
          },
        };
      },
    })
    .catch((error: unknown) => {
      if (workflowAttempt !== undefined && !exactReplay) {
        emitRunEvent(deps, input.productRunId, {
          level: "warn",
          eventName: "product_commit.failed",
          outcome: "failure",
          productRunId: input.productRunId,
          attemptId: workflowAttempt.attemptId,
          error: { code: "product_commit.failed", type: safeErrorType(error) },
          outputRefs: [],
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
      throw error;
    });

  if (workflowAttempt !== undefined && !result.replayed) {
    emitRunEvent(deps, input.productRunId, {
      level: "info",
      eventName: "product_commit.committed",
      outcome: "success",
      productRunId: input.productRunId,
      attemptId: workflowAttempt.attemptId,
      outputRefs: [
        {
          objectType: "message",
          objectId: result.resultRefs["finalMessageId"] ?? "",
          sha256: result.resultRefs["messageSha256"] ?? "",
        },
      ],
      durationMs: Math.round(performance.now() - startedAt),
    });
    const priorRun = before.entities.runs[input.productRunId];
    if (priorRun !== undefined) {
      const { snapshot: after } = await deps.store.read({ kind: "committedSnapshot" });
      const committedRun = after.entities.runs[input.productRunId];
      if (committedRun !== undefined)
        emitProductRunTransition(deps, priorRun, committedRun, "info");
    }
  }
  return {
    finalMessageId: result.resultRefs["finalMessageId"] ?? "",
    revision: result.storeRevision,
  };
}

function validatePersistedCandidate(
  contract: ExecutionContract,
  candidate: ExecutionCandidate,
  strictEvidence: boolean,
): { code: string; detail: string }[] {
  return validateExecutionCandidate(
    {
      executionContractId: contract.executionContractId,
      approvedPlanId: contract.approvedPlanId,
      approvedPlanRevision: contract.approvedPlanRevision,
      approvedPlanSha256: contract.approvedPlanSha256,
      steps: contract.steps,
      completionCriteria: contract.completionCriteria,
    },
    {
      executionContractId: candidate.executionContractId,
      stepResults: candidate.stepResults,
      finalOutputSections: candidate.finalOutput.sections,
      completionCriteriaEvidence: candidate.completionCriteriaEvidence,
      structuredEvidenceRequired: candidate.evidencePolicyVersion === "structured-tool-result.v1",
    },
    { strictEvidence },
  );
}

/** Product Commit唯一正文渲染器：只接受已持久化Candidate，Workflow不能注入正文。 */
function renderCandidateMarkdown(candidate: ExecutionCandidate): string {
  const markdown = candidate.finalOutput.sections
    .map((section) => `## ${section.heading}\n\n${section.body}`)
    .join("\n\n");
  if (markdown.length > 100_000) {
    throw revisionConflict("执行候选渲染结果超过Message正文上限");
  }
  return markdown;
}

export interface CommitRejectedRunCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly decisionId: DecisionId;
}

/** Reject路径确认：Decision已在SubmitPlanDecision提交cancelled，本命令完成Attempt并保证幂等。 */
export async function commitRejectedRun(
  deps: ApplicationDeps,
  input: CommitRejectedRunCommand,
): Promise<{ revision: number }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.commit-rejected-run.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CommitRejectedRun",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const planningRun = requirePlanningRun(run);
      const decision = draft.entities.decisions[input.decisionId];
      if (decision === undefined || decision.productRunId !== input.productRunId) {
        throw notFound("Decision不存在");
      }
      if (decision.kind !== "reject") throw revisionConflict("只有reject Decision能提交取消终态");
      if (planningRun.status !== "cancelled" || planningRun.phase !== "rejected") {
        throw revisionConflict("Product Run不在cancelled/rejected终态");
      }
      completeWorkflowAttempt(draft, input.productRunId, "success", now);
      synchronizePlanningWorkflowProjection(draft, input.productRunId, now);
      return { resultRefs: { productRunId: input.productRunId } };
    },
  });
  return { revision: result.storeRevision };
}

export interface CommitRunFailureCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly errorCode: string;
  readonly summary: string;
}

export interface ExpireApprovalCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly approvalRequestId: ApprovalRequestId;
  readonly expectedExpiresAt: string;
}

/** Workflow耐久定时器触发的审批收敛；浏览器不能调用本命令。 */
export async function expireApproval(
  deps: ApplicationDeps,
  input: ExpireApprovalCommand,
): Promise<{ status: "expired" | "already_decided"; revision: number }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.expire-approval.v1", input);
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const priorRun = before.entities.runs[input.productRunId];
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "ExpireApproval",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const planningRun = requirePlanningRun(run);
      const approval = draft.entities.approvalRequests[input.approvalRequestId];
      if (approval === undefined || approval.productRunId !== input.productRunId) {
        throw notFound("Approval Request不存在");
      }
      if (approval.expiresAt !== input.expectedExpiresAt) {
        throw revisionConflict("审批定时器与当前Approval过期事实不一致");
      }
      if (Date.parse(now) < Date.parse(approval.expiresAt)) {
        throw revisionConflict("审批尚未到期，拒绝提前过期");
      }
      if (approval.status === "decided") {
        synchronizePlanningWorkflowProjection(draft, input.productRunId, now);
        return { resultRefs: { status: "already_decided" } };
      }

      if (approval.status === "open") {
        draft.entities.approvalRequests[approval.approvalRequestId] = {
          ...approval,
          status: "expired",
          expiredAt: now,
          revision: approval.revision + 1,
          updatedAt: now,
        };
        const plan = Object.values(draft.entities.plans).find(
          (candidate) =>
            candidate.productRunId === input.productRunId &&
            candidate.planId === approval.planId &&
            candidate.planRevision === approval.planRevision,
        );
        if (plan?.status === "under_review") {
          draft.entities.plans[plan.planRevisionId] = {
            ...plan,
            status: "expired",
            revision: plan.revision + 1,
            updatedAt: now,
          };
        }
      }

      if (planningRun.status === "waiting_human" && planningRun.phase === "plan_review") {
        const expiredRun = {
          ...planningRun,
          status: "failed" as const,
          failure: { code: "approval.expired", summary: "计划确认已过期，请重新开始" },
          revision: planningRun.revision + 1,
          updatedAt: now,
        };
        delete expiredRun.currentApprovalRequestId;
        draft.entities.runs[input.productRunId] = expiredRun;
      } else if (
        planningRun.status !== "failed" ||
        planningRun.failure?.code !== "approval.expired"
      ) {
        throw revisionConflict("当前Product Run状态不允许审批过期");
      }
      completeWorkflowAttempt(draft, input.productRunId, "failure", now, "approval.expired");
      synchronizePlanningWorkflowProjection(draft, input.productRunId, now);
      return { resultRefs: { status: "expired" } };
    },
  });
  const status = result.resultRefs["status"] === "already_decided" ? "already_decided" : "expired";
  if (!result.replayed && status === "expired" && priorRun !== undefined) {
    const { snapshot: after } = await deps.store.read({ kind: "committedSnapshot" });
    const settledRun = after.entities.runs[input.productRunId];
    if (settledRun !== undefined) emitProductRunTransition(deps, priorRun, settledRun, "warn");
  }
  return {
    status,
    revision: result.storeRevision,
  };
}

/** 明确失败终态：不产生产假成功；等待中的Approval与under_review Plan一并过期。 */
export async function commitRunFailure(
  deps: ApplicationDeps,
  input: CommitRunFailureCommand,
): Promise<{ revision: number }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.commit-run-failure.v1", input);
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const priorRun = before.entities.runs[input.productRunId];
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CommitRunFailure",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      settleRunWithoutSuccess(
        draft,
        input.productRunId,
        "failed",
        input.errorCode,
        input.summary,
        now,
      );
      return { resultRefs: { productRunId: input.productRunId } };
    },
  });

  if (
    !result.replayed &&
    priorRun !== undefined &&
    priorRun.status !== "succeeded" &&
    priorRun.status !== "failed" &&
    priorRun.status !== "cancelled" &&
    priorRun.status !== "outcome_unknown"
  ) {
    const { snapshot: after } = await deps.store.read({ kind: "committedSnapshot" });
    const settledRun = after.entities.runs[input.productRunId];
    if (settledRun !== undefined) emitProductRunTransition(deps, priorRun, settledRun, "warn");
  }
  return { revision: result.storeRevision };
}

/* ---------- 内部助手 ---------- */

type Entities = Parameters<
  Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]
>[0]["entities"];

function findWorkflowAttempt(entities: Entities, productRunId: ProductRunId) {
  return Object.values(entities.attempts).find(
    (attempt) => attempt.productRunId === productRunId && attempt.kind === "workflow",
  );
}

function completeWorkflowAttempt(
  draft: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
  productRunId: ProductRunId,
  outcome: "success" | "failure",
  now: string,
  errorCode?: string,
): void {
  const attempt = findWorkflowAttempt(draft.entities, productRunId);
  if (attempt === undefined || attempt.outcome !== "running") return;
  draft.entities.attempts[attempt.attemptId] = {
    ...attempt,
    outcome,
    ...(errorCode !== undefined ? { errorCode } : {}),
    revision: attempt.revision + 1,
    updatedAt: now,
  };
}
