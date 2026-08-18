import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  TRACE_SCHEMA_VERSION,
  traceEventSchema,
  type TraceEvent,
  type TraceEventInput,
} from "@chat/contracts";
import { resolveTraceDir, traceFileName } from "./trace-paths.js";

/**
 * JSONL Trace Sink（任务书§7.2）。
 *
 * 写入语义：
 * - 每次emit先通过严格判别联合完成Schema校验，再追加一行JSON；
 * - 合同不存在任意内容通道：未声明字段（含body/prompt/payload等）直接失败，
 *   不做“写入后脱敏”；只有Pi Executor明确声明的有界、已脱敏工具显示证据可写入；
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
  newEventId?: () => string;
}

export function createTraceSink(options: TraceSinkOptions = {}): TraceSink {
  const dir = resolveTraceDir({ ...(options.dir !== undefined ? { dir: options.dir } : {}) });
  const now = options.now ?? (() => new Date());
  const newEventId = options.newEventId ?? (() => `evt_${randomUUID()}`);
  mkdirSync(dir, { recursive: true });

  return {
    dir,
    emit(input) {
      const event = traceEventSchema.parse({
        schemaVersion: TRACE_SCHEMA_VERSION,
        eventId: newEventId(),
        timestamp: now().toISOString(),
        ...input,
      });
      const file = join(dir, traceFileName(new Date(event.timestamp)));
      appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
      return event;
    },
  };
}
