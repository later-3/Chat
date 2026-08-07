import { TRACE_EVENT_NAMES } from "./trace.js";

/**
 * 39种Trace事件的合法Fixture。仅用于测试与本地调试证据；
 * 全部为合成数据，不含正文、密钥或真实Provider Payload。
 */

const SHA256_A = "a".repeat(64);
const SHA256_B = "b".repeat(64);
const SHA256_C = "c".repeat(64);

const base = {
  schemaVersion: 1,
  eventId: "evt_fx1",
  timestamp: "2026-08-07T00:00:00.000Z",
  level: "info",
  traceId: "trace_fx1",
  spanId: "span_fx1",
};

const run = { productRunId: "run_fx1", attemptId: "att_fx1" };
const wfd = { ...run, workflowDefinitionVersion: "1.0.0" };
const model = {
  ...run,
  promptTemplateVersion: "planner-1.0.0",
  modelConfigVersion: "bailian-qwen-1.0.0",
};
const session = { productSessionId: "psn_fx1", interactionId: "ixn_fx1" };
const planRef = { objectType: "plan", objectId: "plan_fx1", revision: 2, sha256: SHA256_A };
const decisionRef = { objectType: "decision", objectId: "dec_fx1", revision: 1, sha256: SHA256_B };
const candidateRef = { objectType: "execution_candidate", objectId: "exc_fx1", sha256: SHA256_C };
const messageRef = { objectType: "message", objectId: "msg_fx1", sha256: SHA256_A };
const err = { code: "provider.timeout", type: "TimeoutError" };
const providerShared = {
  provider: "bailian",
  model: "qwen3.7-plus",
  endpointHost: "dashscope.aliyuncs.com",
  operation: "chat_completion",
};

export const validTraceFixtures: ReadonlyArray<Record<string, unknown>> = [
  // HTTP
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.httpCommandReceived,
    outcome: "unknown",
    requestId: "req_fx1",
    httpMethod: "POST",
    ...session,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.httpCommandAccepted,
    outcome: "success",
    requestId: "req_fx1",
    httpMethod: "POST",
    routeTemplate: "/api/sessions/:sessionId/messages",
    statusCode: 202,
    ...session,
    productRunId: "run_fx1",
    commandId: "cmd_fx1",
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.httpCommandRejected,
    outcome: "rejected",
    requestId: "req_fx1",
    httpMethod: "POST",
    statusCode: 409,
    errorCode: "revision_conflict",
    commandId: "cmd_fx1",
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.httpCommandCompleted,
    outcome: "success",
    requestId: "req_fx1",
    httpMethod: "GET",
    routeTemplate: "/api/runs/:productRunId",
    statusCode: 200,
    durationMs: 4,
  },
  // 产品事务
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.productTransactionStarted,
    outcome: "unknown",
    transactionType: "message.send",
    ...session,
    commandId: "cmd_fx1",
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.productTransactionCommitted,
    outcome: "success",
    transactionType: "message.send",
    ...session,
    commandId: "cmd_fx1",
    productRunId: "run_fx1",
    inputRefs: [messageRef],
    outputRefs: [messageRef],
    durationMs: 7,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.productTransactionFailed,
    outcome: "failure",
    transactionType: "decision.commit",
    commandId: "cmd_fx1",
    error: { code: "revision_conflict", type: "ConflictError" },
  },
  // Product Run
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.productRunCreated,
    outcome: "success",
    productRunId: "run_fx1",
    ...session,
    runStatus: "planning",
    phase: "plan",
    revision: 0,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.productRunTransitioned,
    outcome: "success",
    productRunId: "run_fx1",
    fromStatus: "planning",
    toStatus: "awaiting_decision",
    fromPhase: "plan",
    toPhase: "approval",
    revision: 1,
  },
  // Workflow
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.workflowStartRequested,
    outcome: "unknown",
    ...wfd,
    workflowDefinitionId: "wfd_fx1",
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.workflowStartStarted,
    outcome: "unknown",
    ...wfd,
    workflowDefinitionId: "wfd_fx1",
    runMappingRef: "wrmap_fx1",
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.workflowStartFailed,
    outcome: "failure",
    ...wfd,
    workflowDefinitionId: "wfd_fx1",
    error: { code: "workflow.unavailable", type: "WorkflowError" },
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.workflowStepStarted,
    outcome: "unknown",
    ...wfd,
    stepKey: "plan.generate",
    stepAttempt: 1,
    replay: false,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.workflowStepCompleted,
    outcome: "success",
    ...wfd,
    stepKey: "plan.generate",
    stepAttempt: 1,
    replay: false,
    outputRefs: [planRef],
    durationMs: 3200,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.workflowStepFailed,
    outcome: "failure",
    ...wfd,
    stepKey: "execute.step",
    stepAttempt: 2,
    replay: true,
    error: err,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.workflowStepReplayed,
    outcome: "success",
    ...wfd,
    stepKey: "plan.publish",
    stepAttempt: 1,
  },
  // Plan候选
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.planCandidateReceived,
    outcome: "unknown",
    ...run,
    candidateSha256: SHA256_A,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.planCandidateRejected,
    outcome: "rejected",
    ...run,
    candidateSha256: SHA256_A,
    error: { code: "plan.schema_invalid", type: "ValidationError" },
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.planCandidatePublished,
    outcome: "success",
    ...run,
    planRef,
  },
  // Approval与Decision
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.approvalCreated,
    outcome: "success",
    ...run,
    approvalRequestId: "apr_fx1",
    planRef,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.decisionCommitted,
    outcome: "success",
    ...run,
    commandId: "cmd_fx1",
    decisionKind: "approve",
    decisionRef,
    planRef,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.decisionRejected,
    outcome: "rejected",
    ...run,
    commandId: "cmd_fx1",
    decisionKind: "approve",
    error: { code: "decision_hash_mismatch", type: "ConflictError" },
    planRef,
  },
  // Hook
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.workflowHookWaiting,
    outcome: "unknown",
    ...wfd,
    waitReason: "plan_approval",
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.workflowHookResumeDispatched,
    outcome: "success",
    ...wfd,
    resumeAttempt: 1,
    decisionRef,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.workflowHookResumed,
    outcome: "success",
    ...wfd,
    resumeAttempt: 1,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.workflowHookResumeFailed,
    outcome: "failure",
    ...wfd,
    resumeAttempt: 1,
    error: { code: "workflow.hook_expired", type: "WorkflowError" },
  },
  // Provider
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.providerRequestStarted,
    outcome: "unknown",
    ...model,
    ...providerShared,
    inputManifestSha256: SHA256_B,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.providerRequestCompleted,
    outcome: "success",
    ...model,
    ...providerShared,
    httpStatus: 200,
    providerRequestId: "req-0a1b2c",
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    inputManifestSha256: SHA256_B,
    durationMs: 1234,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.providerRequestFailed,
    outcome: "failure",
    ...model,
    ...providerShared,
    error: { code: "provider.timeout", type: "TimeoutError" },
    durationMs: 30000,
    httpStatus: 504,
    providerRequestId: "req-0a1b2c",
    inputManifestSha256: SHA256_B,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.providerRequestFailed,
    outcome: "failure",
    ...model,
    ...providerShared,
    error: { code: "provider.pre_request.auth", type: "AuthError" },
    durationMs: 12,
  },
  // pi节点
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.piNodeStarted,
    outcome: "unknown",
    ...model,
    nodeKind: "planner",
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.piNodeCompleted,
    outcome: "success",
    ...model,
    nodeKind: "executor",
    candidateRef,
    durationMs: 5400,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.piNodeFailed,
    outcome: "failure",
    ...model,
    nodeKind: "planner",
    error: err,
  },
  // 执行验证
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.executionValidated,
    outcome: "success",
    ...run,
    candidateRef,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.executionRejected,
    outcome: "rejected",
    ...run,
    candidateRef,
    error: { code: "execution.criteria_unmet", type: "ValidationError" },
  },
  // Product Commit
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.productCommitStarted,
    outcome: "unknown",
    ...run,
    outputRefs: [messageRef],
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.productCommitCommitted,
    outcome: "success",
    ...run,
    outputRefs: [messageRef],
    durationMs: 9,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.productCommitFailed,
    outcome: "failure",
    ...run,
    error: { code: "store.cas_conflict", type: "StoreError" },
  },
  // 调试生命周期
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.serviceDebugStarted,
    outcome: "unknown",
    role: "api",
    port: 43111,
  },
  {
    ...base,
    eventName: TRACE_EVENT_NAMES.serviceDebugStopped,
    outcome: "success",
    role: "workflow",
    port: 43112,
  },
];
