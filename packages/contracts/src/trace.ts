import { z } from "zod";

/**
 * 结构化Trace合同（任务书§7）。
 *
 * Trace只保存可观察事件、对象引用、长度、Hash和结果，不保存密钥、
 * 完整正文、完整Provider Payload或隐藏推理。用户消息与模型候选正文
 * 属于Product Store内容，不复制进Trace。
 */

export const TRACE_SCHEMA_VERSION = 1;

export const traceLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type TraceLevel = z.infer<typeof traceLevelSchema>;

export const traceOutcomeSchema = z.enum(["success", "failure", "rejected", "unknown"]);
export type TraceOutcome = z.infer<typeof traceOutcomeSchema>;

/** 任务书§7.3规定的必须记录的边界事件名。 */
export const TRACE_EVENT_NAMES = {
  httpCommandReceived: "http.command.received",
  httpCommandAccepted: "http.command.accepted",
  httpCommandRejected: "http.command.rejected",
  httpCommandCompleted: "http.command.completed",
  productTransactionStarted: "product.transaction.started",
  productTransactionCommitted: "product.transaction.committed",
  productTransactionFailed: "product.transaction.failed",
  productRunCreated: "product_run.created",
  productRunTransitioned: "product_run.transitioned",
  workflowStartRequested: "workflow.start.requested",
  workflowStartStarted: "workflow.start.started",
  workflowStartFailed: "workflow.start.failed",
  workflowStepStarted: "workflow.step.started",
  workflowStepCompleted: "workflow.step.completed",
  workflowStepFailed: "workflow.step.failed",
  workflowStepReplayed: "workflow.step.replayed",
  planCandidateReceived: "plan.candidate.received",
  planCandidateRejected: "plan.candidate.rejected",
  planCandidatePublished: "plan.candidate.published",
  approvalCreated: "approval.created",
  decisionCommitted: "decision.committed",
  decisionRejected: "decision.rejected",
  workflowHookWaiting: "workflow.hook.waiting",
  workflowHookResumeDispatched: "workflow.hook.resume_dispatched",
  workflowHookResumed: "workflow.hook.resumed",
  workflowHookResumeFailed: "workflow.hook.resume_failed",
  providerRequestStarted: "provider.request.started",
  providerRequestCompleted: "provider.request.completed",
  providerRequestFailed: "provider.request.failed",
  piNodeStarted: "pi.node.started",
  piNodeCompleted: "pi.node.completed",
  piNodeFailed: "pi.node.failed",
  executionValidated: "execution.validated",
  executionRejected: "execution.rejected",
  productCommitStarted: "product_commit.started",
  productCommitCommitted: "product_commit.committed",
  productCommitFailed: "product_commit.failed",
  /** 本地调试生命周期（B1调试基线使用）。 */
  serviceDebugStarted: "service.debug.started",
  serviceDebugStopped: "service.debug.stopped",
} as const;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** 任务书§7.2规定的Trace公共字段。 */
export const traceEventSchema = z.object({
  schemaVersion: z.literal(TRACE_SCHEMA_VERSION),
  timestamp: z.iso.datetime(),
  level: traceLevelSchema,
  eventName: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/,
      "eventName必须为小写点分层级，例如http.command.received",
    ),
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  productSessionId: z.string().min(1).optional(),
  interactionId: z.string().min(1).optional(),
  productRunId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  commandId: z.string().min(1).optional(),
  workflowDefinitionVersion: z.string().min(1).optional(),
  planRevision: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  outcome: traceOutcomeSchema,
  errorCode: z.string().min(1).optional(),
  attributes: z.record(z.string(), jsonValueSchema),
});

export type TraceEvent = z.infer<typeof traceEventSchema>;

/**
 * 待写入的Trace事件。schemaVersion/timestamp由Sink生成；
 * attributes在写入前经过脱敏与长度截断。
 */
export interface TraceEventInput {
  level: TraceLevel;
  eventName: string;
  traceId: string;
  spanId: string;
  outcome: TraceOutcome;
  parentSpanId?: string;
  requestId?: string;
  productSessionId?: string;
  interactionId?: string;
  productRunId?: string;
  attemptId?: string;
  commandId?: string;
  workflowDefinitionVersion?: string;
  planRevision?: number;
  durationMs?: number;
  errorCode?: string;
  attributes?: Record<string, unknown>;
}

/** 单个attribute字符串的最大长度；超出部分截断并标记。 */
export const TRACE_ATTRIBUTE_STRING_MAX = 1000;

export const TRACE_REDACTED = "[redacted]" as const;

/** 归一化后精确匹配的敏感键（小写、去除 - _ . 与空白）。 */
const SENSITIVE_EXACT_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "xapikey",
  "dashscopeapikey",
  "accesstoken",
  "refreshtoken",
  "hooktoken",
  "sessiontoken",
  "secret",
  "clientsecret",
  "password",
  "prompt",
  "systemprompt",
  "requestpayload",
  "responsepayload",
  "providerpayload",
  "hiddenreasoning",
  "reasoning",
  "thinkingcontent",
]);

/**
 * 判断attribute键是否敏感。允许tokenUsage等用量字段，
 * 禁止API Key、Authorization、Cookie、各类Token、Prompt、完整Payload与隐藏推理。
 */
export function isSensitiveAttributeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_.\s]/g, "");
  if (SENSITIVE_EXACT_KEYS.has(normalized)) return true;
  if (normalized.endsWith("token") && normalized !== "tokenusage") return true;
  if (normalized.endsWith("apikey")) return true;
  if (normalized.endsWith("password") || normalized.endsWith("secret")) return true;
  if (normalized.includes("authorization") || normalized.includes("cookie")) return true;
  return false;
}

function truncateString(value: string): string {
  if (value.length <= TRACE_ATTRIBUTE_STRING_MAX) return value;
  const omitted = value.length - TRACE_ATTRIBUTE_STRING_MAX;
  return `${value.slice(0, TRACE_ATTRIBUTE_STRING_MAX)}…[truncated ${omitted} chars]`;
}

function redactValue(key: string | null, value: unknown): JsonValue {
  if (key !== null && isSensitiveAttributeKey(key)) return TRACE_REDACTED;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(null, item));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactValue(childKey, childValue);
    }
    return out;
  }
  return String(value);
}

/** 递归脱敏attributes：敏感键替换为[redacted]，超长字符串截断，不可序列化值转字符串。 */
export function redactAttributes(attributes: Record<string, unknown>): Record<string, JsonValue> {
  return redactValue(null, attributes) as Record<string, JsonValue>;
}
