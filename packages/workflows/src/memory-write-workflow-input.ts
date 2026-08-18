import { z } from "zod";
import {
  memoryWriteIntentIdSchema,
  memoryWriteResultIdSchema,
  outboxEntryIdSchema,
} from "@chat/contracts";

export const memoryWriteWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal("memory-write-workflow-input.v1"),
    memoryWriteIntentId: memoryWriteIntentIdSchema,
    memoryWriteResultId: memoryWriteResultIdSchema,
    outboxId: outboxEntryIdSchema,
    expectedResultRevision: z.number().int().positive(),
    mode: z.enum(["write", "reconcile"]),
  })
  .strict();

export type MemoryWriteWorkflowInput = z.infer<typeof memoryWriteWorkflowInputSchema>;
