import { z } from "zod";
import { productRunIdSchema } from "./ids.js";

export const WORKFLOW_RUNTIME_TRACE_SCHEMA_VERSION = "chat-workflow-runtime-trace.v1";

export const workflowRuntimeEventTypeSchema = z.enum([
  "run_created",
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "step_created",
  "step_started",
  "step_completed",
  "step_failed",
  "step_retrying",
  "hook_created",
  "hook_received",
  "hook_disposed",
  "hook_conflict",
  "wait_created",
  "wait_completed",
]);

export const workflowRuntimeResourceKindSchema = z.enum(["run", "step", "hook", "sleep"]);

export const workflowRuntimeSpanStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "retrying",
  "waiting",
  "received",
  "disposed",
  "sleeping",
]);

const durationMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const runtimeSpanKeySchema = z.string().regex(/^runtime-(?:run|step|hook|sleep)-[0-9]+$/u);

export const workflowRuntimeTraceSegmentDtoSchema = z
  .object({
    status: workflowRuntimeSpanStatusSchema,
    offsetMs: durationMsSchema,
    durationMs: durationMsSchema,
  })
  .strict();

export const workflowRuntimeTraceEventDtoSchema = z
  .object({
    sequence: z.number().int().positive().max(10_000),
    type: workflowRuntimeEventTypeSchema,
    resourceKind: workflowRuntimeResourceKindSchema,
    spanKey: runtimeSpanKeySchema,
    recordedAt: z.iso.datetime(),
    offsetMs: durationMsSchema,
  })
  .strict();

export const workflowRuntimeTraceSpanDtoSchema = z
  .object({
    spanKey: runtimeSpanKeySchema,
    sequence: z.number().int().nonnegative().max(10_000),
    kind: workflowRuntimeResourceKindSchema,
    name: z.string().min(1).max(160),
    status: workflowRuntimeSpanStatusSchema,
    attempt: z.number().int().positive().max(100).optional(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    offsetMs: durationMsSchema,
    durationMs: durationMsSchema,
    segments: z.array(workflowRuntimeTraceSegmentDtoSchema).max(2_000),
    eventSequences: z.array(z.number().int().positive().max(10_000)).max(2_000),
  })
  .strict();

const runtimeTraceBaseSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_RUNTIME_TRACE_SCHEMA_VERSION),
  productRunId: productRunIdSchema,
  sourceKind: z.literal("vercel_workflow"),
  refreshedAt: z.iso.datetime(),
});

export const workflowRuntimeTracePendingDtoSchema = runtimeTraceBaseSchema
  .extend({
    availability: z.literal("pending"),
    reason: z.enum(["not_started", "start_outcome_unknown"]),
    refreshAfterMs: z.number().int().min(250).max(60_000),
  })
  .strict();

export const workflowRuntimeTraceUnavailableDtoSchema = runtimeTraceBaseSchema
  .extend({
    availability: z.literal("unavailable"),
    reason: z.literal("not_recorded"),
    refreshAfterMs: z.null(),
  })
  .strict();

export const workflowRuntimeTraceAvailableDtoSchema = runtimeTraceBaseSchema
  .extend({
    availability: z.literal("available"),
    workflowName: z.string().min(1).max(160),
    runtimeStatus: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
    isLive: z.boolean(),
    refreshAfterMs: z.number().int().min(250).max(60_000).nullable(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    durationMs: durationMsSchema,
    knownDurationMs: durationMsSchema,
    eventCount: z.number().int().nonnegative().max(10_000),
    truncated: z.boolean(),
    spans: z.array(workflowRuntimeTraceSpanDtoSchema).min(1).max(2_001),
    events: z.array(workflowRuntimeTraceEventDtoSchema).max(2_000),
  })
  .strict();

/**
 * Vercel World的公开只读投影。没有Workflow Run ID、Step/Event/Correlation ID、
 * Hook Token、输入输出和错误正文；浏览器不能用它恢复或控制Runtime。
 */
export const workflowRuntimeTraceDtoSchema = z.discriminatedUnion("availability", [
  workflowRuntimeTracePendingDtoSchema,
  workflowRuntimeTraceUnavailableDtoSchema,
  workflowRuntimeTraceAvailableDtoSchema,
]);

export type WorkflowRuntimeEventType = z.infer<typeof workflowRuntimeEventTypeSchema>;
export type WorkflowRuntimeResourceKind = z.infer<typeof workflowRuntimeResourceKindSchema>;
export type WorkflowRuntimeSpanStatus = z.infer<typeof workflowRuntimeSpanStatusSchema>;
export type WorkflowRuntimeTraceSegmentDto = z.infer<typeof workflowRuntimeTraceSegmentDtoSchema>;
export type WorkflowRuntimeTraceEventDto = z.infer<typeof workflowRuntimeTraceEventDtoSchema>;
export type WorkflowRuntimeTraceSpanDto = z.infer<typeof workflowRuntimeTraceSpanDtoSchema>;
export type WorkflowRuntimeTraceDto = z.infer<typeof workflowRuntimeTraceDtoSchema>;
