import { z } from "zod";
import { productRunIdSchema, runAttemptIdSchema } from "./ids.js";
import { agentRuntimeToolNameSchema } from "./agent-runtime-capabilities.js";
import { resolvedCapabilitySnapshotSchema } from "./capability.js";

/**
 * Chat Session 中由 Workflow / Agent Runtime 产生的可展示活动。
 *
 * 这是 Session 轨迹的一个来源，不是 Debug Trace，也不是 Product Store 终态：
 * - Product Store 继续拥有 Run、Node、Decision、Message 等产品事实；
 * - DSH / Pi 继续拥有各自的原生 Session；
 * - 本合同只保存把 Agent、模型与工具活动接回 Product Run 所需的有界投影。
 */
export const RUN_ACTIVITY_SCHEMA_VERSION = "chat-run-activity.v1" as const;

const sourceKeySchema = z.string().min(1).max(400);
const sourceKindSchema = z.enum(["workflow", "pi_executor", "pi_direct_executor"]);
const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime();
const durationMsSchema = z.number().nonnegative().max(3_600_000);
const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/u)
  .max(80);
const nodeKindSchema = z.enum(["planner", "executor", "direct_agent", "note_capture"]);
const displaySchema = z.string().max(32_000);
const providerSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const modelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
const tokenUsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative().max(100_000_000),
    completionTokens: z.number().int().nonnegative().max(100_000_000),
    totalTokens: z.number().int().nonnegative().max(100_000_000),
  })
  .strict();

const base = {
  schemaVersion: z.literal(RUN_ACTIVITY_SCHEMA_VERSION),
  sequence: sequenceSchema,
  productRunId: productRunIdSchema,
  attemptId: runAttemptIdSchema.optional(),
  timestamp: timestampSchema,
  sourceKey: sourceKeySchema,
  sourceKind: sourceKindSchema,
  sourceOperationId: z.string().min(1).max(160).optional(),
  sourceSequence: sequenceSchema.optional(),
};

const runActivityEventShapeSchema = z.discriminatedUnion("activityType", [
  z
    .object({
      ...base,
      activityType: z.literal("agent"),
      phase: z.enum(["started", "completed", "failed", "cancelled", "outcome_unknown"]),
      nodeKind: nodeKindSchema,
      durationMs: durationMsSchema.optional(),
      errorCode: stableErrorCodeSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      activityType: z.literal("model"),
      phase: z.enum(["started", "completed", "failed"]),
      nodeKind: nodeKindSchema,
      provider: providerSchema,
      model: modelSchema,
      requestIndex: z.number().int().positive().max(1000).optional(),
      durationMs: durationMsSchema.optional(),
      tokenUsage: tokenUsageSchema.optional(),
      errorCode: stableErrorCodeSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      activityType: z.literal("tool"),
      phase: z.enum(["started", "completed", "failed", "blocked", "outcome_unknown"]),
      nodeKind: nodeKindSchema.optional(),
      workflowNodeRunId: z
        .string()
        .regex(/^wnr_[A-Za-z0-9]+$/u)
        .optional(),
      toolCallId: z.string().min(1).max(160),
      toolName: agentRuntimeToolNameSchema,
      /** v1早期Journal没有qualified identity；新Pi事件必须写入。 */
      capability: resolvedCapabilitySnapshotSchema.optional(),
      inputDisplay: displaySchema.optional(),
      inputDisplayTruncated: z.boolean().optional(),
      resultDisplay: displaySchema.optional(),
      resultDisplayTruncated: z.boolean().optional(),
      durationMs: durationMsSchema.optional(),
      errorCode: stableErrorCodeSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      activityType: z.literal("assistant_message"),
      text: displaySchema,
      textTruncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...base,
      activityType: z.literal("lifecycle"),
      name: z.enum([
        "operation.accepted",
        "operation.started",
        "operation.completed",
        "operation.cancelled",
        "operation.failed",
        "operation.outcome_unknown",
        "session.started",
        "session.resumed",
        "session.settled",
        "turn.started",
        "turn.completed",
        "compaction.started",
        "compaction.completed",
        "prompt_review.preparing",
        "prompt_review.waiting",
        "prompt_review.decided",
      ]),
      outcome: z.enum(["success", "failure", "cancelled", "unknown"]),
      turnIndex: z.number().int().nonnegative().max(1000).optional(),
      durationMs: durationMsSchema.optional(),
      errorCode: stableErrorCodeSchema.optional(),
    })
    .strict(),
]);

/**
 * 来源身份也是Journal合同的一部分，不能只靠调用方约定：
 * - Pi来源必须能回指原生Operation及其事件序号；
 * - Workflow工具活动必须能回指Workflow Node Run；
 * - Agent/Model/Assistant活动必须能回指Chat Run Attempt。
 */
export const runActivityEventSchema = runActivityEventShapeSchema.superRefine((event, context) => {
  const needsAttempt =
    event.activityType === "agent" ||
    event.activityType === "model" ||
    event.activityType === "assistant_message" ||
    event.sourceKind !== "workflow";
  if (needsAttempt && event.attemptId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["attemptId"],
      message: "该Activity必须绑定Run Attempt",
    });
  }

  if (event.sourceKind === "workflow") {
    if (event.sourceOperationId !== undefined || event.sourceSequence !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["sourceOperationId"],
        message: "Workflow Activity不得伪装为Pi Operation事件",
      });
    }
    if (event.activityType === "tool" && event.workflowNodeRunId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["workflowNodeRunId"],
        message: "Workflow工具Activity必须绑定Workflow Node Run",
      });
    }
    return;
  }

  if (event.sourceOperationId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["sourceOperationId"],
      message: "Pi Activity必须绑定原生Operation",
    });
  }
  if (event.sourceSequence === undefined) {
    context.addIssue({
      code: "custom",
      path: ["sourceSequence"],
      message: "Pi Activity必须绑定原生Operation事件序号",
    });
  }
  if (event.activityType === "tool" && event.workflowNodeRunId !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["workflowNodeRunId"],
      message: "Pi工具Activity不得绑定Workflow Node Run",
    });
  }
});

export type RunActivityEvent = z.infer<typeof runActivityEventSchema>;
export type RunActivityEventInput = RunActivityEvent extends infer Event
  ? Event extends RunActivityEvent
    ? Omit<Event, "schemaVersion" | "sequence">
    : never
  : never;
