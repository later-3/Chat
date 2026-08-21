import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  TRACE_SCHEMA_VERSION,
  traceEventSchema,
  type TraceEvent,
  type TraceEventInput,
} from "@chat/contracts";
import { boundedTraceFileName, resolveTraceDir } from "./trace-paths.js";

const DEFAULT_MAX_DAILY_BYTES = 16 * 1024 * 1024;

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
  /** 因容量门而未持久化的诊断事件数；Session Activity不受此门影响。 */
  readonly droppedEvents: number;
}

export interface TraceSinkOptions {
  dir?: string;
  now?: () => Date;
  newEventId?: () => string;
  maxDailyBytes?: number;
}

function configuredMaxDailyBytes(explicit: number | undefined): number {
  const raw =
    explicit ??
    (process.env.CHAT_TRACE_MAX_DAILY_BYTES === undefined
      ? DEFAULT_MAX_DAILY_BYTES
      : Number(process.env.CHAT_TRACE_MAX_DAILY_BYTES));
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error("CHAT_TRACE_MAX_DAILY_BYTES必须是正整数");
  }
  return raw;
}

export function createTraceSink(options: TraceSinkOptions = {}): TraceSink {
  const dir = resolveTraceDir({ ...(options.dir !== undefined ? { dir: options.dir } : {}) });
  const now = options.now ?? (() => new Date());
  const newEventId = options.newEventId ?? (() => `evt_${randomUUID()}`);
  const maxDailyBytes = configuredMaxDailyBytes(options.maxDailyBytes);
  const capacityWarnings = new Set<string>();
  let droppedEvents = 0;
  mkdirSync(dir, { recursive: true });

  return {
    dir,
    get droppedEvents() {
      return droppedEvents;
    },
    emit(input) {
      const event = traceEventSchema.parse({
        schemaVersion: TRACE_SCHEMA_VERSION,
        eventId: newEventId(),
        timestamp: now().toISOString(),
        ...input,
      });
      const file = join(dir, boundedTraceFileName(new Date(event.timestamp)));
      const line = `${JSON.stringify(event)}\n`;
      const currentBytes = existsSync(file) ? statSync(file).size : 0;
      if (currentBytes + Buffer.byteLength(line) > maxDailyBytes) {
        droppedEvents += 1;
        if (!capacityWarnings.has(file)) {
          capacityWarnings.add(file);
          console.error(
            `[trace] capacity_reached file=${boundedTraceFileName(new Date(event.timestamp))} ` +
              `max_bytes=${String(maxDailyBytes)}`,
          );
        }
        return event;
      }
      appendFileSync(file, line, "utf8");
      return event;
    },
  };
}
