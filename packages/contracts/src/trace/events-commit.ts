/**
 * Trace事件族。schema仅供union.ts组合；对外经../trace.js barrel的联合类型。
 */
import { z } from "zod";
import {
  TRACE_EVENT_NAMES,
  traceErrorSchema,
  executionCandidateRefSchema,
  runScopedFields,
  durationMsOptional,
  defineTraceEvent,
  refs,
} from "./foundations.js";

export const executionValidatedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.executionValidated,
  "success",
  {
    ...runScopedFields,
    candidateRef: executionCandidateRefSchema,
    ...durationMsOptional,
  },
);

export const executionRejectedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.executionRejected,
  "rejected",
  {
    ...runScopedFields,
    candidateRef: executionCandidateRefSchema,
    error: traceErrorSchema,
    ...durationMsOptional,
  },
);

// Product Commit：Run + Attempt。
export const productCommitStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productCommitStarted,
  "unknown",
  {
    ...runScopedFields,
    outputRefs: refs,
    ...durationMsOptional,
  },
);

export const productCommitCommittedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productCommitCommitted,
  "success",
  { ...runScopedFields, outputRefs: refs, ...durationMsOptional },
);

export const productCommitFailedSchema = defineTraceEvent(
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
export const debugRoleSchema = z.enum(["api", "web", "workflow", "pi_executor"]);
export const debugPortSchema = z.number().int().min(1).max(65535);

export const serviceDebugStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.serviceDebugStarted,
  "unknown",
  {
    role: debugRoleSchema,
    port: debugPortSchema,
    ...durationMsOptional,
  },
);

export const serviceDebugStoppedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.serviceDebugStopped,
  "success",
  {
    role: debugRoleSchema,
    port: debugPortSchema,
    ...durationMsOptional,
  },
);

/** Trace事件严格联合：以eventName判别，未声明字段在根部与嵌套层均失败关闭。 */
