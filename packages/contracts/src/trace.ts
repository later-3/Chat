import { z } from "zod";
import {
  approvalRequestIdSchema,
  commandIdSchema,
  interactionIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  runAttemptIdSchema,
  workflowDefinitionIdSchema,
} from "./ids.js";

/**
 * 结构化Trace合同（任务书§7）。
 *
 * 职责边界：
 * - Trace记录系统边界、状态转换、调用关系、错误、耗时与统计；
 * - 用户正文、Plan正文、模型候选正文、Prompt、Provider请求/响应正文只保存在
 *   Product Store，Trace通过`对象ID + revision + sha256`引用它们；
 * - Trace不是第二份产品事实源，永远不保存模型隐藏推理；
 * - 合同是以eventName为判别字段的严格联合：未声明字段（含body/content/
 *   message/prompt/payload等任意正文入口）在根部与嵌套层都失败关闭，
 *   不存在Record<string, unknown>形式的内容通道。
 */

export const TRACE_SCHEMA_VERSION = 1;

export const traceLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type TraceLevel = z.infer<typeof traceLevelSchema>;

export const traceOutcomeSchema = z.enum(["success", "failure", "rejected", "unknown"]);
export type TraceOutcome = z.infer<typeof traceOutcomeSchema>;

/** 任务书§7.3规定的必须记录的边界事件名。 */
export const TRACE_EVENT_NAMES = {
  httpCommandReceived: "http.command.received",
  httpCommandAccepted: "http.command.accepted",
  httpCommandRejected: "http.command.rejected",
  httpCommandCompleted: "http.command.completed",
  productTransactionStarted: "product.transaction.started",
  productTransactionCommitted: "product.transaction.committed",
  productTransactionFailed: "product.transaction.failed",
  productRunCreated: "product_run.created",
  productRunTransitioned: "product_run.transitioned",
  workflowStartRequested: "workflow.start.requested",
  workflowStartStarted: "workflow.start.started",
  workflowStartFailed: "workflow.start.failed",
  workflowStepStarted: "workflow.step.started",
  workflowStepCompleted: "workflow.step.completed",
  workflowStepFailed: "workflow.step.failed",
  workflowStepReplayed: "workflow.step.replayed",
  planCandidateReceived: "plan.candidate.received",
  planCandidateRejected: "plan.candidate.rejected",
  planCandidatePublished: "plan.candidate.published",
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

/** Trace内部关联ID（traceId/spanId/requestId/eventId及后端私有引用）。 */
const traceIdLikeSchema = z.string().regex(/^[a-z][a-z0-9]*_[A-Za-z0-9-]{1,80}$/);

/** 版本证据标识（Workflow Definition、Prompt模板、模型配置版本）。 */
const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/** SHA-256摘要，固定小写十六进制。 */
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** 稳定错误码：小写点分层级，不允许塞入原始错误消息。 */
export const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
  .max(64);

/** 仓库相对路径（安全Stack Frame用）：不允许绝对路径、`..`、反斜杠与空白。 */
const repoRelativePathSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .max(200)
  .refine((path) => !path.split("/").some((segment) => segment === ".."), {
    message: "不允许包含..路径段",
  });

const safeStackFrameSchema = z
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

/** 产品对象引用：Trace关联产品事实的唯一方式，不复制正文。 */
export const traceObjectTypeSchema = z.enum([
  "message",
  "plan",
  "decision",
  "execution_contract",
  "execution_candidate",
  "context_package",
  "artifact",
]);

export const traceObjectRefSchema = z
  .object({
    objectType: traceObjectTypeSchema,
    objectId: traceIdLikeSchema,
    revision: z.number().int().positive().max(1_000_000).optional(),
    sha256: sha256Schema.optional(),
  })
  .strict();

export type TraceObjectRef = z.infer<typeof traceObjectRefSchema>;

/* ---------- HTTP ---------- */

const httpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** 路由模板（如/api/sessions/:sessionId/messages）：不允许query、原始URL或正文。 */
const routeTemplateSchema = z
  .string()
  .regex(/^\/(?:[A-Za-z0-9:_-]+\/?)*$/)
  .max(128);

const httpStatusCodeSchema = z.number().int().min(100).max(599);

/* ---------- 产品Run状态/阶段（B3将以领域枚举收紧，当前为受限字符串） ---------- */

const runStatusSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const runPhaseSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

/** 事务/用例类型：稳定小写标识。 */
const transactionTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
  .max(64);

/* ---------- Workflow ---------- */

/** 稳定step key。 */
const stepKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/)
  .max(64);

const stepAttemptSchema = z.number().int().positive().max(1000);

/* ---------- Provider ---------- */

/** Provider固定为bailian；模型冻结为qwen3.7-plus（任务书§9），新增需合同PR。 */
const providerNameSchema = z.literal("bailian");
const providerModelSchema = z.literal("qwen3.7-plus");

const endpointHostSchema = z
  .string()
  .regex(
    /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
    "endpointHost必须是合法主机名",
  );

const providerRequestIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);

const tokenUsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative().max(100_000_000),
    completionTokens: z.number().int().nonnegative().max(100_000_000),
    totalTokens: z.number().int().nonnegative().max(100_000_000),
  })
  .strict();

/* ---------- 公共字段（每个事件严格持有自己需要的字段） ---------- */

const traceCommonFields = {
  schemaVersion: z.literal(TRACE_SCHEMA_VERSION),
  eventId: traceIdLikeSchema,
  timestamp: z.iso.datetime(),
  level: traceLevelSchema,
  traceId: traceIdLikeSchema,
  spanId: traceIdLikeSchema,
  parentSpanId: traceIdLikeSchema.optional(),
  requestId: traceIdLikeSchema.optional(),
  productSessionId: productSessionIdSchema.optional(),
  interactionId: interactionIdSchema.optional(),
  productRunId: productRunIdSchema.optional(),
  attemptId: runAttemptIdSchema.optional(),
  commandId: commandIdSchema.optional(),
  workflowDefinitionVersion: versionSchema.optional(),
  promptTemplateVersion: versionSchema.optional(),
  modelConfigVersion: versionSchema.optional(),
  durationMs: z.number().nonnegative().max(3_600_000).optional(),
  outcome: traceOutcomeSchema,
};

function defineTraceEvent<Name extends string, Fields extends Record<string, z.ZodTypeAny>>(
  eventName: Name,
  fields: Fields,
) {
  return z
    .object({
      ...traceCommonFields,
      eventName: z.literal(eventName),
      ...fields,
    })
    .strict();
}

const refs = z.array(traceObjectRefSchema).max(8);

/* ---------- 事件定义 ---------- */

// HTTP：不记录请求Body、Query正文或可能携带用户内容的原始URL。
const httpCommandReceivedSchema = defineTraceEvent(TRACE_EVENT_NAMES.httpCommandReceived, {
  httpMethod: httpMethodSchema,
});

const httpCommandAcceptedSchema = defineTraceEvent(TRACE_EVENT_NAMES.httpCommandAccepted, {
  httpMethod: httpMethodSchema,
  routeTemplate: routeTemplateSchema,
  statusCode: httpStatusCodeSchema,
});

const httpCommandRejectedSchema = defineTraceEvent(TRACE_EVENT_NAMES.httpCommandRejected, {
  httpMethod: httpMethodSchema,
  statusCode: httpStatusCodeSchema,
  routeTemplate: routeTemplateSchema.optional(),
  errorCode: stableErrorCodeSchema.optional(),
});

const httpCommandCompletedSchema = defineTraceEvent(TRACE_EVENT_NAMES.httpCommandCompleted, {
  httpMethod: httpMethodSchema,
  statusCode: httpStatusCodeSchema,
  routeTemplate: routeTemplateSchema.optional(),
});

// 产品事务。
const productTransactionStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productTransactionStarted,
  {
    transactionType: transactionTypeSchema,
    inputRefs: refs.optional(),
  },
);

const productTransactionCommittedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productTransactionCommitted,
  {
    transactionType: transactionTypeSchema,
    inputRefs: refs.optional(),
    outputRefs: refs.optional(),
  },
);

const productTransactionFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productTransactionFailed,
  {
    transactionType: transactionTypeSchema,
    error: traceErrorSchema,
    inputRefs: refs.optional(),
  },
);

// Product Run状态转换。
const productRunCreatedSchema = defineTraceEvent(TRACE_EVENT_NAMES.productRunCreated, {
  runStatus: runStatusSchema,
  phase: runPhaseSchema,
  revision: z.number().int().nonnegative().max(1_000_000),
});

const productRunTransitionedSchema = defineTraceEvent(TRACE_EVENT_NAMES.productRunTransitioned, {
  fromStatus: runStatusSchema,
  toStatus: runStatusSchema,
  fromPhase: runPhaseSchema.optional(),
  toPhase: runPhaseSchema.optional(),
  revision: z.number().int().nonnegative().max(1_000_000),
});

// Workflow：runMappingRef为后端私有映射引用，不是Hook Token。
const workflowStartRequestedSchema = defineTraceEvent(TRACE_EVENT_NAMES.workflowStartRequested, {
  workflowDefinitionId: workflowDefinitionIdSchema,
});

const workflowStartStartedSchema = defineTraceEvent(TRACE_EVENT_NAMES.workflowStartStarted, {
  workflowDefinitionId: workflowDefinitionIdSchema,
  runMappingRef: traceIdLikeSchema,
});

const workflowStartFailedSchema = defineTraceEvent(TRACE_EVENT_NAMES.workflowStartFailed, {
  workflowDefinitionId: workflowDefinitionIdSchema,
  error: traceErrorSchema,
});

const workflowStepStartedSchema = defineTraceEvent(TRACE_EVENT_NAMES.workflowStepStarted, {
  stepKey: stepKeySchema,
  stepAttempt: stepAttemptSchema,
  replay: z.boolean(),
});

const workflowStepCompletedSchema = defineTraceEvent(TRACE_EVENT_NAMES.workflowStepCompleted, {
  stepKey: stepKeySchema,
  stepAttempt: stepAttemptSchema,
  replay: z.boolean(),
  outputRefs: refs.optional(),
});

const workflowStepFailedSchema = defineTraceEvent(TRACE_EVENT_NAMES.workflowStepFailed, {
  stepKey: stepKeySchema,
  stepAttempt: stepAttemptSchema,
  replay: z.boolean(),
  error: traceErrorSchema,
});

const workflowStepReplayedSchema = defineTraceEvent(TRACE_EVENT_NAMES.workflowStepReplayed, {
  stepKey: stepKeySchema,
  stepAttempt: stepAttemptSchema,
});

// Plan候选。
const planCandidateReceivedSchema = defineTraceEvent(TRACE_EVENT_NAMES.planCandidateReceived, {
  candidateSha256: sha256Schema,
});

const planCandidateRejectedSchema = defineTraceEvent(TRACE_EVENT_NAMES.planCandidateRejected, {
  candidateSha256: sha256Schema,
  error: traceErrorSchema,
});

const planCandidatePublishedSchema = defineTraceEvent(TRACE_EVENT_NAMES.planCandidatePublished, {
  planRef: traceObjectRefSchema,
});

// Approval与Decision。
const approvalCreatedSchema = defineTraceEvent(TRACE_EVENT_NAMES.approvalCreated, {
  approvalRequestId: approvalRequestIdSchema,
  planRef: traceObjectRefSchema,
});

const decisionKindSchema = z.enum(["approve", "reject", "request_revision"]);

const decisionCommittedSchema = defineTraceEvent(TRACE_EVENT_NAMES.decisionCommitted, {
  decisionKind: decisionKindSchema,
  decisionRef: traceObjectRefSchema,
  planRef: traceObjectRefSchema,
});

const decisionRejectedSchema = defineTraceEvent(TRACE_EVENT_NAMES.decisionRejected, {
  decisionKind: decisionKindSchema,
  error: traceErrorSchema,
  planRef: traceObjectRefSchema.optional(),
});

// Workflow Hook等待与恢复：不记录Hook Token。
const workflowHookWaitingSchema = defineTraceEvent(TRACE_EVENT_NAMES.workflowHookWaiting, {
  waitReason: z.enum(["plan_approval"]),
});

const workflowHookResumeDispatchedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowHookResumeDispatched,
  {
    resumeAttempt: stepAttemptSchema,
    decisionRef: traceObjectRefSchema.optional(),
  },
);

const workflowHookResumedSchema = defineTraceEvent(TRACE_EVENT_NAMES.workflowHookResumed, {
  resumeAttempt: stepAttemptSchema,
});

const workflowHookResumeFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowHookResumeFailed,
  {
    resumeAttempt: stepAttemptSchema,
    error: traceErrorSchema,
  },
);

// Provider：只保存Provider、模型、Endpoint host、请求ID、状态、耗时与Usage；
// 不记录Prompt、消息数组、工具Payload、原始响应或隐藏推理。
const providerSharedFields = {
  provider: providerNameSchema,
  model: providerModelSchema,
  endpointHost: endpointHostSchema,
  operation: z.enum(["chat_completion"]),
};

const providerRequestStartedSchema = defineTraceEvent(TRACE_EVENT_NAMES.providerRequestStarted, {
  ...providerSharedFields,
  inputManifestSha256: sha256Schema.optional(),
});

const providerRequestCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.providerRequestCompleted,
  {
    ...providerSharedFields,
    httpStatus: httpStatusCodeSchema,
    providerRequestId: providerRequestIdSchema,
    tokenUsage: tokenUsageSchema,
    inputManifestSha256: sha256Schema.optional(),
  },
);

const providerRequestFailedSchema = defineTraceEvent(TRACE_EVENT_NAMES.providerRequestFailed, {
  ...providerSharedFields,
  error: traceErrorSchema,
  httpStatus: httpStatusCodeSchema.optional(),
  providerRequestId: providerRequestIdSchema.optional(),
});

// pi节点。
const piNodeKindSchema = z.enum(["planner", "executor"]);

const piNodeStartedSchema = defineTraceEvent(TRACE_EVENT_NAMES.piNodeStarted, {
  nodeKind: piNodeKindSchema,
});

const piNodeCompletedSchema = defineTraceEvent(TRACE_EVENT_NAMES.piNodeCompleted, {
  nodeKind: piNodeKindSchema,
  candidateRef: traceObjectRefSchema.optional(),
});

const piNodeFailedSchema = defineTraceEvent(TRACE_EVENT_NAMES.piNodeFailed, {
  nodeKind: piNodeKindSchema,
  error: traceErrorSchema,
});

// 执行验证。
const executionValidatedSchema = defineTraceEvent(TRACE_EVENT_NAMES.executionValidated, {
  candidateRef: traceObjectRefSchema,
});

const executionRejectedSchema = defineTraceEvent(TRACE_EVENT_NAMES.executionRejected, {
  candidateRef: traceObjectRefSchema,
  error: traceErrorSchema,
});

// Product Commit。
const productCommitStartedSchema = defineTraceEvent(TRACE_EVENT_NAMES.productCommitStarted, {
  outputRefs: refs,
});

const productCommitCommittedSchema = defineTraceEvent(TRACE_EVENT_NAMES.productCommitCommitted, {
  outputRefs: refs,
});

const productCommitFailedSchema = defineTraceEvent(TRACE_EVENT_NAMES.productCommitFailed, {
  error: traceErrorSchema,
  outputRefs: refs.optional(),
});

// 本地调试生命周期。
const debugRoleSchema = z.enum(["api", "web", "workflow"]);
const debugPortSchema = z.number().int().min(1).max(65535);

const serviceDebugStartedSchema = defineTraceEvent(TRACE_EVENT_NAMES.serviceDebugStarted, {
  role: debugRoleSchema,
  port: debugPortSchema,
});

const serviceDebugStoppedSchema = defineTraceEvent(TRACE_EVENT_NAMES.serviceDebugStopped, {
  role: debugRoleSchema,
  port: debugPortSchema,
});

/** Trace事件严格联合：以eventName判别，未声明字段在根部与嵌套层均失败关闭。 */
export const traceEventSchema = z.discriminatedUnion("eventName", [
  httpCommandReceivedSchema,
  httpCommandAcceptedSchema,
  httpCommandRejectedSchema,
  httpCommandCompletedSchema,
  productTransactionStartedSchema,
  productTransactionCommittedSchema,
  productTransactionFailedSchema,
  productRunCreatedSchema,
  productRunTransitionedSchema,
  workflowStartRequestedSchema,
  workflowStartStartedSchema,
  workflowStartFailedSchema,
  workflowStepStartedSchema,
  workflowStepCompletedSchema,
  workflowStepFailedSchema,
  workflowStepReplayedSchema,
  planCandidateReceivedSchema,
  planCandidateRejectedSchema,
  planCandidatePublishedSchema,
  approvalCreatedSchema,
  decisionCommittedSchema,
  decisionRejectedSchema,
  workflowHookWaitingSchema,
  workflowHookResumeDispatchedSchema,
  workflowHookResumedSchema,
  workflowHookResumeFailedSchema,
  providerRequestStartedSchema,
  providerRequestCompletedSchema,
  providerRequestFailedSchema,
  piNodeStartedSchema,
  piNodeCompletedSchema,
  piNodeFailedSchema,
  executionValidatedSchema,
  executionRejectedSchema,
  productCommitStartedSchema,
  productCommitCommittedSchema,
  productCommitFailedSchema,
  serviceDebugStartedSchema,
  serviceDebugStoppedSchema,
]);

export type TraceEvent = z.infer<typeof traceEventSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * 待写入的Trace事件。schemaVersion/eventId/timestamp由Sink生成。
 * 不存在任意内容通道：每个事件只允许自己声明的字段。
 */
export type TraceEventInput = DistributiveOmit<
  TraceEvent,
  "schemaVersion" | "eventId" | "timestamp"
>;
