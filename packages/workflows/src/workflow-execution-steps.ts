import { computeExecutionInputManifestSha256, hashCanonical } from "@chat/domain";
import {
  EXECUTOR_PROMPT_TEMPLATE_VERSION,
  MODEL_CONFIG_VERSION,
  type ExecutionContract,
} from "@chat/contracts";
import type { ExecutorDependencyResult, ExecutorStepCandidate } from "@chat/pi-runtime";
import { getWorkflowRuntimeContext } from "./runtime-context.js";
import {
  cmdId,
  completedProviderEvidence,
  emitPiNodeTrace,
  emitProviderTrace,
  PiStepFailure,
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

export async function compileExecutionContractStep(input: {
  productRunId: string;
  attemptId: string;
  approvalDecisionId: string;
}): Promise<ExecutionContract> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "compile_execution_contract", async () => {
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
  });
}

export async function beginExecutionAttemptStep(input: {
  productRunId: string;
  attemptId: string;
  executionContractId: string;
  approvedPlanSha256: string;
  stepId: string;
  dependencyRefs: readonly {
    stepId: string;
    executionAttemptId: string;
    sha256: string;
  }[];
  promptTemplateVersion: string;
  modelConfigVersion: string;
}): Promise<{ attemptId: string; inputManifestSha256: string }> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "begin_execution_attempt", async () => {
    const ctx = getWorkflowRuntimeContext();
    const inputManifestSha256 = computeExecutionInputManifestSha256({
      executionContractId: input.executionContractId,
      approvedPlanSha256: input.approvedPlanSha256,
      stepId: input.stepId,
      dependencyRefs: input.dependencyRefs,
      promptTemplateVersion: input.promptTemplateVersion,
      modelConfigVersion: input.modelConfigVersion,
    });
    try {
      const result = await ctx.api.beginRunAttempt({
        commandId: cmdId("begin-execution-attempt", input.productRunId, input.stepId) as never,
        productRunId: input.productRunId,
        kind: "execution",
        stepId: input.stepId,
        inputManifestSha256,
        promptTemplateVersion: input.promptTemplateVersion,
        modelConfigVersion: input.modelConfigVersion,
      });
      return { attemptId: result.attemptId, inputManifestSha256 };
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function runPiExecutorStep(input: {
  contract: ExecutionContract;
  stepId: string;
  executionAttemptId: string;
  inputManifestSha256: string;
  dependencyResults: readonly (ExecutorDependencyResult & {
    executionAttemptId: string;
  })[];
}): Promise<DurableExecutorStepCandidate> {
  "use step";
  const productRunId = input.contract.productRunId;
  return runStep(productRunId, input.executionAttemptId, "pi.execute", async () => {
    const ctx = getWorkflowRuntimeContext();
    const startedAt = performance.now();
    const computedInputManifestSha256 = computeExecutionInputManifestSha256({
      executionContractId: input.contract.executionContractId,
      approvedPlanSha256: input.contract.approvedPlanSha256,
      stepId: input.stepId,
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
        const evidence = completedProviderEvidence(result);
        if (evidence === undefined) {
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
          });
          emitPiNodeTrace(scoped, "pi.node.failed", "executor", {
            durationMs: result.durationMs,
            errorCode,
          });
          throw new PiStepFailure(errorCode, "pi.execute证据缺失");
        }
        emitProviderTrace(scoped, "provider.request.completed", {
          inputManifestSha256,
          durationMs: result.durationMs,
          httpStatus: evidence.httpStatus,
          providerRequestId: evidence.providerRequestId,
          tokenUsage: evidence.tokenUsage,
        });
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
      const errorCode =
        result.kind === "invalid_candidate"
          ? `model.candidate.${result.errorCode}`
          : result.errorCode;
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
        error instanceof Error &&
        "code" in error &&
        error.code === "provider.pre_request.no_api_key"
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
  });
}
runPiExecutorStep.maxRetries = 0;

export async function completeRunAttemptStep(input: {
  productRunId: string;
  attemptId: string;
  targetAttemptId: string;
  outcome: "success" | "failure";
  errorCode?: string;
}): Promise<void> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "complete_run_attempt", async () => {
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
  });
}
