import { z } from "zod";
import { WORKFLOW_DEFINITION_CONTRACT_LIMITS } from "./workflow-definition.js";
import { sha256Schema } from "./hash.js";
import {
  approvalRequestIdSchema,
  artifactIdSchema,
  decisionIdSchema,
  executionCandidateIdSchema,
  executionContractIdSchema,
  messageIdSchema,
  memoryResultSnapshotIdSchema,
  noteCandidateIdSchema,
  noteDecisionIdSchema,
  noteRevisionIdSchema,
  nodeRunTransitionIdSchema,
  nodeValueManifestIdSchema,
  planRevisionIdSchema,
  planningMemorySelectionIdSchema,
  planningProjectContextIdSchema,
  projectIdSchema,
  ruleRevisionIdSchema,
  ruleSelectionIdSchema,
  productRunIdSchema,
  validationResultIdSchema,
  workflowPolicyResolutionIdSchema,
  workflowDefinitionIdSchema,
  workflowNodeRunIdSchema,
  workflowViewDefinitionIdSchema,
} from "./ids.js";

/**
 * 用户可见Workflow节点身份。它属于Definition/View局部空间，不是Vercel Step、
 * Workflow Run或pi Session身份；运行时实例另由workflowNodeRunId标识。
 */
export const definitionNodeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,99}$/u)
  .brand("definition-node");

export const workflowNodeTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u)
  .max(100)
  .brand("workflow-node-type");

export const workflowViewNodeKindSchema = z.enum([
  "task",
  "human_review",
  "composite",
  "product_commit",
]);

export const workflowViewNodeSchema = z
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

export const workflowViewEdgeSchema = z
  .object({
    from: definitionNodeIdSchema,
    to: definitionNodeIdSchema,
    kind: z.enum(["control", "outcome", "loop_back"]),
    outcomeCode: z.string().min(1).max(64).optional(),
  })
  .strict();

const workflowViewSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("legacy_code"),
      blueprintKey: z.string().min(1).max(80),
      blueprintVersion: z.string().min(1).max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal("published_definition"),
      workflowDefinitionId: workflowDefinitionIdSchema,
      definitionRevision: z.number().int().positive(),
      definitionSha256: sha256Schema,
      blueprintKey: z.string().min(1).max(80),
      blueprintVersion: z.string().min(1).max(50),
    })
    .strict(),
]);

/**
 * 一次Run绑定的用户可见结构快照。坐标、Executor key和Runtime身份刻意不在合同中；
 * 历史Viewer因此不依赖当前代码或最新Definition重新猜图。
 */
export const workflowViewDefinitionSchema = z
  .object({
    schemaVersion: z.literal("workflow-view-definition.v1"),
    workflowViewDefinitionId: workflowViewDefinitionIdSchema,
    title: z.string().min(1).max(160),
    source: workflowViewSourceSchema,
    nodes: z.array(workflowViewNodeSchema).min(1).max(100),
    edges: z.array(workflowViewEdgeSchema).max(200),
    sha256: sha256Schema,
    revision: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const workflowNodeRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_human",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "outcome_unknown",
]);

export const workflowExecutionPathSegmentSchema = z
  .object({
    containerNodeId: definitionNodeIdSchema,
    iteration: z.number().int().positive().max(100),
  })
  .strict();

export const workflowNodePublicErrorSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
    summary: z.string().min(1).max(500),
  })
  .strict();

/** Product正文由各自聚合拥有；Manifest只保存严格类型化的版本引用。 */
const productRefBase = {
  revision: z.number().int().positive(),
  sha256: sha256Schema,
  label: z.string().min(1).max(200),
};

export const nodeProductRefSchema = z.discriminatedUnion("kind", [
  z.object({ ...productRefBase, kind: z.literal("message"), id: messageIdSchema }).strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("context_package"),
      id: z.string().regex(/^ctxp_[A-Za-z0-9]+$/u),
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("memory_result_snapshot"),
      id: memoryResultSnapshotIdSchema,
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("planning_memory_selection"),
      id: planningMemorySelectionIdSchema,
    })
    .strict(),
  z.object({ ...productRefBase, kind: z.literal("project"), id: projectIdSchema }).strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("planning_project_context"),
      id: planningProjectContextIdSchema,
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("rule_revision"),
      id: ruleRevisionIdSchema,
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("rule_selection"),
      id: ruleSelectionIdSchema,
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("plan_revision"),
      id: planRevisionIdSchema,
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("approval_request"),
      id: approvalRequestIdSchema,
    })
    .strict(),
  z.object({ ...productRefBase, kind: z.literal("decision"), id: decisionIdSchema }).strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("note_candidate"),
      id: noteCandidateIdSchema,
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("note_decision"),
      id: noteDecisionIdSchema,
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("note_revision"),
      id: noteRevisionIdSchema,
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("workflow_policy_resolution"),
      id: workflowPolicyResolutionIdSchema,
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("execution_contract"),
      id: executionContractIdSchema,
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("execution_candidate"),
      id: executionCandidateIdSchema,
    })
    .strict(),
  z
    .object({
      ...productRefBase,
      kind: z.literal("validation_result"),
      id: validationResultIdSchema,
    })
    .strict(),
  z.object({ ...productRefBase, kind: z.literal("artifact"), id: artifactIdSchema }).strict(),
]);

export const nodeValueManifestSlotSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
    refs: z.array(nodeProductRefSchema).min(1).max(50),
  })
  .strict();

export const nodeValueManifestSchema = z
  .object({
    schemaVersion: z.literal("node-value-manifest.v1"),
    nodeValueManifestId: nodeValueManifestIdSchema,
    workflowNodeRunId: workflowNodeRunIdSchema,
    direction: z.enum(["input", "output"]),
    slots: z
      .array(nodeValueManifestSlotSchema)
      .max(WORKFLOW_DEFINITION_CONTRACT_LIMITS.projection.maxManifestSlots),
    sha256: sha256Schema,
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const workflowNodeRunSchema = z
  .object({
    schemaVersion: z.literal("workflow-node-run.v1"),
    workflowNodeRunId: workflowNodeRunIdSchema,
    productRunId: productRunIdSchema,
    workflowViewDefinitionId: workflowViewDefinitionIdSchema,
    definitionNodeId: definitionNodeIdSchema,
    nodeType: workflowNodeTypeSchema,
    nodeSchemaVersion: z.string().min(1).max(50),
    executionPath: z.array(workflowExecutionPathSegmentSchema).max(8),
    attemptNumber: z.number().int().positive().max(100),
    parentNodeRunId: workflowNodeRunIdSchema.optional(),
    status: workflowNodeRunStatusSchema,
    outcomeCode: z.string().min(1).max(64).optional(),
    inputManifestId: nodeValueManifestIdSchema.optional(),
    outputManifestId: nodeValueManifestIdSchema.optional(),
    publicSummary: z.string().min(1).max(500).optional(),
    error: workflowNodePublicErrorSchema.optional(),
    projectionSource: z.enum(["runtime", "legacy_product_facts"]),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const nodeRunTransitionSchema = z
  .object({
    schemaVersion: z.literal("node-run-transition.v1"),
    nodeRunTransitionId: nodeRunTransitionIdSchema,
    workflowNodeRunId: workflowNodeRunIdSchema,
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
    projectionSource: z.enum(["runtime", "legacy_product_facts"]),
    occurredAt: z.iso.datetime(),
    revision: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type DefinitionNodeId = z.infer<typeof definitionNodeIdSchema>;
export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>;
export type WorkflowViewDefinition = z.infer<typeof workflowViewDefinitionSchema>;
export type WorkflowViewNode = z.infer<typeof workflowViewNodeSchema>;
export type WorkflowViewEdge = z.infer<typeof workflowViewEdgeSchema>;
export type WorkflowNodeRunStatus = z.infer<typeof workflowNodeRunStatusSchema>;
export type WorkflowNodeRun = z.infer<typeof workflowNodeRunSchema>;
export type NodeRunTransition = z.infer<typeof nodeRunTransitionSchema>;
export type NodeValueManifest = z.infer<typeof nodeValueManifestSchema>;
export type NodeValueManifestSlot = z.infer<typeof nodeValueManifestSlotSchema>;
export type NodeProductRef = z.infer<typeof nodeProductRefSchema>;
