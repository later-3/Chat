import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  approvalRequestIdSchema,
  commandIdSchema,
  interactionIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  requestIdSchema,
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
 *
 * 关联与统计保证（回放可信的前提）：
 * - Product Run事件必须有productRunId；
 * - Workflow/Provider/pi/执行/Product Commit事件必须有productRunId + attemptId；
 * - Workflow事件必须绑定workflowDefinitionVersion；
 * - Provider/pi事件必须绑定promptTemplateVersion + modelConfigVersion；
 * - Provider completed/failed必须有durationMs；started/completed必须有输入manifest Hash，
 *   failed只在预请求失败（provider.pre_request.*错误族）时允许缺失manifest；
 * - outcome按事件名固定：started/received/waiting=unknown，
 *   completed/committed/validated及事实断言类=success，rejected=rejected，failed=failure。
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

/** Trace内部关联ID（traceId/spanId及后端私有引用）。 */
const traceIdLikeSchema = z.string().regex(/^[a-z][a-z0-9]*_[A-Za-z0-9-]{1,80}$/);

/** 版本证据标识（Workflow Definition、Prompt模板、模型配置版本）。 */
const versionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/** SHA-256摘要，固定小写十六进制。 */
export { sha256Schema } from "./hash.js";

/** 稳定错误码：小写点分层级，不允许塞入原始错误消息。 */
export const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/)
  .max(64);

/** 预请求失败错误族：Provider请求尚未形成输入manifest时的失败。 */
export const PROVIDER_PRE_REQUEST_ERROR_PREFIX = "provider.pre_request.";

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

/* ---------- 对象引用：事件专属、类型固定、回放所需revision/Hash强制 ---------- */

const objectIdSchema = traceIdLikeSchema;
const revisionSchema = z.number().int().positive().max(1_000_000);

/** 版本化对象（plan/decision）：必须携带revision + sha256，回放才能定位版本并校验完整性。 */
function versionedObjectRef<Type extends string>(objectType: Type) {
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
function immutableObjectRef<Type extends string>(objectType: Type) {
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
export const contextPackageRefSchema = immutableObjectRef("context_package");
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
    /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9][a-z0-9-]{0,61}[a-z0-9])*$/,
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

/* ---------- 事件族关联字段（回放强制的最小关联） ---------- */

/** Product Run事件族。 */
const runScopedFields = {
  productRunId: productRunIdSchema,
  attemptId: runAttemptIdSchema,
};

/** Workflow事件族：Run + Attempt + Definition版本。 */
const workflowScopedFields = {
  ...runScopedFields,
  workflowDefinitionVersion: versionSchema,
};

/** 模型事件族（Provider/pi）：Run + Attempt + Prompt模板 + 模型配置版本。 */
const modelScopedFields = {
  ...runScopedFields,
  promptTemplateVersion: versionSchema,
  modelConfigVersion: versionSchema,
};

const sessionFields = {
  productSessionId: productSessionIdSchema.optional(),
  interactionId: interactionIdSchema.optional(),
};

/* ---------- 公共字段（只保留真正适用于所有事件的字段） ---------- */

const traceCommonFields = {
  schemaVersion: z.literal(TRACE_SCHEMA_VERSION),
  eventId: traceIdLikeSchema,
  timestamp: z.iso.datetime(),
  level: traceLevelSchema,
  traceId: traceIdLikeSchema,
  spanId: traceIdLikeSchema,
  parentSpanId: traceIdLikeSchema.optional(),
};

const durationMsOptional = { durationMs: z.number().nonnegative().max(3_600_000).optional() };
const durationMsRequired = { durationMs: z.number().nonnegative().max(3_600_000) };

function defineTraceEvent<
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

const refs = z.array(traceObjectRefSchema).max(8);

/* ---------- 事件定义 ---------- */

// HTTP：不记录请求Body、Query正文或可能携带用户内容的原始URL；requestId必填。
const httpCommandReceivedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.httpCommandReceived,
  "unknown",
  {
    requestId: requestIdSchema,
    httpMethod: httpMethodSchema,
    ...sessionFields,
    ...durationMsOptional,
  },
);

const httpCommandAcceptedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.httpCommandAccepted,
  "success",
  {
    requestId: requestIdSchema,
    httpMethod: httpMethodSchema,
    routeTemplate: routeTemplateSchema,
    statusCode: httpStatusCodeSchema,
    ...sessionFields,
    productRunId: productRunIdSchema.optional(),
    commandId: commandIdSchema.optional(),
    ...durationMsOptional,
  },
);

const httpCommandRejectedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.httpCommandRejected,
  "rejected",
  {
    requestId: requestIdSchema,
    httpMethod: httpMethodSchema,
    statusCode: httpStatusCodeSchema,
    routeTemplate: routeTemplateSchema.optional(),
    errorCode: stableErrorCodeSchema.optional(),
    ...sessionFields,
    productRunId: productRunIdSchema.optional(),
    commandId: commandIdSchema.optional(),
    ...durationMsOptional,
  },
);

const httpCommandCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.httpCommandCompleted,
  "success",
  {
    requestId: requestIdSchema,
    httpMethod: httpMethodSchema,
    statusCode: httpStatusCodeSchema,
    routeTemplate: routeTemplateSchema.optional(),
    ...sessionFields,
    productRunId: productRunIdSchema.optional(),
    commandId: commandIdSchema.optional(),
    ...durationMsOptional,
  },
);

// 产品事务：创建Run的事务尚无productRunId，故可选。
const transactionFields = {
  transactionType: transactionTypeSchema,
  ...sessionFields,
  commandId: commandIdSchema.optional(),
  productRunId: productRunIdSchema.optional(),
};

const productTransactionStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productTransactionStarted,
  "unknown",
  { ...transactionFields, inputRefs: refs.optional(), ...durationMsOptional },
);

const productTransactionCommittedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productTransactionCommitted,
  "success",
  {
    ...transactionFields,
    inputRefs: refs.optional(),
    outputRefs: refs.optional(),
    ...durationMsOptional,
  },
);

const productTransactionFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productTransactionFailed,
  "failure",
  {
    ...transactionFields,
    error: traceErrorSchema,
    inputRefs: refs.optional(),
    ...durationMsOptional,
  },
);

// Product Run事件族：必须有productRunId。
const productRunCreatedSchema = defineTraceEvent(TRACE_EVENT_NAMES.productRunCreated, "success", {
  productRunId: productRunIdSchema,
  ...sessionFields,
  runStatus: runStatusSchema,
  phase: runPhaseSchema,
  revision: z.number().int().nonnegative().max(1_000_000),
  ...durationMsOptional,
});

const productRunTransitionedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productRunTransitioned,
  "success",
  {
    productRunId: productRunIdSchema,
    ...sessionFields,
    fromStatus: runStatusSchema,
    toStatus: runStatusSchema,
    fromPhase: runPhaseSchema.optional(),
    toPhase: runPhaseSchema.optional(),
    revision: z.number().int().nonnegative().max(1_000_000),
    ...durationMsOptional,
  },
);

// Workflow事件族：Run + Attempt + Definition版本；runMappingRef为后端私有映射引用，不是Hook Token。
const workflowStartRequestedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowStartRequested,
  "unknown",
  {
    ...workflowScopedFields,
    workflowDefinitionId: workflowDefinitionIdSchema,
    ...durationMsOptional,
  },
);

const workflowStartStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowStartStarted,
  "unknown",
  {
    ...workflowScopedFields,
    workflowDefinitionId: workflowDefinitionIdSchema,
    runMappingRef: traceIdLikeSchema,
    ...durationMsOptional,
  },
);

const workflowStartFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowStartFailed,
  "failure",
  {
    ...workflowScopedFields,
    workflowDefinitionId: workflowDefinitionIdSchema,
    error: traceErrorSchema,
    ...durationMsOptional,
  },
);

const workflowStepStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowStepStarted,
  "unknown",
  {
    ...workflowScopedFields,
    stepKey: stepKeySchema,
    stepAttempt: stepAttemptSchema,
    replay: z.boolean(),
    ...durationMsOptional,
  },
);

const workflowStepCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowStepCompleted,
  "success",
  {
    ...workflowScopedFields,
    stepKey: stepKeySchema,
    stepAttempt: stepAttemptSchema,
    replay: z.boolean(),
    outputRefs: refs.optional(),
    ...durationMsOptional,
  },
);

const workflowStepFailedSchema = defineTraceEvent(TRACE_EVENT_NAMES.workflowStepFailed, "failure", {
  ...workflowScopedFields,
  stepKey: stepKeySchema,
  stepAttempt: stepAttemptSchema,
  replay: z.boolean(),
  error: traceErrorSchema,
  ...durationMsOptional,
});

const workflowStepReplayedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowStepReplayed,
  "success",
  {
    ...workflowScopedFields,
    stepKey: stepKeySchema,
    stepAttempt: stepAttemptSchema,
    ...durationMsOptional,
  },
);

// Plan候选：Run + Attempt（候选来自pi规划Attempt）。
const planCandidateReceivedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.planCandidateReceived,
  "unknown",
  { ...runScopedFields, candidateSha256: sha256Schema, ...durationMsOptional },
);

const planCandidateRejectedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.planCandidateRejected,
  "rejected",
  {
    ...runScopedFields,
    candidateSha256: sha256Schema,
    error: traceErrorSchema,
    ...durationMsOptional,
  },
);

const planCandidatePublishedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.planCandidatePublished,
  "success",
  { ...runScopedFields, planRef: planRefSchema, ...durationMsOptional },
);

// Approval与Decision：Run + Attempt（审批等待发生在同一Run Attempt内）。
const approvalCreatedSchema = defineTraceEvent(TRACE_EVENT_NAMES.approvalCreated, "success", {
  ...runScopedFields,
  approvalRequestId: approvalRequestIdSchema,
  planRef: planRefSchema,
  ...durationMsOptional,
});

const decisionKindSchema = z.enum(["approve", "reject", "request_revision"]);

const decisionCommittedSchema = defineTraceEvent(TRACE_EVENT_NAMES.decisionCommitted, "success", {
  ...runScopedFields,
  commandId: commandIdSchema,
  decisionKind: decisionKindSchema,
  decisionRef: decisionRefSchema,
  planRef: planRefSchema,
  ...durationMsOptional,
});

const decisionRejectedSchema = defineTraceEvent(TRACE_EVENT_NAMES.decisionRejected, "rejected", {
  ...runScopedFields,
  commandId: commandIdSchema,
  decisionKind: decisionKindSchema,
  error: traceErrorSchema,
  planRef: planRefSchema.optional(),
  ...durationMsOptional,
});

// Workflow Hook等待与恢复：不记录Hook Token。
const workflowHookWaitingSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowHookWaiting,
  "unknown",
  {
    ...workflowScopedFields,
    waitReason: z.enum(["plan_approval"]),
    ...durationMsOptional,
  },
);

const workflowHookResumeDispatchedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowHookResumeDispatched,
  "success",
  {
    ...workflowScopedFields,
    resumeAttempt: stepAttemptSchema,
    decisionRef: decisionRefSchema.optional(),
    ...durationMsOptional,
  },
);

const workflowHookResumedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowHookResumed,
  "success",
  {
    ...workflowScopedFields,
    resumeAttempt: stepAttemptSchema,
    ...durationMsOptional,
  },
);

const workflowHookResumeFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowHookResumeFailed,
  "failure",
  {
    ...workflowScopedFields,
    resumeAttempt: stepAttemptSchema,
    error: traceErrorSchema,
    ...durationMsOptional,
  },
);

// Provider：Run + Attempt + Prompt模板 + 模型配置版本；只保存白名单字段。
const providerSharedFields = {
  provider: providerNameSchema,
  model: providerModelSchema,
  endpointHost: endpointHostSchema,
  operation: z.enum(["chat_completion"]),
};

/** Provider终止原因与工具调用计数只描述代码路径，不包含请求/响应正文。 */
export const providerStopReasonSchema = z.enum(["stop", "length", "toolUse", "error", "aborted"]);
const providerResultDiagnostics = {
  providerStopReason: providerStopReasonSchema.optional(),
  toolCallCount: z.number().int().nonnegative().max(64).optional(),
};

const providerRequestStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.providerRequestStarted,
  "unknown",
  {
    ...modelScopedFields,
    ...providerSharedFields,
    inputManifestSha256: sha256Schema,
    ...durationMsOptional,
  },
);

const providerRequestCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.providerRequestCompleted,
  "success",
  {
    ...modelScopedFields,
    ...providerSharedFields,
    httpStatus: httpStatusCodeSchema,
    providerRequestId: providerRequestIdSchema,
    tokenUsage: tokenUsageSchema,
    inputManifestSha256: sha256Schema,
    ...providerResultDiagnostics,
    ...durationMsRequired,
  },
);

const providerRequestFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.providerRequestFailed,
  "failure",
  {
    ...modelScopedFields,
    ...providerSharedFields,
    error: traceErrorSchema,
    httpStatus: httpStatusCodeSchema.optional(),
    providerRequestId: providerRequestIdSchema.optional(),
    inputManifestSha256: sha256Schema.optional(),
    ...providerResultDiagnostics,
    ...durationMsRequired,
  },
).refine(
  (event) =>
    event.inputManifestSha256 !== undefined ||
    event.error.code.startsWith(PROVIDER_PRE_REQUEST_ERROR_PREFIX),
  {
    message:
      "Provider失败事件缺少inputManifestSha256时，错误码必须属于provider.pre_request.*预请求失败族",
  },
);

// pi节点：Run + Attempt + Prompt模板 + 模型配置版本。
const piNodeKindSchema = z.enum(["planner", "executor"]);

const piNodeStartedSchema = defineTraceEvent(TRACE_EVENT_NAMES.piNodeStarted, "unknown", {
  ...modelScopedFields,
  nodeKind: piNodeKindSchema,
  ...durationMsOptional,
});

const piNodeCompletedSchema = defineTraceEvent(TRACE_EVENT_NAMES.piNodeCompleted, "success", {
  ...modelScopedFields,
  nodeKind: piNodeKindSchema,
  candidateRef: executionCandidateRefSchema.optional(),
  ...durationMsOptional,
});

const piNodeFailedSchema = defineTraceEvent(TRACE_EVENT_NAMES.piNodeFailed, "failure", {
  ...modelScopedFields,
  nodeKind: piNodeKindSchema,
  error: traceErrorSchema,
  ...durationMsOptional,
});

// 执行验证：Run + Attempt。
const executionValidatedSchema = defineTraceEvent(TRACE_EVENT_NAMES.executionValidated, "success", {
  ...runScopedFields,
  candidateRef: executionCandidateRefSchema,
  ...durationMsOptional,
});

const executionRejectedSchema = defineTraceEvent(TRACE_EVENT_NAMES.executionRejected, "rejected", {
  ...runScopedFields,
  candidateRef: executionCandidateRefSchema,
  error: traceErrorSchema,
  ...durationMsOptional,
});

// Product Commit：Run + Attempt。
const productCommitStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productCommitStarted,
  "unknown",
  {
    ...runScopedFields,
    outputRefs: refs,
    ...durationMsOptional,
  },
);

const productCommitCommittedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productCommitCommitted,
  "success",
  { ...runScopedFields, outputRefs: refs, ...durationMsOptional },
);

const productCommitFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productCommitFailed,
  "failure",
  {
    ...runScopedFields,
    error: traceErrorSchema,
    outputRefs: refs.optional(),
    ...durationMsOptional,
  },
);

// 本地调试生命周期。
const debugRoleSchema = z.enum(["api", "web", "workflow"]);
const debugPortSchema = z.number().int().min(1).max(65535);

const serviceDebugStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.serviceDebugStarted,
  "unknown",
  {
    role: debugRoleSchema,
    port: debugPortSchema,
    ...durationMsOptional,
  },
);

const serviceDebugStoppedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.serviceDebugStopped,
  "success",
  {
    role: debugRoleSchema,
    port: debugPortSchema,
    ...durationMsOptional,
  },
);

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
