import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  memoryBackendIdSchema,
  memorySessionImportIdSchema,
  memoryWriteIntentIdSchema,
  productSessionIdSchema,
  principalIdSchema,
} from "./ids.js";
import { memoryProviderDescriptorSchema, memoryWriteResultSchema } from "./workflow-memory.js";

const isoDateTimeSchema = z.iso.datetime();

export const codexSessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f-]{27,71}$/u)
  .max(80);

export const memorySessionSourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), productSessionId: productSessionIdSchema }).strict(),
  z.object({ kind: z.literal("codex"), codexSessionId: codexSessionIdSchema }).strict(),
]);

export const memorySessionConversionVersionSchema = z.literal("conversation-turns.v1");

export const memorySessionImportItemRefSchema = z
  .object({
    memoryWriteIntentId: memoryWriteIntentIdSchema,
    disposition: z.enum(["created", "existing"]),
    sourceItemKey: z.string().min(1).max(200),
    sourceItemSha256: sha256Schema,
    title: z.string().min(1).max(200),
    contentCharacters: z.number().int().positive().max(50_000),
  })
  .strict();

export const memorySessionImportSchema = z
  .object({
    schemaVersion: z.literal("memory-session-import.v1"),
    memorySessionImportId: memorySessionImportIdSchema,
    requestedByPrincipalId: principalIdSchema,
    source: memorySessionSourceRefSchema,
    sourceTitle: z.string().min(1).max(200),
    sourceUpdatedAt: isoDateTimeSchema,
    sourceSnapshotSha256: sha256Schema,
    conversionVersion: memorySessionConversionVersionSchema,
    previewSha256: sha256Schema,
    providerId: memoryBackendIdSchema,
    providerDescriptor: memoryProviderDescriptorSchema,
    providerDescriptorSha256: sha256Schema,
    items: z.array(memorySessionImportItemRefSchema).max(200),
    createdItemCount: z.number().int().nonnegative().max(200),
    existingItemCount: z.number().int().nonnegative().max(200),
    semanticDedupeSha256: sha256Schema,
    revision: z.literal(1),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const memorySessionSourceListQuerySchema = z
  .object({
    kind: z.enum(["chat", "codex"]),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const memorySessionSourceDescriptorSchema = z
  .object({
    source: memorySessionSourceRefSchema,
    title: z.string().min(1).max(200),
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const listMemorySessionSourcesResponseSchema = z
  .object({ sources: z.array(memorySessionSourceDescriptorSchema).max(100) })
  .strict();

export const previewMemorySessionImportPayloadSchema = z
  .object({ source: memorySessionSourceRefSchema, providerId: memoryBackendIdSchema })
  .strict();

export const memorySessionImportPreviewItemSchema = z
  .object({
    sourceItemKey: z.string().min(1).max(200),
    sourceItemSha256: sha256Schema,
    title: z.string().min(1).max(200),
    contentPreview: z.string().min(1).max(1_000),
    contentCharacters: z.number().int().positive().max(50_000),
    alreadyImported: z.boolean(),
    existingMemoryWriteIntentId: memoryWriteIntentIdSchema.optional(),
  })
  .strict();

export const memorySessionImportPreviewSchema = z
  .object({
    schemaVersion: z.literal("memory-session-import-preview.v1"),
    source: memorySessionSourceRefSchema,
    sourceTitle: z.string().min(1).max(200),
    sourceUpdatedAt: isoDateTimeSchema,
    sourceSnapshotSha256: sha256Schema,
    conversionVersion: memorySessionConversionVersionSchema,
    previewSha256: sha256Schema,
    providerId: memoryBackendIdSchema,
    providerDisplayName: z.string().min(1).max(100),
    items: z.array(memorySessionImportPreviewItemSchema).max(200),
    newItemCount: z.number().int().nonnegative().max(200),
    existingItemCount: z.number().int().nonnegative().max(200),
  })
  .strict();

export const previewMemorySessionImportResponseSchema = z
  .object({ preview: memorySessionImportPreviewSchema })
  .strict();

export const createMemorySessionImportPayloadSchema = z
  .object({
    source: memorySessionSourceRefSchema,
    providerId: memoryBackendIdSchema,
    sourceSnapshotSha256: sha256Schema,
    previewSha256: sha256Schema,
  })
  .strict();

const memorySessionImportResultCountSchema = z
  .object({
    queued: z.number().int().nonnegative(),
    dispatching: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    materialized: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    outcomeUnknown: z.number().int().nonnegative(),
  })
  .strict();

export const memorySessionImportDtoSchema = z
  .object({
    memorySessionImportId: memorySessionImportIdSchema,
    source: memorySessionSourceRefSchema,
    sourceTitle: z.string().min(1).max(200),
    sourceUpdatedAt: isoDateTimeSchema,
    sourceSnapshotSha256: sha256Schema,
    conversionVersion: memorySessionConversionVersionSchema,
    previewSha256: sha256Schema,
    providerId: memoryBackendIdSchema,
    providerDisplayName: z.string().min(1).max(100),
    status: z.enum(["no_changes", "processing", "completed", "needs_attention"]),
    createdItemCount: z.number().int().nonnegative().max(200),
    existingItemCount: z.number().int().nonnegative().max(200),
    resultCounts: memorySessionImportResultCountSchema,
    items: z
      .array(
        memorySessionImportItemRefSchema.extend({
          result: memoryWriteResultSchema,
          canReconcile: z.boolean(),
        }),
      )
      .max(200),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export const memorySessionImportResponseSchema = z
  .object({ memorySessionImport: memorySessionImportDtoSchema })
  .strict();

export const listMemorySessionImportsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

export const listMemorySessionImportsResponseSchema = z
  .object({ memorySessionImports: z.array(memorySessionImportDtoSchema).max(100) })
  .strict();

export type CodexSessionId = z.infer<typeof codexSessionIdSchema>;
export type MemorySessionSourceRef = z.infer<typeof memorySessionSourceRefSchema>;
export type MemorySessionImport = z.infer<typeof memorySessionImportSchema>;
export type MemorySessionImportPreview = z.infer<typeof memorySessionImportPreviewSchema>;
export type MemorySessionImportDto = z.infer<typeof memorySessionImportDtoSchema>;
export type CreateMemorySessionImportPayload = z.infer<
  typeof createMemorySessionImportPayloadSchema
>;
