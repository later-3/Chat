import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  TRACE_SCHEMA_VERSION,
  redactAttributes,
  traceEventSchema,
  type TraceEvent,
  type TraceEventInput,
} from "@chat/contracts";

/**
 * API本地JSONL Trace Sink。
 *
 * TODO(B6)：并行期不允许改动pnpm-lock.yaml，apps/api暂时无法声明对
 * @chat/realtime的依赖（架构测试已放行该方向）。PR #3合并后应把本文件
 * 替换为@chat/realtime的createTraceSink，保持单一实现。
 *
 * 写入语义与@chat/realtime的Sink一致：内存校验+脱敏后追加单行，
 * 校验失败抛错，不产生半行写入。
 */

/** Sink函数签名与@chat/realtime的TraceSink.emit对齐。 */
export type TraceEventSink = (input: TraceEventInput) => TraceEvent;

export function resolveTraceDir(dir?: string): string {
  if (dir) return resolve(dir);
  if (process.env.CHAT_TRACE_DIR) return resolve(process.env.CHAT_TRACE_DIR);
  let current = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return join(current, ".data", "traces");
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("无法向上找到仓库根（pnpm-workspace.yaml）以定位Trace目录");
    }
    current = parent;
  }
}

export function createJsonlTraceSink(options: { dir?: string } = {}): TraceEventSink {
  const dir = resolveTraceDir(options.dir);
  mkdirSync(dir, { recursive: true });
  return (input) => {
    const event = traceEventSchema.parse({
      schemaVersion: TRACE_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      ...input,
      attributes: redactAttributes(input.attributes ?? {}),
    });
    const file = join(dir, `chat-trace-${event.timestamp.slice(0, 10)}.jsonl`);
    appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  };
}
