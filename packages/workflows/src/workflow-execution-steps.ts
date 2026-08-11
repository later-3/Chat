import { computeExecutionInputManifestSha256, hashCanonical } from "@chat/domain";
import {
  EXECUTOR_PROMPT_TEMPLATE_VERSION,
  MODEL_CONFIG_VERSION,
  type ExecutionContextItemDto,
  type ExecutionContract,
} from "@chat/contracts";
import type { ExecutorDependencyResult, ExecutorStepCandidate } from "@chat/pi-runtime";
import { getWorkflowRuntimeContext } from "./runtime-context.js";
import {
  cmdId,
  emitCompletedProviderCall,
  emitPiNodeTrace,
  emitProviderTrace,
  PiStepFailure,
  providerResultTraceDetails,
  runStep,
  wrapApiError,
} from "./workflow-step-support.js";

/* ---------- 执行 ---------- */

export interface DurableExecutorStepCandidate extends ExecutorStepCandidate {
  readonly executionAttemptId: string;
  readonly inputManifestSha256: string;
  readonly dependencyRefs: { stepId: string; executionAttemptId: string; sha256: string }[];
  readonly sha256: string;
}

async function compileExecutionContractWithinStep(input: {
  productRunId: string;
  approvalDecisionId: string;
}): Promise<ExecutionContract> {
  const ctx = getWorkflowRuntimeContext();
  try {
    const result = await ctx.api.compileExecutionContract({
      commandId: cmdId(
        "compile-execution-contract",
        input.productRunId,
        input.approvalDecisionId,
      ) as never,
      productRunId: input.productRunId as never,
      approvalDecisionId: input.approvalDecisionId as never,
    });
    return result.contract;
  } catch (error) {
    wrapApiError(error);
  }
}

export async function compileExecutionContractStep(input: {
  productRunId: string;
  attemptId: string;
  approvalDecisionId: string;
}): Promise<ExecutionContract> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "compile_execution_contract", async () => {
    return compileExecutionContractWithinStep(input);
  });
}

interface BeginExecutionAttemptWithinStepInput {
  productRunId: string;
  executionContractId: string;
  stepId: string;
  dependencyRefs: readonly {
    stepId: string;
    executionAttemptId: string;
    sha256: string;
  }[];
  promptTemplateVersion: string;
  modelConfigVersion: string;
}

async function beginExecutionAttemptWithinStep(input: BeginExecutionAttemptWithinStepInput) {
  const ctx = getWorkflowRuntimeContext();
  try {
    return await ctx.api.beginRunAttempt({
      commandId: cmdId("begin-execution-attempt", input.productRunId, input.stepId) as never,
      productRunId: input.productRunId,
      kind: "execution",
      executionContractId: input.executionContractId,
      stepId: input.stepId,
      dependencyRefs: input.dependencyRefs,
      promptTemplateVersion: input.promptTemplateVersion,
      modelConfigVersion: input.modelConfigVersion,
    });
  } catch (error) {
    wrapApiError(error);
  }
}

export async function beginExecutionAttemptStep(input: {
  productRunId: string;
  attemptId: string;
  executionContractId: string;
  stepId: string;
  dependencyRefs: readonly {
    stepId: string;
    executionAttemptId: string;
    sha256: string;
  }[];
  promptTemplateVersion: string;
  modelConfigVersion: string;
}): Promise<{
  attemptId: string;
  inputManifestSha256: string;
  contextItems: readonly ExecutionContextItemDto[];
}> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "begin_execution_attempt", async () => {
    return beginExecutionAttemptWithinStep(input);
  });
}

export async function runPiExecutorStep(input: {
  contract: ExecutionContract;
  stepId: string;
  executionAttemptId: string;
  inputManifestSha256: string;
  contextItems: readonly ExecutionContextItemDto[];
  dependencyResults: readonly (ExecutorDependencyResult & {
    executionAttemptId: string;
  })[];
}): Promise<DurableExecutorStepCandidate> {
  "use step";
  const productRunId = input.contract.productRunId;
  return runStep(productRunId, input.executionAttemptId, "pi.execute", () =>
    runExecutorWithinStep(input),
  );
}

async function runExecutorWithinStep(input: {
  contract: ExecutionContract;
  stepId: string;
  executionAttemptId: string;
  inputManifestSha256: string;
  contextItems: readonly ExecutionContextItemDto[];
  dependencyResults: readonly (ExecutorDependencyResult & {
    executionAttemptId: string;
  })[];
}): Promise<DurableExecutorStepCandidate> {
  const productRunId = input.contract.productRunId;
  const ctx = getWorkflowRuntimeContext();
  const startedAt = performance.now();
  const contractStep = input.contract.steps.find((step) => step.stepId === input.stepId);
  const contextRefs = input.contextItems.map(({ refId, revision, sha256 }) => ({
    refId,
    revision,
    sha256,
  }));
  if (
    contractStep === undefined ||
    JSON.stringify(contextRefs) !== JSON.stringify(contractStep.inputRefs)
  ) {
    throw new PiStepFailure(
      "execution.context_ref_mismatch",
      "执行上下文与Approved Step引用不一致",
    );
  }
  const computedInputManifestSha256 = computeExecutionInputManifestSha256({
    executionContractId: input.contract.executionContractId,
    approvedPlanSha256: input.contract.approvedPlanSha256,
    stepId: input.stepId,
    inputRefs: contractStep.inputRefs,
    dependencyRefs: input.dependencyResults.map((dependency) => ({
      stepId: dependency.stepId,
      executionAttemptId: dependency.executionAttemptId,
      sha256: dependency.sha256,
    })),
    promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
    modelConfigVersion: MODEL_CONFIG_VERSION,
  });
  if (computedInputManifestSha256 !== input.inputManifestSha256) {
    throw new PiStepFailure("execution.input_manifest_mismatch", "执行输入证据不一致");
  }
  const inputManifestSha256 = computedInputManifestSha256;
  const scoped = {
    productRunId,
    attemptId: input.executionAttemptId,
    promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
    modelConfigVersion: MODEL_CONFIG_VERSION,
  };
  if (ctx.bailian.apiKey === undefined) {
    const code = "provider.pre_request.no_api_key";
    emitProviderTrace(scoped, "provider.request.failed", {
      durationMs: 0,
      errorCode: code,
      preRequest: true,
    });
    emitPiNodeTrace(scoped, "pi.node.failed", "executor", { errorCode: code });
    throw new PiStepFailure(code, "pi.execute预请求失败:未配置Provider凭据");
  }
  emitPiNodeTrace(scoped, "pi.node.started", "executor");
  try {
    const result = await ctx.executor({
      config: ctx.bailian,
      contract: input.contract,
      stepId: input.stepId,
      contextItems: input.contextItems,
      dependencyResults: input.dependencyResults.map(({ stepId, sha256, output, sections }) => ({
        stepId,
        sha256,
        output,
        sections,
      })),
      onProviderRequestStart: () =>
        emitProviderTrace(scoped, "provider.request.started", { inputManifestSha256 }),
    });
    if (result.kind === "candidate") {
      if (!emitCompletedProviderCall(scoped, inputManifestSha256, result)) {
        const errorCode = "provider.evidence_missing";
        emitProviderTrace(scoped, "provider.request.failed", {
          inputManifestSha256,
          durationMs: result.durationMs,
          errorCode,
          ...(result.providerMeta.httpStatus !== undefined
            ? { httpStatus: result.providerMeta.httpStatus }
            : {}),
          ...(result.providerMeta.providerRequestId !== undefined
            ? { providerRequestId: result.providerMeta.providerRequestId }
            : {}),
          ...providerResultTraceDetails(result.providerMeta),
        });
        emitPiNodeTrace(scoped, "pi.node.failed", "executor", {
          durationMs: result.durationMs,
          errorCode,
        });
        throw new PiStepFailure(errorCode, "pi.execute证据缺失");
      }
      emitPiNodeTrace(scoped, "pi.node.completed", "executor", {
        durationMs: result.durationMs,
      });
      const dependencyRefs = input.dependencyResults.map((dependency) => ({
        stepId: dependency.stepId,
        executionAttemptId: dependency.executionAttemptId,
        sha256: dependency.sha256,
      }));
      const durable = {
        ...result.candidate,
        executionAttemptId: input.executionAttemptId,
        inputManifestSha256,
        dependencyRefs,
      };
      return {
        ...durable,
        sha256: hashCanonical("execution-step-result.v1", durable),
      };
    }
    if (result.kind === "invalid_candidate") {
      if (!emitCompletedProviderCall(scoped, inputManifestSha256, result)) {
        const errorCode = "provider.evidence_missing";
        emitProviderTrace(scoped, "provider.request.failed", {
          inputManifestSha256,
          durationMs: result.durationMs,
          errorCode,
          ...(result.providerMeta.httpStatus !== undefined
            ? { httpStatus: result.providerMeta.httpStatus }
            : {}),
          ...(result.providerMeta.providerRequestId !== undefined
            ? { providerRequestId: result.providerMeta.providerRequestId }
            : {}),
          ...providerResultTraceDetails(result.providerMeta),
        });
        emitPiNodeTrace(scoped, "pi.node.failed", "executor", {
          durationMs: result.durationMs,
          errorCode,
        });
        throw new PiStepFailure(errorCode, "pi.execute证据缺失");
      }
      const errorCode = `model.candidate.${result.errorCode}`;
      emitPiNodeTrace(scoped, "pi.node.failed", "executor", {
        durationMs: result.durationMs,
        errorCode,
        ...(result.diagnostics !== undefined ? { candidateValidation: result.diagnostics } : {}),
      });
      throw new PiStepFailure(errorCode, `pi.execute失败:${errorCode}`);
    }
    const errorCode = result.errorCode;
    emitProviderTrace(scoped, "provider.request.failed", {
      inputManifestSha256,
      durationMs: result.durationMs,
      errorCode,
      ...(result.providerMeta.httpStatus !== undefined
        ? { httpStatus: result.providerMeta.httpStatus }
        : {}),
      ...(result.providerMeta.providerRequestId !== undefined
        ? { providerRequestId: result.providerMeta.providerRequestId }
        : {}),
      ...providerResultTraceDetails(result.providerMeta),
      ...(result.providerCallCount === 0 ? { preRequest: true } : {}),
    });
    emitPiNodeTrace(scoped, "pi.node.failed", "executor", {
      durationMs: result.durationMs,
      errorCode,
    });
    throw new PiStepFailure(errorCode, `pi.execute失败:${errorCode}`);
  } catch (error) {
    if (error instanceof PiStepFailure) throw error;
    const code =
      error instanceof Error && "code" in error && error.code === "provider.pre_request.no_api_key"
        ? "provider.pre_request.no_api_key"
        : "provider.pre_request.executor_failed";
    emitProviderTrace(scoped, "provider.request.failed", {
      durationMs: Math.round(performance.now() - startedAt),
      errorCode: code,
      preRequest: true,
    });
    emitPiNodeTrace(scoped, "pi.node.failed", "executor", { errorCode: code });
    throw new PiStepFailure(code, `pi.execute预请求失败:${code}`);
  }
}
runPiExecutorStep.maxRetries = 0;

async function completeRunAttemptWithinStep(input: {
  targetAttemptId: string;
  outcome: "success" | "failure";
  errorCode?: string;
}): Promise<void> {
  const ctx = getWorkflowRuntimeContext();
  try {
    await ctx.api.completeRunAttempt({
      commandId: cmdId("complete-run-attempt", input.targetAttemptId) as never,
      attemptId: input.targetAttemptId as never,
      outcome: input.outcome,
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    });
  } catch (error) {
    wrapApiError(error);
  }
}

export async function completeRunAttemptStep(input: {
  productRunId: string;
  attemptId: string;
  targetAttemptId: string;
  outcome: "success" | "failure";
  errorCode?: string;
}): Promise<void> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "complete_run_attempt", async () => {
    await completeRunAttemptWithinStep(input);
  });
}

export interface ExecutionCheckpointRefs {
  readonly executionContractId: string;
  readonly approvedPlanSha256: string;
  readonly executionCandidateId: string;
  readonly executionCandidateSha256: string;
}

/**
 * Configurable Composite把Contract正文、执行上下文、依赖输出和模型Candidate限制在单Step。
 * Workflow checkpoint只接收Product refs；Provider/持久化结果未知时不自动重试整段付费链。
 */
export async function executeAndPersistApprovedPlanStep(input: {
  readonly productRunId: string;
  readonly attemptId: string;
  readonly approvalDecisionId: string;
  readonly maxActions: number;
}): Promise<
  | { readonly status: "persisted"; readonly refs: ExecutionCheckpointRefs }
  | {
      readonly status: "failed" | "outcome_unknown";
      readonly errorCode: string;
    }
> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "execute_persist_approved_plan", async () => {
    let contract: ExecutionContract;
    try {
      contract = await compileExecutionContractWithinStep(input);
    } catch (error) {
      return executionFailureCheckpoint(error);
    }
    if (
      !Number.isInteger(input.maxActions) ||
      input.maxActions < 1 ||
      contract.steps.length > input.maxActions
    ) {
      return { status: "failed", errorCode: "execution.max_actions_exceeded" };
    }
    const candidates: DurableExecutorStepCandidate[] = [];
    for (const planStep of contract.steps) {
      let begun: Awaited<ReturnType<typeof beginExecutionAttemptWithinStep>> | undefined;
      try {
        const dependencyResults = planStep.dependsOn.map((dependencyStepId) => {
          const dependency = candidates.find((candidate) => candidate.stepId === dependencyStepId);
          if (dependency === undefined) {
            throw new PiStepFailure("execution.dependency_missing", "执行依赖缺失");
          }
          return {
            stepId: dependency.stepId,
            executionAttemptId: dependency.executionAttemptId,
            sha256: dependency.sha256,
            output: dependency.output,
            sections: dependency.sections,
          };
        });
        begun = await beginExecutionAttemptWithinStep({
          productRunId: input.productRunId,
          executionContractId: contract.executionContractId,
          stepId: planStep.stepId,
          dependencyRefs: dependencyResults.map(({ stepId, executionAttemptId, sha256 }) => ({
            stepId,
            executionAttemptId,
            sha256,
          })),
          promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
          modelConfigVersion: MODEL_CONFIG_VERSION,
        });
        const candidate = await runExecutorWithinStep({
          contract,
          stepId: planStep.stepId,
          executionAttemptId: begun.attemptId,
          inputManifestSha256: begun.inputManifestSha256,
          contextItems: begun.contextItems,
          dependencyResults,
        });
        await completeRunAttemptWithinStep({
          targetAttemptId: begun.attemptId,
          outcome: "success",
        });
        candidates.push(candidate);
      } catch (error) {
        const failed = executionFailureCheckpoint(error);
        if (begun !== undefined) {
          try {
            await completeRunAttemptWithinStep({
              targetAttemptId: begun.attemptId,
              outcome: "failure",
              errorCode: failed.errorCode,
            });
          } catch {
            return { status: "outcome_unknown", errorCode: "execution.attempt_settlement_unknown" };
          }
        }
        return failed;
      }
    }
    const stepResults = candidates.map((candidate) => ({
      stepId: candidate.stepId,
      executionAttemptId: candidate.executionAttemptId,
      inputManifestSha256: candidate.inputManifestSha256,
      dependencyRefs: candidate.dependencyRefs,
      output: candidate.output,
      sections: candidate.sections,
      successCriteriaEvidence: candidate.successCriteriaEvidence,
      criteriaEvidence: candidate.criteriaEvidence,
      warnings: candidate.warnings,
      sha256: candidate.sha256,
    }));
    try {
      const persisted = await getWorkflowRuntimeContext().api.persistExecutionCandidate({
        commandId: cmdId(
          "persist-execution-candidate",
          input.productRunId,
          contract.executionContractId,
        ) as never,
        productRunId: input.productRunId as never,
        executionContractId: contract.executionContractId as never,
        stepResults: stepResults as never,
        finalOutput: {
          format: "markdown_sections",
          sections: candidates.flatMap((candidate) => candidate.sections),
        },
        completionCriteriaEvidence: candidates.flatMap((candidate) => candidate.criteriaEvidence),
        warnings: candidates.flatMap((candidate) => candidate.warnings),
      });
      return {
        status: "persisted",
        refs: {
          executionContractId: contract.executionContractId,
          approvedPlanSha256: contract.approvedPlanSha256,
          executionCandidateId: persisted.executionCandidateId,
          executionCandidateSha256: persisted.sha256,
        },
      };
    } catch (error) {
      // HTTP明确拒绝是已知失败；只有网络/成功响应损坏的dispatch.outcome_unknown
      // 才进入人工对账，不能把所有业务冲突都伪装成结果未知。
      return executionFailureCheckpoint(error);
    }
  });
}
executeAndPersistApprovedPlanStep.maxRetries = 0;

function executionFailureCheckpoint(error: unknown): {
  readonly status: "failed" | "outcome_unknown";
  readonly errorCode: string;
} {
  const errorCode =
    error instanceof PiStepFailure
      ? error.stableCode
      : error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : error instanceof Error && STABLE_EXECUTION_ERROR.test(error.message)
          ? error.message
          : "execution.runner_failed";
  return {
    status: errorCode.includes("outcome_unknown") ? "outcome_unknown" : "failed",
    errorCode,
  };
}

const STABLE_EXECUTION_ERROR = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u;
