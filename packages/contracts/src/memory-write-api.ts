import { z } from "zod";
import { commandEnvelopeSchema } from "./command.js";
import {
  memoryBackendIdSchema,
  memoryWriteIntentIdSchema,
  memoryWriteResultIdSchema,
  productSessionIdSchema,
} from "./ids.js";
import {
  memoryProviderDescriptorSchema,
  memoryWriteResultSchema,
  memoryWriteSourceSelectionSchema,
} from "./workflow-memory.js";

export const createMemoryWritePayloadSchema = z
  .object({
    productSessionId: productSessionIdSchema,
    providerId: memoryBackendIdSchema,
    sourceSelection: memoryWriteSourceSelectionSchema,
    expectedSessionRevision: z.number().int().positive(),
  })
  .strict();

export const createMemoryWriteCommandSchema = commandEnvelopeSchema.extend({
  payload: createMemoryWritePayloadSchema,
});

export const memoryWriteDtoSchema = z
  .object({
    memoryWriteIntentId: memoryWriteIntentIdSchema,
    memoryWriteResultId: memoryWriteResultIdSchema,
    productSessionId: productSessionIdSchema,
    providerId: memoryBackendIdSchema,
    sourceSelection: memoryWriteSourceSelectionSchema,
    result: memoryWriteResultSchema,
    canReconcile: z.boolean(),
  })
  .strict();

export const memoryWriteResponseSchema = z.object({ memoryWrite: memoryWriteDtoSchema }).strict();

export const reconcileMemoryWritePayloadSchema = z
  .object({
    expectedResultRevision: z.number().int().positive(),
  })
  .strict();

export const reconcileMemoryWriteCommandSchema = commandEnvelopeSchema.extend({
  payload: reconcileMemoryWritePayloadSchema,
});

export const listMemoryWritesQuerySchema = z
  .object({
    productSessionId: productSessionIdSchema,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: memoryWriteIntentIdSchema.optional(),
  })
  .strict();

export const listMemoryWritesResponseSchema = z
  .object({
    memoryWrites: z.array(memoryWriteDtoSchema).max(100),
    nextCursor: memoryWriteIntentIdSchema.optional(),
  })
  .strict();

export const listMemoryProvidersResponseSchema = z
  .object({ providers: z.array(memoryProviderDescriptorSchema).max(50) })
  .strict();

export type CreateMemoryWritePayload = z.infer<typeof createMemoryWritePayloadSchema>;
export type MemoryWriteDto = z.infer<typeof memoryWriteDtoSchema>;
export type ReconcileMemoryWritePayload = z.infer<typeof reconcileMemoryWritePayloadSchema>;
