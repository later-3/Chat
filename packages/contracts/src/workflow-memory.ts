import { z } from "zod";
import { sha256Schema } from "./hash.js";
import { definitionNodeIdSchema, workflowExecutionPathSegmentSchema } from "./workflow-run.js";
import {
  memoryBackendIdSchema,
  memoryWriteIntentIdSchema,
  memoryWriteResultIdSchema,
  messageIdSchema,
  principalIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  workflowMemoryContextIdSchema,
  workflowMemoryQueryIdSchema,
  workflowMemorySnapshotIdSchema,
  workflowRunSpecIdSchema,
} from "./ids.js";

/**
 * Workflow Memory 是 Chat 拥有的稳定节点合同，不是某个 Memory 项目的对象模型。
 * Provider 的 L0/L1/L2/L3、bank/cube/team 等概念只允许留在 Adapter 内部。
 */

const isoDateTimeSchema = z.iso.datetime();
const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
  .max(96);

export const memoryProviderTransportSchema = z.enum(["http", "sdk", "mcp"]);
export const memoryProviderKindSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);
export const memoryAdapterContractVersionSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/u);

const memoryProviderQueryCapabilitySchema = z
  .object({
    maxResults: z.number().int().min(1).max(100),
    maxContextCharacters: z.number().int().min(128).max(200_000),
  })
  .strict();

const memoryProviderWriteCapabilitySchema = z
  .object({
    maxContentCharacters: z.number().int().min(1).max(200_000),
    /**
     * synchronous：写响应即可证明已形成可查询Memory；
     * asynchronous：Provider承诺接收后会异步物化；
     * accepted_only：当前Profile只承诺耐久接收，调用方不得等待或暗示必然物化。
     * accepted_only并不禁止只读对账在未来发现真实Memory对象后报告materialized。
     */
    materialization: z.enum(["synchronous", "asynchronous", "accepted_only"]),
    idempotency: z.enum(["provider_key", "chat_reconcile"]),
  })
  .strict();

export const memoryProviderCapabilitiesSchema = z
  .object({
    query: memoryProviderQueryCapabilitySchema.nullable(),
    write: memoryProviderWriteCapabilitySchema.nullable(),
    reconcile: z.boolean(),
    management: z
      .object({
        list: z.boolean(),
        get: z.boolean(),
        update: z.boolean(),
        delete: z.boolean(),
        history: z.boolean(),
      })
      .strict(),
  })
  .strict();

const memoryProviderDescriptorBase = {
  schemaVersion: z.literal("memory-provider-descriptor.v1"),
  providerId: memoryBackendIdSchema,
  displayName: z.string().trim().min(1).max(100),
  providerKind: memoryProviderKindSchema,
  transport: memoryProviderTransportSchema,
  adapterContractVersion: memoryAdapterContractVersionSchema,
  configured: z.boolean(),
  configurationFingerprint: sha256Schema,
  capabilities: memoryProviderCapabilitiesSchema,
};

/** endpoint、Token、serviceId 与 tenant 映射绝不进入该可持久化描述。 */
export const memoryProviderDescriptorSchema = z.union([
  z
    .object({
      ...memoryProviderDescriptorBase,
      authMode: z.literal("none"),
      credentialRevision: z.literal("none"),
    })
    .strict(),
  z
    .object({
      ...memoryProviderDescriptorBase,
      authMode: z.literal("bearer"),
      credentialRevision: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
        .refine((value) => value !== "none"),
    })
    .strict(),
]);

export const workflowMemoryQueryNodeConfigSchema = z
  .object({
    providerId: memoryBackendIdSchema,
    required: z.boolean().default(false),
    querySource: z.literal("source_message").default("source_message"),
    maxResults: z.number().int().min(1).max(20).default(8),
    maxContextCharacters: z.number().int().min(128).max(50_000).default(8_000),
  })
  .strict();

export const workflowMemoryWriteNodeConfigSchema = z
  .object({
    providerId: memoryBackendIdSchema,
    source: z.literal("source_message").default("source_message"),
    contentType: z.literal("conversation_turn").default("conversation_turn"),
  })
  .strict();

/**
 * v2只为需要声明写回是否阻断后续Product Commit的Workflow增加required语义。
 * v1必须保持字节级规范化兼容，避免历史Memory Planning Definition哈希漂移。
 */
export const workflowMemoryWriteNodeConfigV2Schema = z
  .object({
    providerId: memoryBackendIdSchema,
    source: z.literal("source_message").default("source_message"),
    contentType: z.literal("conversation_turn").default("conversation_turn"),
    required: z.boolean().default(true),
  })
  .strict();

const workflowMemoryQueryBase = {
  schemaVersion: z.literal("workflow-memory-query.v1"),
  workflowMemoryQueryId: workflowMemoryQueryIdSchema,
  operationId: workflowMemoryQueryIdSchema,
  productRunId: productRunIdSchema,
  productSessionId: productSessionIdSchema,
  requestedByPrincipalId: principalIdSchema,
  workflowRunSpecId: workflowRunSpecIdSchema,
  workflowRunSpecSha256: sha256Schema,
  definitionNodeId: definitionNodeIdSchema,
  executionPath: z.array(workflowExecutionPathSegmentSchema).max(8),
  attemptNumber: z.number().int().positive().max(100),
  sourceMessageId: messageIdSchema,
  sourceMessageSha256: sha256Schema,
  querySha256: sha256Schema,
  providerId: memoryBackendIdSchema,
  providerDescriptor: memoryProviderDescriptorSchema,
  providerDescriptorSha256: sha256Schema,
  requirement: z.enum(["required", "optional"]),
  maxResults: z.number().int().min(1).max(20),
  maxContextCharacters: z.number().int().min(128).max(50_000),
  startedAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

export const workflowMemoryQuerySchema = z.discriminatedUnion("status", [
  z
    .object({ ...workflowMemoryQueryBase, status: z.literal("pending"), revision: z.literal(1) })
    .strict(),
  z
    .object({
      ...workflowMemoryQueryBase,
      status: z.literal("completed"),
      externalQueryId: z.string().min(1).max(200),
      hitCount: z.number().int().nonnegative(),
      selectedCount: z.number().int().nonnegative(),
      selectedCharacters: z.number().int().nonnegative(),
      resultSetSha256: sha256Schema,
      completedAt: isoDateTimeSchema,
      revision: z.literal(2),
    })
    .strict(),
  z
    .object({
      ...workflowMemoryQueryBase,
      status: z.literal("failed"),
      errorCode: stableErrorCodeSchema,
      completedAt: isoDateTimeSchema,
      revision: z.literal(2),
    })
    .strict(),
]);

export const workflowMemoryCategorySchema = z.enum([
  "episode",
  "fact",
  "preference",
  "procedure",
  "skill",
  "other",
]);

/** Provider 原始对象不进入 Product Store；只冻结被本轮采用的最小正文快照。 */
export const workflowMemorySnapshotSchema = z
  .object({
    schemaVersion: z.literal("workflow-memory-snapshot.v1"),
    workflowMemorySnapshotId: workflowMemorySnapshotIdSchema,
    workflowMemoryQueryId: workflowMemoryQueryIdSchema,
    providerId: memoryBackendIdSchema,
    externalObjectIds: z.array(z.string().min(1).max(200)).min(1).max(50),
    title: z.string().trim().min(1).max(200),
    category: workflowMemoryCategorySchema,
    content: z.string().min(1).max(50_000),
    labels: z.array(z.string().trim().min(1).max(64)).max(50),
    score: z.number().finite().optional(),
    sourceUpdatedAt: isoDateTimeSchema.optional(),
    sha256: sha256Schema,
    revision: z.literal(1),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

const workflowMemoryQueryRefSchema = z
  .object({
    workflowMemoryQueryId: workflowMemoryQueryIdSchema,
    revision: z.union([z.literal(1), z.literal(2)]),
    providerId: memoryBackendIdSchema,
    outcome: z.enum(["completed", "optional_failed"]),
    resultSetSha256: sha256Schema.optional(),
    errorCode: stableErrorCodeSchema.optional(),
  })
  .strict()
  .check((ctx) => {
    if (ctx.value.outcome === "completed" && ctx.value.resultSetSha256 === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "completed query必须带resultSetSha256",
        path: ["resultSetSha256"],
      });
    }
    if (ctx.value.outcome === "optional_failed" && ctx.value.errorCode === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "optional_failed query必须带errorCode",
        path: ["errorCode"],
      });
    }
  });

export const workflowMemoryContextSchema = z
  .object({
    schemaVersion: z.literal("workflow-memory-context.v1"),
    workflowMemoryContextId: workflowMemoryContextIdSchema,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    workflowRunSpecSha256: sha256Schema,
    queries: z.array(workflowMemoryQueryRefSchema).min(1).max(16),
    items: z
      .array(
        z
          .object({
            workflowMemorySnapshotId: workflowMemorySnapshotIdSchema,
            revision: z.literal(1),
            sha256: sha256Schema,
          })
          .strict(),
      )
      .max(100),
    totalContentCharacters: z.number().int().nonnegative().max(200_000),
    sha256: sha256Schema,
    revision: z.literal(1),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const memoryWriteSourceSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("full_message"),
      sourceMessageId: messageIdSchema,
      sourceMessageSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("utf16_range"),
      sourceMessageId: messageIdSchema,
      sourceMessageSha256: sha256Schema,
      startUtf16: z.number().int().nonnegative(),
      endUtf16: z.number().int().positive(),
      selectedTextSha256: sha256Schema,
    })
    .strict(),
]);

export const memoryWriteIntentSchema = z
  .object({
    schemaVersion: z.literal("memory-write-intent.v1"),
    memoryWriteIntentId: memoryWriteIntentIdSchema,
    operationId: memoryWriteIntentIdSchema,
    requestedByPrincipalId: principalIdSchema,
    productSessionId: productSessionIdSchema,
    sourceSelection: memoryWriteSourceSelectionSchema,
    contentType: z.literal("conversation_turn"),
    providerId: memoryBackendIdSchema,
    providerDescriptor: memoryProviderDescriptorSchema,
    providerDescriptorSha256: sha256Schema,
    requestSha256: sha256Schema,
    semanticDedupeSha256: sha256Schema,
    revision: z.literal(1),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

const memoryWriteResultBase = {
  schemaVersion: z.literal("memory-write-result.v1"),
  memoryWriteResultId: memoryWriteResultIdSchema,
  memoryWriteIntentId: memoryWriteIntentIdSchema,
  dispatchAttempts: z.number().int().nonnegative(),
  reconcileAttempts: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

const memoryWriteAcceptedEvidence = {
  externalObjectId: z.string().min(1).max(200),
  externalObjectVersion: z.string().min(1).max(200).optional(),
  externalStatus: z.string().min(1).max(100).optional(),
  acceptedAt: isoDateTimeSchema,
  responseSha256: sha256Schema,
};

export const memoryWriteResultSchema = z.discriminatedUnion("status", [
  z.object({ ...memoryWriteResultBase, status: z.literal("queued") }).strict(),
  z
    .object({
      ...memoryWriteResultBase,
      status: z.literal("dispatching"),
      dispatchStartedAt: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      ...memoryWriteResultBase,
      status: z.literal("accepted"),
      ...memoryWriteAcceptedEvidence,
    })
    .strict(),
  z
    .object({
      ...memoryWriteResultBase,
      status: z.literal("materialized"),
      ...memoryWriteAcceptedEvidence,
      materializedAt: isoDateTimeSchema,
      verificationKind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
      verificationSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...memoryWriteResultBase,
      status: z.literal("failed"),
      errorCode: stableErrorCodeSchema,
      summary: z.string().min(1).max(500),
      failedAt: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      ...memoryWriteResultBase,
      status: z.literal("outcome_unknown"),
      errorCode: stableErrorCodeSchema,
      unknownSince: isoDateTimeSchema,
      lastReconciledAt: isoDateTimeSchema.optional(),
    })
    .strict(),
]);

export type MemoryProviderDescriptor = z.infer<typeof memoryProviderDescriptorSchema>;
export type MemoryProviderCapabilities = z.infer<typeof memoryProviderCapabilitiesSchema>;
export type WorkflowMemoryQueryNodeConfig = z.infer<typeof workflowMemoryQueryNodeConfigSchema>;
export type WorkflowMemoryWriteNodeConfig = z.infer<typeof workflowMemoryWriteNodeConfigSchema>;
export type WorkflowMemoryWriteNodeConfigV2 = z.infer<typeof workflowMemoryWriteNodeConfigV2Schema>;
export type WorkflowMemoryQuery = z.infer<typeof workflowMemoryQuerySchema>;
export type WorkflowMemorySnapshot = z.infer<typeof workflowMemorySnapshotSchema>;
export type WorkflowMemoryContext = z.infer<typeof workflowMemoryContextSchema>;
export type WorkflowMemoryCategory = z.infer<typeof workflowMemoryCategorySchema>;
export type MemoryWriteSourceSelection = z.infer<typeof memoryWriteSourceSelectionSchema>;
export type MemoryWriteIntent = z.infer<typeof memoryWriteIntentSchema>;
export type MemoryWriteResult = z.infer<typeof memoryWriteResultSchema>;
