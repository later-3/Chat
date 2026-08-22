/**
 * Trace事件族。schema仅供union.ts组合；对外经../trace.js barrel的联合类型。
 */
import { z } from "zod";
import { workflowDefinitionIdSchema, workflowNodeRunIdSchema } from "../ids.js";
import { definitionNodeIdSchema, workflowNodeTypeSchema } from "../workflow-run.js";
import {
  TRACE_EVENT_NAMES,
  traceIdLikeSchema,
  stableErrorCodeSchema,
  traceErrorSchema,
  stepKeySchema,
  stepAttemptSchema,
  runScopedFields,
  workflowScopedFields,
  durationMsOptional,
  defineTraceEvent,
  refs,
} from "./foundations.js";

export const workflowStartRequestedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowStartRequested,
  "unknown",
  {
    ...workflowScopedFields,
    workflowDefinitionId: workflowDefinitionIdSchema,
    ...durationMsOptional,
  },
);

export const workflowStartStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowStartStarted,
  "unknown",
  {
    ...workflowScopedFields,
    workflowDefinitionId: workflowDefinitionIdSchema,
    runMappingRef: traceIdLikeSchema,
    ...durationMsOptional,
  },
);

export const workflowStartFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowStartFailed,
  "failure",
  {
    ...workflowScopedFields,
    workflowDefinitionId: workflowDefinitionIdSchema,
    error: traceErrorSchema,
    ...durationMsOptional,
  },
);

export const workflowStepStartedSchema = defineTraceEvent(
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

export const workflowStepCompletedSchema = defineTraceEvent(
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

export const workflowStepFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowStepFailed,
  "failure",
  {
    ...workflowScopedFields,
    stepKey: stepKeySchema,
    stepAttempt: stepAttemptSchema,
    replay: z.boolean(),
    error: traceErrorSchema,
    ...durationMsOptional,
  },
);

export const workflowStepReplayedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowStepReplayed,
  "success",
  {
    ...workflowScopedFields,
    stepKey: stepKeySchema,
    stepAttempt: stepAttemptSchema,
    ...durationMsOptional,
  },
);

export const workflowMemoryNodeFields = {
  ...runScopedFields,
  workflowNodeRunId: workflowNodeRunIdSchema,
  definitionNodeId: definitionNodeIdSchema,
  nodeType: workflowNodeTypeSchema.refine(
    (value) => value === "memory.query" || value === "memory.write",
  ),
  publicSummary: z.string().min(1).max(500).optional(),
};

export const workflowMemoryNodeStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowMemoryNodeStarted,
  "unknown",
  workflowMemoryNodeFields,
);
export const workflowMemoryNodeCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowMemoryNodeCompleted,
  "success",
  {
    ...workflowMemoryNodeFields,
    outcomeCode: stableErrorCodeSchema,
    ...durationMsOptional,
  },
);
export const workflowMemoryNodeFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowMemoryNodeFailed,
  "failure",
  {
    ...workflowMemoryNodeFields,
    outcomeCode: stableErrorCodeSchema,
    error: traceErrorSchema,
    ...durationMsOptional,
  },
);
export const workflowMemoryNodeOutcomeUnknownSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.workflowMemoryNodeOutcomeUnknown,
  "unknown",
  {
    ...workflowMemoryNodeFields,
    outcomeCode: stableErrorCodeSchema,
    error: traceErrorSchema,
    ...durationMsOptional,
  },
);

// Plan候选：Run + Attempt（候选来自pi规划Attempt）。
