import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  commandIdSchema,
  productSessionIdSchema,
  workflowDefinitionRevisionIdSchema,
} from "@chat/contracts/public";

export const DSH_BRIDGE_TRACE_EVENTS = {
  dshAdapterRequestCaptured: "dsh.adapter_request.captured",
  bridgeDispatchPrepared: "bridge.dispatch.prepared",
} as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const traceIdSchema = z.string().regex(/^[a-z][a-z0-9]*_[A-Za-z0-9-]{1,80}$/u);
const baseInputSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  outcome: z.enum(["success", "failure", "rejected", "unknown"]),
  traceId: traceIdSchema,
  spanId: traceIdSchema,
  parentSpanId: traceIdSchema.optional(),
});

const dshTraceInputSchema = baseInputSchema
  .extend({
    eventName: z.literal(DSH_BRIDGE_TRACE_EVENTS.dshAdapterRequestCaptured),
    outcome: z.literal("success"),
    dshSessionIdSha256: sha256Schema,
    requestSha256: sha256Schema,
    userTextSha256: sha256Schema,
    sectionCount: z.number().int().nonnegative().max(10_000),
  })
  .strict();

const bridgeTraceInputSchema = baseInputSchema
  .extend({
    eventName: z.literal(DSH_BRIDGE_TRACE_EVENTS.bridgeDispatchPrepared),
    outcome: z.literal("success"),
    dshSessionIdSha256: sha256Schema,
    commandId: commandIdSchema,
    dispatchPlanSha256: sha256Schema,
    promptSelectionSha256: sha256Schema.optional(),
    workflowDefinitionRevisionId: workflowDefinitionRevisionIdSchema.optional(),
    productSessionId: productSessionIdSchema.optional(),
  })
  .strict();

const traceInputSchema = z.discriminatedUnion("eventName", [
  dshTraceInputSchema,
  bridgeTraceInputSchema,
]);

export type DshBridgeTraceEventInput = z.infer<typeof traceInputSchema>;
export type DshBridgeTraceScope = "dsh" | "bridge";
type TraceMode = "off" | "errors" | "full";

const ALL_TRACE_SCOPES = new Set([
  "dsh",
  "bridge",
  "api",
  "application",
  "workflow",
  "pi",
  "provider",
  "tool",
]);
const DEFAULT_MAX_DAILY_BYTES = 16 * 1024 * 1024;

function traceMode(env: NodeJS.ProcessEnv): TraceMode {
  const value = env.CHAT_TRACE_MODE?.trim() || "off";
  if (value === "off" || value === "errors" || value === "full") return value;
  throw new Error("CHAT_TRACE_MODE必须是off、errors或full");
}

function selectedScopes(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = env.CHAT_TRACE_SCOPES;
  if (raw === undefined || raw.trim() === "") return ALL_TRACE_SCOPES;
  const scopes = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  for (const scope of scopes) {
    if (!ALL_TRACE_SCOPES.has(scope)) {
      throw new Error(`CHAT_TRACE_SCOPES包含未知模块:${scope}`);
    }
  }
  return new Set(scopes);
}

function traceDirectory(repoRoot: string, env: NodeJS.ProcessEnv): string {
  const explicit = env.CHAT_TRACE_DIR?.trim();
  if (explicit === undefined || explicit === "") return join(repoRoot, ".data", "traces");
  if (!isAbsolute(explicit)) throw new Error("CHAT_TRACE_DIR必须是绝对路径");
  return resolve(explicit);
}

function maxDailyBytes(env: NodeJS.ProcessEnv): number {
  const raw =
    env.CHAT_TRACE_MAX_DAILY_BYTES === undefined
      ? DEFAULT_MAX_DAILY_BYTES
      : Number(env.CHAT_TRACE_MAX_DAILY_BYTES);
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error("CHAT_TRACE_MAX_DAILY_BYTES必须是正整数");
  }
  return raw;
}

/**
 * DSH Host是独立上游进程，不能依赖Chat Realtime实现包。这个窄Adapter只负责把
 * 两类公开边界摘要写成与Chat Debug Trace兼容的JSONL；正文没有Schema字段通道。
 */
export function createDshBridgeTraceEmitter(input: {
  readonly scope: DshBridgeTraceScope;
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}): ((event: DshBridgeTraceEventInput) => void) | undefined {
  const env = input.env ?? process.env;
  const mode = traceMode(env);
  if (mode === "off" || !selectedScopes(env).has(input.scope)) return undefined;

  const dir = traceDirectory(input.repoRoot, env);
  const capacity = maxDailyBytes(env);
  const warnedFiles = new Set<string>();
  mkdirSync(dir, { recursive: true });

  return (unparsed) => {
    const event = traceInputSchema.parse(unparsed);
    // 当前DSH/Bridge只定义两类成功边界摘要；errors模式因此不写这两类事件。
    // 后续若增加严格失败事件Schema，应在这里按其level/outcome白名单放行。
    if (mode === "errors") return;
    const timestamp = new Date();
    const stored = {
      schemaVersion: 1 as const,
      eventId: `evt_${randomUUID()}`,
      timestamp: timestamp.toISOString(),
      ...event,
    };
    const fileName = `chat-trace-${timestamp.toISOString().slice(0, 10)}.bounded.jsonl`;
    const file = join(dir, fileName);
    const line = `${JSON.stringify(stored)}\n`;
    const currentBytes = existsSync(file) ? statSync(file).size : 0;
    if (currentBytes + Buffer.byteLength(line) > capacity) {
      if (!warnedFiles.has(file)) {
        warnedFiles.add(file);
        console.error(`[trace] capacity_reached file=${fileName} max_bytes=${String(capacity)}`);
      }
      return;
    }
    appendFileSync(file, line, "utf8");
  };
}
