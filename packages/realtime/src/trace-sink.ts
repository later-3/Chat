import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  TRACE_SCHEMA_VERSION,
  redactAttributes,
  traceEventSchema,
  type TraceEvent,
  type TraceEventInput,
} from "@chat/contracts";
import { resolveTraceDir, traceFileName } from "./trace-paths.js";

/**
 * JSONL Trace Sink（任务书§7.2）。
 *
 * 写入语义：
 * - 每次emit先在内存完成Schema校验与递归脱敏，再追加一行JSON；
 * - 校验失败抛错（属于调用方编程错误），不产生半行写入；
 * - 文件按UTC日期切分，目录缺失时自动创建；
 * - 崩溃耐久性不属于B1边界（B2 Product Store提供原子提交语义）。
 */
export interface TraceSink {
  emit(input: TraceEventInput): TraceEvent;
  readonly dir: string;
}

export interface TraceSinkOptions {
  dir?: string;
  now?: () => Date;
}

export function createTraceSink(options: TraceSinkOptions = {}): TraceSink {
  const dir = resolveTraceDir({ ...(options.dir !== undefined ? { dir: options.dir } : {}) });
  const now = options.now ?? (() => new Date());
  mkdirSync(dir, { recursive: true });

  return {
    dir,
    emit(input) {
      const event = traceEventSchema.parse({
        schemaVersion: TRACE_SCHEMA_VERSION,
        timestamp: now().toISOString(),
        ...input,
        attributes: redactAttributes(input.attributes ?? {}),
      });
      const file = join(dir, traceFileName(new Date(event.timestamp)));
      appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
      return event;
    },
  };
}
