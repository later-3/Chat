import {
  executionContextItemDtoSchema,
  executionContractSchema,
  runAttemptIdSchema,
  sha256Schema,
  stepResultSchema,
  workflowNodePromptRuntimeSchema,
} from "@chat/contracts";
import { z } from "zod";
import { executorStepCandidateSchema } from "./executor.js";

/** Chat私有Pi Executor协议；它不是浏览器API，也不是Product Store事实。 */
export const PI_EXECUTOR_PROTOCOL_VERSION = "pi-executor.v1";
export const PI_EXECUTOR_RUNTIME_HEADER = "x-chat-runtime-key";

export const piOperationIdSchema = z.string().regex(/^pio_[A-Za-z0-9]+$/u);
export const piRuntimeSessionIdSchema = z
  .string()
  .regex(/^pis_[A-Za-z0-9-]+$/u)
  .max(128);
const isoDateTimeSchema = z.iso.datetime();
const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u)
  .max(80);
const observableDisplaySchema = z.string().max(32_000);
const endpointHostSchema = z
  .string()
  .regex(
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u,
  );

export const piToolNameSchema = z.enum(["read", "grep", "find", "ls", "edit", "write", "bash"]);
export type PiToolName = z.infer<typeof piToolNameSchema>;

/** 依赖正文携带完整已持久Step Result证明，服务端可重算sha256而不是盲信Workflow正文。 */
const dependencyResultSchema = stepResultSchema;

/**
 * Operation ID由executionAttemptId确定性派生；服务端用requestSha256实现幂等冲突门。
 * API Key、canonical workspace path和Runtime Credential都不进入请求正文。
 */
export const startPiExecutorOperationRequestSchema = z
  .object({
    schemaVersion: z.literal(PI_EXECUTOR_PROTOCOL_VERSION),
    operationId: piOperationIdSchema,
    executionAttemptId: runAttemptIdSchema,
    inputManifestSha256: sha256Schema,
    contract: executionContractSchema,
    stepId: z.string().min(1).max(100),
    contextItems: z.array(executionContextItemDtoSchema).max(50),
    dependencyResults: z.array(dependencyResultSchema).max(50),
    nodePrompt: workflowNodePromptRuntimeSchema.optional(),
  })
  .strict();

export type StartPiExecutorOperationRequest = z.infer<typeof startPiExecutorOperationRequestSchema>;

const usageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative().max(100_000_000),
    completionTokens: z.number().int().nonnegative().max(100_000_000),
    totalTokens: z.number().int().nonnegative().max(100_000_000),
  })
  .strict();

const eventBase = {
  sequence: sequenceSchema,
  timestamp: isoDateTimeSchema,
};

const operationIdentity = {
  operationId: piOperationIdSchema,
};

/**
 * Executor Journal不存Prompt、Provider Payload或隐藏推理。工具输入/结果和可见
 * Assistant文本作为用户要求的执行证据，只经有界、密钥脱敏的display字段进入。
 */
export const piExecutorEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("operation.accepted"),
      requestSha256: sha256Schema,
      workspaceRootId: z
        .string()
        .regex(/^root_[A-Za-z0-9]+$/u)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("operation.started"),
      requestSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("session.started"),
      sessionId: piRuntimeSessionIdSchema,
      enabledTools: z.array(piToolNameSchema).max(7),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("turn.started"),
      sessionId: piRuntimeSessionIdSchema,
      turnIndex: z.number().int().nonnegative().max(1000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("turn.completed"),
      sessionId: piRuntimeSessionIdSchema,
      turnIndex: z.number().int().nonnegative().max(1000),
      durationMs: z.number().nonnegative().max(3_600_000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("provider.started"),
      sessionId: piRuntimeSessionIdSchema,
      requestIndex: z.number().int().positive().max(1000),
      endpointHost: endpointHostSchema,
      inputSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("tool.blocked"),
      sessionId: piRuntimeSessionIdSchema,
      turnIndex: z.number().int().nonnegative().max(1000),
      toolCallId: z.string().min(1).max(160),
      toolName: piToolNameSchema,
      capabilityId: z.string().min(8).max(240).optional(),
      capabilityRefSha256: sha256Schema.optional(),
      inputSha256: sha256Schema,
      inputDisplay: observableDisplaySchema,
      inputDisplayTruncated: z.boolean(),
      errorCode: stableErrorCodeSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("provider.completed"),
      sessionId: piRuntimeSessionIdSchema,
      requestIndex: z.number().int().positive().max(1000),
      endpointHost: endpointHostSchema,
      inputSha256: sha256Schema,
      httpStatus: z.number().int().min(100).max(599),
      providerRequestId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      usage: usageSchema,
      stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]),
      toolCallCount: z.number().int().nonnegative().max(64),
      durationMs: z.number().nonnegative().max(3_600_000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("provider.failed"),
      sessionId: piRuntimeSessionIdSchema,
      requestIndex: z.number().int().positive().max(1000),
      endpointHost: endpointHostSchema,
      inputSha256: sha256Schema.optional(),
      httpStatus: z.number().int().min(100).max(599).optional(),
      providerRequestId: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{1,128}$/u)
        .optional(),
      errorCode: stableErrorCodeSchema,
      durationMs: z.number().nonnegative().max(3_600_000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("message.completed"),
      sessionId: piRuntimeSessionIdSchema,
      messageIndex: z.number().int().nonnegative().max(100_000),
      role: z.enum(["user", "assistant", "toolResult", "custom"]),
      contentSha256: sha256Schema,
      /** 新Operation用于把最终Candidate正文绑定到耐久Assistant证据；旧v1可缺省。 */
      visibleTextSha256: sha256Schema.optional(),
      visibleText: observableDisplaySchema.optional(),
      visibleTextTruncated: z.boolean().optional(),
      stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]).optional(),
      usage: usageSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("tool.intent_persisted"),
      sessionId: piRuntimeSessionIdSchema,
      turnIndex: z.number().int().nonnegative().max(1000),
      toolCallId: z.string().min(1).max(160),
      toolName: piToolNameSchema,
      capabilityId: z.string().min(8).max(240).optional(),
      capabilityRefSha256: sha256Schema.optional(),
      inputSha256: sha256Schema,
      inputDisplay: observableDisplaySchema,
      inputDisplayTruncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("tool.completed"),
      sessionId: piRuntimeSessionIdSchema,
      turnIndex: z.number().int().nonnegative().max(1000),
      toolCallId: z.string().min(1).max(160),
      toolName: piToolNameSchema,
      capabilityId: z.string().min(8).max(240).optional(),
      capabilityRefSha256: sha256Schema.optional(),
      // v1早期已落盘Result没有复制Intent Hash；读取继续兼容，但Store拒绝新追加缺失/不匹配值。
      inputSha256: sha256Schema.optional(),
      resultSha256: sha256Schema,
      resultDisplay: observableDisplaySchema,
      resultDisplayTruncated: z.boolean(),
      durationMs: z.number().nonnegative().max(3_600_000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("tool.failed"),
      sessionId: piRuntimeSessionIdSchema,
      turnIndex: z.number().int().nonnegative().max(1000),
      toolCallId: z.string().min(1).max(160),
      toolName: piToolNameSchema,
      capabilityId: z.string().min(8).max(240).optional(),
      capabilityRefSha256: sha256Schema.optional(),
      // v1早期已落盘Result没有复制Intent Hash；读取继续兼容，但Store拒绝新追加缺失/不匹配值。
      inputSha256: sha256Schema.optional(),
      resultSha256: sha256Schema,
      resultDisplay: observableDisplaySchema,
      resultDisplayTruncated: z.boolean(),
      errorCode: stableErrorCodeSchema,
      durationMs: z.number().nonnegative().max(3_600_000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("tool.outcome_unknown"),
      sessionId: piRuntimeSessionIdSchema,
      turnIndex: z.number().int().nonnegative().max(1000),
      toolCallId: z.string().min(1).max(160),
      toolName: piToolNameSchema,
      capabilityId: z.string().min(8).max(240).optional(),
      capabilityRefSha256: sha256Schema.optional(),
      inputSha256: sha256Schema,
      inputDisplay: observableDisplaySchema,
      inputDisplayTruncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("compaction.started"),
      sessionId: piRuntimeSessionIdSchema,
      reason: z.enum(["manual", "threshold", "overflow"]),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("compaction.completed"),
      sessionId: piRuntimeSessionIdSchema,
      reason: z.enum(["manual", "threshold", "overflow"]),
      aborted: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("session.settled"),
      sessionId: piRuntimeSessionIdSchema,
      turnCount: z.number().int().nonnegative().max(1000),
      providerRequestCount: z.number().int().nonnegative().max(1000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("operation.completed"),
      requestSha256: sha256Schema,
      resultSha256: sha256Schema,
      durationMs: z
        .number()
        .nonnegative()
        .max(24 * 3_600_000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("operation.failed"),
      requestSha256: sha256Schema,
      errorCode: stableErrorCodeSchema,
      durationMs: z
        .number()
        .nonnegative()
        .max(24 * 3_600_000),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      ...operationIdentity,
      type: z.literal("operation.outcome_unknown"),
      requestSha256: sha256Schema,
      // 重启中断与已执行Tool结果未落盘都属于“无法证明未发生副作用”，
      // 由稳定错误码区分来源，但统一保持outcome_unknown而非普通failed。
      errorCode: stableErrorCodeSchema,
      durationMs: z
        .number()
        .nonnegative()
        .max(24 * 3_600_000),
    })
    .strict(),
]);

export type PiExecutorEvent = z.infer<typeof piExecutorEventSchema>;

export const piExecutorOperationStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "outcome_unknown",
]);
export type PiExecutorOperationStatus = z.infer<typeof piExecutorOperationStatusSchema>;

export const piExecutorOperationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PI_EXECUTOR_PROTOCOL_VERSION),
    /** 缺省表示只读兼容旧v1；新Operation必须使用完整状态机证据。 */
    integrityVersion: z.enum(["full-operation.v2", "full-operation.v3"]).optional(),
    operationId: piOperationIdSchema,
    requestSha256: sha256Schema,
    /** v2私有响应携带完整耐久请求，Client据此重算Hash；旧v1快照可缺省。 */
    request: startPiExecutorOperationRequestSchema.optional(),
    status: piExecutorOperationStatusSchema,
    sessionId: piRuntimeSessionIdSchema.optional(),
    lastEventSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    result: executorStepCandidateSchema.optional(),
    resultSha256: sha256Schema.optional(),
    errorCode: stableErrorCodeSchema.optional(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type PiExecutorOperationSnapshot = z.infer<typeof piExecutorOperationSnapshotSchema>;

export const piExecutorEventsResponseSchema = z
  .object({
    schemaVersion: z.literal(PI_EXECUTOR_PROTOCOL_VERSION),
    operationId: piOperationIdSchema,
    events: z.array(piExecutorEventSchema).max(10_000),
    lastEventSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type PiExecutorEventsResponse = z.infer<typeof piExecutorEventsResponseSchema>;
