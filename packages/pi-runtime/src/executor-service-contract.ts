import {
  executionContextItemDtoSchema,
  executionContractSchema,
  runAttemptIdSchema,
  sha256Schema,
  stepResultSchema,
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
 * Executor Journal事件永远不存prompt、消息、tool参数或tool结果正文。
 * 正文只存在于受限Operation请求/结果和Pi自己的Session JSONL；事件只保留Hash与统计。
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
      inputSha256: sha256Schema,
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
      inputSha256: sha256Schema,
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
      resultSha256: sha256Schema,
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
      resultSha256: sha256Schema,
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
      inputSha256: sha256Schema,
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
      errorCode: z.literal("executor.operation_interrupted"),
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
    operationId: piOperationIdSchema,
    requestSha256: sha256Schema,
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
