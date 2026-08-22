/**
 * Trace合同基础件：事件名目录、对象引用、公共字段与defineTraceEvent工厂。
 * 事件族在events-*.ts；对外统一经../trace.js barrel。
 */
import { z } from "zod";
import { sha256Schema } from "../hash.js";
import {
  interactionIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  runAttemptIdSchema,
} from "../ids.js";

export const TRACE_SCHEMA_VERSION = 1;

export const traceLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type TraceLevel = z.infer<typeof traceLevelSchema>;

export const traceOutcomeSchema = z.enum(["success", "failure", "rejected", "unknown"]);
export type TraceOutcome = z.infer<typeof traceOutcomeSchema>;

/** 任务书§7.3规定的必须记录的边界事件名。 */
export const TRACE_EVENT_NAMES = {
  dshAdapterRequestCaptured: "dsh.adapter_request.captured",
  bridgeDispatchPrepared: "bridge.dispatch.prepared",
  httpCommandReceived: "http.command.received",
  httpCommandAccepted: "http.command.accepted",
  httpCommandRejected: "http.command.rejected",
  httpCommandCompleted: "http.command.completed",
  productTransactionStarted: "product.transaction.started",
  productTransactionCommitted: "product.transaction.committed",
  productTransactionFailed: "product.transaction.failed",
  productRunCreated: "product_run.created",
  productRunTransitioned: "product_run.transitioned",
  contextAssemblyStarted: "context.assembly.started",
  contextAssemblyCompleted: "context.assembly.completed",
  contextAssemblyFailed: "context.assembly.failed",
  memoryQueryStarted: "memory.query.started",
  memoryQueryCompleted: "memory.query.completed",
  memoryQueryFailed: "memory.query.failed",
  memoryImportIntentCreated: "memory.import.intent_created",
  memoryImportStarted: "memory.import.started",
  memoryImportAccepted: "memory.import.accepted",
  memoryImportMaterialized: "memory.import.materialized",
  memoryImportOutcomeUnknown: "memory.import.outcome_unknown",
  memoryImportFailed: "memory.import.failed",
  memoryImportReconcileStarted: "memory.import.reconcile.started",
  memoryImportReconcileCompleted: "memory.import.reconcile.completed",
  memoryImportReconcileFailed: "memory.import.reconcile.failed",
  projectIntakeStarted: "project.intake.started",
  projectIntakeCandidatePublished: "project.intake.candidate_published",
  projectIntakeConfirmed: "project.intake.confirmed",
  projectIntakeRejected: "project.intake.rejected",
  projectAdvancementStarted: "project.advancement.started",
  projectAdvancementCandidatePublished: "project.advancement.candidate_published",
  projectAdvancementConfirmed: "project.advancement.confirmed",
  projectAdvancementRejected: "project.advancement.rejected",
  projectLifecycleTransitioned: "project.lifecycle.transitioned",
  projectStageTransitioned: "project.stage.transitioned",
  projectMilestoneTransitioned: "project.milestone.transitioned",
  projectUpdatePublished: "project.update.published",
  projectUnderstandingStarted: "project.understanding.started",
  projectUnderstandingCompleted: "project.understanding.completed",
  projectUnderstandingFailed: "project.understanding.failed",
  projectResourceObserveStarted: "project.resource.observe.started",
  projectResourceObserveCompleted: "project.resource.observe.completed",
  projectResourceObserveFailed: "project.resource.observe.failed",
  projectActionCreated: "project.action.created",
  projectActionAssigned: "project.action.assigned",
  projectActionTransitioned: "project.action.transitioned",
  projectDecisionCandidate: "project.decision.candidate",
  projectDecisionCommitted: "project.decision.committed",
  projectDecisionRejected: "project.decision.rejected",
  projectContributionCandidate: "project.contribution.candidate",
  projectContributionCommitted: "project.contribution.committed",
  projectContributionRejected: "project.contribution.rejected",
  workflowStartRequested: "workflow.start.requested",
  workflowStartStarted: "workflow.start.started",
  workflowStartFailed: "workflow.start.failed",
  workflowStepStarted: "workflow.step.started",
  workflowStepCompleted: "workflow.step.completed",
  workflowStepFailed: "workflow.step.failed",
  workflowStepReplayed: "workflow.step.replayed",
  workflowMemoryNodeStarted: "workflow.memory_node.started",
  workflowMemoryNodeCompleted: "workflow.memory_node.completed",
  workflowMemoryNodeFailed: "workflow.memory_node.failed",
  workflowMemoryNodeOutcomeUnknown: "workflow.memory_node.outcome_unknown",
  planCandidateReceived: "plan.candidate.received",
  planCandidateRejected: "plan.candidate.rejected",
  planCandidatePublished: "plan.candidate.published",
  noteCandidateReceived: "note.candidate.received",
  noteCandidateRejected: "note.candidate.rejected",
  approvalCreated: "approval.created",
  decisionCommitted: "decision.committed",
  decisionRejected: "decision.rejected",
  workflowHookWaiting: "workflow.hook.waiting",
  workflowHookResumeDispatched: "workflow.hook.resume_dispatched",
  workflowHookResumed: "workflow.hook.resumed",
  workflowHookResumeFailed: "workflow.hook.resume_failed",
  providerRequestStarted: "provider.request.started",
  providerRequestCompleted: "provider.request.completed",
  providerRequestFailed: "provider.request.failed",
  piNodeStarted: "pi.node.started",
  piNodeCompleted: "pi.node.completed",
  piNodeFailed: "pi.node.failed",
  piOperationAccepted: "pi.operation.accepted",
  piOperationStarted: "pi.operation.started",
  piOperationCompleted: "pi.operation.completed",
  piOperationFailed: "pi.operation.failed",
  piOperationOutcomeUnknown: "pi.operation.outcome_unknown",
  piSessionStarted: "pi.session.started",
  piSessionSettled: "pi.session.settled",
  piTurnStarted: "pi.turn.started",
  piTurnCompleted: "pi.turn.completed",
  piMessageCompleted: "pi.message.completed",
  piToolIntentPersisted: "pi.tool.intent_persisted",
  piToolBlocked: "pi.tool.blocked",
  piToolCompleted: "pi.tool.completed",
  piToolFailed: "pi.tool.failed",
  piToolOutcomeUnknown: "pi.tool.outcome_unknown",
  piCompactionStarted: "pi.compaction.started",
  piCompactionCompleted: "pi.compaction.completed",
  executionValidated: "execution.validated",
  executionRejected: "execution.rejected",
  productCommitStarted: "product_commit.started",
  productCommitCommitted: "product_commit.committed",
  productCommitFailed: "product_commit.failed",
  /** 本地调试生命周期（B1调试基线使用）。 */
  serviceDebugStarted: "service.debug.started",
  serviceDebugStopped: "service.debug.stopped",
} as const;

/* ---------- 受限基础Schema ---------- */

/** Trace内部关联ID（traceId/spanId及后端私有引用）。 */
export const traceIdLikeSchema = z.string().regex(/^[a-z][a-z0-9]*_[A-Za-z0-9-]{1,80}$/);

/** 版本证据标识（Workflow Definition、Prompt模板、模型配置版本）。 */
export const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/** SHA-256摘要，固定小写十六进制。 */
export { sha256Schema } from "../hash.js";

/** 稳定错误码：小写点分层级，不允许塞入原始错误消息。 */
export const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
  .max(64);

/** 预请求失败错误族：Provider请求尚未形成输入manifest时的失败。 */
export const PROVIDER_PRE_REQUEST_ERROR_PREFIX = "provider.pre_request.";

/** 仓库相对路径（安全Stack Frame用）：不允许绝对路径、`..`、反斜杠与空白。 */
export const repoRelativePathSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .max(200)
  .refine((path) => !path.split("/").some((segment) => segment === ".."), {
    message: "不允许包含..路径段",
  });

export const safeStackFrameSchema = z
  .object({
    modulePath: repoRelativePathSchema,
    line: z.number().int().positive().max(1_000_000),
    column: z.number().int().positive().max(100_000),
  })
  .strict();

/**
 * 错误信息：稳定code、错误类型名、可选stack指纹与仓库相对安全帧。
 * 不保存原始Error.message（可能含用户正文或Provider响应）。
 */
export const traceErrorSchema = z
  .object({
    code: stableErrorCodeSchema,
    type: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
    stackFingerprint: sha256Schema.optional(),
    stackFrames: z.array(safeStackFrameSchema).max(20).optional(),
  })
  .strict();

export type TraceError = z.infer<typeof traceErrorSchema>;

/* ---------- 对象引用：事件专属、类型固定、回放所需revision/Hash强制 ---------- */

export const objectIdSchema = traceIdLikeSchema;
export const revisionSchema = z.number().int().positive().max(1_000_000);

/** 版本化对象（plan/decision）：必须携带revision + sha256，回放才能定位版本并校验完整性。 */
export function versionedObjectRef<Type extends string>(objectType: Type) {
  return z
    .object({
      objectType: z.literal(objectType),
      objectId: objectIdSchema,
      revision: revisionSchema,
      sha256: sha256Schema,
    })
    .strict();
}

/** 不可变对象：至少携带sha256。 */
export function immutableObjectRef<Type extends string>(objectType: Type) {
  return z
    .object({
      objectType: z.literal(objectType),
      objectId: objectIdSchema,
      revision: revisionSchema.optional(),
      sha256: sha256Schema,
    })
    .strict();
}

export const messageRefSchema = immutableObjectRef("message");
export const planRefSchema = versionedObjectRef("plan");
export const decisionRefSchema = versionedObjectRef("decision");
export const executionContractRefSchema = immutableObjectRef("execution_contract");
export const executionCandidateRefSchema = immutableObjectRef("execution_candidate");
export const contextPackageRefSchema = versionedObjectRef("context_package");
export const artifactRefSchema = immutableObjectRef("artifact");

/** 通用对象引用：类型判别联合，每种类型的revision/Hash语义固定。 */
export const traceObjectRefSchema = z.discriminatedUnion("objectType", [
  messageRefSchema,
  planRefSchema,
  decisionRefSchema,
  executionContractRefSchema,
  executionCandidateRefSchema,
  contextPackageRefSchema,
  artifactRefSchema,
]);

export type TraceObjectRef = z.infer<typeof traceObjectRefSchema>;

/* ---------- HTTP ---------- */

export const httpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/** 路由模板（如/api/sessions/:sessionId/messages）：不允许query、原始URL或正文。 */
export const routeTemplateSchema = z
  .string()
  .regex(/^\/(?:[A-Za-z0-9:_-]+\/?)*$/)
  .max(128);

export const httpStatusCodeSchema = z.number().int().min(100).max(599);

/* ---------- 产品Run状态/阶段（B3将以领域枚举收紧，当前为受限字符串） ---------- */

export const runStatusSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export const runPhaseSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

/** 事务/用例类型：稳定小写标识。 */
export const transactionTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
  .max(64);

/* ---------- Workflow ---------- */

/** 稳定step key。 */
export const stepKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/)
  .max(64);

export const stepAttemptSchema = z.number().int().positive().max(1000);

/* ---------- Provider ---------- */

/** Provider固定为bailian；模型冻结为qwen3.7-plus（任务书§9），新增需合同PR。 */
export const providerNameSchema = z.literal("bailian");
export const providerModelSchema = z.literal("qwen3.7-plus");

export const endpointHostSchema = z
  .string()
  .regex(
    /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9][a-z0-9-]{0,61}[a-z0-9])*$/,
    "endpointHost必须是合法主机名",
  );

export const providerRequestIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);

export const tokenUsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative().max(100_000_000),
    completionTokens: z.number().int().nonnegative().max(100_000_000),
    totalTokens: z.number().int().nonnegative().max(100_000_000),
  })
  .strict();

/* ---------- 事件族关联字段（回放强制的最小关联） ---------- */

/** Product Run事件族。 */
export const runScopedFields = {
  productRunId: productRunIdSchema,
  attemptId: runAttemptIdSchema,
};

/** Workflow事件族：Run + Attempt + Definition版本。 */
export const workflowScopedFields = {
  ...runScopedFields,
  workflowDefinitionVersion: versionSchema,
};

/** 模型事件族（Provider/pi）：Run + Attempt + Prompt模板 + 模型配置版本。 */
export const modelScopedFields = {
  ...runScopedFields,
  promptTemplateVersion: versionSchema,
  modelConfigVersion: versionSchema,
};

export const sessionFields = {
  productSessionId: productSessionIdSchema.optional(),
  interactionId: interactionIdSchema.optional(),
};

/* ---------- 公共字段（只保留真正适用于所有事件的字段） ---------- */

export const traceCommonFields = {
  schemaVersion: z.literal(TRACE_SCHEMA_VERSION),
  eventId: traceIdLikeSchema,
  timestamp: z.iso.datetime(),
  level: traceLevelSchema,
  traceId: traceIdLikeSchema,
  spanId: traceIdLikeSchema,
  parentSpanId: traceIdLikeSchema.optional(),
};

export const durationMsOptional = {
  durationMs: z.number().nonnegative().max(3_600_000).optional(),
};
export const durationMsRequired = { durationMs: z.number().nonnegative().max(3_600_000) };

export function defineTraceEvent<
  Name extends string,
  Result extends TraceOutcome,
  Fields extends Record<string, z.ZodTypeAny>,
>(eventName: Name, outcome: Result, fields: Fields) {
  // durationMs由各事件在fields中显式声明一次（durationMsOptional/Required），
  // 避免公共可选字段与事件必填覆盖时的泛型spread推导陷阱。
  return z
    .object({
      ...traceCommonFields,
      eventName: z.literal(eventName),
      outcome: z.literal(outcome),
      ...fields,
    })
    .strict();
}

export const refs = z.array(traceObjectRefSchema).max(8);

/* ---------- 事件定义 ---------- */

// HTTP：不记录请求Body、Query正文或可能携带用户内容的原始URL；requestId必填。
