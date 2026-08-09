import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  memoryResultSnapshotIdSchema,
  planningMemorySelectionIdSchema,
  productRunIdSchema,
  workflowRunSpecIdSchema,
} from "./ids.js";
import { definitionNodeIdSchema } from "./workflow-run.js";

/**
 * Planning Memory Selection是一次Run对既有Memory Snapshot的不可变采用事实。
 * 正文继续由MemoryResultSnapshot拥有；Selection只保存RunSpec绑定和三元组引用。
 */
export const planningMemorySelectionItemSchema = z
  .object({
    memoryResultSnapshotId: memoryResultSnapshotIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
  })
  .strict();

export const planningMemorySelectionSchema = z
  .object({
    schemaVersion: z.literal("planning-memory-selection.v1"),
    planningMemorySelectionId: planningMemorySelectionIdSchema,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    workflowRunSpecSha256: sha256Schema,
    definitionNodeId: definitionNodeIdSchema,
    maxItems: z.number().int().min(1).max(20),
    selected: z.array(planningMemorySelectionItemSchema).min(1).max(20),
    sha256: sha256Schema,
    revision: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type PlanningMemorySelectionItem = z.infer<typeof planningMemorySelectionItemSchema>;
export type PlanningMemorySelection = z.infer<typeof planningMemorySelectionSchema>;
