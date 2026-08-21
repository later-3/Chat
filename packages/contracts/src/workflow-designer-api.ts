import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  principalIdSchema,
  workflowDefinitionIdSchema,
  workflowDefinitionRevisionIdSchema,
} from "./ids.js";
import { PRODUCT_API_SCHEMA_VERSION } from "./product-api.js";
import { agentKeySchema } from "./agent-profile-api.js";
import {
  WORKFLOW_DEFINITION_CONTRACT_LIMITS,
  workflowBlueprintKeySchema,
  workflowDefaultActivationSchema,
  workflowDefinitionNodeIdSchema,
  workflowDefinitionNodeTypeSchema,
  workflowDefinitionRevisionStateSchema,
  workflowDefinitionStateSchema,
  workflowSequenceBoundarySchema,
} from "./workflow-definition.js";

/**
 * S6公开合同只允许操作受限semanticRoot。React Flow坐标、edge、Executor身份、
 * Runtime Token与任意JSON Patch不属于保存payload，也不会进入Definition Hash。
 */

export const workflowDesignerAddressSegmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("choice_branch"),
      fromDefinitionNodeId: workflowDefinitionNodeIdSchema,
      outcome: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal("loop_body"),
      outcomeFromDefinitionNodeId: workflowDefinitionNodeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("nested_sequence"),
      index: z.number().int().nonnegative().max(127),
    })
    .strict(),
]);

export const workflowDesignerAddressSchema = z
  .array(workflowDesignerAddressSegmentSchema)
  .max(WORKFLOW_DEFINITION_CONTRACT_LIMITS.structure.maxDepth);

const workflowDesignerElementTargetSchema = z
  .object({ definitionNodeId: workflowDefinitionNodeIdSchema })
  .strict();

/**
 * 浏览器工作副本只持久化这组受限语义操作。它没有edge、表达式、URL、Executor key
 * 或任意对象值；真正保存/发布时Application仍重新校验完整semanticRoot。
 */
export const workflowDesignerOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("insert_task"),
      slotId: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/u),
      index: z.number().int().nonnegative().max(127),
      nodeType: workflowDefinitionNodeTypeSchema,
      definitionNodeId: workflowDefinitionNodeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("move_element"),
      target: workflowDesignerElementTargetSchema,
      slotId: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/u),
      index: z.number().int().nonnegative().max(127),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remove_optional_task"),
      target: workflowDesignerElementTargetSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_default_activation"),
      target: workflowDesignerElementTargetSchema,
      activation: workflowDefaultActivationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_node_config"),
      target: workflowDesignerElementTargetSchema,
      fieldName: z.string().regex(/^[a-z][A-Za-z0-9_]{0,63}$/u),
      value: z.union([
        z.boolean(),
        z.number().int(),
        z.string().max(65_536),
        z.array(z.string().min(1).max(64)).max(20),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wrap_in_choice"),
      fromDefinitionNodeId: workflowDefinitionNodeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("move_into_branch"),
      target: workflowDesignerElementTargetSchema,
      fromDefinitionNodeId: workflowDefinitionNodeIdSchema,
      outcome: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
      index: z.number().int().nonnegative().max(127),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unwrap_choice"),
      fromDefinitionNodeId: workflowDefinitionNodeIdSchema,
      preserveOutcome: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wrap_in_bounded_loop"),
      address: workflowDesignerAddressSchema,
      startIndex: z.number().int().nonnegative().max(127),
      endIndexExclusive: z.number().int().positive().max(128),
      outcomeFromDefinitionNodeId: workflowDefinitionNodeIdSchema,
      maxIterations: z
        .number()
        .int()
        .positive()
        .max(WORKFLOW_DEFINITION_CONTRACT_LIMITS.structure.maxLoopIterations),
      exceededPolicy: z.enum(["fail", "request_human"]),
    })
    .strict()
    .refine((operation) => operation.startIndex < operation.endIndexExclusive, {
      message: "BoundedLoop起点必须小于终点",
      path: ["endIndexExclusive"],
    }),
  z
    .object({
      kind: z.literal("update_loop_policy"),
      outcomeFromDefinitionNodeId: workflowDefinitionNodeIdSchema,
      maxIterations: z
        .number()
        .int()
        .positive()
        .max(WORKFLOW_DEFINITION_CONTRACT_LIMITS.structure.maxLoopIterations),
      exceededPolicy: z.enum(["fail", "request_human"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unwrap_loop"),
      outcomeFromDefinitionNodeId: workflowDefinitionNodeIdSchema,
    })
    .strict(),
]);

export const workflowDesignerSlotDtoSchema = z
  .object({
    slotId: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/u),
    address: z.array(workflowDesignerAddressSegmentSchema).max(12),
    label: z.string().min(1).max(120),
    allowedNodeTypes: z.array(workflowDefinitionNodeTypeSchema).min(1).max(32),
    minimumIndex: z.number().int().nonnegative().max(127),
    maximumIndex: z.number().int().nonnegative().max(127),
    maximumElements: z.number().int().positive().max(128).optional(),
  })
  .strict()
  .refine((slot) => slot.minimumIndex <= slot.maximumIndex, {
    message: "slot minimumIndex不能大于maximumIndex",
    path: ["maximumIndex"],
  });

export const workflowDesignerDiagnosticSeveritySchema = z.enum(["error", "warning", "info"]);

const diagnosticParamSchema = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

export const workflowDesignerDiagnosticDtoSchema = z
  .object({
    family: z.enum(["definition_invalid", "policy_denied", "resource_stale", "limit_exceeded"]),
    code: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),
    path: z.string().min(1).max(500),
    severity: workflowDesignerDiagnosticSeveritySchema,
    params: z.record(z.string().max(80), diagnosticParamSchema),
    help: z.string().min(1).max(500).optional(),
  })
  .strict();

export const workflowDefinitionRevisionSummaryDtoSchema = z
  .object({
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    definitionRevision: z.number().int().positive(),
    state: workflowDefinitionRevisionStateSchema,
    definitionSha256: sha256Schema,
    createdAt: z.iso.datetime(),
    publishedAt: z.iso.datetime().optional(),
  })
  .strict();

const definitionDetailBase = {
  schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
  workflowDefinitionId: workflowDefinitionIdSchema,
  ownerKind: z.enum(["system", "principal"]),
  ownerPrincipalId: principalIdSchema.optional(),
  key: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(1_000),
  blueprintKey: workflowBlueprintKeySchema,
  blueprintVersion: z.number().int().positive().max(32),
  status: workflowDefinitionStateSchema,
  revision: z.number().int().positive(),
  publishedRevision: workflowDefinitionRevisionSummaryDtoSchema.optional(),
  currentDraftRevision: workflowDefinitionRevisionSummaryDtoSchema.optional(),
  slots: z.array(workflowDesignerSlotDtoSchema).max(64),
  allowedChoiceSourceTypes: z.array(workflowDefinitionNodeTypeSchema).max(32),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const workflowDefinitionDetailDtoSchema = z.discriminatedUnion("compatibility", [
  z
    .object({
      ...definitionDetailBase,
      compatibility: z.literal("editable"),
      semanticRoot: workflowSequenceBoundarySchema,
      baseRevisionId: workflowDefinitionRevisionIdSchema,
      baseDefinitionSha256: sha256Schema,
      allowedActions: z.array(
        z.enum(["copy", "save", "validate", "publish", "archive", "restore"]),
      ),
    })
    .strict(),
  z
    .object({
      ...definitionDetailBase,
      compatibility: z.literal("read_only_incompatible"),
      safeStructureSummary: z
        .object({
          nodeCount: z.number().int().nonnegative().max(128),
          nodeTypes: z.array(workflowDefinitionNodeTypeSchema).max(64),
        })
        .strict(),
      incompatibilityCode: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),
      allowedActions: z.tuple([]),
    })
    .strict(),
]);

export const createWorkflowDefinitionCopyPayloadSchema = z
  .object({
    sourceWorkflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    sourceDefinitionSha256: sha256Schema,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000),
  })
  .strict();

/**
 * 面向普通配置页的窄命令：把一个Agent节点的模板引用与Prompt差异保存成已发布Workflow。
 * System Workflow会派生个人副本；个人Workflow会原子发布下一Revision。
 */
export const saveWorkflowAgentNodeConfigurationPayloadSchema = z
  .object({
    sourceWorkflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    sourceDefinitionSha256: sha256Schema,
    definitionNodeId: workflowDefinitionNodeIdSchema,
    agentKey: agentKeySchema,
    promptOverrideMarkdown: z.string().max(65_536).optional(),
  })
  .strict();

export const saveWorkflowDefinitionDraftPayloadSchema = z
  .object({
    baseRevisionId: workflowDefinitionRevisionIdSchema,
    baseDefinitionSha256: sha256Schema,
    semanticRoot: workflowSequenceBoundarySchema,
  })
  .strict();

export const validateWorkflowDefinitionPayloadSchema = z
  .object({
    workflowDefinitionId: workflowDefinitionIdSchema.optional(),
    baseRevisionId: workflowDefinitionRevisionIdSchema,
    baseDefinitionSha256: sha256Schema,
    blueprintKey: workflowBlueprintKeySchema,
    blueprintVersion: z.number().int().positive().max(32),
    semanticRoot: workflowSequenceBoundarySchema,
  })
  .strict();

export const publishWorkflowDefinitionPayloadSchema = z
  .object({
    draftRevisionId: workflowDefinitionRevisionIdSchema,
    draftDefinitionSha256: sha256Schema,
  })
  .strict();

export const changeWorkflowDefinitionArchiveStatusPayloadSchema = z
  .object({
    targetStatus: z.enum(["active", "archived"]),
    publishedRevisionId: workflowDefinitionRevisionIdSchema,
    publishedDefinitionSha256: sha256Schema,
  })
  .strict();

export const workflowDefinitionValidationDtoSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_API_SCHEMA_VERSION),
    valid: z.boolean(),
    diagnostics: z.array(workflowDesignerDiagnosticDtoSchema).max(256),
    normalized: z
      .object({
        semanticRoot: workflowSequenceBoundarySchema,
        definitionSha256: sha256Schema,
        nodeCount: z.number().int().nonnegative().max(128),
      })
      .strict()
      .optional(),
  })
  .strict()
  .check((ctx) => {
    if (ctx.value.valid !== (ctx.value.normalized !== undefined)) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "valid与normalized必须同时成立",
        path: ["normalized"],
      });
    }
    if (ctx.value.valid && ctx.value.diagnostics.some((item) => item.severity === "error")) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "valid结果不能含error诊断",
        path: ["diagnostics"],
      });
    }
  });

export const workflowDefinitionCommandResultDtoSchema = z
  .object({
    definition: workflowDefinitionDetailDtoSchema,
    affectedRevision: workflowDefinitionRevisionSummaryDtoSchema.optional(),
  })
  .strict();

export type WorkflowDesignerSlotDto = z.infer<typeof workflowDesignerSlotDtoSchema>;
export type WorkflowDesignerAddress = z.infer<typeof workflowDesignerAddressSchema>;
export type WorkflowDesignerOperation = z.infer<typeof workflowDesignerOperationSchema>;
export type WorkflowDesignerDiagnosticDto = z.infer<typeof workflowDesignerDiagnosticDtoSchema>;
export type WorkflowDefinitionRevisionSummaryDto = z.infer<
  typeof workflowDefinitionRevisionSummaryDtoSchema
>;
export type WorkflowDefinitionDetailDto = z.infer<typeof workflowDefinitionDetailDtoSchema>;
export type CreateWorkflowDefinitionCopyPayload = z.infer<
  typeof createWorkflowDefinitionCopyPayloadSchema
>;
export type SaveWorkflowAgentNodeConfigurationPayload = z.infer<
  typeof saveWorkflowAgentNodeConfigurationPayloadSchema
>;
export type SaveWorkflowDefinitionDraftPayload = z.infer<
  typeof saveWorkflowDefinitionDraftPayloadSchema
>;
export type ValidateWorkflowDefinitionPayload = z.infer<
  typeof validateWorkflowDefinitionPayloadSchema
>;
export type PublishWorkflowDefinitionPayload = z.infer<
  typeof publishWorkflowDefinitionPayloadSchema
>;
export type ChangeWorkflowDefinitionArchiveStatusPayload = z.infer<
  typeof changeWorkflowDefinitionArchiveStatusPayloadSchema
>;
export type WorkflowDefinitionValidationDto = z.infer<typeof workflowDefinitionValidationDtoSchema>;
export type WorkflowDefinitionCommandResultDto = z.infer<
  typeof workflowDefinitionCommandResultDtoSchema
>;
