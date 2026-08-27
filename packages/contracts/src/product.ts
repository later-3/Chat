import { z } from "zod";
import {
  approvalRequestIdSchema,
  artifactIdSchema,
  commandIdSchema,
  decisionIdSchema,
  executionCandidateIdSchema,
  executionContractIdSchema,
  messageIdSchema,
  memoryImportIntentIdSchema,
  memoryImportResultIdSchema,
  memoryWriteIntentIdSchema,
  memoryWriteResultIdSchema,
  noteCandidateIdSchema,
  noteDecisionIdSchema,
  outboxEntryIdSchema,
  planningMemorySelectionIdSchema,
  planningProjectContextIdSchema,
  planIdSchema,
  planRevisionIdSchema,
  principalIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  projectCandidateIdSchema,
  projectIdSchema,
  projectResourceIdSchema,
  revisionInputIdSchema,
  ruleSelectionIdSchema,
  runAttemptIdSchema,
  contextPackageIdSchema,
  directAgentCandidateIdSchema,
  promptReviewDecisionIdSchema,
  promptReviewRequestIdSchema,
  validationResultIdSchema,
  workflowViewDefinitionIdSchema,
  workflowRunSpecIdSchema,
  workflowMemoryContextIdSchema,
} from "./ids.js";
import { sha256Schema } from "./hash.js";
import { governanceReviewRecordSchema } from "./governance-review.js";
import { B2_MAX_PLAN_STEPS } from "./versions.js";
import { workflowRunnerFamilyV3Schema } from "./workflow-definition.js";

/**
 * B2产品持久化实体合同（任务书§8.3、§9）。
 *
 * 不变量：
 * - 所有集合使用`ID -> 对象`的Map形态，不把整个历史嵌套进Session。
 * - 每个持久对象携带自己的schemaVersion、ID、revision（对象级乐观并发）、
 *   创建/更新时间与必要关联引用；Plan的业务版本号字段名为`planRevision`，
 *   与对象级`revision`是两个不同概念，不得混用。
 * - 实体Schema全部strict：持久化层不存在Record<string, unknown>扩展口袋。
 * - 正文只存在于Product Store；Trace、API响应和事件只允许引用ID/revision/Hash。
 * - 这里不保存API Key、Cookie、HTTP Header、隐藏推理或Workflow私有ID；Prompt Review
 *   只在独立实体中保存一次经安全收敛、即将实际发送的canonical JSON正文。
 */

const isoDateTimeSchema = z.iso.datetime();

const entityBaseFields = {
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

/* ---------- Product Session ---------- */

export const productSessionStatusSchema = z.enum(["active", "archived"]);

export const productSessionSchema = z
  .object({
    schemaVersion: z.literal("product-session.v1"),
    sessionId: productSessionIdSchema,
    ownerPrincipalId: principalIdSchema,
    status: productSessionStatusSchema,
    title: z.string().min(1).max(200).optional(),
    /** 单调递增的Message顺序分配器；Message顺序只由它决定，不依赖时间戳或对象键。 */
    lastMessageSequence: z.number().int().nonnegative(),
    ...entityBaseFields,
  })
  .strict();

/* ---------- Message ---------- */

export const messageRoleSchema = z.enum(["user", "assistant"]);

export const messageContentSchema = z
  .object({
    format: z.literal("markdown"),
    text: z.string().min(1).max(100_000),
  })
  .strict();

export const messageSchema = z
  .object({
    schemaVersion: z.literal("message.v1"),
    messageId: messageIdSchema,
    sessionId: productSessionIdSchema,
    /** 会话内单调递增顺序，由服务端分配。 */
    sessionSequence: z.number().int().positive(),
    role: messageRoleSchema,
    content: messageContentSchema,
    /** Assistant Message必须能追溯产生它的Product Run。 */
    sourceRunId: productRunIdSchema.optional(),
    ...entityBaseFields,
  })
  .strict();

/* ---------- Product Run ---------- */

export const productRunStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_human",
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

/** phase解释当前用户可见阶段；status才是权威生命周期，不得建立第二套终态。 */
export const planningRunPhaseSchema = z.enum([
  "queued",
  "planning",
  "plan_review",
  "executing",
  "validating",
  "completed",
  "rejected",
]);
export const noteCaptureRunPhaseSchema = z.enum([
  "queued",
  "extracting",
  "classifying",
  "note_review",
  "committing",
  "completed",
  "rejected",
]);
export const directAgentRunPhaseSchema = z.enum([
  "queued",
  "executing",
  "prompt_review",
  "tool_review",
  "completed",
  "rejected",
]);
export const productRunPhaseSchema = z.union([
  planningRunPhaseSchema,
  noteCaptureRunPhaseSchema,
  directAgentRunPhaseSchema,
]);

/** 用户可读的安全失败摘要；不携带Provider Payload、Stack或内部诊断。 */
export const runFailureSchema = z
  .object({
    code: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
      .max(64),
    summary: z.string().min(1).max(500),
  })
  .strict();

export const productRunV1Schema = z
  .object({
    schemaVersion: z.literal("product-run.v1"),
    productRunId: productRunIdSchema,
    sessionId: productSessionIdSchema,
    sourceMessageId: messageIdSchema,
    status: productRunStatusSchema,
    phase: planningRunPhaseSchema,
    currentPlanId: planIdSchema.optional(),
    currentPlanRevision: z.number().int().positive().optional(),
    currentApprovalRequestId: approvalRequestIdSchema.optional(),
    /** 成功终态时指向正式Assistant Message。 */
    finalMessageId: messageIdSchema.optional(),
    failure: runFailureSchema.optional(),
    /** 规划修订上限；达到后不再调用模型，Run进入明确失败。 */
    maxPlanRevisions: z.number().int().positive().max(20),
    ...entityBaseFields,
  })
  .strict();

/** S1/S2历史Run形状；只用于Store迁移与旧Fixture解析。 */
export const productRunV2Schema = z
  .object({
    schemaVersion: z.literal("product-run.v2"),
    productRunId: productRunIdSchema,
    sessionId: productSessionIdSchema,
    sourceMessageId: messageIdSchema,
    workflowViewDefinitionId: workflowViewDefinitionIdSchema,
    status: productRunStatusSchema,
    phase: planningRunPhaseSchema,
    currentPlanId: planIdSchema.optional(),
    currentPlanRevision: z.number().int().positive().optional(),
    currentApprovalRequestId: approvalRequestIdSchema.optional(),
    finalMessageId: messageIdSchema.optional(),
    failure: runFailureSchema.optional(),
    maxPlanRevisions: z.number().int().positive().max(20),
    ...entityBaseFields,
  })
  .strict();

/** S4起Run显式成为planning分支，并绑定Runner版本证据与可选RunSpec。 */
export const planningProductRunSchema = z
  .object({
    schemaVersion: z.literal("product-run.v3"),
    runKind: z.literal("planning"),
    productRunId: productRunIdSchema,
    sessionId: productSessionIdSchema,
    sourceMessageId: messageIdSchema,
    workflowViewDefinitionId: workflowViewDefinitionIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema.optional(),
    runnerFamily: workflowRunnerFamilyV3Schema,
    runnerBundleVersion: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    status: productRunStatusSchema,
    phase: planningRunPhaseSchema,
    currentPlanId: planIdSchema.optional(),
    currentPlanRevision: z.number().int().positive().optional(),
    currentApprovalRequestId: approvalRequestIdSchema.optional(),
    finalMessageId: messageIdSchema.optional(),
    failure: runFailureSchema.optional(),
    maxPlanRevisions: z.number().int().positive().max(20),
    ...entityBaseFields,
  })
  .strict();

/**
 * S5 Note Capture使用独立Run分支，明确不携带Plan/Approval字段。
 * Runner/RunSpec字段继续复用S4合同，避免为第二业务流程复制Runtime身份。
 */
export const noteCaptureProductRunSchema = z
  .object({
    schemaVersion: z.literal("product-run.v3"),
    runKind: z.literal("note_capture"),
    productRunId: productRunIdSchema,
    sessionId: productSessionIdSchema,
    sourceMessageId: messageIdSchema,
    workflowViewDefinitionId: workflowViewDefinitionIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema.optional(),
    runnerFamily: workflowRunnerFamilyV3Schema,
    runnerBundleVersion: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    status: productRunStatusSchema,
    phase: noteCaptureRunPhaseSchema,
    finalMessageId: messageIdSchema.optional(),
    failure: runFailureSchema.optional(),
    ...entityBaseFields,
  })
  .strict();

/**
 * Direct Agent绕过Plan/Execution Contract，直接运行一个受Prompt Review约束的Pi Session。
 * `currentPromptReviewRequestId`只在waiting_human/prompt_review存在；历史审核事实独立保存。
 */
export const directAgentProductRunSchema = z
  .object({
    schemaVersion: z.literal("product-run.v3"),
    runKind: z.literal("direct_agent"),
    productRunId: productRunIdSchema,
    sessionId: productSessionIdSchema,
    sourceMessageId: messageIdSchema,
    workflowViewDefinitionId: workflowViewDefinitionIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    runnerFamily: z.enum(["direct-agent.v1", "memory-direct.v1", "memory-agent-direct.v1"]),
    runnerBundleVersion: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    status: productRunStatusSchema,
    phase: directAgentRunPhaseSchema,
    currentPromptReviewRequestId: promptReviewRequestIdSchema.optional(),
    /** 最新候选与最终采用候选分开，避免模型输出自动成为正式Message。 */
    currentDirectAgentCandidateId: directAgentCandidateIdSchema.optional(),
    finalDirectAgentCandidateId: directAgentCandidateIdSchema.optional(),
    finalMessageId: messageIdSchema.optional(),
    failure: runFailureSchema.optional(),
    ...entityBaseFields,
  })
  .strict();

export const productRunSchema = z.discriminatedUnion("runKind", [
  planningProductRunSchema,
  noteCaptureProductRunSchema,
  directAgentProductRunSchema,
]);

/* ---------- Run Attempt ---------- */

export const legacyRunAttemptKindSchema = z.enum([
  "workflow",
  "planning",
  "execution",
  "direct_agent",
]);
export const runAttemptKindSchema = z.enum([
  ...legacyRunAttemptKindSchema.options,
  "governance_review",
]);
export const runAttemptOutcomeSchema = z.enum(["running", "success", "failure"]);

export const runAttemptV2Schema = z
  .object({
    schemaVersion: z.literal("run-attempt.v2"),
    attemptId: runAttemptIdSchema,
    productRunId: productRunIdSchema,
    kind: runAttemptKindSchema,
    /** planning Attempt绑定它产生的Plan业务版本。 */
    planRevision: z.number().int().positive().optional(),
    /** execution Attempt绑定Approved Plan Step。 */
    stepId: z.string().min(1).max(100).optional(),
    /** execution Attempt绑定不可变Execution Contract及已成功依赖血缘。 */
    executionContractId: executionContractIdSchema.optional(),
    /** governance_review Attempt绑定唯一待审Execution Candidate。 */
    executionCandidateId: executionCandidateIdSchema.optional(),
    dependencyRefs: z
      .array(
        z
          .object({
            stepId: z.string().min(1).max(100),
            executionAttemptId: runAttemptIdSchema,
            sha256: sha256Schema,
          })
          .strict(),
      )
      .max(B2_MAX_PLAN_STEPS)
      .optional(),
    /** planning Attempt固定编译输入时的Run CAS与全部版本证据。 */
    inputRunRevision: z.number().int().positive().optional(),
    sourceMessageSha256: sha256Schema.optional(),
    priorPlanRevisionId: planRevisionIdSchema.optional(),
    revisionInputId: revisionInputIdSchema.optional(),
    inputManifestSha256: sha256Schema.optional(),
    promptTemplateVersion: z.string().min(1).max(100).optional(),
    modelConfigVersion: z.string().min(1).max(100).optional(),
    contextPackageId: contextPackageIdSchema.optional(),
    contextPackageSha256: sha256Schema.optional(),
    planningMemorySelectionId: planningMemorySelectionIdSchema.optional(),
    planningMemorySelectionSha256: sha256Schema.optional(),
    workflowMemoryContextId: workflowMemoryContextIdSchema.optional(),
    workflowMemoryContextSha256: sha256Schema.optional(),
    planningProjectContextId: planningProjectContextIdSchema.optional(),
    planningProjectContextSha256: sha256Schema.optional(),
    ruleSelectionId: ruleSelectionIdSchema.optional(),
    ruleSelectionSha256: sha256Schema.optional(),
    outcome: runAttemptOutcomeSchema,
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
      .max(64)
      .optional(),
    ...entityBaseFields,
  })
  .strict();

/** 已发布v1只读：没有治理Attempt，也没有Execution Candidate绑定。 */
export const runAttemptV1Schema = runAttemptV2Schema
  .omit({ executionCandidateId: true })
  .extend({
    schemaVersion: z.literal("run-attempt.v1"),
    kind: legacyRunAttemptKindSchema,
    executionCandidateId: z.never().optional(),
  })
  .strict();

export const runAttemptSchema = z.union([runAttemptV1Schema, runAttemptV2Schema]);

/* ---------- Plan ---------- */

/** 上下文引用：已提交产品事实通过ID + revision + Hash引用，不复制对象图。 */
export const contextRefSchema = z
  .object({
    refId: z.string().min(1).max(120),
    revision: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .strict();

export const planAssumptionSchema = z
  .object({
    statement: z.string().min(1).max(500),
    source: z.enum(["user", "context", "planner"]),
  })
  .strict();

export const planStepSchema = z
  .object({
    stepId: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    purpose: z.string().min(1).max(1000),
    dependsOn: z.array(z.string().min(1).max(100)).max(50),
    inputRefs: z.array(contextRefSchema).max(50),
    expectedOutput: z.string().min(1).max(1000),
    successCriteria: z.array(z.string().min(1).max(500)).min(1).max(20),
    requestedCapabilities: z.array(z.string().min(1).max(100)).max(20),
    risk: z.enum(["low", "medium", "high"]),
  })
  .strict();

/** Plan正文。planId/productRunId/revision/Hash/批准状态由Chat确定性生成，不在正文内。 */
export const planContentSchema = z
  .object({
    objective: z.string().min(1).max(2000),
    summary: z.string().min(1).max(4000),
    assumptions: z.array(planAssumptionSchema).max(50),
    openQuestions: z.array(z.string().min(1).max(500)).max(50),
    steps: z.array(planStepSchema).min(1).max(B2_MAX_PLAN_STEPS),
    completionCriteria: z.array(z.string().min(1).max(500)).min(1).max(20),
    warnings: z.array(z.string().min(1).max(500)).max(50),
  })
  .strict();

export const planRevisionStatusSchema = z.enum([
  "under_review",
  "approved",
  "superseded",
  "rejected",
  "expired",
]);

export const planRevisionSchema = z
  .object({
    schemaVersion: z.literal("plan-revision.v1"),
    planRevisionId: planRevisionIdSchema,
    planId: planIdSchema,
    productRunId: productRunIdSchema,
    /** 产生本候选的planning Attempt；用于拒绝延迟/陈旧模型结果。 */
    planningAttemptId: runAttemptIdSchema,
    /** Plan业务版本号，从1开始单调递增；旧版本永久保留。 */
    planRevision: z.number().int().positive(),
    status: planRevisionStatusSchema,
    content: planContentSchema,
    /** canonical JSON SHA-256；Decision必须绑定它。 */
    sha256: sha256Schema,
    ...entityBaseFields,
  })
  .strict();

/* ---------- Revision Input ---------- */

export const revisionInputSchema = z
  .object({
    schemaVersion: z.literal("revision-input.v1"),
    revisionInputId: revisionInputIdSchema,
    productRunId: productRunIdSchema,
    /** 用户要求修改的是哪个Plan业务版本。 */
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    instruction: z.string().min(1).max(2000),
    ...entityBaseFields,
  })
  .strict();

/* ---------- Approval Request ---------- */

export const approvalRequestStatusSchema = z.enum(["open", "decided", "expired"]);

export const approvalRequestSchema = z
  .object({
    schemaVersion: z.literal("approval-request.v1"),
    approvalRequestId: approvalRequestIdSchema,
    productRunId: productRunIdSchema,
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    planSha256: sha256Schema,
    status: approvalRequestStatusSchema,
    decidedByDecisionId: decisionIdSchema.optional(),
    /** 审批窗口是产品事实，不能只靠status假装存在过期语义。 */
    expiresAt: isoDateTimeSchema,
    expiredAt: isoDateTimeSchema.optional(),
    ...entityBaseFields,
  })
  .strict();

/* ---------- Decision ---------- */

export const decisionKindSchema = z.enum(["request_revision", "approve", "reject"]);

export const decisionSchema = z
  .object({
    schemaVersion: z.literal("decision.v1"),
    decisionId: decisionIdSchema,
    approvalRequestId: approvalRequestIdSchema,
    productRunId: productRunIdSchema,
    /** 决定绑定：三者加planSha256缺一不可，旧revision/旧Hash必须失败关闭。 */
    planId: planIdSchema,
    planRevision: z.number().int().positive(),
    planSha256: sha256Schema,
    kind: decisionKindSchema,
    revisionInputId: revisionInputIdSchema.optional(),
    reason: z.string().min(1).max(2000).optional(),
    principalId: principalIdSchema,
    /** 产生本决定的Decision Command，用于审计与幂等关联。 */
    commandId: commandIdSchema,
    ...entityBaseFields,
  })
  .strict();

/* ---------- Execution Contract ---------- */

/** 已批准、不可变的执行步骤；从Approved Plan确定性拷贝。 */
export const approvedExecutionStepSchema = z
  .object({
    stepId: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    purpose: z.string().min(1).max(1000),
    dependsOn: z.array(z.string().min(1).max(100)).max(50),
    inputRefs: z.array(contextRefSchema).max(50),
    expectedOutput: z.string().min(1).max(1000),
    successCriteria: z.array(z.string().min(1).max(500)).min(1).max(20),
    capabilityRefs: z.array(z.string().min(1).max(100)).max(20),
  })
  .strict();

export const executionContractSchema = z
  .object({
    schemaVersion: z.literal("execution-contract.v1"),
    executionContractId: executionContractIdSchema,
    productRunId: productRunIdSchema,
    approvedPlanId: planIdSchema,
    approvedPlanRevision: z.number().int().positive(),
    approvedPlanSha256: sha256Schema,
    approvalDecisionId: decisionIdSchema,
    steps: z.array(approvedExecutionStepSchema).min(1).max(B2_MAX_PLAN_STEPS),
    /** 从Approved Plan确定性拷贝的完成条件；验证时必须逐条有证据。 */
    completionCriteria: z.array(z.string().min(1).max(500)).min(1).max(20),
    /**
     * Coding能力所绑定的产品Workspace。rootId只是一段服务端配置别名；
     * 绝不把canonical path写入Product Store、Workflow checkpoint或Trace。
     * 纯文本Contract可以没有Workspace；任何workspace/shell能力都必须有它。
     */
    workspaceRef: z
      .object({
        projectId: projectIdSchema,
        projectResourceId: projectResourceIdSchema,
        rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
        revision: z.number().int().positive(),
      })
      .strict()
      .optional(),
    /** 从Approved Plan汇总的工具能力白名单；创建后不可修改。 */
    capabilityRefs: z.array(z.string().min(1).max(100)).max(20),
    limits: z
      .object({
        maxTurnsPerStep: z.number().int().positive().max(50),
        timeoutMsPerStep: z.number().int().positive().max(3_600_000),
        tokenBudgetPerStep: z.number().int().positive().max(1_000_000).optional(),
      })
      .strict(),
    sha256: sha256Schema,
    ...entityBaseFields,
  })
  .strict();

/* ---------- Execution Candidate ---------- */

/** 第一版finalOutput只允许Markdown section数据；服务端确定性渲染Markdown。 */
export const markdownSectionSchema = z
  .object({
    heading: z.string().min(1).max(200),
    body: z.string().min(1).max(50_000),
  })
  .strict();

/** Planning Executor只把Pi Journal中可核验的Tool Result引用提升为产品候选证据。 */
export const executionEvidenceRefSchema = z
  .object({
    kind: z.literal("pi_tool_result"),
    executionAttemptId: runAttemptIdSchema,
    capabilityId: z
      .string()
      .min(8)
      .max(240)
      .regex(/^[a-z][a-z0-9._:-]+$/u),
    localName: z.string().min(1).max(160),
    toolCallId: z.string().min(1).max(160),
    inputSha256: sha256Schema,
    resultSha256: sha256Schema,
    outcome: z.enum(["completed", "failed"]),
  })
  .strict();

export const stepResultSchema = z
  .object({
    stepId: z.string().min(1).max(100),
    executionAttemptId: runAttemptIdSchema,
    inputManifestSha256: sha256Schema,
    dependencyRefs: z
      .array(
        z
          .object({
            stepId: z.string().min(1).max(100),
            executionAttemptId: runAttemptIdSchema,
            sha256: sha256Schema,
          })
          .strict(),
      )
      .max(B2_MAX_PLAN_STEPS),
    output: z.string().min(1).max(50_000),
    sections: z.array(markdownSectionSchema).max(20),
    successCriteriaEvidence: z.array(z.string().min(1).max(1000)).min(1).max(20),
    criteriaEvidence: z.array(z.string().min(1).max(1000)).max(20),
    /** 缺失只用于历史Candidate；新严格验证要求至少一个成功的结构化引用。 */
    executionEvidenceRefs: z.array(executionEvidenceRefSchema).max(200).optional(),
    warnings: z.array(z.string().min(1).max(500)).max(50),
    sha256: sha256Schema,
  })
  .strict();

export const executionCandidateSchema = z
  .object({
    schemaVersion: z.literal("execution-candidate.v1"),
    executionCandidateId: executionCandidateIdSchema,
    productRunId: productRunIdSchema,
    executionContractId: executionContractIdSchema,
    /** 历史Candidate缺失；新Runtime必须声明并满足结构化Tool证据政策。 */
    evidencePolicyVersion: z.literal("structured-tool-result.v1").optional(),
    stepResults: z.array(stepResultSchema).min(1).max(B2_MAX_PLAN_STEPS),
    finalOutput: z
      .object({
        format: z.literal("markdown_sections"),
        sections: z
          .array(markdownSectionSchema)
          .min(1)
          .max(B2_MAX_PLAN_STEPS * 20),
      })
      .strict(),
    completionCriteriaEvidence: z.array(z.string().min(1).max(1000)).min(1).max(50),
    warnings: z.array(z.string().min(1).max(500)).max(50),
    sha256: sha256Schema,
    ...entityBaseFields,
  })
  .strict();

/* ---------- Validation Result ---------- */

export const validationResultV2Schema = z
  .object({
    schemaVersion: z.literal("validation-result.v2"),
    validationResultId: validationResultIdSchema,
    productRunId: productRunIdSchema,
    executionContractId: executionContractIdSchema,
    executionCandidateId: executionCandidateIdSchema,
    /** 旧固定Runner缺省为true；新Runner必须显式持久化冻结的验证策略。 */
    strictEvidence: z.boolean().optional(),
    /** 新治理检查节点冻结的语义审查；历史确定性Validation可以缺省。 */
    governanceReview: governanceReviewRecordSchema.optional(),
    outcome: z.enum(["pass", "fail"]),
    failures: z
      .array(
        z
          .object({
            code: z
              .string()
              .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
              .max(64),
            detail: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(50),
    ...entityBaseFields,
  })
  .strict();

/** 已发布v1只读：只记录确定性Validation，不接受治理Reviewer语义。 */
export const validationResultV1Schema = validationResultV2Schema
  .omit({ governanceReview: true })
  .extend({
    schemaVersion: z.literal("validation-result.v1"),
    governanceReview: z.never().optional(),
  })
  .strict();

export const validationResultSchema = z.union([validationResultV1Schema, validationResultV2Schema]);

/* ---------- Artifact ---------- */

export const artifactSchema = z
  .object({
    schemaVersion: z.literal("artifact.v1"),
    artifactId: artifactIdSchema,
    productRunId: productRunIdSchema,
    kind: z.literal("markdown"),
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(200_000),
    sha256: sha256Schema,
    ...entityBaseFields,
  })
  .strict();

/* ---------- Command Receipt ---------- */

/**
 * 命令幂等事实。同一commandId + 相同请求Hash返回原结果；
 * 同一commandId + 不同请求Hash返回409 COMMAND_ID_REUSED。
 */
export const commandReceiptSchema = z
  .object({
    commandId: commandIdSchema,
    commandType: z.string().min(1).max(100),
    requestSha256: sha256Schema,
    /** 重建原响应所需的产品对象引用；不复制响应正文。 */
    resultRefs: z.record(z.string().min(1).max(50), z.string().min(1).max(200)),
    committedStoreRevision: z.number().int().nonnegative(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

/* ---------- Outbox ---------- */

export const outboxEntryKindSchema = z.enum([
  "workflow_start",
  "workflow_resume",
  "memory_import_start",
  "memory_import_reconcile",
  "memory_write_start",
  "memory_write_reconcile",
  "project_intake_start",
  "project_intake_resume",
  "project_advancement_start",
  "project_advancement_resume",
]);

export const outboxEntryStatusSchema = z.enum([
  "pending",
  "dispatched",
  "acknowledged",
  "outcome_unknown",
  "failed_terminal",
]);

/**
 * Transactional Outbox：与产品事实同一次快照提交。
 * 只保存逻辑目标和公开对象引用，绝不保存Hook Token或Workflow Run ID。
 */
const outboxCommonFields = {
  schemaVersion: z.literal("outbox-entry.v1"),
  outboxId: outboxEntryIdSchema,
  status: outboxEntryStatusSchema,
  dispatchAttempts: z.number().int().nonnegative(),
  lastErrorCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
    .max(64)
    .optional(),
  ...entityBaseFields,
};

/** kind决定唯一目标，避免把无关可选字段组合成非法派发。 */
export const outboxEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...outboxCommonFields,
      kind: z.literal("workflow_start"),
      productRunId: productRunIdSchema,
      workflowRunSpecId: workflowRunSpecIdSchema.optional(),
      runnerFamily: workflowRunnerFamilyV3Schema.optional(),
      runnerBundleVersion: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._-]+$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...outboxCommonFields,
      kind: z.literal("workflow_resume"),
      productRunId: productRunIdSchema,
      approvalRequestId: approvalRequestIdSchema.optional(),
      decisionId: decisionIdSchema.optional(),
      hookNoteCandidateId: noteCandidateIdSchema.optional(),
      noteCandidateId: noteCandidateIdSchema.optional(),
      noteDecisionId: noteDecisionIdSchema.optional(),
      promptReviewRequestId: promptReviewRequestIdSchema.optional(),
      promptReviewDecisionId: promptReviewDecisionIdSchema.optional(),
      workflowRunSpecId: workflowRunSpecIdSchema.optional(),
      runnerFamily: workflowRunnerFamilyV3Schema.optional(),
      runnerBundleVersion: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._-]+$/)
        .optional(),
    })
    .strict()
    .check((ctx) => {
      const value = ctx.value;
      const hasPlanning = value.approvalRequestId !== undefined || value.decisionId !== undefined;
      const hasNote =
        value.hookNoteCandidateId !== undefined ||
        value.noteCandidateId !== undefined ||
        value.noteDecisionId !== undefined;
      const hasPromptReview =
        value.promptReviewRequestId !== undefined || value.promptReviewDecisionId !== undefined;
      if (
        Number(hasPlanning) + Number(hasNote) + Number(hasPromptReview) !== 1 ||
        (hasPlanning &&
          (value.approvalRequestId === undefined || value.decisionId === undefined)) ||
        (hasNote &&
          (value.hookNoteCandidateId === undefined ||
            value.noteCandidateId === undefined ||
            value.noteDecisionId === undefined)) ||
        (hasPromptReview &&
          (value.promptReviewRequestId === undefined || value.promptReviewDecisionId === undefined))
      ) {
        ctx.issues.push({
          code: "custom",
          input: value,
          message: "workflow_resume必须且只能携带Planning、Note或Prompt Review决定引用",
          path: ["kind"],
        });
      }
    }),
  z
    .object({
      ...outboxCommonFields,
      kind: z.literal("memory_import_start"),
      memoryImportIntentId: memoryImportIntentIdSchema,
      memoryImportResultId: memoryImportResultIdSchema,
      expectedResultRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...outboxCommonFields,
      kind: z.literal("memory_import_reconcile"),
      memoryImportIntentId: memoryImportIntentIdSchema,
      memoryImportResultId: memoryImportResultIdSchema,
      expectedResultRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...outboxCommonFields,
      kind: z.literal("memory_write_start"),
      memoryWriteIntentId: memoryWriteIntentIdSchema,
      memoryWriteResultId: memoryWriteResultIdSchema,
      expectedResultRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...outboxCommonFields,
      kind: z.literal("memory_write_reconcile"),
      memoryWriteIntentId: memoryWriteIntentIdSchema,
      memoryWriteResultId: memoryWriteResultIdSchema,
      expectedResultRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...outboxCommonFields,
      kind: z.literal("project_intake_start"),
      projectCandidateId: projectCandidateIdSchema,
      expectedCandidateRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...outboxCommonFields,
      kind: z.literal("project_intake_resume"),
      projectCandidateId: projectCandidateIdSchema,
      expectedCandidateRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...outboxCommonFields,
      kind: z.literal("project_advancement_start"),
      projectCandidateId: projectCandidateIdSchema,
      expectedCandidateRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...outboxCommonFields,
      kind: z.literal("project_advancement_resume"),
      projectCandidateId: projectCandidateIdSchema,
      expectedCandidateRevision: z.number().int().positive(),
    })
    .strict(),
]);

/* ---------- 推导类型 ---------- */

export type ProductSession = z.infer<typeof productSessionSchema>;
export type Message = z.infer<typeof messageSchema>;
export type ProductRun = z.infer<typeof productRunSchema>;
export type RunAttempt = z.infer<typeof runAttemptSchema>;
export type PlanContent = z.infer<typeof planContentSchema>;
export type PlanRevision = z.infer<typeof planRevisionSchema>;
export type RevisionInput = z.infer<typeof revisionInputSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type ExecutionContract = z.infer<typeof executionContractSchema>;
export type ExecutionEvidenceRef = z.infer<typeof executionEvidenceRefSchema>;
export type ExecutionCandidate = z.infer<typeof executionCandidateSchema>;
export type ValidationResult = z.infer<typeof validationResultSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
export type OutboxEntry = z.infer<typeof outboxEntrySchema>;
export type ContextRef = z.infer<typeof contextRefSchema>;
