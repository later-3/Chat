import { z } from "zod";
import { sha256Schema } from "./hash.js";
import { noteKindSchema, noteSourceRefSchema, noteTagsSchema } from "./note.js";
import {
  productRunIdSchema,
  principalIdSchema,
  workflowDefinitionIdSchema,
  workflowDefinitionRevisionIdSchema,
  workflowRunSpecIdSchema,
} from "./ids.js";

/**
 * S4正式Workflow Definition持久合同。
 *
 * 约束：
 * - Definition是可变聚合身份；Revision与RunSpec是不可变产品事实。
 * - 合同只描述有限节点、有限配置和安全公开摘要；Executor key、Runtime ID、
 *   Hook Token、Credential与任意代码都不进入这里。
 * - Application Compiler必须直接复用本文件Schema，避免S3实验Schema与持久合同漂移。
 */

export const workflowDefinitionNodeTypeSchema = z.enum([
  "context.memory",
  "context.project",
  "policy.rules",
  "capability.skills",
  "agent.research",
  "agent.plan",
  "human.plan_review",
  "execute.plan",
  "result.validate",
  "product.commit",
  "note.extract",
  "note.classify",
  "human.note_review",
  "note.commit",
]);

export const workflowBlueprintKeySchema = z.enum(["planning", "note"]);
export const workflowDefinitionStateSchema = z.enum(["active", "archived"]);
export const workflowDefinitionRevisionStateSchema = z.enum(["draft", "published", "superseded"]);
export const workflowExecutorKindSchema = z.enum(["step", "human_review", "composite"]);
export const workflowRiskLevelSchema = z.enum([
  "read_context",
  "generate_candidate",
  "human_decision",
  "external_effect",
  "product_commit",
]);
export const workflowReviewModeSchema = z.enum([
  "manual",
  "auto_continue_if_policy_allows",
  "always_auto",
]);
export const workflowDefaultActivationSchema = z.enum(["enabled", "skipped"]);

export const workflowRunnerFamilySchema = z.enum([
  "legacy-planning.v1",
  "definition-kernel-lab.v1",
  "configurable-planning.v1",
  "note-capture.v1",
]);

export const workflowRunnerEvidenceSchema = z
  .object({
    runnerFamily: workflowRunnerFamilySchema,
    runnerBundleVersion: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
  })
  .strict();

export const WORKFLOW_DEFINITION_CONTRACT_LIMITS = Object.freeze({
  request: { maxDefinitionBytes: 128 * 1024 },
  structure: {
    maxDepth: 12,
    maxNodes: 64,
    maxBranches: 24,
    maxLoops: 8,
    maxNestedLoops: 2,
    maxLoopIterations: 5,
  },
  runtime: {
    maxNodeExecutions: 256,
    maxCompositeChildren: 32,
    maxWaits: 16,
  },
  projection: {
    maxManifestSlots: 30,
    maxPreviewBytes: 16 * 1024,
  },
} as const);

export const workflowDefinitionNodeIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

const outcomeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

const configSchema = z.record(z.string().min(1).max(64), z.unknown());

const taskSchema = z
  .object({
    kind: z.literal("task"),
    definitionNodeId: workflowDefinitionNodeIdSchema,
    nodeType: workflowDefinitionNodeTypeSchema,
    schemaVersion: z.number().int().min(1).max(32),
    config: configSchema,
    defaultActivation: workflowDefaultActivationSchema.optional(),
  })
  .strict();

const compositeSchema = z
  .object({
    kind: z.literal("composite"),
    definitionNodeId: workflowDefinitionNodeIdSchema,
    nodeType: workflowDefinitionNodeTypeSchema,
    schemaVersion: z.number().int().min(1).max(32),
    config: configSchema,
    defaultActivation: workflowDefaultActivationSchema.optional(),
  })
  .strict();

export type WorkflowDefinitionElement =
  | z.infer<typeof taskSchema>
  | z.infer<typeof compositeSchema>
  | {
      readonly kind: "sequence";
      readonly elements: readonly WorkflowDefinitionElement[];
    }
  | {
      readonly kind: "choice";
      readonly fromDefinitionNodeId: string;
      readonly branches: readonly {
        readonly outcome: string;
        readonly body: WorkflowDefinitionSequence;
      }[];
    }
  | {
      readonly kind: "bounded_loop";
      readonly body: WorkflowDefinitionSequence;
      readonly outcomeFromDefinitionNodeId: string;
      readonly continueOutcomes: readonly string[];
      readonly exitOutcomes: readonly string[];
      readonly maxIterations: number;
      readonly exceededPolicy: "fail" | "request_human";
    };

export interface WorkflowDefinitionSequence {
  readonly kind: "sequence";
  readonly elements: readonly WorkflowDefinitionElement[];
}

const workflowElementBoundarySchema: z.ZodType<WorkflowDefinitionElement> = z.lazy(() =>
  z.union([
    workflowSequenceBoundarySchema,
    taskSchema,
    choiceSchema,
    boundedLoopSchema,
    compositeSchema,
  ]),
);

export const workflowSequenceBoundarySchema: z.ZodType<WorkflowDefinitionSequence> = z.lazy(() =>
  z
    .object({
      kind: z.literal("sequence"),
      elements: z
        .array(workflowElementBoundarySchema)
        .max(WORKFLOW_DEFINITION_CONTRACT_LIMITS.structure.maxNodes * 2),
    })
    .strict(),
);

const choiceSchema = z
  .object({
    kind: z.literal("choice"),
    fromDefinitionNodeId: workflowDefinitionNodeIdSchema,
    branches: z
      .array(
        z
          .object({
            outcome: outcomeSchema,
            body: workflowSequenceBoundarySchema,
          })
          .strict(),
      )
      .min(1)
      .max(WORKFLOW_DEFINITION_CONTRACT_LIMITS.structure.maxBranches),
  })
  .strict();

const boundedLoopSchema = z
  .object({
    kind: z.literal("bounded_loop"),
    body: workflowSequenceBoundarySchema,
    outcomeFromDefinitionNodeId: workflowDefinitionNodeIdSchema,
    continueOutcomes: z.array(outcomeSchema).min(1).max(16),
    exitOutcomes: z.array(outcomeSchema).min(1).max(16),
    maxIterations: z.number().int().min(1).max(1_000),
    exceededPolicy: z.enum(["fail", "request_human"]),
  })
  .strict();

export const workflowDefinitionRevisionInputSchema = z
  .object({
    schemaVersion: z.literal("workflow-definition-revision-input.v1"),
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    definitionRevision: z.number().int().min(1),
    blueprintKey: workflowBlueprintKeySchema,
    blueprintVersion: z.number().int().min(1).max(32),
    semanticRoot: workflowSequenceBoundarySchema,
    expectedSha256: sha256Schema.optional(),
  })
  .strict();

export const workflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal("workflow-definition.v1"),
    workflowDefinitionId: workflowDefinitionIdSchema,
    ownerKind: z.enum(["system", "principal"]),
    ownerPrincipalId: principalIdSchema.optional(),
    key: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9_.-]*$/),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1000),
    blueprintKey: workflowBlueprintKeySchema,
    blueprintVersion: z.number().int().min(1).max(32),
    status: workflowDefinitionStateSchema,
    publishedRevisionId: workflowDefinitionRevisionIdSchema.optional(),
    currentDraftRevisionId: workflowDefinitionRevisionIdSchema.optional(),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .check((ctx) => {
    if (ctx.value.ownerKind === "system" && ctx.value.ownerPrincipalId !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "system Definition不得携带ownerPrincipalId",
        path: ["ownerPrincipalId"],
      });
    }
    if (ctx.value.ownerKind === "system" && ctx.value.currentDraftRevisionId !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "system Definition不得携带可编辑Draft",
        path: ["currentDraftRevisionId"],
      });
    }
    if (ctx.value.ownerKind === "principal" && ctx.value.ownerPrincipalId === undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "principal Definition必须携带ownerPrincipalId",
        path: ["ownerPrincipalId"],
      });
    }
  });

export const workflowDefinitionRevisionSchema = z
  .object({
    schemaVersion: z.literal("workflow-definition-revision.v1"),
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    workflowDefinitionId: workflowDefinitionIdSchema,
    definitionRevision: z.number().int().positive(),
    state: workflowDefinitionRevisionStateSchema,
    blueprintKey: workflowBlueprintKeySchema,
    blueprintVersion: z.number().int().min(1).max(32),
    title: z.string().min(1).max(160),
    semanticRoot: workflowSequenceBoundarySchema,
    definitionSha256: sha256Schema,
    basedOnRevisionId: workflowDefinitionRevisionIdSchema.optional(),
    revision: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    publishedAt: z.iso.datetime().optional(),
    supersededAt: z.iso.datetime().optional(),
  })
  .strict();

export type WorkflowResourceKind = "memory" | "project" | "rule" | "skill";

export const workflowFrozenResourceSchema = z
  .object({
    resourceKind: z.enum(["memory", "project", "rule", "skill"]),
    resourceId: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z][a-z0-9]*_[A-Za-z0-9]+$/),
    revision: z.number().int().min(1),
    sha256: sha256Schema,
    status: z.enum(["active", "archived"]),
    allowedPrincipalIds: z.array(principalIdSchema).max(100),
  })
  .strict();

export const workflowPrincipalSnapshotSchema = z
  .object({
    principalId: principalIdSchema,
    capabilities: z
      .array(
        z
          .string()
          .min(1)
          .max(80)
          .regex(/^[a-z][a-z0-9_.-]*$/),
      )
      .max(64),
  })
  .strict();

const selectedResourceRefSchema = z
  .object({
    resourceId: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z][a-z0-9]*_[A-Za-z0-9]+$/),
    expectedRevision: z.number().int().min(1),
    expectedSha256: sha256Schema,
  })
  .strict();

const nodeEnabledOverrideSchema = z
  .object({
    kind: z.literal("node_enabled"),
    definitionNodeId: workflowDefinitionNodeIdSchema,
    enabled: z.boolean(),
  })
  .strict();

const resourceSelectionOverrideSchema = z
  .object({
    kind: z.literal("resource_selection"),
    definitionNodeId: workflowDefinitionNodeIdSchema,
    resourceKind: z.enum(["memory", "project", "rule", "skill"]),
    required: z.boolean(),
    selections: z.array(selectedResourceRefSchema).max(32),
  })
  .strict();

const reviewModeOverrideSchema = z
  .object({
    kind: z.literal("review_mode"),
    definitionNodeId: workflowDefinitionNodeIdSchema,
    reviewMode: workflowReviewModeSchema,
  })
  .strict();

export const workflowRunOverrideSchema = z.discriminatedUnion("kind", [
  nodeEnabledOverrideSchema,
  resourceSelectionOverrideSchema,
  reviewModeOverrideSchema,
]);

export const workflowRunConfigurationSchema = z
  .object({
    schemaVersion: z.literal("workflow-run-configuration.v1"),
    overrides: z.array(workflowRunOverrideSchema).max(64),
  })
  .strict();

export const workflowExecutorManifestEntrySchema = z
  .object({
    nodeType: workflowDefinitionNodeTypeSchema,
    schemaVersion: z.number().int().min(1).max(32),
    executorVersion: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
  })
  .strict();

const resolvedResourceBase = {
  definitionNodeId: z.string(),
  resourceKind: z.enum(["memory", "project", "rule", "skill"]),
} as const;

const frozenSelectedResourceFields = {
  resourceId: z.string(),
  expectedRevision: z.number().int().min(1),
  expectedSha256: sha256Schema,
} as const;

export const workflowResolvedResourceSchema = z.union([
  z
    .object({
      ...resolvedResourceBase,
      ...frozenSelectedResourceFields,
      resolution: z.literal("included"),
    })
    .strict(),
  z
    .object({
      ...resolvedResourceBase,
      ...frozenSelectedResourceFields,
      resolution: z.literal("excluded"),
      exclusionReason: z.enum([
        "not_found",
        "archived",
        "forbidden",
        "revision_stale",
        "hash_mismatch",
      ]),
    })
    .strict(),
  z
    .object({
      ...resolvedResourceBase,
      resolution: z.literal("excluded"),
      exclusionReason: z.literal("not_selected"),
    })
    .strict(),
]);

export const workflowNodeResolutionSchema = z
  .object({
    definitionNodeId: z.string(),
    nodeType: workflowDefinitionNodeTypeSchema,
    schemaVersion: z.number().int().min(1),
    config: z.record(z.string(), z.unknown()),
    activation: z.enum(["enabled", "skipped"]),
    skipOutcome: z.string().optional(),
  })
  .strict();

export const workflowReviewResolutionSchema = z
  .object({
    definitionNodeId: z.string(),
    mode: workflowReviewModeSchema,
    actor: z.enum(["user", "system_policy"]),
    policyRef: z
      .object({
        resourceId: z.string(),
        revision: z.number().int().min(1),
        sha256: sha256Schema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const workflowRunBusinessInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("planning_message"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("note_capture"),
      source: noteSourceRefSchema,
      defaultKind: noteKindSchema,
      suggestedTags: noteTagsSchema,
    })
    .strict(),
]);

export const workflowKernelLimitsSchema = z
  .object({
    request: z.object({ maxDefinitionBytes: z.number().int().positive() }).strict(),
    structure: z
      .object({
        maxDepth: z.number().int().positive(),
        maxNodes: z.number().int().positive(),
        maxBranches: z.number().int().positive(),
        maxLoops: z.number().int().positive(),
        maxNestedLoops: z.number().int().positive(),
        maxLoopIterations: z.number().int().positive(),
      })
      .strict(),
    runtime: z
      .object({
        maxNodeExecutions: z.number().int().positive(),
        maxCompositeChildren: z.number().int().positive(),
        maxWaits: z.number().int().positive(),
      })
      .strict(),
    projection: z
      .object({
        maxManifestSlots: z.number().int().positive(),
        maxPreviewBytes: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export const workflowRunSpecSchema = z
  .object({
    schemaVersion: z.literal("workflow-run-spec.v1"),
    workflowRunSpecId: workflowRunSpecIdSchema,
    productRunId: productRunIdSchema,
    definitionRef: z
      .object({
        workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
        definitionRevision: z.number().int().min(1),
        definitionSha256: sha256Schema,
        blueprintKey: workflowBlueprintKeySchema,
        blueprintVersion: z.number().int().min(1),
      })
      .strict(),
    runner: workflowRunnerEvidenceSchema,
    semanticRoot: workflowSequenceBoundarySchema,
    nodeResolutions: z.array(workflowNodeResolutionSchema).max(64),
    resourceResolutions: z.array(workflowResolvedResourceSchema).max(128),
    reviewResolutions: z.array(workflowReviewResolutionSchema).max(16),
    businessInput: workflowRunBusinessInputSchema.optional(),
    limits: workflowKernelLimitsSchema,
    executorManifest: z.array(workflowExecutorManifestEntrySchema).max(64),
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export type WorkflowDefinitionRevisionInput = z.infer<typeof workflowDefinitionRevisionInputSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowDefinitionRevision = z.infer<typeof workflowDefinitionRevisionSchema>;
export type WorkflowFrozenResource = z.infer<typeof workflowFrozenResourceSchema>;
export type WorkflowPrincipalSnapshot = z.infer<typeof workflowPrincipalSnapshotSchema>;
export type WorkflowRunOverride = z.infer<typeof workflowRunOverrideSchema>;
export type WorkflowRunConfiguration = z.infer<typeof workflowRunConfigurationSchema>;
export type WorkflowExecutorManifestEntry = z.infer<typeof workflowExecutorManifestEntrySchema>;
export type WorkflowRunnerEvidence = z.infer<typeof workflowRunnerEvidenceSchema>;
export type WorkflowResolvedResource = z.infer<typeof workflowResolvedResourceSchema>;
export type WorkflowNodeResolution = z.infer<typeof workflowNodeResolutionSchema>;
export type WorkflowReviewResolution = z.infer<typeof workflowReviewResolutionSchema>;
export type WorkflowRunBusinessInput = z.infer<typeof workflowRunBusinessInputSchema>;
export type WorkflowRunSpec = z.infer<typeof workflowRunSpecSchema>;
