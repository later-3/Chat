/**
 * Trace事件族。schema仅供union.ts组合；对外经../trace.js barrel的联合类型。
 */
import { z } from "zod";
import { sha256Schema } from "../hash.js";
import {
  TRACE_EVENT_NAMES,
  traceErrorSchema,
  executionCandidateRefSchema,
  tokenUsageSchema,
  modelScopedFields,
  durationMsOptional,
  durationMsRequired,
  defineTraceEvent,
} from "./foundations.js";
import { providerStopReasonSchema } from "./events-provider.js";

export const piNodeKindSchema = z.enum(["planner", "executor", "note_capture"]);
export const candidateValidationDiagnosticsSchema = z
  .object({
    stage: z.enum(["tool_argument_schema", "candidate_contract", "capability_policy"]),
    fields: z.array(z.enum(["root", "stepId", "output"])).max(3),
    issueCodes: z
      .array(
        z.enum([
          "unknown_tool",
          "invalid_type",
          "too_small",
          "too_big",
          "unrecognized_keys",
          "value_mismatch",
          "stepId.missing",
          "stepId.null",
          "stepId.array",
          "stepId.string",
          "stepId.object",
          "stepId.other",
          "output.missing",
          "output.null",
          "output.array",
          "output.string",
          "output.object",
          "output.other",
        ]),
      )
      .max(12),
  })
  .strict();

export const piNodeStartedSchema = defineTraceEvent(TRACE_EVENT_NAMES.piNodeStarted, "unknown", {
  ...modelScopedFields,
  nodeKind: piNodeKindSchema,
  ...durationMsOptional,
});

export const piNodeCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piNodeCompleted,
  "success",
  {
    ...modelScopedFields,
    nodeKind: piNodeKindSchema,
    candidateRef: executionCandidateRefSchema.optional(),
    ...durationMsOptional,
  },
);

export const piNodeFailedSchema = defineTraceEvent(TRACE_EVENT_NAMES.piNodeFailed, "failure", {
  ...modelScopedFields,
  nodeKind: piNodeKindSchema,
  error: traceErrorSchema,
  candidateValidation: candidateValidationDiagnosticsSchema.optional(),
  ...durationMsOptional,
});

/* ---------- 完整Pi Coding Agent可观察执行事件 ---------- */

export const piOperationIdSchema = z.string().regex(/^pio_[A-Za-z0-9]+$/u);
export const piRuntimeSessionIdSchema = z
  .string()
  .regex(/^pis_[A-Za-z0-9-]+$/u)
  .max(128);
export const operationEventSequenceSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const piTurnIndexSchema = z.number().int().nonnegative().max(1000);
export const piToolNameSchema = z.enum(["read", "grep", "find", "ls", "edit", "write", "bash"]);
/** 只容纳Executor在边界前已脱敏、有界的可见执行证据。 */
export const piObservableDisplaySchema = z.string().max(32_000);
export const piOperationFields = {
  ...modelScopedFields,
  piOperationId: piOperationIdSchema,
  operationEventSequence: operationEventSequenceSchema,
  sourceTimestamp: z.iso.datetime(),
};
export const piSessionFields = {
  ...piOperationFields,
  piRuntimeSessionId: piRuntimeSessionIdSchema,
};

export const piOperationAcceptedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piOperationAccepted,
  "unknown",
  {
    ...piOperationFields,
    requestSha256: sha256Schema,
    workspaceRootId: z
      .string()
      .regex(/^root_[A-Za-z0-9]+$/u)
      .optional(),
    ...durationMsOptional,
  },
);
export const piOperationStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piOperationStarted,
  "unknown",
  {
    ...piOperationFields,
    requestSha256: sha256Schema,
    ...durationMsOptional,
  },
);
export const piOperationCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piOperationCompleted,
  "success",
  {
    ...piOperationFields,
    requestSha256: sha256Schema,
    resultSha256: sha256Schema,
    ...durationMsRequired,
  },
);
export const piOperationFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piOperationFailed,
  "failure",
  {
    ...piOperationFields,
    requestSha256: sha256Schema,
    error: traceErrorSchema,
    ...durationMsRequired,
  },
);
export const piOperationOutcomeUnknownSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piOperationOutcomeUnknown,
  "unknown",
  {
    ...piOperationFields,
    requestSha256: sha256Schema,
    error: traceErrorSchema,
    ...durationMsRequired,
  },
);
export const piSessionStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piSessionStarted,
  "unknown",
  {
    ...piSessionFields,
    enabledTools: z.array(piToolNameSchema).max(7),
    ...durationMsOptional,
  },
);
export const piSessionSettledSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piSessionSettled,
  "success",
  {
    ...piSessionFields,
    turnCount: z.number().int().nonnegative().max(1000),
    providerRequestCount: z.number().int().nonnegative().max(1000),
    ...durationMsOptional,
  },
);
export const piTurnStartedSchema = defineTraceEvent(TRACE_EVENT_NAMES.piTurnStarted, "unknown", {
  ...piSessionFields,
  turnIndex: piTurnIndexSchema,
  ...durationMsOptional,
});
export const piTurnCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piTurnCompleted,
  "success",
  {
    ...piSessionFields,
    turnIndex: piTurnIndexSchema,
    ...durationMsRequired,
  },
);
export const piMessageCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piMessageCompleted,
  "success",
  {
    ...piSessionFields,
    messageIndex: z.number().int().nonnegative().max(100_000),
    messageRole: z.enum(["user", "assistant", "toolResult", "custom"]),
    contentSha256: sha256Schema,
    visibleText: piObservableDisplaySchema.optional(),
    visibleTextTruncated: z.boolean().optional(),
    providerStopReason: providerStopReasonSchema.optional(),
    tokenUsage: tokenUsageSchema.optional(),
    ...durationMsOptional,
  },
);
export const piToolIntentPersistedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piToolIntentPersisted,
  "unknown",
  {
    ...piSessionFields,
    turnIndex: piTurnIndexSchema,
    toolCallId: z.string().min(1).max(160),
    toolName: piToolNameSchema,
    inputSha256: sha256Schema,
    /** v1历史事件可能没有显示字段；新Executor Operation合同强制产生。 */
    inputDisplay: piObservableDisplaySchema.optional(),
    inputDisplayTruncated: z.boolean().optional(),
    ...durationMsOptional,
  },
);
export const piToolBlockedSchema = defineTraceEvent(TRACE_EVENT_NAMES.piToolBlocked, "rejected", {
  ...piSessionFields,
  turnIndex: piTurnIndexSchema,
  toolCallId: z.string().min(1).max(160),
  toolName: piToolNameSchema,
  inputSha256: sha256Schema,
  inputDisplay: piObservableDisplaySchema.optional(),
  inputDisplayTruncated: z.boolean().optional(),
  error: traceErrorSchema,
  ...durationMsOptional,
});
export const piToolCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piToolCompleted,
  "success",
  {
    ...piSessionFields,
    turnIndex: piTurnIndexSchema,
    toolCallId: z.string().min(1).max(160),
    toolName: piToolNameSchema,
    resultSha256: sha256Schema,
    resultDisplay: piObservableDisplaySchema.optional(),
    resultDisplayTruncated: z.boolean().optional(),
    ...durationMsRequired,
  },
);
export const piToolFailedSchema = defineTraceEvent(TRACE_EVENT_NAMES.piToolFailed, "failure", {
  ...piSessionFields,
  turnIndex: piTurnIndexSchema,
  toolCallId: z.string().min(1).max(160),
  toolName: piToolNameSchema,
  resultSha256: sha256Schema,
  resultDisplay: piObservableDisplaySchema.optional(),
  resultDisplayTruncated: z.boolean().optional(),
  error: traceErrorSchema,
  ...durationMsRequired,
});
export const piToolOutcomeUnknownSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piToolOutcomeUnknown,
  "unknown",
  {
    ...piSessionFields,
    turnIndex: piTurnIndexSchema,
    toolCallId: z.string().min(1).max(160),
    toolName: piToolNameSchema,
    inputSha256: sha256Schema,
    inputDisplay: piObservableDisplaySchema.optional(),
    inputDisplayTruncated: z.boolean().optional(),
    ...durationMsOptional,
  },
);
export const piCompactionStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piCompactionStarted,
  "unknown",
  {
    ...piSessionFields,
    reason: z.enum(["manual", "threshold", "overflow"]),
    ...durationMsOptional,
  },
);
export const piCompactionCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.piCompactionCompleted,
  "success",
  {
    ...piSessionFields,
    reason: z.enum(["manual", "threshold", "overflow"]),
    aborted: z.boolean(),
    ...durationMsOptional,
  },
);

// 执行验证：Run + Attempt。
