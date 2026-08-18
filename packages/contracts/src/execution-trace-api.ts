import { z } from "zod";
import { productRunIdSchema, runAttemptIdSchema, workflowNodeRunIdSchema } from "./ids.js";
import { productRunPhaseSchema, productRunStatusSchema } from "./product.js";
import { sha256Schema } from "./hash.js";
import { workflowNodeRunSummaryDtoSchema } from "./workflow-api.js";
import { workflowRuntimeTraceDtoSchema } from "./workflow-runtime-trace-api.js";
import { nodeProductRefSchema } from "./workflow-run.js";

export const EXECUTION_TRACE_SCHEMA_VERSION = "chat-execution-trace.v2";

const executionTraceValueDtoSchema = z
  .object({
    label: z.string().min(1).max(240),
    format: z.enum(["text", "markdown", "json"]),
    text: z.string().max(64_000),
    truncated: z.boolean(),
    source: nodeProductRefSchema.optional(),
  })
  .strict();

const workflowNodeTraceDetailDtoSchema = z
  .object({
    workflowNodeRunId: workflowNodeRunIdSchema,
    input: z.array(executionTraceValueDtoSchema).max(100),
    output: z.array(executionTraceValueDtoSchema).max(100),
  })
  .strict();

const executionStepTraceDtoSchema = z
  .object({
    parentWorkflowNodeRunId: workflowNodeRunIdSchema,
    stepId: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    status: z.enum(["running", "succeeded", "failed"]),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    durationMs: z.number().int().nonnegative().max(3_600_000).optional(),
    input: z.array(executionTraceValueDtoSchema).max(20),
    output: z.array(executionTraceValueDtoSchema).max(20),
  })
  .strict();

export const piTraceActivityStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);

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
    nodeKind: z.enum(["planner", "executor", "note_capture"]),
    toolName: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u)
      .optional(),
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

export const executionTraceDtoSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_TRACE_SCHEMA_VERSION),
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
export type ExecutionTraceDto = z.infer<typeof executionTraceDtoSchema>;
export type ExecutionTraceValueDto = z.infer<typeof executionTraceValueDtoSchema>;
export type WorkflowNodeTraceDetailDto = z.infer<typeof workflowNodeTraceDetailDtoSchema>;
export type ExecutionStepTraceDto = z.infer<typeof executionStepTraceDtoSchema>;
