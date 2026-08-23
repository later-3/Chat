import { z } from "zod";
import { sha256Schema } from "./hash.js";
import { memoryBackendIdSchema } from "./ids.js";
import { memorySessionSourceRefSchema } from "./memory-session-import.js";
import {
  memoryAdapterContractVersionSchema,
  memoryProviderKindSchema,
  memoryProviderTransportSchema,
  workflowMemoryCategorySchema,
} from "./workflow-memory.js";

const isoDateTimeSchema = z.iso.datetime();
const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
  .max(96);

export const previewMemoryProviderComparisonPayloadSchema = z
  .object({
    source: memorySessionSourceRefSchema,
    query: z.string().trim().min(1).max(4_000),
    providerIds: z
      .array(memoryBackendIdSchema)
      .min(2)
      .max(4)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({ code: "custom", message: "Provider不能重复" });
        }
      }),
    maxResults: z.number().int().min(1).max(20).default(8),
    maxContextCharacters: z.number().int().min(128).max(50_000).default(8_000),
  })
  .strict();

export const memoryProviderComparisonItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    category: workflowMemoryCategorySchema,
    content: z.string().min(1).max(50_000),
    contentSha256: sha256Schema,
    labels: z.array(z.string().trim().min(1).max(64)).max(50),
    /** Provider分数只在该Provider内部展示，禁止跨Provider排序或宣称优劣。 */
    providerScore: z.number().finite().optional(),
    sourceUpdatedAt: isoDateTimeSchema.optional(),
  })
  .strict();

const comparisonProviderBase = {
  providerId: memoryBackendIdSchema,
  displayName: z.string().trim().min(1).max(100),
  providerKind: memoryProviderKindSchema,
  transport: memoryProviderTransportSchema,
  adapterContractVersion: memoryAdapterContractVersionSchema,
  providerDescriptorSha256: sha256Schema,
  queryCapability: z
    .object({
      maxResults: z.number().int().min(1).max(100),
      maxContextCharacters: z.number().int().min(128).max(200_000),
    })
    .strict(),
  writeMaterialization: z.enum(["synchronous", "asynchronous", "accepted_only"]).nullable(),
};

export const memoryProviderComparisonOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...comparisonProviderBase,
      status: z.literal("completed"),
      hitCount: z.number().int().nonnegative(),
      selectedCount: z.number().int().nonnegative().max(100),
      selectedCharacters: z.number().int().nonnegative().max(200_000),
      resultSetSha256: sha256Schema,
      items: z.array(memoryProviderComparisonItemSchema).max(100),
    })
    .strict(),
  z
    .object({
      ...comparisonProviderBase,
      status: z.literal("failed"),
      errorCode: stableErrorCodeSchema,
      retryable: z.boolean(),
    })
    .strict(),
]);

export const memoryProviderPairwiseComparisonSchema = z
  .object({
    leftProviderId: memoryBackendIdSchema,
    rightProviderId: memoryBackendIdSchema,
    exactContentOverlapCount: z.number().int().nonnegative().max(100),
    leftUniqueContentCount: z.number().int().nonnegative().max(100),
    rightUniqueContentCount: z.number().int().nonnegative().max(100),
    sharedLabels: z.array(z.string().trim().min(1).max(64)).max(100),
    scoreComparisonAllowed: z.literal(false),
  })
  .strict();

export const memoryProviderComparisonPreviewSchema = z
  .object({
    schemaVersion: z.literal("memory-provider-comparison-preview.v1"),
    source: memorySessionSourceRefSchema,
    sourceTitle: z.string().trim().min(1).max(200),
    sourceUpdatedAt: isoDateTimeSchema,
    sourceSnapshotSha256: sha256Schema,
    querySha256: sha256Schema,
    maxResults: z.number().int().min(1).max(20),
    maxContextCharacters: z.number().int().min(128).max(50_000),
    providers: z.array(memoryProviderComparisonOutcomeSchema).min(2).max(4),
    pairwise: z.array(memoryProviderPairwiseComparisonSchema).max(6),
    comparisonSha256: sha256Schema,
    generatedAt: isoDateTimeSchema,
  })
  .strict();

export const previewMemoryProviderComparisonResponseSchema = z
  .object({ comparison: memoryProviderComparisonPreviewSchema })
  .strict();

export type PreviewMemoryProviderComparisonPayload = z.infer<
  typeof previewMemoryProviderComparisonPayloadSchema
>;
export type MemoryProviderComparisonOutcome = z.infer<typeof memoryProviderComparisonOutcomeSchema>;
export type MemoryProviderPairwiseComparison = z.infer<
  typeof memoryProviderPairwiseComparisonSchema
>;
export type MemoryProviderComparisonPreview = z.infer<typeof memoryProviderComparisonPreviewSchema>;
