/**
 * Trace事件族。schema仅供union.ts组合；对外经../trace.js barrel的联合类型。
 */
import { z } from "zod";
import {
  commandIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  requestIdSchema,
  contextRequestIdSchema,
  workflowDefinitionRevisionIdSchema,
} from "../ids.js";
import {
  sha256Schema,
  TRACE_EVENT_NAMES,
  stableErrorCodeSchema,
  traceErrorSchema,
  contextPackageRefSchema,
  httpMethodSchema,
  routeTemplateSchema,
  httpStatusCodeSchema,
  runStatusSchema,
  runPhaseSchema,
  transactionTypeSchema,
  runScopedFields,
  sessionFields,
  durationMsOptional,
  durationMsRequired,
  defineTraceEvent,
  refs,
} from "./foundations.js";

// DSH/Bridge只保存身份Hash和组装证据；用户正文与完整GenerateOptions没有字段通道。
export const dshAdapterRequestCapturedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.dshAdapterRequestCaptured,
  "success",
  {
    dshSessionIdSha256: sha256Schema,
    requestSha256: sha256Schema,
    userTextSha256: sha256Schema,
    sectionCount: z.number().int().nonnegative().max(1_000),
    ...durationMsOptional,
  },
);

export const bridgeDispatchPreparedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.bridgeDispatchPrepared,
  "success",
  {
    dshSessionIdSha256: sha256Schema,
    commandId: commandIdSchema,
    dispatchPlanSha256: sha256Schema,
    promptSelectionSha256: sha256Schema.optional(),
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema.optional(),
    productSessionId: productSessionIdSchema.optional(),
    ...durationMsOptional,
  },
);

export const httpCommandReceivedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.httpCommandReceived,
  "unknown",
  {
    requestId: requestIdSchema,
    httpMethod: httpMethodSchema,
    ...sessionFields,
    ...durationMsOptional,
  },
);

export const httpCommandAcceptedSchema = defineTraceEvent(
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

export const httpCommandRejectedSchema = defineTraceEvent(
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

export const httpCommandCompletedSchema = defineTraceEvent(
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
export const transactionFields = {
  transactionType: transactionTypeSchema,
  ...sessionFields,
  commandId: commandIdSchema.optional(),
  productRunId: productRunIdSchema.optional(),
};

export const productTransactionStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productTransactionStarted,
  "unknown",
  { ...transactionFields, inputRefs: refs.optional(), ...durationMsOptional },
);

export const productTransactionCommittedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productTransactionCommitted,
  "success",
  {
    ...transactionFields,
    inputRefs: refs.optional(),
    outputRefs: refs.optional(),
    ...durationMsOptional,
  },
);

export const productTransactionFailedSchema = defineTraceEvent(
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
export const productRunCreatedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.productRunCreated,
  "success",
  {
    productRunId: productRunIdSchema,
    ...sessionFields,
    runStatus: runStatusSchema,
    phase: runPhaseSchema,
    revision: z.number().int().nonnegative().max(1_000_000),
    ...durationMsOptional,
  },
);

export const productRunTransitionedSchema = defineTraceEvent(
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

// 长期上下文：只记录选择、数量、Hash和耗时，禁止 query、标签值和 Memory 正文。
export const contextScopedFields = {
  ...runScopedFields,
  contextRequestId: contextRequestIdSchema,
};

export const contextAssemblyStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.contextAssemblyStarted,
  "unknown",
  {
    ...contextScopedFields,
    memoryRequested: z.boolean(),
    ...durationMsOptional,
  },
);

export const contextAssemblyCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.contextAssemblyCompleted,
  "success",
  {
    ...contextScopedFields,
    status: z.enum(["none", "ready", "optional_failed"]),
    memoryRequested: z.boolean(),
    adoptedCount: z.number().int().nonnegative().max(10_000),
    excludedCount: z.number().int().nonnegative().max(10_000),
    contextPackageRef: contextPackageRefSchema.optional(),
    ...durationMsRequired,
  },
).superRefine((event, context) => {
  const hasRef = event.contextPackageRef !== undefined;
  const valid =
    event.status === "none"
      ? !event.memoryRequested && !hasRef && event.adoptedCount === 0 && event.excludedCount === 0
      : event.status === "ready"
        ? event.memoryRequested && hasRef && event.excludedCount === 0
        : event.memoryRequested && hasRef && event.adoptedCount === 0 && event.excludedCount === 1;
  if (!valid) {
    context.addIssue({
      code: "custom",
      message: "Context完成状态、数量与ContextPackage引用不一致",
    });
  }
});

export const contextAssemblyFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.contextAssemblyFailed,
  "failure",
  {
    ...contextScopedFields,
    memoryRequested: z.literal(true),
    error: traceErrorSchema,
    ...durationMsRequired,
  },
);
