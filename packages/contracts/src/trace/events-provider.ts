/**
 * Trace事件族。schema仅供union.ts组合；对外经../trace.js barrel的联合类型。
 */
import { z } from "zod";
import { sha256Schema } from "../hash.js";
import {
  TRACE_EVENT_NAMES,
  PROVIDER_PRE_REQUEST_ERROR_PREFIX,
  traceErrorSchema,
  httpStatusCodeSchema,
  providerNameSchema,
  providerModelSchema,
  endpointHostSchema,
  providerRequestIdSchema,
  tokenUsageSchema,
  modelScopedFields,
  durationMsOptional,
  durationMsRequired,
  defineTraceEvent,
} from "./foundations.js";

export const providerSharedFields = {
  provider: providerNameSchema,
  model: providerModelSchema,
  endpointHost: endpointHostSchema,
  operation: z.enum(["chat_completion"]),
  nodeKind: z.enum(["planner", "executor", "governance_reviewer", "note_capture"]).optional(),
};

/** Provider终止原因与工具调用计数只描述代码路径，不包含请求/响应正文。 */
export const providerStopReasonSchema = z.enum([
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
]);
export const providerResultDiagnostics = {
  providerStopReason: providerStopReasonSchema.optional(),
  toolCallCount: z.number().int().nonnegative().max(64).optional(),
};

export const providerRequestStartedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.providerRequestStarted,
  "unknown",
  {
    ...modelScopedFields,
    ...providerSharedFields,
    inputManifestSha256: sha256Schema,
    piOperationId: z
      .string()
      .regex(/^pio_[A-Za-z0-9]+$/u)
      .optional(),
    operationEventSequence: z.number().int().positive().optional(),
    providerRequestIndex: z.number().int().positive().max(1000).optional(),
    sourceTimestamp: z.iso.datetime().optional(),
    ...durationMsOptional,
  },
);

export const providerRequestCompletedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.providerRequestCompleted,
  "success",
  {
    ...modelScopedFields,
    ...providerSharedFields,
    httpStatus: httpStatusCodeSchema,
    providerRequestId: providerRequestIdSchema,
    tokenUsage: tokenUsageSchema,
    inputManifestSha256: sha256Schema,
    piOperationId: z
      .string()
      .regex(/^pio_[A-Za-z0-9]+$/u)
      .optional(),
    operationEventSequence: z.number().int().positive().optional(),
    providerRequestIndex: z.number().int().positive().max(1000).optional(),
    sourceTimestamp: z.iso.datetime().optional(),
    ...providerResultDiagnostics,
    ...durationMsRequired,
  },
);

export const providerRequestFailedSchema = defineTraceEvent(
  TRACE_EVENT_NAMES.providerRequestFailed,
  "failure",
  {
    ...modelScopedFields,
    ...providerSharedFields,
    error: traceErrorSchema,
    httpStatus: httpStatusCodeSchema.optional(),
    providerRequestId: providerRequestIdSchema.optional(),
    inputManifestSha256: sha256Schema.optional(),
    piOperationId: z
      .string()
      .regex(/^pio_[A-Za-z0-9]+$/u)
      .optional(),
    operationEventSequence: z.number().int().positive().optional(),
    providerRequestIndex: z.number().int().positive().max(1000).optional(),
    sourceTimestamp: z.iso.datetime().optional(),
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
