import { z } from "zod";
import {
  memoryImportIntentIdSchema,
  memoryImportResultIdSchema,
  outboxEntryIdSchema,
} from "@chat/contracts";

export const memoryImportWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal("memory-import-workflow-input.v1"),
    memoryImportIntentId: memoryImportIntentIdSchema,
    memoryImportResultId: memoryImportResultIdSchema,
    outboxId: outboxEntryIdSchema,
    expectedResultRevision: z.number().int().positive(),
    mode: z.enum(["import", "reconcile"]),
  })
  .strict();

export type MemoryImportWorkflowInput = z.infer<typeof memoryImportWorkflowInputSchema>;
