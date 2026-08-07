import { FatalError } from "workflow";
import { hashCanonical, sha256Hex, validateExecutionCandidate } from "@chat/domain";
import {
  MODEL_CONFIG_VERSION,
  WORKFLOW_DEFINITION_VERSION,
  type ExecutionContract,
  type PlanContent,
  type PlanningInputDto,
} from "@chat/contracts";
import type { ExecutorStepCandidate } from "@chat/pi-runtime";
import { ApiClientError } from "./api-client.js";
import {
  getWorkflowRuntimeContext,
  workflowRunTraceId,
  workflowSpanId,
} from "./runtime-context.js";
import { decisionHookToken } from "./workflow-input.js";

/**
 * PlanningExecutionWorkflow的Step实现。
 *
 * 边界：
 * - Step只携带可序列化、经Zod校验的值或对象引用。
 * - 产品读写全部经过私有Application Command；Step不直接打开Product JSON。
 * - pi模型Step（pi.plan/pi.execute）maxRetries=0，避免重复费用和不同候选。
 * - Application Step使用稳定commandId，replay安全。
 */

function cmdId(...parts: string[]): string {
  return `cmd_${sha256Hex(parts.join(":")).slice(0, 32)}`;
}

function emitStepTrace(input: {
  productRunId: string;
  attemptId: string;
  stepKey: string;
  eventName: "workflow.step.started" | "workflow.step.completed" | "workflow.step.failed";
  errorCode?: string;
}): void {
  const ctx = getWorkflowRuntimeContext();
  const outcome =
    input.eventName === "workflow.step.started"
      ? "unknown"
      : input.eventName === "workflow.step.completed"
        ? "success"
        : "failure";
  ctx.trace({
    level: input.eventName === "workflow.step.failed" ? "warn" : "info",
    eventName: input.eventName,
    outcome,
    traceId: workflowRunTraceId(input.productRunId),
    spanId: workflowSpanId(),
    productRunId: input.productRunId as never,
    attemptId: input.attemptId as never,
    workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
    stepKey: input.stepKey,
    stepAttempt: 1,
    replay: false,
    ...(input.eventName === "workflow.step.failed"
      ? { error: { code: input.errorCode ?? "step.failed", type: "StepError" } }
      : {}),
  } as never);
}

async function runStep<T>(
  productRunId: string,
  attemptId: string,
  stepKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  emitStepTrace({ productRunId, attemptId, stepKey, eventName: "workflow.step.started" });
  try {
    const result = await fn();
    emitStepTrace({ productRunId, attemptId, stepKey, eventName: "workflow.step.completed" });
    return result;
  } catch (error) {
    emitStepTrace({
      productRunId,
      attemptId,
      stepKey,
      eventName: "workflow.step.failed",
      errorCode: error instanceof PiStepFailure ? error.stableCode : "step.failed",
    });
    throw error;
  }
}

/** pi/Provider失败与非法候选：Workflow捕获后提交明确失败终态，不由Workflow自动重试。 */
export class PiStepFailure extends Error {
  readonly stableCode: string;
  constructor(stableCode: string, message: string) {
    super(message);
    this.name = "PiStepFailure";
    this.stableCode = stableCode;
  }
}

function wrapApiError(error: unknown): never {
  if (error instanceof ApiClientError && error.retryable) throw error;
  if (error instanceof ApiClientError) throw new FatalError(error.message);
  throw error;
}

/* ---------- 规划 ---------- */

export async function compilePlanningInputStep(input: {
  productRunId: string;
  attemptId: string;
  planRevision: number;
}): Promise<PlanningInputDto> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "compile_planning_input", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      return await ctx.api.compilePlanningInput({
        commandId: cmdId(
          "compile-planning-input",
          input.productRunId,
          String(input.planRevision),
        ) as never,
        productRunId: input.productRunId as never,
        planRevision: input.planRevision,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function runPiPlannerStep(planningInput: PlanningInputDto): Promise<PlanContent> {
  "use step";
  const productRunId = planningInput.productRunId;
  const attemptId = planningInput.attemptId;
  return runStep(productRunId, attemptId, "pi.plan", async () => {
    const ctx = getWorkflowRuntimeContext();
    const startedAt = performance.now();
    const inputManifestSha256 = hashCanonical("planning-input-manifest.v1", {
      sourceMessageRef: planningInput.sourceMessageRef,
      ...(planningInput.priorPlan !== undefined
        ? {
            priorPlanRef: {
              planId: planningInput.priorPlan.planId,
              planRevision: planningInput.priorPlan.planRevision,
              sha256: planningInput.priorPlan.sha256,
            },
          }
        : {}),
      hasRevisionInstruction: planningInput.revisionInstruction !== undefined,
      planRevision: planningInput.planRevision,
      promptTemplateVersion: planningInput.promptTemplateVersion,
      modelConfigVersion: planningInput.modelConfigVersion,
    });
    emitProviderTrace(planningInput, "provider.request.started", { inputManifestSha256 });
    emitPiNodeTrace(planningInput, "pi.node.started", "planner");
    try {
      const result = await ctx.planner({ config: ctx.bailian, planningInput });
      const durationMs = Math.round(performance.now() - startedAt);
      if (result.kind === "candidate") {
        emitProviderTrace(planningInput, "provider.request.completed", {
          inputManifestSha256,
          durationMs,
          ...(result.providerMeta.httpStatus !== undefined
            ? { httpStatus: result.providerMeta.httpStatus }
            : {}),
          ...(result.providerMeta.providerRequestId !== undefined
            ? { providerRequestId: result.providerMeta.providerRequestId }
            : {}),
          tokenUsage: {
            promptTokens: result.usage.inputTokens,
            completionTokens: result.usage.outputTokens,
            totalTokens: result.usage.inputTokens + result.usage.outputTokens,
          },
        });
        emitPiNodeTrace(planningInput, "pi.node.completed", "planner", { durationMs });
        return result.candidate;
      }
      const errorCode =
        result.kind === "invalid_candidate"
          ? `model.candidate.${result.errorCode}`
          : result.errorCode;
      emitProviderTrace(planningInput, "provider.request.failed", {
        inputManifestSha256,
        durationMs,
        errorCode,
        ...(result.providerMeta.httpStatus !== undefined
          ? { httpStatus: result.providerMeta.httpStatus }
          : {}),
        ...(result.providerMeta.providerRequestId !== undefined
          ? { providerRequestId: result.providerMeta.providerRequestId }
          : {}),
      });
      emitPiNodeTrace(planningInput, "pi.node.failed", "planner", { durationMs, errorCode });
      throw new PiStepFailure(errorCode, `pi.plan失败:${errorCode}`);
    } catch (error) {
      if (error instanceof PiStepFailure) throw error;
      const code =
        error instanceof Error &&
        "code" in error &&
        error.code === "provider.pre_request.no_api_key"
          ? "provider.pre_request.no_api_key"
          : "provider.pre_request.planner_failed";
      emitProviderTrace(planningInput, "provider.request.failed", {
        durationMs: Math.round(performance.now() - startedAt),
        errorCode: code,
        preRequest: true,
      });
      emitPiNodeTrace(planningInput, "pi.node.failed", "planner", { errorCode: code });
      throw new PiStepFailure(code, `pi.plan预请求失败:${code}`);
    }
  });
}
runPiPlannerStep.maxRetries = 0;

export async function publishPlanReviewStep(input: {
  productRunId: string;
  attemptId: string;
  planningAttemptId: string;
  content: PlanContent;
}): Promise<{
  planId: string;
  planRevision: number;
  planSha256: string;
  approvalRequestId: string;
}> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "publish_plan_review", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      return await ctx.api.publishPlanReview({
        commandId: cmdId(
          "publish-plan-review",
          input.productRunId,
          hashCanonical("plan-content.v1", input.content).slice(0, 16),
        ) as never,
        productRunId: input.productRunId as never,
        attemptId: input.planningAttemptId as never,
        content: input.content,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}

/* ---------- Hook ---------- */

export async function claimDecisionHookStep(input: {
  productRunId: string;
  attemptId: string;
  planRevision: number;
  approvalRequestId: string;
}): Promise<{ token: string }> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "claim_decision_hook", async () => {
    const ctx = getWorkflowRuntimeContext();
    const token = decisionHookToken(input.productRunId, input.planRevision);
    await ctx.bindings.claimHookBinding({
      approvalRequestId: input.approvalRequestId as never,
      productRunId: input.productRunId as never,
      planRevision: input.planRevision,
      hookToken: token,
      now: ctx.now(),
    });
    ctx.trace({
      level: "info",
      eventName: "workflow.hook.waiting",
      outcome: "unknown",
      traceId: workflowRunTraceId(input.productRunId),
      spanId: workflowSpanId(),
      productRunId: input.productRunId as never,
      attemptId: input.attemptId as never,
      workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
      waitReason: "plan_approval",
    } as never);
    return { token };
  });
}

export async function loadCommittedDecisionStep(input: {
  productRunId: string;
  attemptId: string;
  decisionId: string;
  expectedPlanId: string;
  expectedPlanRevision: number;
  expectedPlanSha256: string;
}): Promise<{
  decisionId: string;
  kind: "request_revision" | "approve" | "reject";
  principalId: string;
}> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "load_committed_decision", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      const decision = await ctx.api.loadCommittedDecision({
        commandId: cmdId("load-committed-decision", input.productRunId, input.decisionId) as never,
        productRunId: input.productRunId as never,
        decisionId: input.decisionId as never,
        expectedPlanId: input.expectedPlanId as never,
        expectedPlanRevision: input.expectedPlanRevision,
        expectedPlanSha256: input.expectedPlanSha256,
      });
      ctx.trace({
        level: "info",
        eventName: "workflow.hook.resumed",
        outcome: "success",
        traceId: workflowRunTraceId(input.productRunId),
        spanId: workflowSpanId(),
        productRunId: input.productRunId as never,
        attemptId: input.attemptId as never,
        workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
        resumeAttempt: 1,
      } as never);
      return {
        decisionId: decision.decisionId,
        kind: decision.kind,
        principalId: decision.principalId,
      };
    } catch (error) {
      wrapApiError(error);
    }
  });
}

/* ---------- 执行 ---------- */

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
  stepId: string;
}): Promise<{ attemptId: string }> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "begin_execution_attempt", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      const result = await ctx.api.beginRunAttempt({
        commandId: cmdId("begin-execution-attempt", input.productRunId, input.stepId) as never,
        productRunId: input.productRunId,
        kind: "execution",
        stepId: input.stepId,
      });
      return { attemptId: result.attemptId };
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function runPiExecutorStep(input: {
  contract: ExecutionContract;
  stepId: string;
  workflowAttemptId: string;
}): Promise<ExecutorStepCandidate> {
  "use step";
  const productRunId = input.contract.productRunId;
  return runStep(productRunId, input.workflowAttemptId, "pi.execute", async () => {
    const ctx = getWorkflowRuntimeContext();
    const startedAt = performance.now();
    const manifestInput = {
      executionContractId: input.contract.executionContractId,
      approvedPlanSha256: input.contract.approvedPlanSha256,
      stepId: input.stepId,
      promptTemplateVersion: "executor-prompt.v1",
      modelConfigVersion: MODEL_CONFIG_VERSION,
    };
    const inputManifestSha256 = hashCanonical("execution-input-manifest.v1", manifestInput);
    const scoped = {
      productRunId,
      attemptId: input.workflowAttemptId,
      promptTemplateVersion: "executor-prompt.v1",
      modelConfigVersion: MODEL_CONFIG_VERSION,
    };
    emitProviderTrace(scoped, "provider.request.started", { inputManifestSha256 });
    emitPiNodeTrace(scoped, "pi.node.started", "executor");
    const result = await ctx.executor({
      config: ctx.bailian,
      contract: input.contract,
      stepId: input.stepId,
    });
    const durationMs = Math.round(performance.now() - startedAt);
    if (result.kind === "candidate") {
      emitProviderTrace(scoped, "provider.request.completed", {
        inputManifestSha256,
        durationMs,
        ...(result.providerMeta.httpStatus !== undefined
          ? { httpStatus: result.providerMeta.httpStatus }
          : {}),
        ...(result.providerMeta.providerRequestId !== undefined
          ? { providerRequestId: result.providerMeta.providerRequestId }
          : {}),
        tokenUsage: {
          promptTokens: result.usage.inputTokens,
          completionTokens: result.usage.outputTokens,
          totalTokens: result.usage.inputTokens + result.usage.outputTokens,
        },
      });
      emitPiNodeTrace(scoped, "pi.node.completed", "executor", { durationMs });
      return result.candidate;
    }
    const errorCode =
      result.kind === "invalid_candidate"
        ? `model.candidate.${result.errorCode}`
        : result.errorCode;
    emitProviderTrace(scoped, "provider.request.failed", {
      inputManifestSha256,
      durationMs,
      errorCode,
    });
    emitPiNodeTrace(scoped, "pi.node.failed", "executor", { durationMs, errorCode });
    throw new PiStepFailure(errorCode, `pi.execute失败:${errorCode}`);
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

/* ---------- 候选、验证与提交 ---------- */

export interface AssembledExecutionCandidate {
  readonly stepResults: readonly {
    stepId: string;
    output: string;
    successCriteriaEvidence: string[];
  }[];
  readonly finalOutput: {
    format: "markdown_sections";
    sections: { heading: string; body: string }[];
  };
  readonly completionCriteriaEvidence: string[];
  readonly warnings: string[];
}

export async function persistExecutionCandidateStep(input: {
  productRunId: string;
  attemptId: string;
  executionContractId: string;
  candidateAttemptId: string;
  candidate: AssembledExecutionCandidate;
}): Promise<{ executionCandidateId: string; sha256: string }> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "persist_execution_candidate", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      return await ctx.api.persistExecutionCandidate({
        commandId: cmdId(
          "persist-execution-candidate",
          input.productRunId,
          input.executionContractId,
        ) as never,
        productRunId: input.productRunId as never,
        executionContractId: input.executionContractId as never,
        attemptId: input.candidateAttemptId as never,
        stepResults: [...input.candidate.stepResults],
        finalOutput: input.candidate.finalOutput,
        completionCriteriaEvidence: input.candidate.completionCriteriaEvidence,
        warnings: input.candidate.warnings,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function validateExecutionStep(input: {
  contract: ExecutionContract;
  executionCandidateId: string;
  candidate: AssembledExecutionCandidate;
  workflowAttemptId: string;
}): Promise<{
  outcome: "pass" | "fail";
  validationResultId: string;
  failures: { code: string; detail: string }[];
}> {
  "use step";
  const productRunId = input.contract.productRunId;
  return runStep(productRunId, input.workflowAttemptId, "validate_execution", async () => {
    const ctx = getWorkflowRuntimeContext();
    const failures = validateExecutionCandidate(
      {
        executionContractId: input.contract.executionContractId,
        approvedPlanId: input.contract.approvedPlanId,
        approvedPlanRevision: input.contract.approvedPlanRevision,
        approvedPlanSha256: input.contract.approvedPlanSha256,
        steps: input.contract.steps,
        completionCriteria: input.contract.completionCriteria,
      },
      {
        executionContractId: input.contract.executionContractId,
        stepResults: input.candidate.stepResults,
        finalOutputSections: input.candidate.finalOutput.sections,
        completionCriteriaEvidence: input.candidate.completionCriteriaEvidence,
      },
    );
    try {
      const result = await ctx.api.persistValidationResult({
        commandId: cmdId(
          "persist-validation-result",
          input.contract.productRunId,
          input.executionCandidateId,
        ) as never,
        productRunId: input.contract.productRunId as never,
        executionContractId: input.contract.executionContractId as never,
        executionCandidateId: input.executionCandidateId as never,
        outcome: failures.length === 0 ? "pass" : "fail",
        failures,
      });
      return {
        outcome: failures.length === 0 ? "pass" : "fail",
        validationResultId: result.validationResultId,
        failures,
      };
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function commitExecutionResultStep(input: {
  productRunId: string;
  attemptId: string;
  executionContractId: string;
  executionCandidateId: string;
  validationResultId: string;
  renderedMarkdown: string;
  planSha256: string;
}): Promise<{ finalMessageId: string }> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "product_commit", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      const result = await ctx.api.commitExecutionResult({
        commandId: cmdId("commit-execution-result", input.productRunId, input.planSha256) as never,
        productRunId: input.productRunId as never,
        executionContractId: input.executionContractId as never,
        executionCandidateId: input.executionCandidateId as never,
        validationResultId: input.validationResultId as never,
        renderedMarkdown: input.renderedMarkdown,
      });
      return { finalMessageId: result.finalMessageId };
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function commitRejectedRunStep(input: {
  productRunId: string;
  attemptId: string;
  decisionId: string;
}): Promise<void> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "commit_rejected_run", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      await ctx.api.commitRejectedRun({
        commandId: cmdId("commit-rejected-run", input.productRunId, input.decisionId) as never,
        productRunId: input.productRunId as never,
        decisionId: input.decisionId as never,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function commitRunFailureStep(input: {
  productRunId: string;
  attemptId: string;
  errorCode: string;
  summary: string;
}): Promise<void> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "commit_run_failure", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      await ctx.api.commitRunFailure({
        commandId: cmdId("commit-run-failure", input.productRunId, input.errorCode) as never,
        productRunId: input.productRunId as never,
        errorCode: input.errorCode,
        summary: input.summary,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}

/* ---------- Trace辅助 ---------- */

interface ProviderEventScope {
  productRunId: string;
  attemptId: string;
  promptTemplateVersion: string;
  modelConfigVersion: string;
}

function emitProviderTrace(
  scope: ProviderEventScope | PlanningInputDto,
  eventName: "provider.request.started" | "provider.request.completed" | "provider.request.failed",
  details: {
    inputManifestSha256?: string;
    durationMs?: number;
    httpStatus?: number;
    providerRequestId?: string;
    tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    errorCode?: string;
    preRequest?: boolean;
  },
): void {
  const ctx = getWorkflowRuntimeContext();
  const base = {
    traceId: workflowRunTraceId(scope.productRunId),
    spanId: workflowSpanId(),
    productRunId: scope.productRunId as never,
    attemptId: scope.attemptId as never,
    promptTemplateVersion: scope.promptTemplateVersion,
    modelConfigVersion: scope.modelConfigVersion,
    provider: "bailian" as const,
    model: "qwen3.7-plus" as const,
    endpointHost: getWorkflowRuntimeContext().bailian.endpointHost,
    operation: "chat_completion" as const,
  };
  if (eventName === "provider.request.started") {
    ctx.trace({
      ...base,
      level: "info",
      eventName,
      outcome: "unknown",
      inputManifestSha256: details.inputManifestSha256 ?? sha256Hex("empty"),
    } as never);
    return;
  }
  if (eventName === "provider.request.completed") {
    ctx.trace({
      ...base,
      level: "info",
      eventName,
      outcome: "success",
      durationMs: details.durationMs ?? 0,
      httpStatus: details.httpStatus ?? 200,
      providerRequestId: details.providerRequestId ?? "unknown",
      tokenUsage: details.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      inputManifestSha256: details.inputManifestSha256 ?? sha256Hex("empty"),
    } as never);
    return;
  }
  const preRequest = details.preRequest === true;
  ctx.trace({
    ...base,
    level: "warn",
    eventName,
    outcome: "failure",
    durationMs: details.durationMs ?? 0,
    error: { code: details.errorCode ?? "provider.request_failed", type: "ProviderError" },
    ...(details.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}),
    ...(details.providerRequestId !== undefined
      ? { providerRequestId: details.providerRequestId }
      : {}),
    ...(preRequest
      ? {}
      : { inputManifestSha256: details.inputManifestSha256 ?? sha256Hex("empty") }),
  } as never);
}

function emitPiNodeTrace(
  scope: ProviderEventScope | PlanningInputDto,
  eventName: "pi.node.started" | "pi.node.completed" | "pi.node.failed",
  nodeKind: "planner" | "executor",
  details: { durationMs?: number; errorCode?: string } = {},
): void {
  const ctx = getWorkflowRuntimeContext();
  const base = {
    traceId: workflowRunTraceId(scope.productRunId),
    spanId: workflowSpanId(),
    productRunId: scope.productRunId as never,
    attemptId: scope.attemptId as never,
    promptTemplateVersion: scope.promptTemplateVersion,
    modelConfigVersion: scope.modelConfigVersion,
    nodeKind,
  };
  if (eventName === "pi.node.started") {
    ctx.trace({ ...base, level: "info", eventName, outcome: "unknown" } as never);
    return;
  }
  if (eventName === "pi.node.completed") {
    ctx.trace({
      ...base,
      level: "info",
      eventName,
      outcome: "success",
      ...(details.durationMs !== undefined ? { durationMs: details.durationMs } : {}),
    } as never);
    return;
  }
  ctx.trace({
    ...base,
    level: "warn",
    eventName,
    outcome: "failure",
    error: { code: details.errorCode ?? "pi.node_failed", type: "PiNodeError" },
    ...(details.durationMs !== undefined ? { durationMs: details.durationMs } : {}),
  } as never);
}
