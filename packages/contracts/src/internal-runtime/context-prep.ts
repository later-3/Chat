/**
 * 内部Runtime合同 context-prep 族。对外经../internal-runtime.js barrel。
 */
import { z } from "zod";
import {
  commandIdSchema,
  productRunIdSchema,
  workflowRunSpecIdSchema,
  ruleSelectionIdSchema,
  ruleIdSchema,
  ruleRevisionIdSchema,
} from "../ids.js";
import { sha256Schema } from "../hash.js";
import { memoryResultSnapshotSchema } from "../context.js";
import { workflowExecutionPathSegmentSchema } from "../workflow-run.js";
import { versioned, internalPlanningMemorySelectionRefSchema } from "./shared.js";

/** Memory正文只通过本私有响应进入单个Step；Selection/Node/Manifest只保存引用。 */
export const preparePlanningMemoryContextRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    definitionNodeId: z.string().min(1).max(120),
    executionPath: z.array(workflowExecutionPathSegmentSchema).max(8),
    attemptNumber: z.number().int().positive().max(100),
  })
  .strict();

export const preparedMemorySnapshotSchema = memoryResultSnapshotSchema.pick({
  memoryResultSnapshotId: true,
  revision: true,
  sha256: true,
  title: true,
  kind: true,
  memoryLayer: true,
  content: true,
  tags: true,
  tokenEstimate: true,
});

export const preparePlanningMemoryContextResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...versioned,
      status: z.literal("none"),
      productRunId: productRunIdSchema,
      workflowRunSpecId: workflowRunSpecIdSchema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      status: z.literal("ready"),
      productRunId: productRunIdSchema,
      workflowRunSpecId: workflowRunSpecIdSchema,
      selectionRef: internalPlanningMemorySelectionRefSchema,
      snapshots: z.array(preparedMemorySnapshotSchema).min(1).max(20),
      totalContentCharacters: z.number().int().positive().max(1_000_000),
    })
    .strict(),
]);

export const preparePlanningRulesContextRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    definitionNodeId: z.string().min(1).max(120),
    executionPath: z.array(workflowExecutionPathSegmentSchema).max(8),
    attemptNumber: z.number().int().positive().max(100),
  })
  .strict();

export const preparedRuleContentSchema = z
  .object({
    ruleId: ruleIdSchema,
    ruleRevisionId: ruleRevisionIdSchema,
    ruleRevisionSha256: sha256Schema,
    body: z.string().min(1).max(8_000),
  })
  .strict();

export const preparePlanningRulesContextResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...versioned,
      status: z.literal("none"),
      productRunId: productRunIdSchema,
      workflowRunSpecId: workflowRunSpecIdSchema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      status: z.literal("ready"),
      productRunId: productRunIdSchema,
      workflowRunSpecId: workflowRunSpecIdSchema,
      selectionRef: z
        .object({
          ruleSelectionId: ruleSelectionIdSchema,
          revision: z.literal(1),
          sha256: sha256Schema,
        })
        .strict(),
      rules: z.array(preparedRuleContentSchema).max(100),
      totalContentCharacters: z.number().int().nonnegative().max(200_000),
    })
    .strict(),
]);

/* ---------- S5 note capture runtime ---------- */

/**
 * Runtime只能提交候选正文；来源由Application从RunSpec.businessInput派生并复核。
 * strict schema故意不接受source/sourceRefs，防止Workflow凭runtime key伪造跨Message来源。
 */
