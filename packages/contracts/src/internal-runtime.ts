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
} from "./ids.js";
import {
  decisionKindSchema,
  executionCandidateSchema,
  executionContractSchema,
  planContentSchema,
  validationResultSchema,
} from "./product.js";
import { sha256Schema } from "./hash.js";

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

/* ---------- compilePlanningInput ---------- */

export const compilePlanningInputRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    planRevision: z.number().int().positive(),
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
export const beginRunAttemptRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    kind: z.literal("execution"),
    stepId: z.string().min(1).max(100),
    inputManifestSha256: sha256Schema,
    promptTemplateVersion: z.string().min(1).max(100),
    modelConfigVersion: z.string().min(1).max(100),
  })
  .strict();

export const beginRunAttemptResponseSchema = z
  .object({ ...versioned, attemptId: runAttemptIdSchema })
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

/* ---------- Workflow Runtime分发合同（API Outbox Dispatcher -> Workflow进程） ---------- */

export const WORKFLOW_DISPATCH_SCHEMA_VERSION = "chat-workflow-dispatch.v1";

export const workflowStartRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    /** 关联的workflow Run Attempt（Trace关联用，不是Runtime私有身份）。 */
    attemptId: runAttemptIdSchema,
    workflowDefinitionVersion: z.string().min(1),
    outboxId: outboxEntryIdSchema,
  })
  .strict();

export const workflowStartResponseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    status: z.enum(["started", "already_started", "outcome_unknown"]),
  })
  .strict();

export const workflowResumeRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    attemptId: runAttemptIdSchema,
    approvalRequestId: approvalRequestIdSchema,
    decisionId: decisionIdSchema,
    outboxId: outboxEntryIdSchema,
  })
  .strict();

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

/* ---------- 类型 ---------- */

export type CompilePlanningInputRequest = z.infer<typeof compilePlanningInputRequestSchema>;
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
export type CommitRunFailureRequest = z.infer<typeof commitRunFailureRequestSchema>;
export type ExpireApprovalRequest = z.infer<typeof expireApprovalRequestSchema>;
export type BeginRunAttemptRequest = z.infer<typeof beginRunAttemptRequestSchema>;
export type CompleteRunAttemptRequest = z.infer<typeof completeRunAttemptRequestSchema>;
export type WorkflowStartRequest = z.infer<typeof workflowStartRequestSchema>;
export type WorkflowResumeRequest = z.infer<typeof workflowResumeRequestSchema>;
export type WorkflowReconcileResponse = z.infer<typeof workflowReconcileResponseSchema>;
