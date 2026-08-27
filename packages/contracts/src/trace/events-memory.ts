/**
 * Trace事件族。schema仅供union.ts组合；对外经../trace.js barrel的联合类型。
 */
import { z } from "zod";
import { sha256Schema } from "../hash.js";
import {
  memoryBackendIdSchema,
  memoryImportIntentIdSchema,
  memoryImportResultIdSchema,
  memoryQueryIdSchema,
  outboxEntryIdSchema,
} from "../ids.js";
import {
  TRACE_EVENT_NAMES,
  traceErrorSchema,
  revisionSchema,
  stepAttemptSchema,
  durationMsOptional,
  durationMsRequired,
  defineTraceEvent,
} from "./foundations.js";
import { contextScopedFields } from "./events-http.js";

export const memoryQueryFields = {
  ...contextScopedFields,
  memoryQueryId: memoryQueryIdSchema,
  backendId: memoryBackendIdSchema,
  requirement: z.enum(["required", "optional"]),
  sourceMessageSha256: sha256Schema,
  tagCount: z.number().int().nonnegative().max(20),
  layerCount: z.number().int().positive().max(4),
  requestedLimit: z.number().int().positive().max(20),
  contextBudget: z.number().int().positive().max(8_192),
};

export const memoryQueryStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryQueryStarted,
  "unknown",
  {
    ...memoryQueryFields,
    ...durationMsOptional,
  },
);

export const memoryQueryCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryQueryCompleted,
  "success",
  {
    ...memoryQueryFields,
    hitCount: z.number().int().nonnegative().max(10_000),
    adoptedCount: z.number().int().nonnegative().max(10_000),
    resultSetSha256: sha256Schema,
    ...durationMsRequired,
  },
);

export const memoryQueryFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryQueryFailed,
  "failure",
  {
    ...memoryQueryFields,
    error: traceErrorSchema,
    ...durationMsRequired,
  },
);

// Memory Import：正文仍只存在Message；Trace只保存稳定身份、Hash、状态与耗时。
export const memoryImportFields = {
  memoryImportIntentId: memoryImportIntentIdSchema,
  memoryImportResultId: memoryImportResultIdSchema,
  outboxId: outboxEntryIdSchema,
  operationId: memoryImportIntentIdSchema,
  backendId: memoryBackendIdSchema,
  requestSha256: sha256Schema,
  intentRevision: revisionSchema,
  resultRevision: revisionSchema,
};

export const memoryImportIntentCreatedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryImportIntentCreated,
  "success",
  {
    ...memoryImportFields,
    backendDescriptorSha256: sha256Schema,
    ...durationMsOptional,
  },
);

export const memoryImportStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryImportStarted,
  "unknown",
  { ...memoryImportFields, dispatchAttempt: stepAttemptSchema, ...durationMsOptional },
);

export const memoryImportAcceptedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryImportAccepted,
  "success",
  {
    ...memoryImportFields,
    externalObjectIdSha256: sha256Schema,
    responseSha256: sha256Schema,
    dispatchAttempt: stepAttemptSchema,
    ...durationMsRequired,
  },
);

export const memoryImportMaterializedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryImportMaterialized,
  "success",
  {
    ...memoryImportFields,
    externalObjectIdSha256: sha256Schema,
    verificationSha256: sha256Schema,
    reconcileAttempt: stepAttemptSchema,
    ...durationMsRequired,
  },
);

export const memoryImportOutcomeUnknownSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryImportOutcomeUnknown,
  "unknown",
  {
    ...memoryImportFields,
    origin: z.enum(["workflow_dispatch", "dispatch", "reconcile", "recovery"]),
    attempt: stepAttemptSchema,
    error: traceErrorSchema,
    ...durationMsRequired,
  },
);

export const memoryImportFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryImportFailed,
  "failure",
  {
    ...memoryImportFields,
    origin: z.enum(["workflow_dispatch", "dispatch", "reconcile", "recovery"]),
    attempt: stepAttemptSchema,
    error: traceErrorSchema,
    ...durationMsRequired,
  },
);

export const memoryImportReconcileStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryImportReconcileStarted,
  "unknown",
  { ...memoryImportFields, reconcileAttempt: stepAttemptSchema, ...durationMsOptional },
);

export const memoryImportReconcileCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryImportReconcileCompleted,
  "success",
  {
    ...memoryImportFields,
    resolution: z.enum(["accepted", "materialized", "failed"]),
    reconcileAttempt: stepAttemptSchema,
    externalObjectIdSha256: sha256Schema.optional(),
    ...durationMsRequired,
  },
);

export const memoryImportReconcileFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.memoryImportReconcileFailed,
  "failure",
  {
    ...memoryImportFields,
    reconcileAttempt: stepAttemptSchema,
    error: traceErrorSchema,
    ...durationMsRequired,
  },
);

// Trace只保存产品身份、revision、Hash与结果，不复制目标、路径或候选正文。
