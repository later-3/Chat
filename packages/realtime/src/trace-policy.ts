import { TRACE_SCHEMA_VERSION, traceEventSchema, type TraceEventInput } from "@chat/contracts";
import { randomUUID } from "node:crypto";
import { createTraceSink, type TraceSink, type TraceSinkOptions } from "./trace-sink.js";

export const TRACE_SCOPES = [
  "dsh",
  "bridge",
  "api",
  "application",
  "workflow",
  "pi",
  "provider",
  "tool",
] as const;

export type TraceScope = (typeof TRACE_SCOPES)[number];
export type TraceMode = "off" | "errors" | "full";

export interface TracePolicy {
  readonly mode: TraceMode;
  readonly scopes: ReadonlySet<TraceScope>;
}

function parseMode(value: string | undefined): TraceMode {
  const normalized = value?.trim() || "off";
  if (normalized === "off" || normalized === "errors" || normalized === "full") {
    return normalized;
  }
  throw new Error("CHAT_TRACE_MODE必须是off、errors或full");
}

function parseScopes(value: string | undefined): ReadonlySet<TraceScope> {
  if (value === undefined || value.trim() === "") return new Set(TRACE_SCOPES);
  const scopes = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const allowed = new Set<string>(TRACE_SCOPES);
  for (const scope of scopes) {
    if (!allowed.has(scope)) throw new Error(`CHAT_TRACE_SCOPES包含未知模块:${scope}`);
  }
  return new Set(scopes as TraceScope[]);
}

/** 默认完全关闭；只有显式模式和模块同时允许时才会创建文件Sink。 */
export function tracePolicyFromEnvironment(env: NodeJS.ProcessEnv = process.env): TracePolicy {
  return {
    mode: parseMode(env.CHAT_TRACE_MODE),
    scopes: parseScopes(env.CHAT_TRACE_SCOPES),
  };
}

function shouldPersist(mode: Exclude<TraceMode, "off">, event: TraceEventInput): boolean {
  if (mode === "full") return true;
  return (
    event.level === "warn" ||
    event.level === "error" ||
    event.outcome === "failure" ||
    event.outcome === "rejected"
  );
}

export function createConfiguredTraceSink(input: {
  readonly scope: TraceScope;
  readonly env?: NodeJS.ProcessEnv;
  readonly sinkOptions?: TraceSinkOptions;
}): TraceSink | undefined {
  const policy = tracePolicyFromEnvironment(input.env);
  if (policy.mode === "off" || !policy.scopes.has(input.scope)) return undefined;
  const sink = createTraceSink(input.sinkOptions);
  const mode = policy.mode;
  return {
    dir: sink.dir,
    get droppedEvents() {
      return sink.droppedEvents;
    },
    emit(event) {
      // 被errors策略过滤的事件没有写入失败，也不属于容量丢弃。
      return shouldPersist(mode, event)
        ? sink.emit(event)
        : traceEventSchema.parse({
            schemaVersion: TRACE_SCHEMA_VERSION,
            eventId: `evf_${randomUUID()}`,
            timestamp: new Date().toISOString(),
            ...event,
          });
    },
  };
}
