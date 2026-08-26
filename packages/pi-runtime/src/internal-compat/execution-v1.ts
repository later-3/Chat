import {
  memoryBackendIdSchema,
  memoryLayerSchema,
  memoryResultSnapshotIdSchema,
  memoryResultSnapshotSchema,
  planningProjectContextIdSchema,
  projectIdSchema,
  ruleIdSchema,
  ruleRevisionIdSchema,
  sha256Schema,
  workflowMemoryCategorySchema,
  workflowMemorySnapshotIdSchema,
} from "@chat/contracts";
import { z } from "zod";
import { planningProjectSnapshotSchema } from "./planning-project-context-v1.js";

export const executionMemoryContextItemDtoSchema = z
  .object({
    refId: memoryResultSnapshotIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
    title: memoryResultSnapshotSchema.shape.title,
    kind: memoryResultSnapshotSchema.shape.kind,
    layer: memoryLayerSchema,
    tags: memoryResultSnapshotSchema.shape.tags,
    content: memoryResultSnapshotSchema.shape.content,
  })
  .strict();

export const executionWorkflowMemoryContextItemDtoSchema = z
  .object({
    contextKind: z.literal("memory"),
    refId: workflowMemorySnapshotIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
    providerId: memoryBackendIdSchema,
    title: z.string().trim().min(1).max(200),
    category: workflowMemoryCategorySchema,
    labels: z.array(z.string().trim().min(1).max(64)).max(50),
    content: z.string().min(1).max(50_000),
  })
  .strict();

export const executionProjectContextItemDtoSchema = z
  .object({
    contextKind: z.literal("project"),
    refId: planningProjectContextIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
    title: z.string().trim().min(1).max(120),
    projectId: projectIdSchema,
    projectRevision: z.number().int().positive(),
    snapshot: planningProjectSnapshotSchema,
  })
  .strict();

export const executionRuleContextItemDtoSchema = z
  .object({
    contextKind: z.literal("rule"),
    refId: ruleRevisionIdSchema,
    revision: z.number().int().positive(),
    sha256: sha256Schema,
    ruleId: ruleIdSchema,
    content: z.string().trim().min(1).max(8_000),
  })
  .strict();

export const executionContextItemDtoSchema = z.union([
  executionMemoryContextItemDtoSchema,
  executionWorkflowMemoryContextItemDtoSchema,
  executionProjectContextItemDtoSchema,
  executionRuleContextItemDtoSchema,
]);
