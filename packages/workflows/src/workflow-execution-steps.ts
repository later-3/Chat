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
  return runStep(productRunId, input.executionAttemptId, "pi.execute", async () => {
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
