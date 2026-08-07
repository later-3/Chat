import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  TRACE_SCHEMA_VERSION,
  traceEventSchema,
  type TraceEvent,
  type TraceEventInput,
} from "@chat/contracts";

/**
 * API本地JSONL Trace Sink。
 *
 * 合并阻断项（PR #4复审）：API最终只使用@chat/realtime提供的唯一Trace Sink。
 * 当前受P1.2 PR #3锁文件并行约束，apps/api不能新增对@chat/realtime的依赖；
 * PR #3合并后必须删除本文件并切换，PR #4在此之前保持Draft。
 *
 * 写入语义与@chat/realtime的Sink一致：严格判别联合校验后追加单行，
 * 校验失败抛错，不产生半行写入；合同本身不存在任意内容通道。
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
      eventId: `evt_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      ...input,
    });
    const file = join(dir, `chat-trace-${event.timestamp.slice(0, 10)}.jsonl`);
    appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  };
}
