import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  memoryBackendIdSchema,
  memoryImportIntentIdSchema,
  memoryImportResultIdSchema,
  messageIdSchema,
  principalIdSchema,
} from "./ids.js";
import { memoryCredentialRevisionSchema } from "./context.js";

/**
 * 显式 Memory 导入产品合同。
 *
 * Message 是 Chat 内唯一来源正文；Intent 只冻结引用、选区和 Hash，Result 只拥有
 * 外部副作用状态。这样 Trace、Outbox 与运行时映射都不需要复制用户正文。
 */

const isoDateTimeSchema = z.iso.datetime();
const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
  .max(64);

export const memoryImportSourceSelectionSchema = z.discriminatedUnion("kind", [
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

export const memoryImportCapabilitiesSchema = z
  .object({
    mode: z.literal("explicit_fact"),
    layers: z.tuple([z.literal("L2")]),
    title: z.literal(true),
    tags: z.literal(true),
    maxContentChars: z.number().int().min(1).max(100_000),
  })
  .strict();

const memoryImportBackendDescriptorBase = {
  backendId: memoryBackendIdSchema,
  displayName: z.string().min(1).max(100),
  kind: z.literal("memmy"),
  adapterContractVersion: z.literal("memmy-http-import.v1"),
  configured: z.boolean(),
  configurationFingerprint: sha256Schema,
  capabilities: memoryImportCapabilitiesSchema,
};

export const memoryImportBackendDescriptorSchema = z.discriminatedUnion("authMode", [
  z
    .object({
      ...memoryImportBackendDescriptorBase,
      authMode: z.literal("none"),
      credentialRevision: z.literal("none"),
    })
    .strict(),
  z
    .object({
      ...memoryImportBackendDescriptorBase,
      authMode: z.literal("bearer"),
      credentialRevision: memoryCredentialRevisionSchema.refine((value) => value !== "none"),
    })
    .strict(),
]);

export const memoryImportIntentSchema = z
  .object({
    schemaVersion: z.literal("memory-import-intent.v1"),
    memoryImportIntentId: memoryImportIntentIdSchema,
    requestedByPrincipalId: principalIdSchema,
    sourceSelection: memoryImportSourceSelectionSchema,
    backendId: memoryBackendIdSchema,
    backendDescriptor: memoryImportBackendDescriptorSchema,
    backendDescriptorSha256: sha256Schema,
    memoryLayer: z.literal("L2"),
    title: z.string().min(1).max(200),
    tags: z.array(z.string().min(1).max(64)).max(20),
    /** memmy requestId 使用该稳定产品身份；一次 Intent 永不改变。 */
    operationId: memoryImportIntentIdSchema,
    requestSha256: sha256Schema,
    semanticDedupeSha256: sha256Schema,
    revision: z.literal(1),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

const resultBase = {
  schemaVersion: z.literal("memory-import-result.v1"),
  memoryImportResultId: memoryImportResultIdSchema,
  memoryImportIntentId: memoryImportIntentIdSchema,
  dispatchAttempts: z.number().int().nonnegative(),
  reconcileAttempts: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

const acceptedEvidence = {
  externalObjectId: z.string().min(1).max(200),
  externalObjectVersion: z.string().min(1).max(200).optional(),
  externalStatus: z.string().min(1).max(100).optional(),
  acceptedAt: isoDateTimeSchema,
  responseSha256: sha256Schema,
};

export const memoryImportResultSchema = z.discriminatedUnion("status", [
  z.object({ ...resultBase, status: z.literal("queued") }).strict(),
  z
    .object({
      ...resultBase,
      status: z.literal("dispatching"),
      dispatchStartedAt: isoDateTimeSchema,
    })
    .strict(),
  z.object({ ...resultBase, status: z.literal("accepted"), ...acceptedEvidence }).strict(),
  z
    .object({
      ...resultBase,
      status: z.literal("materialized"),
      ...acceptedEvidence,
      materializedAt: isoDateTimeSchema,
      verificationKind: z.literal("read_by_id_and_search"),
      verificationSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      ...resultBase,
      status: z.literal("failed"),
      errorCode: stableErrorCodeSchema,
      summary: z.string().min(1).max(500),
      failedAt: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      ...resultBase,
      status: z.literal("outcome_unknown"),
      errorCode: stableErrorCodeSchema,
      unknownSince: isoDateTimeSchema,
      lastReconciledAt: isoDateTimeSchema.optional(),
    })
    .strict(),
]);

export type MemoryImportSourceSelection = z.infer<typeof memoryImportSourceSelectionSchema>;
export type MemoryImportCapabilities = z.infer<typeof memoryImportCapabilitiesSchema>;
export type MemoryImportBackendDescriptor = z.infer<typeof memoryImportBackendDescriptorSchema>;
export type MemoryImportIntent = z.infer<typeof memoryImportIntentSchema>;
export type MemoryImportResult = z.infer<typeof memoryImportResultSchema>;
export type MemoryImportStatus = MemoryImportResult["status"];
