import { z } from "zod";
import {
  approvalRequestIdSchema,
  commandIdSchema,
  decisionIdSchema,
  executionCandidateIdSchema,
  executionContractIdSchema,
  messageIdSchema,
  outboxEntryIdSchema,
  planIdSchema,
  principalIdSchema,
  productRunIdSchema,
  revisionInputIdSchema,
  runAttemptIdSchema,
  validationResultIdSchema,
  contextPackageIdSchema,
  contextRequestIdSchema,
  memoryBackendIdSchema,
  memoryQueryIdSchema,
  memoryResultSnapshotIdSchema,
  memoryImportIntentIdSchema,
  memoryImportResultIdSchema,
  noteCandidateIdSchema,
  noteDecisionIdSchema,
  productSessionIdSchema,
  workflowDefinitionRevisionIdSchema,
  workflowRunSpecIdSchema,
  planningProjectContextIdSchema,
  planningMemorySelectionIdSchema,
  projectIdSchema,
  ruleSelectionIdSchema,
  ruleIdSchema,
  ruleRevisionIdSchema,
  workflowPolicyResolutionIdSchema,
  workflowMemoryQueryIdSchema,
  workflowMemorySnapshotIdSchema,
  workflowMemoryContextIdSchema,
  memoryWriteIntentIdSchema,
  memoryWriteResultIdSchema,
} from "./ids.js";
import {
  decisionKindSchema,
  executionCandidateSchema,
  executionContractSchema,
  planContentSchema,
  validationResultSchema,
} from "./product.js";
import { sha256Schema } from "./hash.js";
import {
  memoryBackendDescriptorSchema,
  memoryLayerSchema,
  memoryRequirementSchema,
  memoryResultSnapshotSchema,
  workspaceInstructionsSnapshotSchema,
} from "./context.js";
import { memoryImportIntentSchema, memoryImportResultSchema } from "./memory-import.js";
import {
  NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS,
  NOTE_TAG_LABEL_MAX_CHARACTERS,
  NOTE_TAG_MAX_COUNT,
  noteKindSchema,
  noteSourceRefSchema,
} from "./note.js";
import {
  noteCandidateReviewDtoSchema,
  noteDecisionDtoSchema,
  noteRevisionInputSchema,
} from "./note-api.js";
import {
  MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
  MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
} from "./versions.js";
import { workflowRunSpecSchema, workflowRunnerFamilySchema } from "./workflow-definition.js";
import { workflowExecutionPathSegmentSchema } from "./workflow-run.js";
import { planningProjectSnapshotSchema } from "./planning-project-context.js";
import { ruleSelectionSourceSchema } from "./rules.js";
import {
  memoryProviderDescriptorSchema,
  memoryWriteIntentSchema,
  memoryWriteResultSchema,
  workflowMemoryCategorySchema,
} from "./workflow-memory.js";

/**
 * 后端私有Runtime合同（任务书§12.4）。
 *
 * 边界：
 * - 只接受产品对象引用和稳定命令身份，不接受浏览器原始决定。
 * - 只监听loopback + 仅服务端持有的Runtime凭据；与公开API分Router、
 *   分DTO、分授权测试，不进入OpenAPI/前端客户端或浏览器Bundle。
 * - 所有写命令仍经过strict Zod、Application Coordinator、CAS、Trace与幂等。
 * - 原始Workflow/Hook/pi身份不进入本合同。
 */

export const INTERNAL_RUNTIME_SCHEMA_VERSION = "chat-internal-runtime.v1";

const versioned = { schemaVersion: z.literal(INTERNAL_RUNTIME_SCHEMA_VERSION) };
const contextPackageRefFields = {
  contextPackageId: contextPackageIdSchema,
  revision: z.literal(1),
  sha256: sha256Schema,
};
export const internalContextPackageRefSchema = z.object(contextPackageRefFields).strict();
const internalPlanningProjectContextRefSchema = z
  .object({
    planningProjectContextId: planningProjectContextIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
  })
  .strict();
const internalPlanningMemorySelectionRefSchema = z
  .object({
    planningMemorySelectionId: planningMemorySelectionIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
  })
  .strict();
const internalWorkspaceInstructionsRefSchema = z
  .object({
    contextRequestId: contextRequestIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
  })
  .strict();
const internalRuleSelectionRefSchema = z
  .object({
    ruleSelectionId: ruleSelectionIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
  })
  .strict();
export const internalWorkflowMemoryContextRefSchema = z
  .object({
    workflowMemoryContextId: workflowMemoryContextIdSchema,
    revision: z.literal(1),
    sha256: sha256Schema,
  })
  .strict();

/* ---------- compilePlanningInput ---------- */

export const compilePlanningInputRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    planRevision: z.number().int().positive(),
    contextPackageRef: internalContextPackageRefSchema.optional(),
    planningMemorySelectionRef: internalPlanningMemorySelectionRefSchema.optional(),
    workflowMemoryContextRef: internalWorkflowMemoryContextRefSchema.optional(),
    planningProjectContextRef: internalPlanningProjectContextRefSchema.optional(),
    ruleSelectionRef: internalRuleSelectionRefSchema.optional(),
  })
  .strict();

/** 版本证据：Prompt模板与模型配置版本随Planning Input下发并进入Trace。 */
export const planningInputDtoSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    attemptId: runAttemptIdSchema,
    inputRunRevision: z.number().int().positive(),
    inputManifestSha256: sha256Schema,
    sourceMessageRef: z.object({ messageId: messageIdSchema, sha256: sha256Schema }).strict(),
    sourceMessageText: z.string().min(1),
    workspaceInstructions: z
      .object({
        ref: internalWorkspaceInstructionsRefSchema,
        snapshot: workspaceInstructionsSnapshotSchema,
      })
      .strict()
      .optional(),
    priorPlan: z
      .object({
        planId: planIdSchema,
        planRevision: z.number().int().positive(),
        sha256: sha256Schema,
        content: planContentSchema,
      })
      .strict()
      .optional(),
    revisionInstruction: z.string().min(1).optional(),
    memorySelection: z
      .object({
        ref: internalPlanningMemorySelectionRefSchema,
        items: z
          .array(
            z
              .object({
                refId: memoryResultSnapshotIdSchema,
                revision: z.literal(1),
                sha256: sha256Schema,
                title: z.string().min(1).max(200),
                kind: z.enum(["trace", "span", "policy", "world_model", "skill"]),
                memoryLayer: z.enum(["L1", "L2", "L3", "Skill"]),
                content: z.string().min(1).max(50_000),
                tags: z.array(z.string().min(1).max(64)).max(50),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict()
      .optional(),
    workflowMemory: z
      .object({
        ref: internalWorkflowMemoryContextRefSchema,
        items: z
          .array(
            z
              .object({
                refId: workflowMemorySnapshotIdSchema,
                revision: z.literal(1),
                sha256: sha256Schema,
                providerId: memoryBackendIdSchema,
                title: z.string().min(1).max(200),
                category: workflowMemoryCategorySchema,
                content: z.string().min(1).max(50_000),
                labels: z.array(z.string().min(1).max(64)).max(50),
              })
              .strict(),
          )
          .max(100),
        optionalFailures: z
          .array(
            z
              .object({
                providerId: memoryBackendIdSchema,
                errorCode: z.string().min(1).max(96),
              })
              .strict(),
          )
          .max(16),
        totalContentCharacters: z.number().int().nonnegative().max(200_000),
      })
      .strict()
      .optional(),
    contextPackage: z
      .object({
        ref: z
          .object({
            contextPackageId: contextPackageIdSchema,
            revision: z.number().int().positive(),
            sha256: sha256Schema,
          })
          .strict(),
        memory: z
          .object({
            backendId: z.string().min(1).max(100),
            items: z
              .array(
                z
                  .object({
                    refId: z.string().min(1).max(120),
                    revision: z.number().int().positive(),
                    sha256: sha256Schema,
                    title: z.string().min(1).max(200),
                    kind: z.enum(["trace", "span", "policy", "world_model", "skill"]),
                    memoryLayer: z.enum(["L1", "L2", "L3", "Skill"]),
                    content: z.string().min(1).max(50_000),
                    tags: z.array(z.string().min(1).max(64)).max(50),
                  })
                  .strict(),
              )
              .max(20),
            exclusions: z
              .array(
                z
                  .object({
                    backendId: z.string().min(1).max(100),
                    reasonCode: z.string().min(1).max(64),
                  })
                  .strict(),
              )
              .max(20),
          })
          .strict(),
      })
      .strict()
      .optional(),
    projectContext: z
      .object({
        ref: internalPlanningProjectContextRefSchema,
        projectId: projectIdSchema,
        projectRevision: z.number().int().positive(),
        projectSha256: sha256Schema,
        snapshot: planningProjectSnapshotSchema,
      })
      .strict()
      .optional(),
    rulesContext: z
      .object({
        ref: internalRuleSelectionRefSchema,
        rules: z
          .array(
            z
              .object({
                ruleId: ruleIdSchema,
                ruleRevisionId: ruleRevisionIdSchema,
                revision: z.number().int().positive(),
                sha256: sha256Schema,
                body: z.string().trim().min(1).max(8_000),
                source: ruleSelectionSourceSchema,
                priority: z.number().int().min(0).max(1_000),
              })
              .strict(),
          )
          .max(100),
        totalContentCharacters: z.number().int().nonnegative().max(200_000),
      })
      .strict()
      .optional(),
    planRevision: z.number().int().positive(),
    limits: z
      .object({
        maxTurns: z.number().int().positive(),
        timeoutMs: z.number().int().positive(),
        tokenBudget: z.number().int().positive().optional(),
      })
      .strict(),
    promptTemplateVersion: z.string().min(1),
    modelConfigVersion: z.string().min(1),
  })
  .strict();

/* ---------- preparePlanningContext：intent → durable query → persist ---------- */

export const preparePlanningContextRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    attemptId: runAttemptIdSchema,
    planRevision: z.number().int().positive(),
  })
  .strict();

export const memoryQueryDispatchDtoSchema = z
  .object({
    memoryQueryId: memoryQueryIdSchema,
    contextRequestId: contextRequestIdSchema,
    productRunId: productRunIdSchema,
    productSessionId: productSessionIdSchema,
    backendId: memoryBackendIdSchema,
    backendDescriptor: memoryBackendDescriptorSchema,
    backendDescriptorSha256: sha256Schema,
    requirement: memoryRequirementSchema,
    sourceMessageSha256: sha256Schema,
    queryText: z.string().min(1).max(4_000),
    tags: z.array(z.string().min(1).max(64)).max(20),
    layers: z.array(memoryLayerSchema).min(1).max(4),
    limit: z.number().int().min(1).max(20),
    contextBudget: z.number().int().min(128).max(8_192),
  })
  .strict();

export const beginPlanningContextResponseSchema = z.discriminatedUnion("status", [
  z.object({ ...versioned, status: z.literal("none") }).strict(),
  z
    .object({
      ...versioned,
      status: z.literal("dispatch_required"),
      query: memoryQueryDispatchDtoSchema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      status: z.enum(["ready", "optional_failed"]),
      contextPackageRef: internalContextPackageRefSchema,
    })
    .strict(),
  z.object({ ...versioned, status: z.literal("required_failed") }).strict(),
]);

const memoryQuerySectionResultSchema = z
  .object({
    externalObjectIds: z.array(z.string().min(1).max(200)).min(1).max(50),
    title: z.string().min(1).max(200),
    kind: z.enum(["trace", "span", "policy", "world_model", "skill"]),
    memoryLayer: memoryLayerSchema,
    content: z.string().min(1).max(50_000),
    tags: z.array(z.string().min(1).max(64)).max(50),
    score: z.number().finite().optional(),
    tokenEstimate: z.number().int().nonnegative(),
    sourceUpdatedAt: z.iso.datetime().optional(),
  })
  .strict();

export const memoryQueryExecutionResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      externalQueryId: z.string().min(1).max(200),
      hitCount: z.number().int().nonnegative(),
      tokenEstimate: z.number().int().nonnegative(),
      resultSetSha256: sha256Schema,
      sections: z.array(memoryQuerySectionResultSchema).max(20),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("failure"),
      errorCode: z
        .string()
        .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
        .max(64),
    })
    .strict(),
]);

export const persistPlanningContextResultRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    attemptId: runAttemptIdSchema,
    memoryQueryId: memoryQueryIdSchema,
    result: memoryQueryExecutionResultSchema,
  })
  .strict();

export const preparePlanningContextResponseSchema = z.discriminatedUnion("status", [
  z.object({ ...versioned, status: z.literal("none") }).strict(),
  z
    .object({
      ...versioned,
      status: z.enum(["ready", "optional_failed"]),
      contextPackageRef: internalContextPackageRefSchema,
    })
    .strict(),
  z.object({ ...versioned, status: z.literal("required_failed") }).strict(),
]);

/* ---------- Workflow Memory：可组合query节点与聚合Context ---------- */

const workflowMemoryNodeIdentityFields = {
  productRunId: productRunIdSchema,
  workflowRunSpecId: workflowRunSpecIdSchema,
  definitionNodeId: z.string().min(1).max(100),
  executionPath: z.array(workflowExecutionPathSegmentSchema).max(8),
  attemptNumber: z.number().int().positive().max(100),
};

export const beginWorkflowMemoryQueryRequestSchema = z
  .object({ ...versioned, commandId: commandIdSchema, ...workflowMemoryNodeIdentityFields })
  .strict();

export const workflowMemoryQueryDispatchDtoSchema = z
  .object({
    workflowMemoryQueryId: workflowMemoryQueryIdSchema,
    operationId: workflowMemoryQueryIdSchema,
    productRunId: productRunIdSchema,
    productSessionId: productSessionIdSchema,
    principalId: principalIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    definitionNodeId: z.string().min(1).max(100),
    providerId: memoryBackendIdSchema,
    providerDescriptor: memoryProviderDescriptorSchema,
    providerDescriptorSha256: sha256Schema,
    requirement: z.enum(["required", "optional"]),
    sourceMessageId: messageIdSchema,
    sourceMessageSha256: sha256Schema,
    querySha256: sha256Schema,
    queryText: z.string().min(1).max(50_000),
    maxResults: z.number().int().min(1).max(20),
    maxContextCharacters: z.number().int().min(128).max(50_000),
  })
  .strict();

const workflowMemoryQuerySectionResultSchema = z
  .object({
    externalObjectIds: z.array(z.string().min(1).max(200)).min(1).max(50),
    title: z.string().trim().min(1).max(200),
    category: workflowMemoryCategorySchema,
    content: z.string().min(1).max(50_000),
    labels: z.array(z.string().trim().min(1).max(64)).max(50),
    score: z.number().finite().optional(),
    sourceUpdatedAt: z.iso.datetime().optional(),
  })
  .strict();

export const workflowMemoryQueryExecutionResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      externalQueryId: z.string().min(1).max(200),
      hitCount: z.number().int().nonnegative(),
      resultSetSha256: sha256Schema,
      sections: z.array(workflowMemoryQuerySectionResultSchema).max(20),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("failure"),
      errorCode: z
        .string()
        .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
        .max(96),
    })
    .strict(),
]);

const workflowMemoryQueryTerminalFields = {
  workflowMemoryQueryId: workflowMemoryQueryIdSchema,
  productRunId: productRunIdSchema,
  workflowRunSpecId: workflowRunSpecIdSchema,
};

export const beginWorkflowMemoryQueryResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...versioned,
      ...workflowMemoryQueryTerminalFields,
      status: z.literal("dispatch_required"),
      query: workflowMemoryQueryDispatchDtoSchema,
    })
    .strict(),
  z
    .object({
      ...versioned,
      ...workflowMemoryQueryTerminalFields,
      status: z.enum(["completed", "optional_failed", "required_failed"]),
    })
    .strict(),
]);

export const persistWorkflowMemoryQueryResultRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    ...workflowMemoryNodeIdentityFields,
    workflowMemoryQueryId: workflowMemoryQueryIdSchema,
    result: workflowMemoryQueryExecutionResultSchema,
  })
  .strict();

export const persistWorkflowMemoryQueryResultResponseSchema = z
  .object({
    ...versioned,
    ...workflowMemoryQueryTerminalFields,
    status: z.enum(["completed", "optional_failed", "required_failed"]),
    snapshotCount: z.number().int().nonnegative().max(20),
  })
  .strict();

export const freezeWorkflowMemoryContextRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
  })
  .strict();

export const freezeWorkflowMemoryContextResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...versioned,
      productRunId: productRunIdSchema,
      workflowRunSpecId: workflowRunSpecIdSchema,
      status: z.literal("none"),
    })
    .strict(),
  z
    .object({
      ...versioned,
      productRunId: productRunIdSchema,
      workflowRunSpecId: workflowRunSpecIdSchema,
      status: z.literal("ready"),
      contextRef: internalWorkflowMemoryContextRefSchema,
    })
    .strict(),
]);

/* ---------- publishPlanReview ---------- */

export const publishPlanReviewRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    attemptId: runAttemptIdSchema,
    expectedRunRevision: z.number().int().positive(),
    inputManifestSha256: sha256Schema,
    content: planContentSchema,
  })
  .strict();

export const publishPlanReviewResponseSchema = z
  .object({
    ...versioned,
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    planSha256: sha256Schema,
    approvalRequestId: approvalRequestIdSchema,
    approvalExpiresAt: z.iso.datetime(),
  })
  .strict();

/* ---------- loadCommittedDecision ---------- */

export const loadCommittedDecisionRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    decisionId: decisionIdSchema,
    expectedPlanId: planIdSchema,
    expectedPlanRevision: z.number().int().positive(),
    expectedPlanSha256: sha256Schema,
  })
  .strict();

export const loadCommittedDecisionResponseSchema = z
  .object({
    ...versioned,
    decisionId: decisionIdSchema,
    kind: decisionKindSchema,
    revisionInputId: revisionInputIdSchema.optional(),
    revisionInstruction: z.string().min(1).optional(),
    principalId: principalIdSchema,
  })
  .strict();

/* ---------- compileExecutionContract ---------- */

export const compileExecutionContractRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    approvalDecisionId: decisionIdSchema,
  })
  .strict();

export const compileExecutionContractResponseSchema = z
  .object({
    ...versioned,
    contract: executionContractSchema,
  })
  .strict();

/* ---------- persistExecutionCandidate / persistValidationResult ---------- */

export const persistExecutionCandidateRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    executionContractId: executionContractIdSchema,
    stepResults: executionCandidateSchema.shape.stepResults,
    finalOutput: z
      .object({
        format: z.literal("markdown_sections"),
        sections: executionCandidateSchema.shape.finalOutput.shape.sections,
      })
      .strict(),
    completionCriteriaEvidence: z.array(z.string().min(1).max(1000)).min(1).max(50),
    warnings: z.array(z.string().min(1).max(500)).max(50),
  })
  .strict();

export const persistExecutionCandidateResponseSchema = z
  .object({
    ...versioned,
    executionCandidateId: executionCandidateIdSchema,
    sha256: sha256Schema,
  })
  .strict();

export const persistValidationResultRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    executionContractId: executionContractIdSchema,
    executionCandidateId: executionCandidateIdSchema,
    /** 由冻结Node config解析；浏览器不能调用或覆盖此私有验证策略。 */
    strictEvidence: z.boolean(),
  })
  .strict();

export const persistValidationResultResponseSchema = z
  .object({
    ...versioned,
    validationResultId: validationResultIdSchema,
    outcome: validationResultSchema.shape.outcome,
    failures: validationResultSchema.shape.failures,
  })
  .strict();

/* ---------- commitExecutionResult（Product Commit） ---------- */

export const commitExecutionResultRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    executionContractId: executionContractIdSchema,
    executionCandidateId: executionCandidateIdSchema,
    validationResultId: validationResultIdSchema,
  })
  .strict();

export const commitExecutionResultResponseSchema = z
  .object({
    ...versioned,
    finalMessageId: messageIdSchema,
    revision: z.number().int().positive(),
  })
  .strict();

/* ---------- commitRejectedRun / commitRunFailure / completeRunAttempt ---------- */

export const commitRejectedRunRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    decisionId: decisionIdSchema,
  })
  .strict();

export const commitRunFailureRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
      .max(64),
    summary: z.string().min(1).max(500),
  })
  .strict();

export const commitRunOutcomeUnknownRuntimeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
      .max(64),
    summary: z.string().min(1).max(500),
  })
  .strict();

export const expireApprovalRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    approvalRequestId: approvalRequestIdSchema,
    /** 必须与已提交Approval事实一致；定时器不能过期另一个版本。 */
    expectedExpiresAt: z.iso.datetime(),
  })
  .strict();

export const expireApprovalResponseSchema = z
  .object({
    ...versioned,
    status: z.enum(["expired", "already_decided"]),
    revision: z.number().int().positive(),
  })
  .strict();

export const runRevisionResponseSchema = z
  .object({
    ...versioned,
    revision: z.number().int().positive(),
  })
  .strict();

const stableRuntimeErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
  .max(64);

/** Planning Attempt只由compilePlanningInput创建；该私有命令只创建执行Attempt。 */
export const executionDependencyRefSchema = z
  .object({
    stepId: z.string().min(1).max(100),
    executionAttemptId: runAttemptIdSchema,
    sha256: sha256Schema,
  })
  .strict();

/**
 * 只读的执行上下文条目。它是Application从已批准Step的inputRefs解析出的
 * Memory/Project/Rule冻结投影；权威正文仍分别属于对应Product对象。
 */
const executionMemoryContextItemDtoSchema = z
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

const executionWorkflowMemoryContextItemDtoSchema = z
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

const executionProjectContextItemDtoSchema = z
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

const executionRuleContextItemDtoSchema = z
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

export const beginRunAttemptRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    kind: z.literal("execution"),
    executionContractId: executionContractIdSchema,
    stepId: z.string().min(1).max(100),
    dependencyRefs: z.array(executionDependencyRefSchema).max(50),
    promptTemplateVersion: z.string().min(1).max(100),
    modelConfigVersion: z.string().min(1).max(100),
  })
  .strict();

export const beginRunAttemptResponseSchema = z
  .object({
    ...versioned,
    attemptId: runAttemptIdSchema,
    inputManifestSha256: sha256Schema,
    contextItems: z.array(executionContextItemDtoSchema).max(50),
  })
  .strict();

/**
 * Executor Service在接触Workspace前回查Application权威事实。Workflow提交的Contract/
 * Context正文不能仅凭Runtime Key被信任；API按Execution Attempt返回权威副本。
 */
export const authorizeExecutorOperationRequestSchema = z
  .object({
    ...versioned,
    executionAttemptId: runAttemptIdSchema,
    executionContractId: executionContractIdSchema,
    executionContractSha256: sha256Schema,
    stepId: z.string().min(1).max(100),
    inputManifestSha256: sha256Schema,
  })
  .strict();

export const authorizeExecutorOperationResponseSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    executionAttemptId: runAttemptIdSchema,
    contract: executionContractSchema,
    contextItems: z.array(executionContextItemDtoSchema).max(50),
    dependencyRefs: z.array(executionDependencyRefSchema).max(50),
  })
  .strict();

export const completeRunAttemptRequestSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      ...versioned,
      commandId: commandIdSchema,
      attemptId: runAttemptIdSchema,
      outcome: z.literal("success"),
    })
    .strict(),
  z
    .object({
      ...versioned,
      commandId: commandIdSchema,
      attemptId: runAttemptIdSchema,
      outcome: z.literal("failure"),
      errorCode: stableRuntimeErrorCodeSchema,
    })
    .strict(),
]);

/* ---------- S4 configurable planning runtime ---------- */

export const loadWorkflowRunSpecRequestSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
  })
  .strict();

export const loadWorkflowRunSpecResponseSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema,
    runSpec: workflowRunSpecSchema,
  })
  .strict();

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

const preparedMemorySnapshotSchema = memoryResultSnapshotSchema.pick({
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

/** Project正文由Application冻结；Workflow只拿精确Context引用。 */
export const preparePlanningProjectContextRequestSchema = z
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

export const preparePlanningProjectContextResponseSchema = z.discriminatedUnion("status", [
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
      contextRef: z
        .object({
          planningProjectContextId: planningProjectContextIdSchema,
          revision: z.literal(1),
          sha256: sha256Schema,
        })
        .strict(),
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

const preparedRuleContentSchema = z
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
export const publishNoteCandidateRuntimeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    proposed: noteRevisionInputSchema,
  })
  .strict();

export const publishNoteCandidateRuntimeResponseSchema = z
  .object({
    ...versioned,
    candidate: noteCandidateReviewDtoSchema,
    review: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("waiting_human") }).strict(),
      z
        .object({
          outcome: z.literal("policy_denied_waiting_human"),
          policyResolutionRef: z
            .object({
              workflowPolicyResolutionId: workflowPolicyResolutionIdSchema,
              revision: z.literal(1),
              sha256: sha256Schema,
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          outcome: z.literal("auto_continued"),
          policyResolutionRef: z
            .object({
              workflowPolicyResolutionId: workflowPolicyResolutionIdSchema,
              revision: z.literal(1),
              sha256: sha256Schema,
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict();

export const prepareNoteCaptureInputRuntimeRequestSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
  })
  .strict();

export const prepareNoteCaptureInputRuntimeResponseSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    source: noteSourceRefSchema,
    sourceText: z.string().min(1).max(NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS),
    defaultKind: noteKindSchema,
    suggestedTagLabels: z
      .array(z.string().trim().min(1).max(NOTE_TAG_LABEL_MAX_CHARACTERS))
      .max(NOTE_TAG_MAX_COUNT),
    priorCandidate: noteCandidateReviewDtoSchema.optional(),
    revisionInstruction: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const loadNoteDecisionRuntimeRequestSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    noteCandidateId: noteCandidateIdSchema,
    noteDecisionId: noteDecisionIdSchema,
  })
  .strict();

export const loadNoteDecisionRuntimeResponseSchema = z
  .object({
    ...versioned,
    candidate: noteCandidateReviewDtoSchema,
    decision: noteDecisionDtoSchema,
  })
  .strict();

export const commitConfirmedNoteRuntimeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    noteCandidateId: noteCandidateIdSchema,
  })
  .strict();

export const commitConfirmedNoteRuntimeResponseSchema = z
  .object({
    ...versioned,
    status: z.literal("committed"),
  })
  .strict();

export const transitionConfigurablePlanningNodeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    definitionNodeId: z.string().min(1).max(100),
    executionPath: z.array(workflowExecutionPathSegmentSchema).max(8),
    attemptNumber: z.number().int().positive().max(100),
    toStatus: z.enum([
      "running",
      "waiting_human",
      "skipped",
      "succeeded",
      "failed",
      "cancelled",
      "outcome_unknown",
    ]),
    outcomeCode: z.string().min(1).max(64).optional(),
    publicSummary: z.string().min(1).max(500).optional(),
  })
  .strict();

/* ---------- Workflow Runtime分发合同（API Outbox Dispatcher -> Workflow进程） ---------- */

export const WORKFLOW_DISPATCH_SCHEMA_VERSION = "chat-workflow-dispatch.v1";

export const workflowStartRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema.optional(),
    runnerFamily: workflowRunnerFamilySchema.optional(),
    runnerBundleVersion: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    /** 关联的workflow Run Attempt（Trace关联用，不是Runtime私有身份）。 */
    attemptId: runAttemptIdSchema,
    workflowDefinitionVersion: z.string().min(1),
    outboxId: outboxEntryIdSchema,
  })
  .strict()
  .check((ctx) => {
    const value = ctx.value;
    if (value.runnerFamily === undefined || value.runnerBundleVersion === undefined) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "Workflow Start必须携带冻结Runner身份",
        path: ["runnerFamily"],
      });
      return;
    }
    if (
      (value.runnerFamily === "configurable-planning.v1" ||
        value.runnerFamily === "note-capture.v1") &&
      value.workflowRunSpecId === undefined
    ) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "Definition Runner必须携带Workflow RunSpec",
        path: ["workflowRunSpecId"],
      });
    }
    if (value.runnerFamily === "legacy-planning.v1" && value.workflowRunSpecId !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "Legacy Runner不得携带Workflow RunSpec",
        path: ["workflowRunSpecId"],
      });
    }
    if (value.runnerFamily === "definition-kernel-lab.v1") {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "实验室Runner不得通过正式派发边界启动",
        path: ["runnerFamily"],
      });
    }
  });

export const workflowStartResponseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    status: z.enum(["started", "already_started", "outcome_unknown"]),
  })
  .strict();

const workflowDispatchBase = {
  schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
  productRunId: productRunIdSchema,
  attemptId: runAttemptIdSchema,
  outboxId: outboxEntryIdSchema,
};

export const workflowPlanningResumeRequestSchema = z
  .object({
    ...workflowDispatchBase,
    approvalRequestId: approvalRequestIdSchema,
    decisionId: decisionIdSchema,
  })
  .strict();

export const workflowNoteResumeRequestSchema = z
  .object({
    ...workflowDispatchBase,
    hookNoteCandidateId: noteCandidateIdSchema,
    noteCandidateId: noteCandidateIdSchema,
    noteDecisionId: noteDecisionIdSchema,
  })
  .strict();

export const workflowResumeRequestSchema = z.union([
  workflowPlanningResumeRequestSchema,
  workflowNoteResumeRequestSchema,
]);

export const workflowResumeResponseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    status: z.enum(["resumed", "already_resumed", "outcome_unknown"]),
  })
  .strict();

/** 对账查询：只返回绑定存在性与派发状态，不返回任何Runtime私有身份。 */
export const workflowReconcileResponseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    startBinding: z.enum(["exists", "missing", "outcome_unknown"]),
    hookResumeState: z
      .enum(["none", "dispatching", "dispatched", "outcome_unknown", "failed_terminal", "missing"])
      .optional(),
  })
  .strict();

/* ---------- Memory Import Workflow 私有合同 ---------- */

export const memoryImportAdapterInputSchema = z
  .object({
    operationId: memoryImportIntentIdSchema,
    requestSha256: sha256Schema,
    content: z.string().min(1).max(50_000),
    layer: z.enum(["L0", "L2"]),
    title: z.string().min(1).max(200),
    tags: z.array(z.string().min(1).max(64)).max(20),
    source: z.literal("chat.explicit_import"),
    sessionId: productSessionIdSchema,
    turnId: messageIdSchema,
  })
  .strict();

export const loadMemoryImportRequestSchema = z
  .object({
    ...versioned,
    workflowDefinitionVersion: z.literal(MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION),
    memoryImportIntentId: memoryImportIntentIdSchema,
    memoryImportResultId: memoryImportResultIdSchema,
  })
  .strict();

export const loadMemoryImportResponseSchema = z
  .object({
    ...versioned,
    intent: memoryImportIntentSchema,
    result: memoryImportResultSchema,
    adapterInput: memoryImportAdapterInputSchema,
  })
  .strict();

const memoryImportResultCommandBase = {
  ...versioned,
  workflowDefinitionVersion: z.literal(MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION),
  commandId: commandIdSchema,
  memoryImportIntentId: memoryImportIntentIdSchema,
  memoryImportResultId: memoryImportResultIdSchema,
  requestSha256: sha256Schema,
  expectedRevision: z.number().int().positive(),
};

export const markMemoryImportDispatchingRequestSchema = z
  .object(memoryImportResultCommandBase)
  .strict();

export const memoryImportAcceptedSchema = z
  .object({
    externalObjectId: z.string().min(1).max(200),
    externalObjectVersion: z.string().min(1).max(200).optional(),
    externalStatus: z.string().min(1).max(100).optional(),
    responseSha256: sha256Schema,
  })
  .strict();

export const commitMemoryImportAcceptedRequestSchema = z
  .object({
    ...memoryImportResultCommandBase,
    accepted: memoryImportAcceptedSchema,
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryImportMaterializedRequestSchema = z
  .object({
    ...memoryImportResultCommandBase,
    accepted: memoryImportAcceptedSchema,
    verificationKind: z.enum(["read_by_id_and_search", "l0_and_session_l1"]),
    verificationSha256: sha256Schema,
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryImportFailedRequestSchema = z
  .object({
    ...memoryImportResultCommandBase,
    errorCode: stableRuntimeErrorCodeSchema,
    summary: z.string().min(1).max(500),
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryImportOutcomeUnknownRequestSchema = z
  .object({
    ...memoryImportResultCommandBase,
    errorCode: stableRuntimeErrorCodeSchema,
    reconciled: z.boolean().optional(),
  })
  .strict();

export const memoryImportResultResponseSchema = z
  .object({ ...versioned, result: memoryImportResultSchema })
  .strict();

export const memoryImportWorkflowDispatchRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    memoryImportIntentId: memoryImportIntentIdSchema,
    memoryImportResultId: memoryImportResultIdSchema,
    expectedResultRevision: z.number().int().positive(),
    mode: z.enum(["import", "reconcile"]),
    workflowDefinitionVersion: z.string().min(1).max(100),
    outboxId: outboxEntryIdSchema,
  })
  .strict();

export const memoryImportWorkflowDispatchResponseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    status: z.enum(["started", "already_started", "outcome_unknown"]),
  })
  .strict();

const memoryImportWorkflowReconcileResponseBase = {
  schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
  outboxId: outboxEntryIdSchema,
};

export const memoryImportWorkflowReconcileResponseSchema = z.discriminatedUnion("startBinding", [
  z
    .object({
      ...memoryImportWorkflowReconcileResponseBase,
      startBinding: z.literal("exists"),
      runStatus: z.enum(["active", "completed", "failed", "cancelled", "missing"]),
    })
    .strict(),
  z
    .object({
      ...memoryImportWorkflowReconcileResponseBase,
      startBinding: z.enum(["missing", "outcome_unknown"]),
    })
    .strict(),
]);

/* ---------- Workflow Memory Write 私有合同 ---------- */

export const memoryWriteAdapterInputSchema = z
  .object({
    operationId: memoryWriteIntentIdSchema,
    requestSha256: sha256Schema,
    content: z.string().min(1).max(200_000),
    contentType: z.literal("conversation_turn"),
    productSessionId: productSessionIdSchema,
    principalId: principalIdSchema,
    sourceMessageId: messageIdSchema,
  })
  .strict();

export const loadMemoryWriteRequestSchema = z
  .object({
    ...versioned,
    workflowDefinitionVersion: z.literal(MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION),
    memoryWriteIntentId: memoryWriteIntentIdSchema,
    memoryWriteResultId: memoryWriteResultIdSchema,
  })
  .strict();

export const loadMemoryWriteResponseSchema = z
  .object({
    ...versioned,
    intent: memoryWriteIntentSchema,
    result: memoryWriteResultSchema,
    adapterInput: memoryWriteAdapterInputSchema,
  })
  .strict();

export const beginWorkflowMemoryWriteRequestSchema = z
  .object({ ...versioned, commandId: commandIdSchema, ...workflowMemoryNodeIdentityFields })
  .strict();

export const beginWorkflowMemoryWriteResponseSchema = loadMemoryWriteResponseSchema;

const memoryWriteResultCommandBase = {
  ...versioned,
  workflowDefinitionVersion: z.literal(MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION),
  commandId: commandIdSchema,
  memoryWriteIntentId: memoryWriteIntentIdSchema,
  memoryWriteResultId: memoryWriteResultIdSchema,
  requestSha256: sha256Schema,
  expectedRevision: z.number().int().positive(),
};

export const markMemoryWriteDispatchingRequestSchema = z
  .object(memoryWriteResultCommandBase)
  .strict();

export const memoryWriteAcceptedSchema = z
  .object({
    externalObjectId: z.string().min(1).max(200),
    externalObjectVersion: z.string().min(1).max(200).optional(),
    externalStatus: z.string().min(1).max(100).optional(),
    responseSha256: sha256Schema,
  })
  .strict();

export const commitMemoryWriteAcceptedRequestSchema = z
  .object({
    ...memoryWriteResultCommandBase,
    accepted: memoryWriteAcceptedSchema,
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryWriteMaterializedRequestSchema = z
  .object({
    ...memoryWriteResultCommandBase,
    accepted: memoryWriteAcceptedSchema,
    verificationKind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    verificationSha256: sha256Schema,
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryWriteFailedRequestSchema = z
  .object({
    ...memoryWriteResultCommandBase,
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
      .max(96),
    summary: z.string().min(1).max(500),
    reconciled: z.boolean().optional(),
  })
  .strict();

export const commitMemoryWriteOutcomeUnknownRequestSchema = z
  .object({
    ...memoryWriteResultCommandBase,
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
      .max(96),
    reconciled: z.boolean().optional(),
  })
  .strict();

export const memoryWriteResultResponseSchema = z
  .object({ ...versioned, result: memoryWriteResultSchema })
  .strict();

export const memoryWriteWorkflowDispatchRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    memoryWriteIntentId: memoryWriteIntentIdSchema,
    memoryWriteResultId: memoryWriteResultIdSchema,
    expectedResultRevision: z.number().int().positive(),
    mode: z.enum(["write", "reconcile"]),
    workflowDefinitionVersion: z.literal(MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION),
    outboxId: outboxEntryIdSchema,
  })
  .strict();

export const memoryWriteWorkflowDispatchResponseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    status: z.enum(["started", "already_started", "outcome_unknown"]),
  })
  .strict();

const memoryWriteWorkflowReconcileResponseBase = {
  schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
  outboxId: outboxEntryIdSchema,
};

export const memoryWriteWorkflowReconcileResponseSchema = z.discriminatedUnion("startBinding", [
  z
    .object({
      ...memoryWriteWorkflowReconcileResponseBase,
      startBinding: z.literal("exists"),
      runStatus: z.enum(["active", "completed", "failed", "cancelled", "missing"]),
    })
    .strict(),
  z
    .object({
      ...memoryWriteWorkflowReconcileResponseBase,
      startBinding: z.enum(["missing", "outcome_unknown"]),
    })
    .strict(),
]);

/* ---------- 类型 ---------- */

export type CompilePlanningInputRequest = z.infer<typeof compilePlanningInputRequestSchema>;
export type PreparePlanningContextRequest = z.infer<typeof preparePlanningContextRequestSchema>;
export type BeginPlanningContextResponse = z.infer<typeof beginPlanningContextResponseSchema>;
export type PreparePlanningContextResponse = z.infer<typeof preparePlanningContextResponseSchema>;
export type MemoryQueryDispatchDto = z.infer<typeof memoryQueryDispatchDtoSchema>;
export type MemoryQueryExecutionResult = z.infer<typeof memoryQueryExecutionResultSchema>;
export type PersistPlanningContextResultRequest = z.infer<
  typeof persistPlanningContextResultRequestSchema
>;
export type BeginWorkflowMemoryQueryRequest = z.infer<typeof beginWorkflowMemoryQueryRequestSchema>;
export type BeginWorkflowMemoryQueryResponse = z.infer<
  typeof beginWorkflowMemoryQueryResponseSchema
>;
export type WorkflowMemoryQueryDispatchDto = z.infer<typeof workflowMemoryQueryDispatchDtoSchema>;
export type WorkflowMemoryQueryExecutionResult = z.infer<
  typeof workflowMemoryQueryExecutionResultSchema
>;
export type PersistWorkflowMemoryQueryResultRequest = z.infer<
  typeof persistWorkflowMemoryQueryResultRequestSchema
>;
export type PersistWorkflowMemoryQueryResultResponse = z.infer<
  typeof persistWorkflowMemoryQueryResultResponseSchema
>;
export type FreezeWorkflowMemoryContextRequest = z.infer<
  typeof freezeWorkflowMemoryContextRequestSchema
>;
export type FreezeWorkflowMemoryContextResponse = z.infer<
  typeof freezeWorkflowMemoryContextResponseSchema
>;
export type PlanningInputDto = z.infer<typeof planningInputDtoSchema>;
export type PublishPlanReviewRequest = z.infer<typeof publishPlanReviewRequestSchema>;
export type PublishPlanReviewResponse = z.infer<typeof publishPlanReviewResponseSchema>;
export type LoadCommittedDecisionRequest = z.infer<typeof loadCommittedDecisionRequestSchema>;
export type LoadCommittedDecisionResponse = z.infer<typeof loadCommittedDecisionResponseSchema>;
export type CompileExecutionContractRequest = z.infer<typeof compileExecutionContractRequestSchema>;
export type PersistExecutionCandidateRequest = z.infer<
  typeof persistExecutionCandidateRequestSchema
>;
export type PersistValidationResultRequest = z.infer<typeof persistValidationResultRequestSchema>;
export type CommitExecutionResultRequest = z.infer<typeof commitExecutionResultRequestSchema>;
export type CommitRejectedRunRequest = z.infer<typeof commitRejectedRunRequestSchema>;
export type LoadMemoryImportRequest = z.infer<typeof loadMemoryImportRequestSchema>;
export type LoadMemoryImportResponse = z.infer<typeof loadMemoryImportResponseSchema>;
export type LoadMemoryWriteRequest = z.infer<typeof loadMemoryWriteRequestSchema>;
export type LoadMemoryWriteResponse = z.infer<typeof loadMemoryWriteResponseSchema>;
export type BeginWorkflowMemoryWriteRequest = z.infer<typeof beginWorkflowMemoryWriteRequestSchema>;
export type BeginWorkflowMemoryWriteResponse = z.infer<
  typeof beginWorkflowMemoryWriteResponseSchema
>;
export type MarkMemoryWriteDispatchingRequest = z.infer<
  typeof markMemoryWriteDispatchingRequestSchema
>;
export type CommitMemoryWriteAcceptedRequest = z.infer<
  typeof commitMemoryWriteAcceptedRequestSchema
>;
export type CommitMemoryWriteMaterializedRequest = z.infer<
  typeof commitMemoryWriteMaterializedRequestSchema
>;
export type CommitMemoryWriteFailedRequest = z.infer<typeof commitMemoryWriteFailedRequestSchema>;
export type CommitMemoryWriteOutcomeUnknownRequest = z.infer<
  typeof commitMemoryWriteOutcomeUnknownRequestSchema
>;
export type CommitRunFailureRequest = z.infer<typeof commitRunFailureRequestSchema>;
export type CommitRunOutcomeUnknownRuntimeRequest = z.infer<
  typeof commitRunOutcomeUnknownRuntimeRequestSchema
>;
export type ExpireApprovalRequest = z.infer<typeof expireApprovalRequestSchema>;
export type BeginRunAttemptRequest = z.infer<typeof beginRunAttemptRequestSchema>;
export type BeginRunAttemptResponse = z.infer<typeof beginRunAttemptResponseSchema>;
export type AuthorizeExecutorOperationRequest = z.infer<
  typeof authorizeExecutorOperationRequestSchema
>;
export type AuthorizeExecutorOperationResponse = z.infer<
  typeof authorizeExecutorOperationResponseSchema
>;
export type CompleteRunAttemptRequest = z.infer<typeof completeRunAttemptRequestSchema>;
export type LoadWorkflowRunSpecRequest = z.infer<typeof loadWorkflowRunSpecRequestSchema>;
export type LoadWorkflowRunSpecResponse = z.infer<typeof loadWorkflowRunSpecResponseSchema>;
export type PreparePlanningMemoryContextRequest = z.infer<
  typeof preparePlanningMemoryContextRequestSchema
>;
export type PreparePlanningMemoryContextResponse = z.infer<
  typeof preparePlanningMemoryContextResponseSchema
>;
export type PreparePlanningProjectContextRequest = z.infer<
  typeof preparePlanningProjectContextRequestSchema
>;
export type PreparePlanningProjectContextResponse = z.infer<
  typeof preparePlanningProjectContextResponseSchema
>;
export type PreparePlanningRulesContextRequest = z.infer<
  typeof preparePlanningRulesContextRequestSchema
>;
export type PreparePlanningRulesContextResponse = z.infer<
  typeof preparePlanningRulesContextResponseSchema
>;
export type PublishNoteCandidateRuntimeRequest = z.infer<
  typeof publishNoteCandidateRuntimeRequestSchema
>;
export type PublishNoteCandidateRuntimeResponse = z.infer<
  typeof publishNoteCandidateRuntimeResponseSchema
>;
export type PrepareNoteCaptureInputRuntimeRequest = z.infer<
  typeof prepareNoteCaptureInputRuntimeRequestSchema
>;
export type PrepareNoteCaptureInputRuntimeResponse = z.infer<
  typeof prepareNoteCaptureInputRuntimeResponseSchema
>;
export type LoadNoteDecisionRuntimeRequest = z.infer<typeof loadNoteDecisionRuntimeRequestSchema>;
export type LoadNoteDecisionRuntimeResponse = z.infer<typeof loadNoteDecisionRuntimeResponseSchema>;
export type CommitConfirmedNoteRuntimeRequest = z.infer<
  typeof commitConfirmedNoteRuntimeRequestSchema
>;
export type CommitConfirmedNoteRuntimeResponse = z.infer<
  typeof commitConfirmedNoteRuntimeResponseSchema
>;
export type TransitionConfigurablePlanningNodeRequest = z.infer<
  typeof transitionConfigurablePlanningNodeRequestSchema
>;
export type ExecutionContextItemDto = z.infer<typeof executionContextItemDtoSchema>;
export type WorkflowStartRequest = z.infer<typeof workflowStartRequestSchema>;
export type WorkflowResumeRequest = z.infer<typeof workflowResumeRequestSchema>;
export type WorkflowReconcileResponse = z.infer<typeof workflowReconcileResponseSchema>;
