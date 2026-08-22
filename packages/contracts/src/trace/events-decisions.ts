/**
 * Trace事件族。schema仅供union.ts组合；对外经../trace.js barrel的联合类型。
 */
import { z } from "zod";
import { sha256Schema } from "../hash.js";
import { approvalRequestIdSchema, commandIdSchema } from "../ids.js";
import {
  TRACE_EVENT_NAMES,
  traceErrorSchema,
  planRefSchema,
  decisionRefSchema,
  stepAttemptSchema,
  runScopedFields,
  workflowScopedFields,
  durationMsOptional,
  defineTraceEvent,
} from "./foundations.js";

export const planCandidateReceivedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.planCandidateReceived,
  "unknown",
  { ...runScopedFields, candidateSha256: sha256Schema, ...durationMsOptional },
);

export const planCandidateRejectedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.planCandidateRejected,
  "rejected",
  {
    ...runScopedFields,
    candidateSha256: sha256Schema,
    error: traceErrorSchema,
    ...durationMsOptional,
  },
);

export const planCandidatePublishedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.planCandidatePublished,
  "success",
  { ...runScopedFields, planRef: planRefSchema, ...durationMsOptional },
);

// Note候选与Plan候选一样只记录不可逆Hash，不把标题、正文或标签写入Trace。
export const noteCandidateReceivedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.noteCandidateReceived,
  "unknown",
  { ...runScopedFields, candidateSha256: sha256Schema, ...durationMsOptional },
);

export const noteCandidateRejectedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.noteCandidateRejected,
  "rejected",
  {
    ...runScopedFields,
    candidateSha256: sha256Schema,
    error: traceErrorSchema,
    ...durationMsOptional,
  },
);

// Approval与Decision：Run + Attempt（审批等待发生在同一Run Attempt内）。
export const approvalCreatedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.approvalCreated,
  "success",
  {
    ...runScopedFields,
    approvalRequestId: approvalRequestIdSchema,
    planRef: planRefSchema,
    ...durationMsOptional,
  },
);

export const decisionKindSchema = z.enum(["approve", "reject", "request_revision"]);

export const decisionCommittedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.decisionCommitted,
  "success",
  {
    ...runScopedFields,
    commandId: commandIdSchema,
    decisionKind: decisionKindSchema,
    decisionRef: decisionRefSchema,
    planRef: planRefSchema,
    ...durationMsOptional,
  },
);

export const decisionRejectedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.decisionRejected,
  "rejected",
  {
    ...runScopedFields,
    commandId: commandIdSchema,
    decisionKind: decisionKindSchema,
    error: traceErrorSchema,
    planRef: planRefSchema.optional(),
    ...durationMsOptional,
  },
);

// Workflow Hook等待与恢复：不记录Hook Token。
export const workflowHookWaitingSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowHookWaiting,
  "unknown",
  {
    ...workflowScopedFields,
    waitReason: z.enum(["plan_approval"]),
    ...durationMsOptional,
  },
);

export const workflowHookResumeDispatchedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowHookResumeDispatched,
  "success",
  {
    ...workflowScopedFields,
    resumeAttempt: stepAttemptSchema,
    decisionRef: decisionRefSchema.optional(),
    ...durationMsOptional,
  },
);

export const workflowHookResumedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowHookResumed,
  "success",
  {
    ...workflowScopedFields,
    resumeAttempt: stepAttemptSchema,
    ...durationMsOptional,
  },
);

export const workflowHookResumeFailedSchema = defineTraceEvent(
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
