import { z } from "zod";
import {
  approvalRequestIdSchema,
  agentVersionIdSchema,
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
  promptReviewRequestIdSchema,
  directAgentCandidateIdSchema,
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
import { agentProfileAgentKeySchema, agentProfileDtoSchema } from "./agent-profile-api.js";
import {
  memoryContextSelectionSchema,
  memoryLayerSchema,
  workspaceInstructionsInputSchema,
} from "./context.js";
import {
  memoryImportCapabilitiesSchema,
  memoryImportSourceSelectionSchema,
} from "./memory-import.js";
import {
  WORKFLOW_DEFINITION_CONTRACT_LIMITS,
  workflowBlueprintKeySchema,
  workflowDefinitionNodeIdSchema,
  workflowDefinitionNodeTypeSchema,
  workflowDefinitionNodeTypeV2Schema,
  workflowDefinitionNodeTypeV3Schema,
  workflowExecutorKindSchema,
  workflowRiskLevelSchema,
  workflowReviewModeSchema,
  workflowRunConfigurationSchema,
  workflowRunnerFamilySchema,
  workflowRunnerFamilyV3Schema,
} from "./workflow-definition.js";
import {
  promptAssemblyV2Schema,
  promptAssemblyV3Schema,
  promptAssemblyV4Schema,
  promptAssemblyV6Schema,
  promptBearingNodeTypeSchema,
  promptTurnSelectionInputSchema,
} from "./prompt-assembly.js";

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
export const PROMPT_TURN_PREVIEW_API_SCHEMA_VERSION = "chat-prompt-turn-preview-api.v2";
export const LEGACY_WORKFLOW_PRODUCT_API_SCHEMA_VERSION = "chat-workflow-product-api.v2";
export const WORKFLOW_PRODUCT_API_SCHEMA_VERSION = "chat-workflow-product-api.v3";
export const WORKFLOW_PRODUCT_API_V3_SCHEMA_VERSION = WORKFLOW_PRODUCT_API_SCHEMA_VERSION;

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
    /** 可省略表示空用户选择；服务端仍为所有新Run冻结精确Prompt Assembly。 */
    promptSelection: promptTurnSelectionInputSchema.optional(),
    context: z
      .object({
        memory: memoryContextSelectionSchema.optional(),
        workspaceInstructions: workspaceInstructionsInputSchema.optional(),
      })
      .strict()
      .refine(
        (value) => value.memory !== undefined || value.workspaceInstructions !== undefined,
        "context至少包含一种上下文",
      )
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

/** 发送前只读解析；与正式提交使用同一个Workflow Compiler和Prompt Compiler。 */
export const previewPromptTurnPayloadSchema = z
  .object({
    sessionId: productSessionIdSchema.optional(),
    message: submitMessagePayloadSchema,
  })
  .strict();

export const promptTurnPreviewDtoSchema = z
  .object({
    schemaVersion: z.literal(PROMPT_TURN_PREVIEW_API_SCHEMA_VERSION),
    status: z.literal("pre_send"),
    currentInput: z.string().min(1).max(4_000),
    assembly: z.union([
      promptAssemblyV2Schema,
      promptAssemblyV3Schema,
      promptAssemblyV4Schema,
      promptAssemblyV6Schema,
    ]),
    nodes: z
      .array(
        z
          .object({
            definitionNodeId: workflowDefinitionNodeIdSchema,
            nodeType: promptBearingNodeTypeSchema,
            agent: agentProfileDtoSchema,
            runtimeResolution: z
              .object({
                stage: z.enum([
                  "direct_pre_send",
                  "direct_pre_send_dynamic_extension",
                  "workflow_node_template",
                  "deferred_step_runtime",
                ]),
                governedSystemPromptAppend: z.string().max(512_000),
                toolResolution: z.enum(["frozen", "runtime_deferred"]),
                note: z.string().min(1).max(1_000),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
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
export type PreviewPromptTurnPayload = z.infer<typeof previewPromptTurnPayloadSchema>;
export type PromptTurnPreviewDto = z.infer<typeof promptTurnPreviewDtoSchema>;
export type SubmitDecisionPayload = z.infer<typeof submitDecisionPayloadSchema>;
export type CreateMemoryImportPayload = z.infer<typeof createMemoryImportPayloadSchema>;
export type ReconcileMemoryImportPayload = z.infer<typeof reconcileMemoryImportPayloadSchema>;

/* ---------- Configurable Workflow公开Query DTO ---------- */

export const publicConfigFieldSchema = z.discriminatedUnion("type", [
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
      type: z.literal("long_text"),
      name: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      defaultValue: z.string().max(65_536),
      maximumLength: z.number().int().positive().max(65_536),
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

export const workflowNodeCatalogItemV2DtoSchema = workflowNodeCatalogItemDtoSchema.extend({
  nodeType: workflowDefinitionNodeTypeV2Schema,
});

export const workflowCatalogV2DtoSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
    nodes: z.array(workflowNodeCatalogItemV2DtoSchema).max(64),
  })
  .strict();

export const workflowNodeCatalogItemV3DtoSchema = workflowNodeCatalogItemDtoSchema.extend({
  nodeType: workflowDefinitionNodeTypeV3Schema,
});

export const workflowCatalogDtoSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
    nodes: z.array(workflowNodeCatalogItemV3DtoSchema).max(64),
  })
  .strict();

export const workflowCatalogV3DtoSchema = workflowCatalogDtoSchema;

export const workflowBlueprintV2DtoSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
    blueprintKey: workflowBlueprintKeySchema,
    blueprintVersion: z.number().int().positive().max(32),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1000),
    runnerFamily: workflowRunnerFamilySchema,
    terminalNodeType: workflowDefinitionNodeTypeV2Schema,
    optionalNodeTypes: z.array(workflowDefinitionNodeTypeV2Schema).max(32),
    loopRules: z
      .array(
        z
          .object({
            outcomeNodeType: workflowDefinitionNodeTypeV2Schema,
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
            nodeType: workflowDefinitionNodeTypeV2Schema,
            fields: z.array(z.enum(["enabled", "selection", "reviewMode"])).max(8),
            configFields: z
              .array(
                z
                  .string()
                  .min(1)
                  .max(64)
                  .regex(/^[A-Za-z][A-Za-z0-9]*$/),
              )
              .max(16)
              .default([]),
          })
          .strict()
          .refine((value) => value.fields.length > 0 || value.configFields.length > 0, {
            message: "每个per-run override规则至少开放一个字段",
          }),
      )
      .max(32),
    reviewModes: z.array(workflowReviewModeSchema).min(1).max(3),
  })
  .strict();

export const workflowBlueprintDtoSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
    blueprintKey: workflowBlueprintKeySchema,
    blueprintVersion: z.number().int().positive().max(32),
    title: z.string().min(1).max(160),
    description: z.string().min(1).max(1000),
    runnerFamily: workflowRunnerFamilyV3Schema,
    terminalNodeType: workflowDefinitionNodeTypeV3Schema,
    optionalNodeTypes: z.array(workflowDefinitionNodeTypeV3Schema).max(32),
    loopRules: z
      .array(
        z
          .object({
            outcomeNodeType: workflowDefinitionNodeTypeV3Schema,
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
            nodeType: workflowDefinitionNodeTypeV3Schema,
            fields: z.array(z.enum(["enabled", "selection", "reviewMode"])).max(8),
            configFields: z
              .array(
                z
                  .string()
                  .min(1)
                  .max(64)
                  .regex(/^[A-Za-z][A-Za-z0-9]*$/),
              )
              .max(16)
              .default([]),
          })
          .strict()
          .refine((value) => value.fields.length > 0 || value.configFields.length > 0, {
            message: "每个per-run override规则至少开放一个字段",
          }),
      )
      .max(32),
    reviewModes: z.array(workflowReviewModeSchema).min(1).max(3),
  })
  .strict();

export const workflowBlueprintV3DtoSchema = workflowBlueprintDtoSchema;

export const workflowBlueprintsV2DtoSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
    blueprints: z.array(workflowBlueprintV2DtoSchema).max(16),
  })
  .strict();

export const workflowBlueprintsDtoSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
    blueprints: z.array(workflowBlueprintDtoSchema).max(16),
  })
  .strict();

export const workflowBlueprintsV3DtoSchema = workflowBlueprintsDtoSchema;

export const workflowDefinitionPublishedV2DtoSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
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
            nodeType: workflowDefinitionNodeTypeV2Schema,
            schemaVersion: z.number().int().positive().max(32),
            displayName: z.string().min(1).max(120),
            optional: z.boolean(),
            defaultActivation: z.enum(["enabled", "skipped"]),
            publicConfigFields: z.array(publicConfigFieldSchema).max(16),
            /** 当前Workflow真正允许在发送前覆盖的节点config字段。 */
            runConfigFields: z.array(publicConfigFieldSchema).max(16).default([]),
            /** Workflow节点只引用独立Agent；会话上下文不改变该绑定。 */
            agentBinding: z
              .object({
                agentKey: agentProfileAgentKeySchema,
                profileVersion: z.string().min(1).max(128),
                bindingKind: z.enum(["agent_catalog", "agent_version"]),
                agentVersionId: agentVersionIdSchema.optional(),
                agentVersionSha256: sha256Schema.optional(),
                promptPolicy: z.literal("agent_profile_plus_session_context"),
                promptSource: z.enum(["agent_default", "agent_version", "workflow_override"]),
                promptOverrideMarkdown: z.string().max(65_536).optional(),
                toolPolicy: z
                  .object({
                    kind: z.enum(["runtime_locked", "agent_configuration"]),
                    summary: z.string().min(1).max(300),
                    defaultTools: z.array(z.string().min(1).max(80)).max(16),
                  })
                  .strict(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(100),
    publishedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const workflowDefinitionPublishedDtoSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
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
            nodeType: workflowDefinitionNodeTypeV3Schema,
            schemaVersion: z.number().int().positive().max(32),
            displayName: z.string().min(1).max(120),
            optional: z.boolean(),
            defaultActivation: z.enum(["enabled", "skipped"]),
            publicConfigFields: z.array(publicConfigFieldSchema).max(16),
            runConfigFields: z.array(publicConfigFieldSchema).max(16).default([]),
            agentBinding: z
              .object({
                agentKey: agentProfileAgentKeySchema,
                profileVersion: z.string().min(1).max(128),
                bindingKind: z.enum(["agent_catalog", "agent_version"]),
                agentVersionId: agentVersionIdSchema.optional(),
                agentVersionSha256: sha256Schema.optional(),
                promptPolicy: z.literal("agent_profile_plus_session_context"),
                promptSource: z.enum(["agent_default", "agent_version", "workflow_override"]),
                promptOverrideMarkdown: z.string().max(65_536).optional(),
                toolPolicy: z
                  .object({
                    kind: z.enum(["runtime_locked", "agent_configuration"]),
                    summary: z.string().min(1).max(300),
                    defaultTools: z.array(z.string().min(1).max(80)).max(16),
                  })
                  .strict(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(100),
    publishedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const workflowDefinitionPublishedV3DtoSchema = workflowDefinitionPublishedDtoSchema;

export const workflowDefinitionsV2DtoSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
    definitions: z.array(workflowDefinitionPublishedV2DtoSchema).max(100),
  })
  .strict();

export const workflowDefinitionsDtoSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
    definitions: z.array(workflowDefinitionPublishedDtoSchema).max(100),
  })
  .strict();

export const workflowDefinitionsV3DtoSchema = workflowDefinitionsDtoSchema;

export const workflowRunConfigSummaryV2DtoSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema.optional(),
    runnerFamily: workflowRunnerFamilySchema,
    runnerBundleVersion: z.string().min(1).max(128),
    definition: workflowDefinitionPublishedV2DtoSchema.optional(),
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

export const workflowRunConfigSummaryDtoSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_PRODUCT_API_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema.optional(),
    runnerFamily: workflowRunnerFamilyV3Schema,
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

export const workflowRunConfigSummaryV3DtoSchema = workflowRunConfigSummaryDtoSchema;

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
export type WorkflowCatalogV2Dto = z.infer<typeof workflowCatalogV2DtoSchema>;
export type WorkflowCatalogV3Dto = z.infer<typeof workflowCatalogV3DtoSchema>;
export type WorkflowBlueprintDto = z.infer<typeof workflowBlueprintDtoSchema>;
export type WorkflowBlueprintV2Dto = z.infer<typeof workflowBlueprintV2DtoSchema>;
export type WorkflowBlueprintV3Dto = z.infer<typeof workflowBlueprintV3DtoSchema>;
export type WorkflowBlueprintsDto = z.infer<typeof workflowBlueprintsDtoSchema>;
export type WorkflowBlueprintsV2Dto = z.infer<typeof workflowBlueprintsV2DtoSchema>;
export type WorkflowBlueprintsV3Dto = z.infer<typeof workflowBlueprintsV3DtoSchema>;
export type WorkflowDefinitionPublishedDto = z.infer<typeof workflowDefinitionPublishedDtoSchema>;
export type WorkflowDefinitionPublishedV2Dto = z.infer<
  typeof workflowDefinitionPublishedV2DtoSchema
>;
export type WorkflowDefinitionPublishedV3Dto = z.infer<
  typeof workflowDefinitionPublishedV3DtoSchema
>;
export type WorkflowDefinitionsDto = z.infer<typeof workflowDefinitionsDtoSchema>;
export type WorkflowDefinitionsV2Dto = z.infer<typeof workflowDefinitionsV2DtoSchema>;
export type WorkflowDefinitionsV3Dto = z.infer<typeof workflowDefinitionsV3DtoSchema>;
export type WorkflowRunConfigSummaryDto = z.infer<typeof workflowRunConfigSummaryDtoSchema>;
export type WorkflowRunConfigSummaryV2Dto = z.infer<typeof workflowRunConfigSummaryV2DtoSchema>;
export type WorkflowRunConfigSummaryV3Dto = z.infer<typeof workflowRunConfigSummaryV3DtoSchema>;
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
    /** 客户端按运行类型选择互斥Query，不能仅凭共享phase猜测。 */
    runKind: z.enum(["planning", "note_capture", "direct_agent"]),
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
    currentPromptReviewRequestId: promptReviewRequestIdSchema.optional(),
    currentDirectAgentCandidateId: directAgentCandidateIdSchema.optional(),
    finalDirectAgentCandidateId: directAgentCandidateIdSchema.optional(),
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

export const submitMessageResponseSchema = z
  .object({ message: messageDtoSchema, run: runDtoSchema })
  .strict();

/** 首轮Message命令的响应；Session只能由Chat Application在同一事务内创建。 */
export const startSessionMessageResponseSchema = z
  .object({ session: sessionDtoSchema, message: messageDtoSchema, run: runDtoSchema })
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
export type SubmitMessageResponse = z.infer<typeof submitMessageResponseSchema>;
export type StartSessionMessageResponse = z.infer<typeof startSessionMessageResponseSchema>;
export type DecisionDto = z.infer<typeof decisionDtoSchema>;
export type RunAllowedAction = z.infer<typeof runAllowedActionSchema>;
