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
  PreparePlanningMemoryContextResponse,
  PreparePlanningProjectContextResponse,
  PreparePlanningRulesContextResponse,
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
  emitPiToolTrace,
  emitProviderTrace,
  PiStepFailure,
  providerResultTraceDetails,
  runStep,
  wrapApiError,
} from "./workflow-step-support.js";

/* ---------- 规划 ---------- */

type PlanningResourceStepIdentity = {
  readonly productRunId: string;
  readonly attemptId: string;
  readonly workflowRunSpecId: string;
  readonly definitionNodeId: string;
  readonly executionPath: readonly {
    readonly containerNodeId: string;
    readonly iteration: number;
  }[];
  readonly attemptNumber: number;
};

function resourceExecutionIdentity(input: PlanningResourceStepIdentity): string {
  return [
    ...input.executionPath.map(
      (segment) => `${segment.containerNodeId}:${String(segment.iteration)}`,
    ),
    `attempt:${String(input.attemptNumber)}`,
  ].join("/");
}

/** Memory正文不返回Workflow；后续Planning合并Step只用Selection ref权威重读。 */
export async function preparePlanningMemoryContextStep(
  input: PlanningResourceStepIdentity,
): Promise<
  | { readonly status: "none" }
  | {
      readonly status: "ready";
      readonly selectionRef: Extract<
        PreparePlanningMemoryContextResponse,
        { readonly status: "ready" }
      >["selectionRef"];
    }
> {
  "use step";
  return runStep(
    input.productRunId,
    input.attemptId,
    "prepare_planning_memory_context",
    async () => {
      try {
        const prepared = await getWorkflowRuntimeContext().api.preparePlanningMemoryContext({
          commandId: cmdId(
            "prepare-planning-memory-context",
            input.productRunId,
            input.workflowRunSpecId,
            input.definitionNodeId,
            resourceExecutionIdentity(input),
          ) as never,
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
          definitionNodeId: input.definitionNodeId,
          executionPath: input.executionPath.map((segment) => ({
            containerNodeId: segment.containerNodeId as never,
            iteration: segment.iteration,
          })),
          attemptNumber: input.attemptNumber,
        });
        return prepared.status === "none"
          ? { status: "none" as const }
          : { status: "ready" as const, selectionRef: prepared.selectionRef };
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}

/** Project正文只在私有API与本Step内短暂出现；耐久checkpoint只保存不可变ref。 */
export async function preparePlanningProjectContextStep(
  input: PlanningResourceStepIdentity,
): Promise<
  | { readonly status: "none" }
  | {
      readonly status: "ready";
      readonly contextRef: Extract<
        PreparePlanningProjectContextResponse,
        { readonly status: "ready" }
      >["contextRef"];
    }
> {
  "use step";
  return runStep(
    input.productRunId,
    input.attemptId,
    "prepare_planning_project_context",
    async () => {
      try {
        const prepared = await getWorkflowRuntimeContext().api.preparePlanningProjectContext({
          commandId: cmdId(
            "prepare-planning-project-context",
            input.productRunId,
            input.workflowRunSpecId,
            input.definitionNodeId,
            resourceExecutionIdentity(input),
          ) as never,
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
          definitionNodeId: input.definitionNodeId,
          executionPath: input.executionPath.map((segment) => ({
            containerNodeId: segment.containerNodeId as never,
            iteration: segment.iteration,
          })),
          attemptNumber: input.attemptNumber,
        });
        return prepared.status === "none"
          ? { status: "none" as const }
          : { status: "ready" as const, contextRef: prepared.contextRef };
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}

/** Rule正文由Application交给compilePlanningInput；Workflow checkpoint只保留Selection ref。 */
export async function preparePlanningRulesContextStep(input: PlanningResourceStepIdentity): Promise<
  | { readonly status: "none" }
  | {
      readonly status: "ready";
      readonly selectionRef: Extract<
        PreparePlanningRulesContextResponse,
        { readonly status: "ready" }
      >["selectionRef"];
    }
> {
  "use step";
  return runStep(
    input.productRunId,
    input.attemptId,
    "prepare_planning_rules_context",
    async () => {
      try {
        const prepared = await getWorkflowRuntimeContext().api.preparePlanningRulesContext({
          commandId: cmdId(
            "prepare-planning-rules-context",
            input.productRunId,
            input.workflowRunSpecId,
            input.definitionNodeId,
            resourceExecutionIdentity(input),
          ) as never,
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
          definitionNodeId: input.definitionNodeId,
          executionPath: input.executionPath.map((segment) => ({
            containerNodeId: segment.containerNodeId as never,
            iteration: segment.iteration,
          })),
          attemptNumber: input.attemptNumber,
        });
        return prepared.status === "none"
          ? { status: "none" as const }
          : { status: "ready" as const, selectionRef: prepared.selectionRef };
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}

/**
 * 第一个耐久节点只让Application冻结查询意图。API Router不会越过外部
 * Memory边界；Workflow重放只会拿到同一条pending Query或已提交终态。
 */
async function beginPlanningContextWithinStep(input: {
  productRunId: string;
  attemptId: string;
}): Promise<BeginPlanningContextResponse> {
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
}

export async function beginPlanningContextStep(input: {
  productRunId: string;
  attemptId: string;
}): Promise<BeginPlanningContextResponse> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "begin_planning_context", () =>
    beginPlanningContextWithinStep(input),
  );
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
async function queryMemoryContextWithinStep(input: {
  attemptId: string;
  query: MemoryQueryDispatchDto;
}): Promise<MemoryQueryExecutionResult> {
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
}

export async function queryMemoryContextStep(input: {
  attemptId: string;
  query: MemoryQueryDispatchDto;
}): Promise<MemoryQueryExecutionResult> {
  "use step";
  return runStep(input.query.productRunId, input.attemptId, "query_memory_context", () =>
    queryMemoryContextWithinStep(input),
  );
}
queryMemoryContextStep.maxRetries = 0;

async function persistPlanningContextResultWithinStep(input: {
  productRunId: string;
  attemptId: string;
  memoryQueryId: string;
  result: MemoryQueryExecutionResult;
}): Promise<PreparePlanningContextResponse> {
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
}

type PlanningContextCheckpoint =
  | { readonly status: "none" | "required_failed" }
  | {
      readonly status: "ready" | "optional_failed";
      readonly contextPackageRef: Extract<
        PreparePlanningContextResponse,
        { readonly status: "ready" | "optional_failed" }
      >["contextPackageRef"];
    };

/**
 * Configurable兼容旧ContextRequest时也把查询正文限制在一个Step；Workflow只接收
 * ContextPackage ref/状态。外部调用结果未知时整段不得由SDK自动重试。
 */
export async function preparePlanningLegacyMemoryContextStep(input: {
  productRunId: string;
  attemptId: string;
}): Promise<PlanningContextCheckpoint> {
  "use step";
  return runStep(
    input.productRunId,
    input.attemptId,
    "prepare_legacy_planning_memory",
    async () => {
      const begun = await beginPlanningContextWithinStep(input);
      if (begun.status === "none" || begun.status === "required_failed") {
        return { status: begun.status };
      }
      if ("contextPackageRef" in begun) {
        return { status: begun.status, contextPackageRef: begun.contextPackageRef };
      }
      if (!("query" in begun)) throw new Error("planning.memory.begin_status_unreachable");
      const prepared = await persistPlanningContextResultWithinStep({
        ...input,
        memoryQueryId: begun.query.memoryQueryId,
        result: await queryMemoryContextWithinStep({
          attemptId: input.attemptId,
          query: begun.query,
        }),
      });
      return prepared.status === "none" || prepared.status === "required_failed"
        ? { status: prepared.status }
        : { status: prepared.status, contextPackageRef: prepared.contextPackageRef };
    },
  );
}
preparePlanningLegacyMemoryContextStep.maxRetries = 0;

/** 第三个耐久节点只提交checkpoint，不读取Registry也不再次调用外部服务。 */
export async function persistPlanningContextResultStep(input: {
  productRunId: string;
  attemptId: string;
  memoryQueryId: string;
  result: MemoryQueryExecutionResult;
}): Promise<PreparePlanningContextResponse> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "persist_planning_context_result", () =>
    persistPlanningContextResultWithinStep(input),
  );
}

interface PlanningGenerationStepInput {
  productRunId: string;
  attemptId: string;
  planRevision: number;
  contextPackageRef?: {
    contextPackageId: string;
    revision: 1;
    sha256: string;
  };
  planningMemorySelectionRef?: {
    planningMemorySelectionId: string;
    revision: 1;
    sha256: string;
  };
  planningProjectContextRef?: {
    planningProjectContextId: string;
    revision: 1;
    sha256: string;
  };
  ruleSelectionRef?: {
    ruleSelectionId: string;
    revision: 1;
    sha256: string;
  };
  /** Configurable Runner冻结的候选步骤上限；旧Runner可缺省以保持历史行为。 */
  maxSteps?: number;
}

async function compilePlanningInputWithinStep(
  input: PlanningGenerationStepInput,
): Promise<PlanningInputDto> {
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
      ...(input.planningMemorySelectionRef !== undefined
        ? { planningMemorySelectionRef: input.planningMemorySelectionRef as never }
        : {}),
      ...(input.planningProjectContextRef !== undefined
        ? { planningProjectContextRef: input.planningProjectContextRef as never }
        : {}),
      ...(input.ruleSelectionRef !== undefined
        ? { ruleSelectionRef: input.ruleSelectionRef as never }
        : {}),
    });
  } catch (error) {
    wrapApiError(error);
  }
}

export async function compilePlanningInputStep(
  input: PlanningGenerationStepInput,
): Promise<PlanningInputDto> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "compile_planning_input", () =>
    compilePlanningInputWithinStep(input),
  );
}

export async function runPiPlannerStep(planningInput: PlanningInputDto): Promise<PlanContent> {
  "use step";
  const productRunId = planningInput.productRunId;
  const attemptId = planningInput.attemptId;
  return runStep(productRunId, attemptId, "pi.plan", () => runPlannerWithinStep(planningInput));
}

async function runPlannerWithinStep(planningInput: PlanningInputDto): Promise<PlanContent> {
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
      onAgentActivity: (activity) => emitPiToolTrace(planningInput, "planner", activity),
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
      error instanceof Error && "code" in error && error.code === "provider.pre_request.no_api_key"
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
}
runPiPlannerStep.maxRetries = 0;

interface PublishPlanWithinStepInput {
  productRunId: string;
  attemptId: string;
  planningAttemptId: string;
  expectedRunRevision: number;
  inputManifestSha256: string;
  content: PlanContent;
  stablePlanRevision?: number;
}

export interface PlanReviewCheckpointRef {
  planId: string;
  planRevision: number;
  planSha256: string;
  approvalRequestId: string;
  approvalExpiresAt: string;
}

async function publishPlanReviewWithinStep(
  input: PublishPlanWithinStepInput,
): Promise<PlanReviewCheckpointRef> {
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
        input.stablePlanRevision === undefined ? candidateSha256 : String(input.stablePlanRevision),
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
}

export async function publishPlanReviewStep(
  input: PublishPlanWithinStepInput,
): Promise<PlanReviewCheckpointRef> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "publish_plan_review", () =>
    publishPlanReviewWithinStep(input),
  );
}

/**
 * Configurable Planning把正文加载、pi与候选提交封入一个Step；Workflow只checkpoint
 * Plan/Approval引用。maxRetries=0阻止Provider结果未知时再次付费。
 */
export async function generateAndPublishPlanStep(
  input: PlanningGenerationStepInput,
): Promise<
  | { readonly status: "published"; readonly review: PlanReviewCheckpointRef }
  | { readonly status: "failed"; readonly errorCode: string }
> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "generate_publish_plan", async () => {
    const planningInput = await compilePlanningInputWithinStep(input);
    let content: PlanContent;
    try {
      content = await runPlannerWithinStep(planningInput);
    } catch (error) {
      if (error instanceof PiStepFailure) {
        return { status: "failed", errorCode: error.stableCode };
      }
      throw error;
    }
    if (
      input.maxSteps !== undefined &&
      (!Number.isInteger(input.maxSteps) ||
        input.maxSteps < 1 ||
        content.steps.length > input.maxSteps)
    ) {
      return { status: "failed", errorCode: "model.candidate.capability_violation" };
    }
    return {
      status: "published",
      review: await publishPlanReviewWithinStep({
        productRunId: input.productRunId,
        attemptId: input.attemptId,
        planningAttemptId: planningInput.attemptId,
        expectedRunRevision: planningInput.inputRunRevision,
        inputManifestSha256: planningInput.inputManifestSha256,
        content,
        stablePlanRevision: input.planRevision,
      }),
    };
  });
}
generateAndPublishPlanStep.maxRetries = 0;
