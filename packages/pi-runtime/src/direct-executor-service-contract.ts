import {
  DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
  DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
  DIRECT_AGENT_TOKEN_BUDGET,
  directAgentCandidateIdSchema,
  messageIdSchema,
  productRunIdSchema,
  promptReviewDecisionIdSchema,
  promptReviewRequestIdSchema,
  runAttemptIdSchema,
  sha256Schema,
  workflowRunSpecIdSchema,
  resolvedCapabilitySnapshotSchema,
} from "@chat/contracts";
import { z } from "zod";
import { piOperationIdSchema, piRuntimeSessionIdSchema } from "./executor-service-contract.js";

/** Direct Agent是独立私有协议，不借用已批准Plan的Execution Contract。 */
export const LEGACY_PI_DIRECT_EXECUTOR_PROTOCOL_VERSION = "pi-direct-executor.v1";
export const PI_DIRECT_EXECUTOR_PROTOCOL_VERSION = "pi-direct-executor.v2";

const isoDateTimeSchema = z.iso.datetime();
const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u)
  .max(80);
/** Direct Agent可选择Pi Extension/Chat Adapter注册的Tool，不能把Journal合同锁死为内置7个。 */
export const directAgentRuntimeToolNameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u);
export const directAgentLimitsSchema = z
  .object({
    maxProviderRequests: z.literal(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
    activeTimeoutMs: z.literal(DIRECT_AGENT_ACTIVE_TIMEOUT_MS),
    tokenBudget: z.literal(DIRECT_AGENT_TOKEN_BUDGET),
  })
  .strict();

export const authorizedDirectAgentProfileSchema = z
  .object({
    runRevision: z.number().int().positive(),
    sourceMessageId: messageIdSchema,
    sourceMessageSha256: sha256Schema,
    capabilityMode: z.enum(["pi_cli_default", "custom", "read_only", "project_bootstrap"]),
    limits: directAgentLimitsSchema,
  })
  .strict();

export type AuthorizedDirectAgentProfile = z.infer<typeof authorizedDirectAgentProfileSchema>;

/**
 * 请求只保存产品引用、Hash与预算。用户正文由Application授权回调加载，绝不写入
 * Executor Operation文件、事件或Workflow checkpoint。
 */
export const startPiDirectExecutorOperationRequestSchema = z
  .object({
    schemaVersion: z.literal(PI_DIRECT_EXECUTOR_PROTOCOL_VERSION),
    operationId: piOperationIdSchema,
    productRunId: productRunIdSchema,
    directAgentAttemptId: runAttemptIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    workflowRunSpecSha256: sha256Schema,
    inputManifestSha256: sha256Schema,
  })
  .strict();

/** v1仅供历史Journal读取/投影；新Service入口永远只接受v2。 */
export const legacyStartPiDirectExecutorOperationRequestSchema =
  startPiDirectExecutorOperationRequestSchema.extend({
    schemaVersion: z.literal(LEGACY_PI_DIRECT_EXECUTOR_PROTOCOL_VERSION),
  });

export type StartPiDirectExecutorOperationRequest = z.infer<
  typeof startPiDirectExecutorOperationRequestSchema
>;

export const directPromptReviewCheckpointSchema = z
  .object({
    fileName: z
      .string()
      .regex(/^[A-Za-z0-9._-]+\.jsonl$/u)
      .max(240),
    fileSha256: sha256Schema,
    sessionId: piRuntimeSessionIdSchema,
    leafId: z.string().min(1).max(160),
  })
  .strict();

export type DirectPromptReviewCheckpoint = z.infer<typeof directPromptReviewCheckpointSchema>;

export const directPromptReviewRefSchema = z
  .object({
    promptReviewRequestId: promptReviewRequestIdSchema,
    requestRevision: z.number().int().positive(),
    revision: z.number().int().positive(),
    requestIndex: z.number().int().positive().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
    payloadSha256: sha256Schema,
    reviewSha256: sha256Schema,
  })
  .strict();

export type DirectPromptReviewRef = z.infer<typeof directPromptReviewRefSchema>;

export const directPromptReviewDecisionRefSchema = z
  .object({
    promptReviewDecisionId: promptReviewDecisionIdSchema,
    revision: z.literal(1),
    decisionSha256: sha256Schema,
    kind: z.enum(["approve", "reject"]),
  })
  .strict();

export type DirectPromptReviewDecisionRef = z.infer<typeof directPromptReviewDecisionRefSchema>;

export const submitDirectPromptReviewDecisionRequestSchema = z
  .object({
    schemaVersion: z.literal(PI_DIRECT_EXECUTOR_PROTOCOL_VERSION),
    promptReviewRequestId: promptReviewRequestIdSchema,
    requestRevision: z.number().int().positive(),
    reviewSha256: sha256Schema,
    payloadSha256: sha256Schema,
    promptReviewDecisionId: promptReviewDecisionIdSchema,
  })
  .strict();

export type SubmitDirectPromptReviewDecisionRequest = z.infer<
  typeof submitDirectPromptReviewDecisionRequestSchema
>;

export const directAgentResultRefSchema = z
  .object({
    directAgentCandidateId: directAgentCandidateIdSchema,
    sha256: sha256Schema,
  })
  .strict();

export type DirectAgentResultRef = z.infer<typeof directAgentResultRefSchema>;

export const piDirectExecutorOperationStatusSchema = z.enum([
  "queued",
  "running",
  "preparing_prompt_review",
  "waiting_prompt_review",
  "dispatching",
  "succeeded",
  "cancelled",
  "failed",
  "outcome_unknown",
]);

export type PiDirectExecutorOperationStatus = z.infer<typeof piDirectExecutorOperationStatusSchema>;

/**
 * v2 Journal携带Manifest Hash的完整、可重算非正文输入。Capability数组单独冻结，避免
 * 重复保存；schemaVersion只标识投影代际，不改变Runtime既有Hash算法。
 */
export const directResolvedRuntimeManifestHashInputSchema = z
  .object({
    schemaVersion: z.literal("pi-direct-resolved-runtime-manifest.v1"),
    systemPromptSha256: sha256Schema,
    resourceInventorySha256: sha256Schema,
  })
  .strict();

export type DirectResolvedRuntimeManifestHashInput = z.infer<
  typeof directResolvedRuntimeManifestHashInputSchema
>;

const eventBase = {
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timestamp: isoDateTimeSchema,
  operationId: piOperationIdSchema,
};

/** Direct Journal只保存引用、Hash和计数，不保存Prompt、消息或工具结果正文。 */
export const piDirectExecutorEventSchema = z.discriminatedUnion("type", [
  z
    .object({ ...eventBase, type: z.literal("operation.accepted"), requestSha256: sha256Schema })
    .strict(),
  z
    .object({ ...eventBase, type: z.literal("operation.started"), requestSha256: sha256Schema })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("session.started"),
      sessionId: piRuntimeSessionIdSchema,
      enabledTools: z.array(directAgentRuntimeToolNameSchema).max(32),
      /** 协议Schema与v1事件共用；v2 Journal Validator要求session事件显式携带。 */
      resolvedRuntimeManifestSha256: sha256Schema.optional(),
      resolvedRuntimeManifest: directResolvedRuntimeManifestHashInputSchema.optional(),
      resolvedCapabilities: z.array(resolvedCapabilitySnapshotSchema).max(64).optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("session.resumed"),
      sessionId: piRuntimeSessionIdSchema,
      checkpointSha256: sha256Schema,
      /** v1只读事件可缺失；v2恢复事件必须携带完整Manifest身份。 */
      enabledTools: z.array(directAgentRuntimeToolNameSchema).max(32).optional(),
      resolvedRuntimeManifestSha256: sha256Schema.optional(),
      resolvedRuntimeManifest: directResolvedRuntimeManifestHashInputSchema.optional(),
      resolvedCapabilities: z.array(resolvedCapabilitySnapshotSchema).max(64).optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("prompt_review.preparing"),
      requestIndex: z.number().int().positive().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
      payloadSha256: sha256Schema,
      payloadEnvelopeSha256: sha256Schema,
      checkpointSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("prompt_review.waiting"),
      review: directPromptReviewRefSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("prompt_review.decided"),
      review: directPromptReviewRefSchema,
      decision: directPromptReviewDecisionRefSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("provider.started"),
      requestIndex: z.number().int().positive().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
      payloadSha256: sha256Schema,
      endpointHost: z.string().min(1).max(253),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("provider.completed"),
      requestIndex: z.number().int().positive().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
      payloadSha256: sha256Schema,
      completionTokens: z.number().int().nonnegative().max(100_000_000),
      stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("tool.intent_persisted"),
      sessionId: piRuntimeSessionIdSchema,
      toolCallId: z.string().min(1).max(160),
      toolName: directAgentRuntimeToolNameSchema,
      inputSha256: sha256Schema,
      inputDisplay: z.string().max(32_000).optional(),
      inputDisplayTruncated: z.boolean().optional(),
      capability: resolvedCapabilitySnapshotSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.enum(["tool.completed", "tool.failed", "tool.blocked", "tool.outcome_unknown"]),
      sessionId: piRuntimeSessionIdSchema,
      toolCallId: z.string().min(1).max(160),
      toolName: directAgentRuntimeToolNameSchema,
      /** v1历史Result可缺失；v2新Journal由共享Validator强制与Intent一致。 */
      inputSha256: sha256Schema.optional(),
      resultSha256: sha256Schema.optional(),
      capability: resolvedCapabilitySnapshotSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("operation.completed"),
      result: directAgentResultRefSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("operation.cancelled"),
      errorCode: stableErrorCodeSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("operation.failed"),
      errorCode: stableErrorCodeSchema,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("operation.outcome_unknown"),
      errorCode: stableErrorCodeSchema,
    })
    .strict(),
]);

export type PiDirectExecutorEvent = z.infer<typeof piDirectExecutorEventSchema>;

export const piDirectExecutorOperationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PI_DIRECT_EXECUTOR_PROTOCOL_VERSION),
    operationId: piOperationIdSchema,
    requestSha256: sha256Schema,
    status: piDirectExecutorOperationStatusSchema,
    sessionId: piRuntimeSessionIdSchema.optional(),
    activeReview: directPromptReviewRefSchema.optional(),
    decision: directPromptReviewDecisionRefSchema.optional(),
    result: directAgentResultRefSchema.optional(),
    errorCode: stableErrorCodeSchema.optional(),
    resolvedRuntimeManifestSha256: sha256Schema.optional(),
    resolvedRuntimeManifest: directResolvedRuntimeManifestHashInputSchema.optional(),
    resolvedCapabilities: z.array(resolvedCapabilitySnapshotSchema).max(64).optional(),
    lastEventSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type PiDirectExecutorOperationSnapshot = z.infer<
  typeof piDirectExecutorOperationSnapshotSchema
>;

export const piDirectExecutorEventsResponseSchema = z
  .object({
    schemaVersion: z.literal(PI_DIRECT_EXECUTOR_PROTOCOL_VERSION),
    operationId: piOperationIdSchema,
    events: z.array(piDirectExecutorEventSchema).max(10_000),
    lastEventSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
