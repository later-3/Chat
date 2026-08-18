import { z } from "zod";
import { productRunIdSchema } from "./ids.js";

/**
 * 浏览器可见的执行轨迹不是内部Trace原文，而是经过白名单裁剪的只读投影。
 * 它保留Pi CLI/Web中用户可观察的命令、路径、工具结果、耗时和可见回复；
 * Provider Payload、凭据、Prompt与隐藏推理没有字段通道。
 */
export const EXECUTION_TRACE_SCHEMA_VERSION = "chat-execution-trace.v1" as const;

export const executionTraceCursorSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const executionTraceToolNameSchema = z.enum([
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "bash",
]);
const displaySchema = z.string().max(32_000);
const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime();

const lifecycleItemSchema = z
  .object({
    sequence: sequenceSchema,
    timestamp: timestampSchema,
    type: z.literal("lifecycle"),
    name: z.enum([
      "operation.started",
      "operation.completed",
      "operation.failed",
      "operation.outcome_unknown",
      "session.started",
      "session.settled",
      "turn.started",
      "turn.completed",
      "provider.started",
      "provider.completed",
      "provider.failed",
      "compaction.started",
      "compaction.completed",
    ]),
    outcome: z.enum(["success", "failure", "unknown"]),
    durationMs: z.number().nonnegative().max(3_600_000).optional(),
    turnIndex: z.number().int().nonnegative().max(1000).optional(),
    providerRequestIndex: z.number().int().positive().max(1000).optional(),
    promptTokens: z.number().int().nonnegative().max(100_000_000).optional(),
    completionTokens: z.number().int().nonnegative().max(100_000_000).optional(),
    totalTokens: z.number().int().nonnegative().max(100_000_000).optional(),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u)
      .max(64)
      .optional(),
  })
  .strict();

const assistantMessageItemSchema = z
  .object({
    sequence: sequenceSchema,
    timestamp: timestampSchema,
    type: z.literal("assistant_message"),
    text: displaySchema,
    textTruncated: z.boolean(),
  })
  .strict();

const toolCallItemSchema = z
  .object({
    sequence: sequenceSchema,
    timestamp: timestampSchema,
    type: z.literal("tool_call"),
    toolCallId: z.string().min(1).max(160),
    toolName: executionTraceToolNameSchema,
    input: displaySchema,
    inputTruncated: z.boolean(),
  })
  .strict();

const toolResultItemSchema = z
  .object({
    sequence: sequenceSchema,
    timestamp: timestampSchema,
    type: z.literal("tool_result"),
    toolCallId: z.string().min(1).max(160),
    toolName: executionTraceToolNameSchema,
    outcome: z.enum(["success", "failure", "rejected", "unknown"]),
    output: displaySchema,
    outputTruncated: z.boolean(),
    durationMs: z.number().nonnegative().max(3_600_000).optional(),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u)
      .max(64)
      .optional(),
  })
  .strict();

export const executionTraceItemSchema = z.discriminatedUnion("type", [
  lifecycleItemSchema,
  assistantMessageItemSchema,
  toolCallItemSchema,
  toolResultItemSchema,
]);

export const executionTracePageSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_TRACE_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    items: z.array(executionTraceItemSchema).max(100),
    nextCursor: executionTraceCursorSchema,
    hasMore: z.boolean(),
  })
  .strict();

export type ExecutionTraceItem = z.infer<typeof executionTraceItemSchema>;
export type ExecutionTracePage = z.infer<typeof executionTracePageSchema>;
