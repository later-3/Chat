import { z } from "zod";
import { sha256Schema } from "./hash.js";
import { productRunIdSchema, runAttemptIdSchema, workflowNodeRunIdSchema } from "./ids.js";
import { productRunPhaseSchema, productRunStatusSchema } from "./product.js";
import { workflowRuntimeTraceDtoSchema } from "./workflow-runtime-trace-api.js";
import { workflowNodeRunSummaryDtoSchema } from "./workflow-api.js";
import { nodeProductRefSchema } from "./workflow-run.js";

export const WORKFLOW_EXECUTION_TRACE_SCHEMA_VERSION = "chat-workflow-execution-trace.v1";

export const workflowExecutionTraceValueDtoSchema = z
  .object({
    label: z.string().min(1).max(240),
    format: z.enum(["text", "markdown", "json"]),
    text: z.string().max(64_000),
    truncated: z.boolean(),
    source: nodeProductRefSchema.optional(),
  })
  .strict();

export const workflowNodeTraceDetailDtoSchema = z
  .object({
    workflowNodeRunId: workflowNodeRunIdSchema,
    input: z.array(workflowExecutionTraceValueDtoSchema).max(100),
    output: z.array(workflowExecutionTraceValueDtoSchema).max(100),
  })
  .strict();

export const executionStepTraceDtoSchema = z
  .object({
    parentWorkflowNodeRunId: workflowNodeRunIdSchema,
    stepId: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    status: z.enum(["running", "succeeded", "failed"]),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    durationMs: z.number().int().nonnegative().max(3_600_000).optional(),
    input: z.array(workflowExecutionTraceValueDtoSchema).max(20),
    output: z.array(workflowExecutionTraceValueDtoSchema).max(20),
  })
  .strict();

export const piTraceActivityStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
  "outcome_unknown",
]);
export const piTraceActivityKindSchema = z.enum(["agent", "model", "tool"]);
const piTraceActivityKeySchema = z.string().regex(/^pi-(?:agent|model|tool)-[0-9]+$/u);
const tokenUsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative().max(100_000_000),
    completionTokens: z.number().int().nonnegative().max(100_000_000),
    totalTokens: z.number().int().nonnegative().max(100_000_000),
  })
  .strict();

/**
 * Pi内部事件的公开活动。模型原始Payload仍不出边界；所属Chat Attempt、Workflow Node与
 * Execution Step只用于把已有产品输入/输出投影到正确的DSH树节点。
 */
export const piTraceActivityDtoSchema = z
  .object({
    activityKey: piTraceActivityKeySchema,
    parentActivityKey: piTraceActivityKeySchema.optional(),
    attemptId: runAttemptIdSchema,
    workflowNodeRunId: workflowNodeRunIdSchema.optional(),
    executionStepId: z.string().min(1).max(100).optional(),
    sequence: z.number().int().positive().max(10_000),
    kind: piTraceActivityKindSchema,
    label: z.string().min(1).max(160),
    status: piTraceActivityStatusSchema,
    nodeKind: z.enum(["planner", "executor", "direct_agent", "note_capture"]),
    toolName: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u)
      .optional(),
    inputDisplay: z.string().max(32_000).optional(),
    inputDisplayTruncated: z.boolean().optional(),
    resultDisplay: z.string().max(32_000).optional(),
    resultDisplayTruncated: z.boolean().optional(),
    provider: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
      .optional(),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u)
      .optional(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    durationMs: z.number().int().nonnegative().max(3_600_000).optional(),
    tokenUsage: tokenUsageSchema.optional(),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
      .max(64)
      .optional(),
  })
  .strict();

export const workflowExecutionTraceDtoSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_EXECUTION_TRACE_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    traceRevision: sha256Schema,
    updatedAt: z.iso.datetime(),
    run: z
      .object({
        status: productRunStatusSchema,
        phase: productRunPhaseSchema,
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      })
      .strict(),
    workflow: z
      .object({
        title: z.string().min(1).max(160),
        /** 只包含实际NodeRun；静态Definition节点不进入执行轨迹。 */
        nodeRuns: z.array(workflowNodeRunSummaryDtoSchema).max(500),
        /** Manifest引用解析后的既有产品事实；不包含模型原始Payload或隐藏推理。 */
        nodeDetails: z.array(workflowNodeTraceDetailDtoSchema).max(500),
        /** execute.plan内部真正执行过的Approved Plan Step。 */
        executionSteps: z.array(executionStepTraceDtoSchema).max(500),
      })
      .strict(),
    runtime: workflowRuntimeTraceDtoSchema,
    piActivities: z.array(piTraceActivityDtoSchema).max(500),
    truncated: z.boolean(),
  })
  .strict();

export type PiTraceActivityDto = z.infer<typeof piTraceActivityDtoSchema>;
export type WorkflowExecutionTraceDto = z.infer<typeof workflowExecutionTraceDtoSchema>;
export type WorkflowExecutionTraceValueDto = z.infer<typeof workflowExecutionTraceValueDtoSchema>;
export type WorkflowNodeTraceDetailDto = z.infer<typeof workflowNodeTraceDetailDtoSchema>;
export type ExecutionStepTraceDto = z.infer<typeof executionStepTraceDtoSchema>;
