/**
 * 内部Runtime合同 execution 族。对外经../internal-runtime.js barrel。
 */
import { z } from "zod";
import {
  approvalRequestIdSchema,
  commandIdSchema,
  decisionIdSchema,
  executionCandidateIdSchema,
  executionContractIdSchema,
  messageIdSchema,
  planIdSchema,
  principalIdSchema,
  productRunIdSchema,
  revisionInputIdSchema,
  runAttemptIdSchema,
  validationResultIdSchema,
  memoryBackendIdSchema,
  memoryResultSnapshotIdSchema,
  workflowDefinitionRevisionIdSchema,
  workflowRunSpecIdSchema,
  promptAssemblyIdSchema,
  ruleIdSchema,
  ruleRevisionIdSchema,
  workflowMemorySnapshotIdSchema,
} from "../ids.js";
import { workflowDefinitionNodeIdSchema } from "../workflow-definition.js";
import {
  decisionKindSchema,
  executionCandidateSchema,
  executionContractSchema,
  planContentSchema,
  validationResultV2Schema,
} from "../product.js";
import { sha256Schema } from "../hash.js";
import { memoryLayerSchema, memoryResultSnapshotSchema } from "../context.js";
import { workflowRunSpecSchema } from "../workflow-definition.js";
import { workflowMemoryCategorySchema } from "../workflow-memory.js";
import { governanceReviewCandidateSchema } from "../governance-review.js";
import {
  versioned,
  stableRuntimeErrorCodeSchema,
  workflowNodePromptRuntimeSchema,
} from "./shared.js";

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
    evidencePolicyVersion: z.literal("structured-tool-result.v1"),
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
    /** 仅治理检查节点提交；Application会复核证据键并绑定冻结节点Prompt。 */
    governanceReview: governanceReviewCandidateSchema.optional(),
    governanceReviewAttemptId: runAttemptIdSchema.optional(),
    governanceReviewInputManifestSha256: sha256Schema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const governanceFields = [
      request.governanceReview,
      request.governanceReviewAttemptId,
      request.governanceReviewInputManifestSha256,
    ];
    const present = governanceFields.filter((value) => value !== undefined).length;
    if (present !== 0 && present !== governanceFields.length) {
      context.addIssue({
        code: "custom",
        path: ["governanceReview"],
        message: "治理检查候选、Attempt与输入Manifest必须同时提供",
      });
    }
  });

export const persistValidationResultResponseSchema = z
  .object({
    ...versioned,
    validationResultId: validationResultIdSchema,
    outcome: validationResultV2Schema.shape.outcome,
    failures: validationResultV2Schema.shape.failures,
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

export const executionDependencyRefSchema = z
  .object({
    stepId: z.string().min(1).max(100),
    executionAttemptId: runAttemptIdSchema,
    sha256: sha256Schema,
  })
  .strict();

/**
 * 只读的执行上下文条目。它是Application从已批准Step的inputRefs解析出的
 * Memory/Rule冻结投影；权威正文仍分别属于对应Product对象。
 */
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
    /** Workflow只需复算Manifest；完整冻结Prompt仍由Executor按Attempt回查。 */
    promptAssemblyRef: z
      .object({
        promptAssemblyId: promptAssemblyIdSchema,
        sha256: sha256Schema,
        definitionNodeId: workflowDefinitionNodeIdSchema,
        nodeAssemblySha256: sha256Schema,
      })
      .strict()
      .optional(),
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
    nodePrompt: workflowNodePromptRuntimeSchema.optional(),
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
