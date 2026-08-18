import { z } from "zod";
import {
  approvalRequestIdSchema,
  decisionIdSchema,
  messageIdSchema,
  planIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  contextPackageIdSchema,
  memoryBackendIdSchema,
  memoryImportIntentIdSchema,
  memoryImportResultIdSchema,
  memoryQueryIdSchema,
  memoryResultSnapshotIdSchema,
  workflowDefinitionIdSchema,
  workflowDefinitionRevisionIdSchema,
  workflowRunSpecIdSchema,
} from "./ids.js";
import {
  approvalRequestStatusSchema,
  decisionKindSchema,
  messageContentSchema,
  messageRoleSchema,
  planContentSchema,
  planRevisionStatusSchema,
  productRunPhaseSchema,
  productRunStatusSchema,
  runFailureSchema,
} from "./product.js";
import { NOTE_TAG_LABEL_MAX_CHARACTERS, NOTE_TAG_MAX_COUNT, noteKindSchema } from "./note.js";
import { sha256Schema } from "./hash.js";
import { memoryContextSelectionSchema, memoryLayerSchema } from "./context.js";
import {
  memoryImportCapabilitiesSchema,
  memoryImportSourceSelectionSchema,
} from "./memory-import.js";
import {
  WORKFLOW_DEFINITION_CONTRACT_LIMITS,
  workflowBlueprintKeySchema,
  workflowDefinitionNodeIdSchema,
  workflowDefinitionNodeTypeSchema,
  workflowExecutorKindSchema,
  workflowRiskLevelSchema,
  workflowReviewModeSchema,
  workflowRunConfigurationSchema,
  workflowRunnerFamilySchema,
} from "./workflow-definition.js";

/**
 * B2公开Query/Command网络DTO（任务书§12）。
 *
 * 不变量：
 * - Command payload全部strict：浏览器试图指定Provider、模型或Runtime参数时
 *   直接以validation_failed拒绝，而不是静默忽略。
 * - Query响应携带schemaVersion、revision、updatedAt与允许的动作。
 * - 公开合同永远不出现Workflow Run ID、Hook Token、pi Session ID、
 *   百炼Request ID或服务器路径。
 */

export const PRODUCT_API_SCHEMA_VERSION = "chat-product-api.v1";

/* ---------- Command payloads ---------- */

export const createSessionPayloadSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

export const noteCaptureSubmitSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("full_message"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("selection"),
      startUtf16: z.number().int().nonnegative(),
      endUtf16: z.number().int().positive(),
      selectedTextSha256: sha256Schema,
    })
    .strict()
    .refine((value) => value.startUtf16 < value.endUtf16, {
      message: "Note选区起点必须小于终点",
      path: ["endUtf16"],
    }),
]);

export const noteCaptureSubmitInputSchema = z
  .object({
    kind: z.literal("note_capture"),
    source: noteCaptureSubmitSourceSchema.optional(),
    defaultKind: noteKindSchema.optional(),
    suggestedTagLabels: z
      .array(z.string().trim().min(1).max(NOTE_TAG_LABEL_MAX_CHARACTERS))
      .max(NOTE_TAG_MAX_COUNT)
      .optional(),
  })
  .strict();

export const submitMessagePayloadSchema = z
  .object({
    text: z.string().min(1).max(4000),
    context: z
      .object({
        memory: memoryContextSelectionSchema,
      })
      .strict()
      .optional(),
    /**
     * S4兼容期：旧客户端不传时，服务端显式映射到system Planning已发布Revision。
     * 浏览器只能提交有限选择；不能提交Executor key、Runtime ID、Secret或任意Graph。
     */
    workflowSelection: z
      .object({
        kind: z.literal("published_revision"),
        workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
        definitionSha256: sha256Schema,
        runConfiguration: workflowRunConfigurationSchema.optional(),
        businessInput: noteCaptureSubmitInputSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const submitDecisionPayloadSchema = z
  .object({
    approvalRequestId: approvalRequestIdSchema,
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    planSha256: sha256Schema,
    kind: decisionKindSchema,
    /** request_revision必填、非空、有长度上限。 */
    revisionInstruction: z.string().min(1).max(2000).optional(),
    /** reject可选、有长度上限。 */
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict()
  .check((ctx) => {
    const value = ctx.value;
    if (value.kind === "request_revision" && value.revisionInstruction === undefined) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "request_revision必须携带revisionInstruction",
        path: ["revisionInstruction"],
      });
    }
    if (value.kind !== "request_revision" && value.revisionInstruction !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "只有request_revision允许携带revisionInstruction",
        path: ["revisionInstruction"],
      });
    }
    if (value.kind !== "reject" && value.reason !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "只有reject允许携带reason",
        path: ["reason"],
      });
    }
  });

export const createMemoryImportPayloadSchema = z
  .object({
    sourceSelection: memoryImportSourceSelectionSchema,
    backendId: memoryBackendIdSchema,
    title: z.string().min(1).max(200),
    tags: z.array(z.string().min(1).max(64)).max(20),
  })
  .strict();

export const reconcileMemoryImportPayloadSchema = z.object({}).strict();

export type CreateSessionPayload = z.infer<typeof createSessionPayloadSchema>;
export type NoteCaptureSubmitInput = z.infer<typeof noteCaptureSubmitInputSchema>;
export type SubmitMessagePayload = z.infer<typeof submitMessagePayloadSchema>;
export type SubmitDecisionPayload = z.infer<typeof submitDecisionPayloadSchema>;
export type CreateMemoryImportPayload = z.infer<typeof createMemoryImportPayloadSchema>;
export type ReconcileMemoryImportPayload = z.infer<typeof reconcileMemoryImportPayloadSchema>;

/* ---------- Configurable Workflow公开Query DTO ---------- */

const publicConfigFieldSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("boolean"),
      name: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      defaultValue: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.union([z.literal("enum_select"), z.literal("review_mode")]),
      name: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      defaultValue: z.string().min(1).max(80),
      options: z.array(z.string().min(1).max(80)).min(1).max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("bounded_integer"),
      name: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      defaultValue: z.number().int(),
      minimum: z.number().int(),
      maximum: z.number().int(),
    })
    .strict(),
  z
    .object({
      type: z.literal("short_text"),
      name: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      defaultValue: z.string().max(200),
      maximumLength: z.number().int().positive().max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal("tag_list"),
      name: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      maxItems: z.number().int().positive().max(NOTE_TAG_MAX_COUNT),
      maxLabelLength: z.number().int().positive().max(NOTE_TAG_LABEL_MAX_CHARACTERS),
    })
    .strict(),
  z
    .object({
      type: z.union([
        z.enum(["resource_selector", "memory_provider_selector"]),
        z.literal("rule_selector"),
        z.literal("skill_selector"),
        z.literal("note_source_selector"),
      ]),
      name: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      multiple: z.boolean(),
      required: z.boolean(),
    })
    .strict(),
]);

export const workflowNodeCatalogItemDtoSchema = z
  .object({
    nodeType: workflowDefinitionNodeTypeSchema,
    schemaVersion: z.number().int().positive().max(32),
    displayName: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    category: z.enum([
      "context",
      "policy",
      "agent",
      "human",
      "execution",
      "validation",
      "commit",
      "note",
    ]),
    executorKind: workflowExecutorKindSchema,
    riskPolicy: workflowRiskLevelSchema,
    /** 仅公开是否允许默认跳过，不公开默认outcome/value等执行细节。 */
    canDefaultSkip: z.boolean(),
    // Provider写节点首期由独立耐久Workflow承载，尚未开放给通用Blueprint时为空。
    supportedBlueprints: z.array(workflowBlueprintKeySchema).max(4),
    publicConfigFields: z.array(publicConfigFieldSchema).max(16),
    outcomes: z.array(z.string().min(1).max(64)).min(1).max(32),
  })
  .strict();

export const workflowCatalogDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    nodes: z.array(workflowNodeCatalogItemDtoSchema).max(64),
  })
  .strict();

export const workflowBlueprintDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    blueprintKey: workflowBlueprintKeySchema,
    blueprintVersion: z.number().int().positive().max(32),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1000),
    runnerFamily: workflowRunnerFamilySchema,
    terminalNodeType: workflowDefinitionNodeTypeSchema,
    optionalNodeTypes: z.array(workflowDefinitionNodeTypeSchema).max(32),
    loopRules: z
      .array(
        z
          .object({
            outcomeNodeType: workflowDefinitionNodeTypeSchema,
            continueOutcomes: z.array(z.string().min(1).max(64)).min(1).max(16),
            exitOutcomes: z.array(z.string().min(1).max(64)).min(1).max(16),
            maxIterations: z
              .number()
              .int()
              .positive()
              .max(WORKFLOW_DEFINITION_CONTRACT_LIMITS.structure.maxLoopIterations),
          })
          .strict(),
      )
      .max(8),
    perRunOverrides: z
      .array(
        z
          .object({
            nodeType: workflowDefinitionNodeTypeSchema,
            fields: z
              .array(z.enum(["enabled", "selection", "reviewMode"]))
              .min(1)
              .max(8),
          })
          .strict(),
      )
      .max(32),
    reviewModes: z.array(workflowReviewModeSchema).min(1).max(3),
  })
  .strict();

export const workflowBlueprintsDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    blueprints: z.array(workflowBlueprintDtoSchema).max(16),
  })
  .strict();

export const workflowDefinitionPublishedDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    workflowDefinitionId: workflowDefinitionIdSchema,
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    definitionRevision: z.number().int().positive(),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1000),
    blueprintKey: workflowBlueprintKeySchema,
    blueprintVersion: z.number().int().positive().max(32),
    definitionSha256: sha256Schema,
    ownerKind: z.enum(["system", "principal"]),
    isDefault: z.boolean(),
    nodes: z
      .array(
        z
          .object({
            definitionNodeId: workflowDefinitionNodeIdSchema,
            nodeType: workflowDefinitionNodeTypeSchema,
            schemaVersion: z.number().int().positive().max(32),
            displayName: z.string().min(1).max(120),
            optional: z.boolean(),
            defaultActivation: z.enum(["enabled", "skipped"]),
            publicConfigFields: z.array(publicConfigFieldSchema).max(16),
          })
          .strict(),
      )
      .max(100),
    publishedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const workflowDefinitionsDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    definitions: z.array(workflowDefinitionPublishedDtoSchema).max(100),
  })
  .strict();

export const workflowRunConfigSummaryDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema.optional(),
    runnerFamily: workflowRunnerFamilySchema,
    runnerBundleVersion: z.string().min(1).max(128),
    definition: workflowDefinitionPublishedDtoSchema.optional(),
    definitionSha256: sha256Schema.optional(),
    nodeCount: z.number().int().nonnegative().max(100),
    resourceSummary: z
      .array(
        z
          .object({
            definitionNodeId: workflowDefinitionNodeIdSchema,
            resourceKind: z.enum(["memory", "project", "rule", "skill"]),
            resolution: z.enum(["included", "excluded"]),
            reason: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(128),
    reviewSummary: z
      .array(
        z
          .object({
            definitionNodeId: workflowDefinitionNodeIdSchema,
            mode: workflowReviewModeSchema,
            actor: z.enum(["user", "system_policy"]),
          })
          .strict(),
      )
      .max(16),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const workflowResourceRefDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    resourceKind: z.enum(["memory", "project", "rule", "skill"]),
    resourceId: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z][a-z0-9]*_[A-Za-z0-9]+$/),
    revision: z.number().int().positive(),
    sha256: sha256Schema,
    status: z.enum(["active", "archived"]),
    label: z.string().min(1).max(200),
    source: z.string().min(1).max(80),
  })
  .strict();

export const workflowResourcesDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    resources: z.array(workflowResourceRefDtoSchema).max(500),
  })
  .strict();

export type WorkflowCatalogDto = z.infer<typeof workflowCatalogDtoSchema>;
export type WorkflowBlueprintDto = z.infer<typeof workflowBlueprintDtoSchema>;
export type WorkflowBlueprintsDto = z.infer<typeof workflowBlueprintsDtoSchema>;
export type WorkflowDefinitionPublishedDto = z.infer<typeof workflowDefinitionPublishedDtoSchema>;
export type WorkflowDefinitionsDto = z.infer<typeof workflowDefinitionsDtoSchema>;
export type WorkflowRunConfigSummaryDto = z.infer<typeof workflowRunConfigSummaryDtoSchema>;
export type WorkflowResourceRefDto = z.infer<typeof workflowResourceRefDtoSchema>;
export type WorkflowResourcesDto = z.infer<typeof workflowResourcesDtoSchema>;

/* ---------- Memory backend 与 Run Context ---------- */

export const memoryBackendProfileDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    backendId: memoryBackendIdSchema,
    displayName: z.string().min(1).max(100),
    kind: z.enum(["memmy", "tencent_memorycore"]),
    configured: z.boolean(),
    health: z.enum(["ready", "unavailable"]),
    capabilities: z
      .object({
        query: z.literal(true),
        tags: z.boolean(),
        layers: z.array(memoryLayerSchema).min(1).max(4),
        maxLimit: z.number().int().positive().max(20),
        maxContextBudget: z.number().int().min(128).max(8_192),
        import: memoryImportCapabilitiesSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const memoryContextSourceDtoSchema = z
  .object({
    memoryResultSnapshotId: memoryResultSnapshotIdSchema,
    backendId: memoryBackendIdSchema,
    title: z.string().min(1).max(200),
    kind: z.enum(["trace", "span", "policy", "world_model", "skill"]),
    memoryLayer: memoryLayerSchema,
    tags: z.array(z.string().min(1).max(64)).max(50),
    revision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

const runContextMemoryBase = {
  backendId: memoryBackendIdSchema,
  requirement: z.enum(["required", "optional"]),
  memoryQueryId: memoryQueryIdSchema,
};

export const runContextMemoryDtoSchema = z.discriminatedUnion("queryStatus", [
  z.object({ ...runContextMemoryBase, queryStatus: z.literal("pending") }).strict(),
  z
    .object({
      ...runContextMemoryBase,
      queryStatus: z.literal("completed"),
      hitCount: z.number().int().nonnegative(),
      adoptedCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...runContextMemoryBase,
      queryStatus: z.literal("failed"),
      errorCode: z
        .string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
        .max(64),
    })
    .strict(),
]);

export const runContextDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    memory: runContextMemoryDtoSchema.optional(),
    contextPackage: z
      .object({
        contextPackageId: contextPackageIdSchema,
        revision: z.number().int().positive(),
        sha256: sha256Schema,
        sources: z.array(memoryContextSourceDtoSchema).max(20),
        exclusions: z
          .array(
            z
              .object({
                backendId: memoryBackendIdSchema,
                reasonCode: z.string().min(1).max(64),
              })
              .strict(),
          )
          .max(20),
      })
      .strict()
      .optional(),
  })
  .strict();

export type MemoryBackendProfileDto = z.infer<typeof memoryBackendProfileDtoSchema>;
export type RunContextDto = z.infer<typeof runContextDtoSchema>;

/* ---------- Memory Import Query DTO ---------- */

const memoryImportDtoBase = {
  schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
  memoryImportIntentId: memoryImportIntentIdSchema,
  memoryImportResultId: memoryImportResultIdSchema,
  sessionId: productSessionIdSchema,
  sourceMessageId: messageIdSchema,
  selectionKind: z.enum(["full_message", "utf16_range"]),
  sourcePreview: z.string().min(1).max(500),
  backendId: memoryBackendIdSchema,
  backendDisplayName: z.string().min(1).max(100),
  memoryLayer: z.enum(["L0", "L2"]),
  title: z.string().min(1).max(200),
  tags: z.array(z.string().min(1).max(64)).max(20),
  resultRevision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const memoryImportDtoSchema = z.discriminatedUnion("status", [
  z
    .object({ ...memoryImportDtoBase, status: z.literal("queued"), allowedActions: z.tuple([]) })
    .strict(),
  z
    .object({
      ...memoryImportDtoBase,
      status: z.literal("dispatching"),
      allowedActions: z.union([z.tuple([]), z.tuple([z.literal("reconcile")])]),
    })
    .strict(),
  z
    .object({
      ...memoryImportDtoBase,
      status: z.literal("accepted"),
      externalObjectId: z.string().min(1).max(200),
      allowedActions: z.tuple([z.literal("reconcile")]),
    })
    .strict(),
  z
    .object({
      ...memoryImportDtoBase,
      status: z.literal("materialized"),
      externalObjectId: z.string().min(1).max(200),
      allowedActions: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...memoryImportDtoBase,
      status: z.literal("failed"),
      errorCode: z.string().min(1).max(64),
      summary: z.string().min(1).max(500),
      allowedActions: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...memoryImportDtoBase,
      status: z.literal("outcome_unknown"),
      errorCode: z.string().min(1).max(64),
      allowedActions: z.tuple([z.literal("reconcile")]),
    })
    .strict(),
]);

export type MemoryImportDto = z.infer<typeof memoryImportDtoSchema>;

/* ---------- Query DTO ---------- */

export const sessionDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    sessionId: productSessionIdSchema,
    status: z.enum(["active", "archived"]),
    title: z.string().min(1).max(200).optional(),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const messageDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    messageId: messageIdSchema,
    sessionId: productSessionIdSchema,
    sessionSequence: z.number().int().positive(),
    role: messageRoleSchema,
    content: messageContentSchema,
    sourceRunId: productRunIdSchema.optional(),
    /** 服务端对正式Message正文计算的版本化Hash，用于绑定导入选区。 */
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict();

/** 精确Message Query响应；只返回已通过Session归属校验的公开产品事实。 */
export const messageResponseSchema = z.object({ message: messageDtoSchema }).strict();

export const planDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    status: planRevisionStatusSchema,
    sha256: sha256Schema,
    content: planContentSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const approvalDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    approvalRequestId: approvalRequestIdSchema,
    productRunId: productRunIdSchema,
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    planSha256: sha256Schema,
    status: approvalRequestStatusSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const runAllowedActionSchema = z.enum(["request_revision", "approve", "reject"]);

export const runDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    sessionId: productSessionIdSchema,
    sourceMessageId: messageIdSchema,
    status: productRunStatusSchema,
    phase: productRunPhaseSchema,
    currentPlan: z
      .object({
        planId: planIdSchema,
        planRevision: z.number().int().positive(),
        status: planRevisionStatusSchema,
        sha256: sha256Schema,
      })
      .strict()
      .optional(),
    currentApprovalRequestId: approvalRequestIdSchema.optional(),
    finalMessageId: messageIdSchema.optional(),
    failure: runFailureSchema.optional(),
    maxPlanRevisions: z.number().int().positive().optional(),
    /** 浏览器只根据本字段呈现可执行动作，不自行猜测状态机。 */
    allowedActions: z.array(runAllowedActionSchema),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const decisionDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    decisionId: decisionIdSchema,
    approvalRequestId: approvalRequestIdSchema,
    productRunId: productRunIdSchema,
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    planSha256: sha256Schema,
    kind: decisionKindSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export type SessionDto = z.infer<typeof sessionDtoSchema>;
export type MessageDto = z.infer<typeof messageDtoSchema>;
export type MessageResponse = z.infer<typeof messageResponseSchema>;
export type PlanDto = z.infer<typeof planDtoSchema>;
export type ApprovalDto = z.infer<typeof approvalDtoSchema>;
export type RunDto = z.infer<typeof runDtoSchema>;
export type DecisionDto = z.infer<typeof decisionDtoSchema>;
export type RunAllowedAction = z.infer<typeof runAllowedActionSchema>;
