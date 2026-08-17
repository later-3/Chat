import { FatalError, getStepMetadata } from "workflow";
import { sha256Hex } from "@chat/domain";
import { WORKFLOW_DEFINITION_VERSION, type PlanningInputDto } from "@chat/contracts";
import type {
  CandidateValidationDiagnostics,
  PiAgentActivityEvent,
  ProviderCallMeta,
} from "@chat/pi-runtime";
import { ApiClientError } from "./api-client.js";
import { PiStepFailure } from "./workflow-error.js";
import {
  getWorkflowRuntimeContext,
  workflowRunTraceId,
  workflowSpanId,
} from "./runtime-context.js";

/** Workflow Step共享的幂等身份、错误语义与无正文Trace。 */
export function cmdId(...parts: string[]): string {
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
  const { attempt: stepAttempt } = getStepMetadata();
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
    stepAttempt,
    replay: false,
    ...(input.eventName === "workflow.step.failed"
      ? { error: { code: input.errorCode ?? "step.failed", type: "StepError" } }
      : {}),
  } as never);
}

export async function runStep<T>(
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

export function wrapApiError(error: unknown): never {
  if (error instanceof ApiClientError && error.retryable) throw error;
  if (error instanceof ApiClientError) throw new FatalError(error.message);
  throw error;
}

export { PiStepFailure };

export interface ProviderEventScope {
  productRunId: string;
  attemptId: string;
  promptTemplateVersion: string;
  modelConfigVersion: string;
}

export function providerResultTraceDetails(meta: ProviderCallMeta): {
  readonly providerStopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  readonly toolCallCount?: number;
} {
  return {
    ...(meta.providerStopReason !== undefined
      ? { providerStopReason: meta.providerStopReason }
      : {}),
    ...(meta.toolCallCount !== undefined ? { toolCallCount: meta.toolCallCount } : {}),
  };
}

interface CompletedProviderEvidence {
  readonly httpStatus: number;
  readonly providerRequestId: string;
  readonly tokenUsage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export function completedProviderEvidence(result: {
  readonly providerCallCount: number;
  readonly providerMeta: { readonly httpStatus?: number; readonly providerRequestId?: string };
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}): CompletedProviderEvidence | undefined {
  const httpStatus = result.providerMeta.httpStatus;
  const providerRequestId = result.providerMeta.providerRequestId;
  if (result.usage === undefined) return undefined;
  const { inputTokens, outputTokens } = result.usage;
  if (
    result.providerCallCount !== 1 ||
    httpStatus === undefined ||
    httpStatus < 200 ||
    httpStatus >= 300 ||
    providerRequestId === undefined ||
    !/^[A-Za-z0-9-]{1,128}$/.test(providerRequestId) ||
    !Number.isInteger(inputTokens) ||
    inputTokens <= 0 ||
    !Number.isInteger(outputTokens) ||
    outputTokens <= 0
  ) {
    return undefined;
  }
  return {
    httpStatus,
    providerRequestId,
    tokenUsage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

export function emitCompletedProviderCall(
  scope: ProviderEventScope | PlanningInputDto,
  inputManifestSha256: string,
  result: Parameters<typeof completedProviderEvidence>[0] & {
    readonly durationMs: number;
    readonly providerMeta: ProviderCallMeta;
  },
): boolean {
  const evidence = completedProviderEvidence(result);
  if (evidence === undefined) return false;
  emitProviderTrace(scope, "provider.request.completed", {
    inputManifestSha256,
    durationMs: result.durationMs,
    httpStatus: evidence.httpStatus,
    providerRequestId: evidence.providerRequestId,
    tokenUsage: evidence.tokenUsage,
    ...providerResultTraceDetails(result.providerMeta),
  });
  return true;
}

export function emitProviderTrace(
  scope: ProviderEventScope | PlanningInputDto,
  eventName: "provider.request.started" | "provider.request.completed" | "provider.request.failed",
  details: {
    inputManifestSha256?: string;
    durationMs?: number;
    httpStatus?: number;
    providerRequestId?: string;
    tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    providerStopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
    toolCallCount?: number;
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
    endpointHost: ctx.bailian.endpointHost,
    operation: "chat_completion" as const,
  };
  if (eventName === "provider.request.started") {
    if (details.inputManifestSha256 === undefined) {
      throw new Error("provider.request.started缺少inputManifestSha256");
    }
    ctx.trace({
      ...base,
      level: "info",
      eventName,
      outcome: "unknown",
      inputManifestSha256: details.inputManifestSha256,
    } as never);
    return;
  }
  if (eventName === "provider.request.completed") {
    if (
      details.inputManifestSha256 === undefined ||
      details.durationMs === undefined ||
      details.httpStatus === undefined ||
      details.providerRequestId === undefined ||
      details.tokenUsage === undefined
    ) {
      throw new Error("provider.request.completed缺少真实Provider证据");
    }
    ctx.trace({
      ...base,
      level: "info",
      eventName,
      outcome: "success",
      durationMs: details.durationMs,
      httpStatus: details.httpStatus,
      providerRequestId: details.providerRequestId,
      tokenUsage: details.tokenUsage,
      inputManifestSha256: details.inputManifestSha256,
      ...(details.providerStopReason !== undefined
        ? { providerStopReason: details.providerStopReason }
        : {}),
      ...(details.toolCallCount !== undefined ? { toolCallCount: details.toolCallCount } : {}),
    } as never);
    return;
  }
  const preRequest = details.preRequest === true;
  if (
    details.durationMs === undefined ||
    details.errorCode === undefined ||
    (!preRequest && details.inputManifestSha256 === undefined)
  ) {
    throw new Error("provider.request.failed缺少实际失败证据");
  }
  ctx.trace({
    ...base,
    level: "warn",
    eventName,
    outcome: "failure",
    durationMs: details.durationMs,
    error: { code: details.errorCode, type: "ProviderError" },
    ...(details.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}),
    ...(details.providerRequestId !== undefined
      ? { providerRequestId: details.providerRequestId }
      : {}),
    ...(preRequest ? {} : { inputManifestSha256: details.inputManifestSha256 }),
    ...(details.providerStopReason !== undefined
      ? { providerStopReason: details.providerStopReason }
      : {}),
    ...(details.toolCallCount !== undefined ? { toolCallCount: details.toolCallCount } : {}),
  } as never);
}

export function emitPiNodeTrace(
  scope: ProviderEventScope | PlanningInputDto,
  eventName: "pi.node.started" | "pi.node.completed" | "pi.node.failed",
  nodeKind: "planner" | "executor" | "note_capture",
  details: {
    durationMs?: number;
    errorCode?: string;
    candidateValidation?: CandidateValidationDiagnostics;
  } = {},
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
    ...(details.candidateValidation !== undefined
      ? { candidateValidation: details.candidateValidation }
      : {}),
    ...(details.durationMs !== undefined ? { durationMs: details.durationMs } : {}),
  } as never);
}

/** pi原生工具生命周期进入Chat Trace的唯一接缝；正文已在pi-runtime边界裁掉。 */
export function emitPiToolTrace(
  scope: ProviderEventScope | PlanningInputDto,
  nodeKind: "planner" | "executor" | "note_capture",
  activity: PiAgentActivityEvent,
): void {
  const eventName =
    activity.kind === "tool.started"
      ? "pi.tool.started"
      : activity.kind === "tool.completed"
        ? "pi.tool.completed"
        : "pi.tool.failed";
  getWorkflowRuntimeContext().trace({
    traceId: workflowRunTraceId(scope.productRunId),
    spanId: workflowSpanId(),
    productRunId: scope.productRunId as never,
    attemptId: scope.attemptId as never,
    promptTemplateVersion: scope.promptTemplateVersion,
    modelConfigVersion: scope.modelConfigVersion,
    nodeKind,
    toolActivityId: activity.toolActivityId,
    toolName: activity.toolName,
    level: activity.kind === "tool.failed" ? "warn" : "info",
    eventName,
    outcome:
      activity.kind === "tool.started"
        ? "unknown"
        : activity.kind === "tool.completed"
          ? "success"
          : "failure",
    ...(activity.kind === "tool.started" ? {} : { durationMs: activity.durationMs }),
    ...(activity.kind === "tool.failed"
      ? { error: { code: "pi.tool_failed", type: "PiToolError" } }
      : {}),
  } as never);
}
