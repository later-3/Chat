import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  contextPackageIdSchema,
  contextRequestIdSchema,
  messageIdSchema,
  memoryAdoptionIdSchema,
  memoryBackendIdSchema,
  memoryQueryIdSchema,
  memoryResultSnapshotIdSchema,
  principalIdSchema,
  productRunIdSchema,
} from "./ids.js";

/**
 * C1 长期上下文合同。
 *
 * 外部 Memory 服务拥有原始记录与索引；Chat 只保存本轮查询意图、被采用结果的
 * 不可变快照和版本化 ContextPackage。所有 Schema 都是 strict，禁止用任意
 * metadata 袋子把外部服务内部结构泄漏进产品事实。
 */

const isoDateTimeSchema = z.iso.datetime();
const timestampFields = {
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};
const immutableEntityFields = { revision: z.literal(1), ...timestampFields };

export const memoryLayerSchema = z.enum(["L1", "L2", "L3", "Skill"]);
export const memoryRequirementSchema = z.enum(["required", "optional"]);
export const memoryBackendAuthModeSchema = z.enum(["none", "bearer"]);
export const memoryCredentialRevisionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const memoryBackendCapabilitiesSchema = z
  .object({
    query: z.literal(true),
    tags: z.literal(true),
    layers: z.array(memoryLayerSchema).min(1).max(4),
    maxLimit: z.number().int().min(1).max(20),
    maxContextBudget: z.number().int().min(128).max(8_192),
  })
  .strict();

const memoryBackendDescriptorBase = {
  backendId: memoryBackendIdSchema,
  displayName: z.string().min(1).max(100),
  kind: z.literal("memmy"),
  adapterContractVersion: z.literal("memmy-http-query.v1"),
  configured: z.boolean(),
  configurationFingerprint: sha256Schema,
  capabilities: memoryBackendCapabilitiesSchema,
};

/** Query冻结时保存的安全后端描述；revision/keyId只标识凭据版本，绝不保存Token。 */
export const memoryBackendDescriptorSchema = z.discriminatedUnion("authMode", [
  z
    .object({
      ...memoryBackendDescriptorBase,
      authMode: z.literal("none"),
      credentialRevision: z.literal("none"),
    })
    .strict(),
  z
    .object({
      ...memoryBackendDescriptorBase,
      authMode: z.literal("bearer"),
      credentialRevision: memoryCredentialRevisionSchema.refine((value) => value !== "none"),
    })
    .strict(),
]);

/** 浏览器可选择的查询条件；endpoint、Token、namespace 映射永远不在这里。 */
export const memoryContextSelectionSchema = z
  .object({
    backendId: memoryBackendIdSchema,
    requirement: memoryRequirementSchema,
    tags: z.array(z.string().trim().min(1).max(64)).max(20),
    layers: z.array(memoryLayerSchema).min(1).max(4),
    limit: z.number().int().min(1).max(20),
    contextBudget: z.number().int().min(128).max(8_192),
  })
  .strict();

export const runContextRequestSchema = z
  .object({
    schemaVersion: z.literal("run-context-request.v1"),
    contextRequestId: contextRequestIdSchema,
    productRunId: productRunIdSchema,
    requestedByPrincipalId: principalIdSchema,
    sourceMessageId: messageIdSchema,
    sourceMessageSha256: sha256Schema,
    memory: memoryContextSelectionSchema.optional(),
    sha256: sha256Schema,
    ...immutableEntityFields,
  })
  .strict();

export const memoryQueryStatusSchema = z.enum(["pending", "completed", "failed"]);
const stableMemoryErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
  .max(64);
const memoryQueryBase = {
  schemaVersion: z.literal("memory-query.v1"),
  memoryQueryId: memoryQueryIdSchema,
  contextRequestId: contextRequestIdSchema,
  productRunId: productRunIdSchema,
  planRevision: z.literal(1),
  backendId: memoryBackendIdSchema,
  backendDescriptor: memoryBackendDescriptorSchema,
  backendDescriptorSha256: sha256Schema,
  requirement: memoryRequirementSchema,
  sourceMessageSha256: sha256Schema,
  tags: z.array(z.string().min(1).max(64)).max(20),
  layers: z.array(memoryLayerSchema).min(1).max(4),
  limit: z.number().int().min(1).max(20),
  contextBudget: z.number().int().min(128).max(8_192),
  startedAt: isoDateTimeSchema,
  ...timestampFields,
};

export const memoryQuerySchema = z.discriminatedUnion("status", [
  z.object({ ...memoryQueryBase, status: z.literal("pending"), revision: z.literal(1) }).strict(),
  z
    .object({
      ...memoryQueryBase,
      status: z.literal("completed"),
      externalQueryId: z.string().min(1).max(200),
      hitCount: z.number().int().nonnegative(),
      adoptedCount: z.number().int().nonnegative(),
      tokenEstimate: z.number().int().nonnegative(),
      resultSetSha256: sha256Schema,
      completedAt: isoDateTimeSchema,
      revision: z.literal(2),
    })
    .strict(),
  z
    .object({
      ...memoryQueryBase,
      status: z.literal("failed"),
      errorCode: stableMemoryErrorCodeSchema,
      completedAt: isoDateTimeSchema,
      revision: z.literal(2),
    })
    .strict(),
]);

/** memmy 的注入 section 是已按服务预算选择的最小可回放单位。 */
export const memoryResultSnapshotSchema = z
  .object({
    schemaVersion: z.literal("memory-result-snapshot.v1"),
    memoryResultSnapshotId: memoryResultSnapshotIdSchema,
    memoryQueryId: memoryQueryIdSchema,
    backendId: memoryBackendIdSchema,
    externalObjectIds: z.array(z.string().min(1).max(200)).min(1).max(50),
    title: z.string().min(1).max(200),
    kind: z.enum(["trace", "span", "policy", "world_model", "skill"]),
    memoryLayer: memoryLayerSchema,
    content: z.string().min(1).max(50_000),
    tags: z.array(z.string().min(1).max(64)).max(50),
    score: z.number().finite().optional(),
    tokenEstimate: z.number().int().nonnegative(),
    sourceUpdatedAt: isoDateTimeSchema.optional(),
    sha256: sha256Schema,
    ...immutableEntityFields,
  })
  .strict();

export const contextPackageItemSchema = z
  .object({
    kind: z.literal("memory_snapshot"),
    memoryResultSnapshotId: memoryResultSnapshotIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
    selection: z.literal("retrieved"),
    reasonCode: z.literal("within_budget"),
  })
  .strict();

export const contextPackageExclusionSchema = z
  .object({
    kind: z.literal("memory_backend"),
    backendId: memoryBackendIdSchema,
    reasonCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
      .max(64),
  })
  .strict();

export const contextPackageSchema = z
  .object({
    schemaVersion: z.literal("context-package.v1"),
    contextPackageId: contextPackageIdSchema,
    contextRequestId: contextRequestIdSchema,
    productRunId: productRunIdSchema,
    /** 包在哪一版规划前首次冻结；后续修订默认复用同一个不可变包。 */
    assembledForPlanRevision: z.number().int().positive(),
    purpose: z.literal("planning"),
    memoryQueryId: memoryQueryIdSchema,
    items: z.array(contextPackageItemSchema).max(20),
    exclusions: z.array(contextPackageExclusionSchema).max(20),
    sha256: sha256Schema,
    ...immutableEntityFields,
  })
  .strict();

export const memoryAdoptionSchema = z
  .object({
    schemaVersion: z.literal("memory-adoption.v1"),
    memoryAdoptionId: memoryAdoptionIdSchema,
    productRunId: productRunIdSchema,
    contextPackageId: contextPackageIdSchema,
    memoryResultSnapshotId: memoryResultSnapshotIdSchema,
    status: z.literal("adopted"),
    reasonCode: z.literal("within_budget"),
    ...immutableEntityFields,
  })
  .strict();

export type MemoryLayer = z.infer<typeof memoryLayerSchema>;
export type MemoryRequirement = z.infer<typeof memoryRequirementSchema>;
export type MemoryContextSelection = z.infer<typeof memoryContextSelectionSchema>;
export type RunContextRequest = z.infer<typeof runContextRequestSchema>;
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;
export type MemoryResultSnapshot = z.infer<typeof memoryResultSnapshotSchema>;
export type ContextPackage = z.infer<typeof contextPackageSchema>;
export type MemoryAdoption = z.infer<typeof memoryAdoptionSchema>;
