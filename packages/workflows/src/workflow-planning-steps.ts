import {
  freezeMemoryBackendDescriptor,
  MemoryBackendError,
  normalizeMemoryQueryResult,
  stableMemoryBackendFailure,
} from "@chat/application";
import { computeMemoryBackendDescriptorSha256, hashCanonical } from "@chat/domain";
import type {
  BeginPlanningContextResponse,
  MemoryQueryDispatchDto,
  MemoryQueryExecutionResult,
  PlanContent,
  PlanningInputDto,
  PreparePlanningContextResponse,
} from "@chat/contracts";
import { memoryQueryExecutionResultSchema } from "@chat/contracts";
import {
  getWorkflowRuntimeContext,
  workflowRunTraceId,
  workflowSpanId,
} from "./runtime-context.js";
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

/* ---------- 规划 ---------- */

/**
 * 第一个耐久节点只让Application冻结查询意图。API Router不会越过外部
 * Memory边界；Workflow重放只会拿到同一条pending Query或已提交终态。
 */
export async function beginPlanningContextStep(input: {
  productRunId: string;
  attemptId: string;
}): Promise<BeginPlanningContextResponse> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "begin_planning_context", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      return await ctx.api.beginPlanningContext({
        commandId: cmdId("begin-planning-context", input.productRunId) as never,
        productRunId: input.productRunId as never,
        attemptId: input.attemptId as never,
        planRevision: 1,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}

function sameDescriptor(
  left: MemoryQueryDispatchDto["backendDescriptor"],
  right: MemoryQueryDispatchDto["backendDescriptor"],
): boolean {
  return (
    left.backendId === right.backendId &&
    left.displayName === right.displayName &&
    left.kind === right.kind &&
    left.adapterContractVersion === right.adapterContractVersion &&
    left.configured === right.configured &&
    left.authMode === right.authMode &&
    left.credentialRevision === right.credentialRevision &&
    left.configurationFingerprint === right.configurationFingerprint &&
    left.capabilities.query === right.capabilities.query &&
    left.capabilities.tags === right.capabilities.tags &&
    left.capabilities.maxLimit === right.capabilities.maxLimit &&
    left.capabilities.maxContextBudget === right.capabilities.maxContextBudget &&
    left.capabilities.layers.length === right.capabilities.layers.length &&
    left.capabilities.layers.every((layer, index) => layer === right.capabilities.layers[index])
  );
}

function runtimeDescriptor(query: MemoryQueryDispatchDto) {
  const backend = getWorkflowRuntimeContext().memoryBackends.get(query.backendId);
  if (backend === undefined) {
    throw new MemoryBackendError({
      code: "memory.backend.not_configured",
      message: "Workflow Runtime未配置请求的Memory后端",
      retryable: false,
    });
  }
  const descriptor = freezeMemoryBackendDescriptor(backend.describe());
  if (
    query.backendDescriptor.backendId !== query.backendId ||
    !sameDescriptor(query.backendDescriptor, descriptor) ||
    computeMemoryBackendDescriptorSha256(query.backendDescriptor) !==
      query.backendDescriptorSha256 ||
    computeMemoryBackendDescriptorSha256(descriptor) !== query.backendDescriptorSha256
  ) {
    throw new MemoryBackendError({
      code: "memory.backend.profile_changed",
      message: "Memory后端配置与冻结查询意图不一致",
      retryable: false,
    });
  }
  return backend;
}

function memoryTraceFields(query: MemoryQueryDispatchDto, attemptId: string) {
  return {
    traceId: workflowRunTraceId(query.productRunId),
    spanId: workflowSpanId(),
    productRunId: query.productRunId,
    attemptId: attemptId as never,
    contextRequestId: query.contextRequestId,
    memoryQueryId: query.memoryQueryId,
    backendId: query.backendId,
    requirement: query.requirement,
    sourceMessageSha256: query.sourceMessageSha256,
    tagCount: query.tags.length,
    layerCount: query.layers.length,
    requestedLimit: query.limit,
    contextBudget: query.contextBudget,
  };
}

function assertQueryWithinCapabilities(query: MemoryQueryDispatchDto): void {
  const capabilities = query.backendDescriptor.capabilities;
  if (
    (!capabilities.tags && query.tags.length > 0) ||
    query.layers.some((layer) => !capabilities.layers.includes(layer)) ||
    query.limit > capabilities.maxLimit ||
    query.contextBudget > capabilities.maxContextBudget
  ) {
    throw new MemoryBackendError({
      code: "memory.backend.capability_unsupported",
      message: "Memory查询超出冻结后端能力",
      retryable: false,
    });
  }
}

/**
 * 第二个耐久节点是唯一允许调用外部Memory服务的规划节点。它只返回strict
 * checkpoint结果，成功正文随Workflow checkpoint传给第三节点，Trace只保留统计与Hash。
 */
export async function queryMemoryContextStep(input: {
  attemptId: string;
  query: MemoryQueryDispatchDto;
}): Promise<MemoryQueryExecutionResult> {
  "use step";
  return runStep(input.query.productRunId, input.attemptId, "query_memory_context", async () => {
    const ctx = getWorkflowRuntimeContext();
    const startedAt = performance.now();
    const traceFields = memoryTraceFields(input.query, input.attemptId);
    ctx.trace({
      ...traceFields,
      level: "info",
      eventName: "memory.query.started",
      outcome: "unknown",
    } as never);
    try {
      const backend = runtimeDescriptor(input.query);
      assertQueryWithinCapabilities(input.query);
      const output = await backend.query({
        operationId: input.query.memoryQueryId,
        productRunId: input.query.productRunId,
        productSessionId: input.query.productSessionId,
        query: input.query.queryText,
        tags: input.query.tags,
        layers: input.query.layers,
        limit: input.query.limit,
        contextBudget: input.query.contextBudget,
      });
      const result = memoryQueryExecutionResultSchema.parse(
        normalizeMemoryQueryResult(input.query, output),
      );
      if (result.outcome !== "success") throw new Error("规范化Memory结果不是成功结果");
      ctx.trace({
        ...traceFields,
        level: "info",
        eventName: "memory.query.completed",
        outcome: "success",
        hitCount: result.hitCount,
        adoptedCount: result.sections.length,
        resultSetSha256: result.resultSetSha256,
        durationMs: Math.round(performance.now() - startedAt),
      } as never);
      return result;
    } catch (error) {
      const errorCode = stableMemoryBackendFailure(error);
      const result = memoryQueryExecutionResultSchema.parse({
        outcome: "failure",
        errorCode,
      });
      ctx.trace({
        ...traceFields,
        level: "warn",
        eventName: "memory.query.failed",
        outcome: "failure",
        error: { code: errorCode, type: "MemoryBackendError" },
        durationMs: Math.round(performance.now() - startedAt),
      } as never);
      return result;
    }
  });
}
queryMemoryContextStep.maxRetries = 0;

/** 第三个耐久节点只提交checkpoint，不读取Registry也不再次调用外部服务。 */
export async function persistPlanningContextResultStep(input: {
  productRunId: string;
  attemptId: string;
  memoryQueryId: string;
  result: MemoryQueryExecutionResult;
}): Promise<PreparePlanningContextResponse> {
  "use step";
  return runStep(
    input.productRunId,
    input.attemptId,
    "persist_planning_context_result",
    async () => {
      const ctx = getWorkflowRuntimeContext();
      try {
        return await ctx.api.persistPlanningContextResult({
          commandId: cmdId("persist-planning-context-result", input.productRunId) as never,
          productRunId: input.productRunId as never,
          attemptId: input.attemptId as never,
          memoryQueryId: input.memoryQueryId as never,
          result: input.result,
        });
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}

export async function compilePlanningInputStep(input: {
  productRunId: string;
  attemptId: string;
  planRevision: number;
  contextPackageRef?: {
    contextPackageId: string;
    revision: 1;
    sha256: string;
  };
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
        ...(input.contextPackageRef !== undefined
          ? { contextPackageRef: input.contextPackageRef as never }
          : {}),
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
    const inputManifestSha256 = planningInput.inputManifestSha256;
    if (ctx.bailian.apiKey === undefined) {
      const code = "provider.pre_request.no_api_key";
      emitProviderTrace(planningInput, "provider.request.failed", {
        durationMs: 0,
        errorCode: code,
        preRequest: true,
      });
      emitPiNodeTrace(planningInput, "pi.node.failed", "planner", { errorCode: code });
      throw new PiStepFailure(code, "pi.plan预请求失败:未配置Provider凭据");
    }
    emitPiNodeTrace(planningInput, "pi.node.started", "planner");
    try {
      const result = await ctx.planner({
        config: ctx.bailian,
        planningInput,
        onProviderRequestStart: () =>
          emitProviderTrace(planningInput, "provider.request.started", {
            inputManifestSha256,
          }),
      });
      if (result.kind === "candidate") {
        if (!emitCompletedProviderCall(planningInput, inputManifestSha256, result)) {
          const errorCode = "provider.evidence_missing";
          emitProviderTrace(planningInput, "provider.request.failed", {
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
          emitPiNodeTrace(planningInput, "pi.node.failed", "planner", {
            durationMs: result.durationMs,
            errorCode,
          });
          throw new PiStepFailure(errorCode, "pi.plan证据缺失");
        }
        emitPiNodeTrace(planningInput, "pi.node.completed", "planner", {
          durationMs: result.durationMs,
        });
        return result.candidate;
      }
      if (result.kind === "invalid_candidate") {
        if (!emitCompletedProviderCall(planningInput, inputManifestSha256, result)) {
          const errorCode = "provider.evidence_missing";
          emitProviderTrace(planningInput, "provider.request.failed", {
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
          emitPiNodeTrace(planningInput, "pi.node.failed", "planner", {
            durationMs: result.durationMs,
            errorCode,
          });
          throw new PiStepFailure(errorCode, "pi.plan证据缺失");
        }
        const errorCode = `model.candidate.${result.errorCode}`;
        emitPiNodeTrace(planningInput, "pi.node.failed", "planner", {
          durationMs: result.durationMs,
          errorCode,
          ...(result.diagnostics !== undefined ? { candidateValidation: result.diagnostics } : {}),
        });
        throw new PiStepFailure(errorCode, `pi.plan失败:${errorCode}`);
      }
      const errorCode = result.errorCode;
      emitProviderTrace(planningInput, "provider.request.failed", {
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
      emitPiNodeTrace(planningInput, "pi.node.failed", "planner", {
        durationMs: result.durationMs,
        errorCode,
      });
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
  expectedRunRevision: number;
  inputManifestSha256: string;
  content: PlanContent;
}): Promise<{
  planId: string;
  planRevision: number;
  planSha256: string;
  approvalRequestId: string;
  approvalExpiresAt: string;
}> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "publish_plan_review", async () => {
    const ctx = getWorkflowRuntimeContext();
    const candidateSha256 = hashCanonical("plan-content.v1", input.content);
    ctx.trace({
      level: "info",
      eventName: "plan.candidate.received",
      outcome: "unknown",
      traceId: workflowRunTraceId(input.productRunId),
      spanId: workflowSpanId(),
      productRunId: input.productRunId as never,
      attemptId: input.planningAttemptId as never,
      candidateSha256,
    } as never);
    try {
      return await ctx.api.publishPlanReview({
        commandId: cmdId(
          "publish-plan-review",
          input.productRunId,
          input.planningAttemptId,
          input.inputManifestSha256,
          candidateSha256,
        ) as never,
        productRunId: input.productRunId as never,
        attemptId: input.planningAttemptId as never,
        expectedRunRevision: input.expectedRunRevision,
        inputManifestSha256: input.inputManifestSha256,
        content: input.content,
      });
    } catch (error) {
      ctx.trace({
        level: "warn",
        eventName: "plan.candidate.rejected",
        outcome: "rejected",
        traceId: workflowRunTraceId(input.productRunId),
        spanId: workflowSpanId(),
        productRunId: input.productRunId as never,
        attemptId: input.planningAttemptId as never,
        candidateSha256,
        error: { code: "plan.candidate_rejected", type: "PlanCandidateError" },
      } as never);
      wrapApiError(error);
    }
  });
}
