import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  productRunIdSchema,
  workflowNodeRunIdSchema,
  workflowViewDefinitionIdSchema,
} from "./ids.js";
import {
  definitionNodeIdSchema,
  nodeProductRefSchema,
  workflowNodeRunStatusSchema,
  workflowNodeTypeSchema,
  workflowViewEdgeSchema,
  workflowViewNodeKindSchema,
} from "./workflow-run.js";

export const WORKFLOW_API_SCHEMA_VERSION = "chat-workflow-api.v1";

export const workflowNodeAllowedActionSchema = z.enum(["inspect", "submit_decision"]);

export const workflowDefinitionNodeDtoSchema = z
  .object({
    definitionNodeId: definitionNodeIdSchema,
    nodeType: workflowNodeTypeSchema,
    nodeSchemaVersion: z.string().min(1).max(50),
    title: z.string().min(1).max(120),
    kind: workflowViewNodeKindSchema,
    optional: z.boolean(),
    parentDefinitionNodeId: definitionNodeIdSchema.optional(),
  })
  .strict();

export const workflowNodeRunSummaryDtoSchema = z
  .object({
    workflowNodeRunId: workflowNodeRunIdSchema,
    definitionNodeId: definitionNodeIdSchema,
    nodeType: workflowNodeTypeSchema,
    title: z.string().min(1).max(200),
    kind: workflowViewNodeKindSchema,
    optional: z.boolean(),
    executionPath: z
      .array(
        z
          .object({
            containerNodeId: definitionNodeIdSchema,
            iteration: z.number().int().positive().max(100),
          })
          .strict(),
      )
      .max(8),
    attemptNumber: z.number().int().positive().max(100),
    parentNodeRunId: workflowNodeRunIdSchema.optional(),
    status: workflowNodeRunStatusSchema,
    outcomeCode: z.string().min(1).max(64).optional(),
    publicSummary: z.string().min(1).max(500).optional(),
    error: z
      .object({
        code: z.string().min(1).max(64),
        summary: z.string().min(1).max(500),
      })
      .strict()
      .optional(),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    revision: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
    allowedActions: z.array(workflowNodeAllowedActionSchema).max(2),
  })
  .strict();

export const workflowRunViewDtoSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_API_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    workflowViewDefinitionId: workflowViewDefinitionIdSchema,
    title: z.string().min(1).max(160),
    viewHash: sha256Schema,
    sourceKind: z.enum(["legacy_code", "published_definition"]),
    historyCompleteness: z.enum(["complete", "legacy_limited"]),
    definitionNodes: z.array(workflowDefinitionNodeDtoSchema).min(1).max(100),
    edges: z.array(workflowViewEdgeSchema).max(200),
    nodeRuns: z.array(workflowNodeRunSummaryDtoSchema).max(500),
    revision: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
    allowedActions: z.tuple([z.literal("inspect_nodes")]),
  })
  .strict();

export const workflowNodeManifestDtoSchema = z
  .object({
    direction: z.enum(["input", "output"]),
    slots: z
      .array(
        z
          .object({
            name: z.string().min(1).max(64),
            refs: z.array(nodeProductRefSchema).min(1).max(50),
          })
          .strict(),
      )
      .max(30),
    sha256: sha256Schema,
    revision: z.number().int().positive(),
  })
  .strict();

export const workflowNodeTimelineItemDtoSchema = z
  .object({
    nodeSequence: z.number().int().positive(),
    fromStatus: workflowNodeRunStatusSchema.optional(),
    toStatus: workflowNodeRunStatusSchema,
    reasonKind: z.enum([
      "queued",
      "started",
      "waiting_human",
      "resumed",
      "completed",
      "skipped",
      "failed",
      "cancelled",
      "outcome_unknown",
      "projected",
    ]),
    relatedProductRef: nodeProductRefSchema.optional(),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const workflowNodeDetailDtoSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_API_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    viewHash: sha256Schema,
    node: workflowNodeRunSummaryDtoSchema,
    input: workflowNodeManifestDtoSchema.optional(),
    output: workflowNodeManifestDtoSchema.optional(),
    timeline: z.array(workflowNodeTimelineItemDtoSchema).max(500).optional(),
    evidence: z.array(nodeProductRefSchema).max(200).optional(),
    revision: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const workflowNodeDetailIncludeSchema = z.enum([
  "summary",
  "manifests",
  "timeline",
  "evidence",
]);

export type WorkflowDefinitionNodeDto = z.infer<typeof workflowDefinitionNodeDtoSchema>;
export type WorkflowNodeRunSummaryDto = z.infer<typeof workflowNodeRunSummaryDtoSchema>;
export type WorkflowRunViewDto = z.infer<typeof workflowRunViewDtoSchema>;
export type WorkflowNodeManifestDto = z.infer<typeof workflowNodeManifestDtoSchema>;
export type WorkflowNodeTimelineItemDto = z.infer<typeof workflowNodeTimelineItemDtoSchema>;
export type WorkflowNodeDetailDto = z.infer<typeof workflowNodeDetailDtoSchema>;
export type WorkflowNodeDetailInclude = z.infer<typeof workflowNodeDetailIncludeSchema>;
