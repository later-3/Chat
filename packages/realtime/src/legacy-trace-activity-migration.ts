import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { traceEventSchema, type TraceEventInput } from "@chat/contracts";
import type { RunActivitySink } from "./run-activity-journal.js";
import { TRACE_FILE_PATTERN } from "./trace-paths.js";

const MIGRATION_VERSION = "legacy-trace-to-run-activity.v1";
const MARKER_FILE = ".legacy-trace-to-run-activity.v1.json";
const ACTIVITY_EVENT_PATTERN =
  /"eventName"\s*:\s*"(?:pi\.|provider\.request\.|workflow\.memory_node\.)/u;

export interface LegacyTraceActivityMigrationResult {
  readonly status: "completed" | "already_completed";
  readonly traceFiles: number;
  readonly scannedLines: number;
  readonly candidateLines: number;
  readonly migratedEvents: number;
}

/** Debug Trace和Session Journal即使被错误配置，也绝不能落到同一个物理目录。 */
export function assertSessionStorageIsolation(input: {
  readonly traceDir: string;
  readonly activityDir: string;
}): void {
  if (resolve(input.traceDir) === resolve(input.activityDir)) {
    throw new Error("CHAT_TRACE_DIR与CHAT_RUN_ACTIVITY_DIR不得相同");
  }
}

/**
 * 从历史Trace一次性恢复可展示Activity。迁移在Workflow单写者启动前流式执行，API请求链路
 * 永不扫描Trace；HTTP轮询等无关行先用字符串白名单跳过，不做JSON解析。
 */
export async function migrateLegacyTraceToRunActivity(input: {
  readonly traceDir: string;
  readonly activitySink: RunActivitySink;
  readonly now?: () => Date;
}): Promise<LegacyTraceActivityMigrationResult> {
  assertSessionStorageIsolation({ traceDir: input.traceDir, activityDir: input.activitySink.dir });
  mkdirSync(input.activitySink.dir, { recursive: true });
  const marker = join(input.activitySink.dir, MARKER_FILE);
  if (existsSync(marker)) {
    return {
      status: "already_completed",
      traceFiles: 0,
      scannedLines: 0,
      candidateLines: 0,
      migratedEvents: 0,
    };
  }

  let names: string[] = [];
  try {
    names = (await readdir(input.traceDir)).filter((name) => TRACE_FILE_PATTERN.test(name)).sort();
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }

  let scannedLines = 0;
  let candidateLines = 0;
  let migratedEvents = 0;
  for (const name of names) {
    const lines = createInterface({
      input: createReadStream(join(input.traceDir, name), { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      scannedLines += 1;
      if (!ACTIVITY_EVENT_PATTERN.test(line)) continue;
      candidateLines += 1;
      try {
        const event = traceEventSchema.parse(JSON.parse(line));
        const traceInput = { ...event } as Partial<typeof event>;
        delete traceInput.schemaVersion;
        delete traceInput.eventId;
        delete traceInput.timestamp;
        if (
          input.activitySink.emitTrace(traceInput as TraceEventInput, event.timestamp) !== undefined
        ) {
          migratedEvents += 1;
        }
      } catch (error) {
        throw new Error(
          `${name}:${String(lineNumber)} 历史Trace迁移失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const completedAt = (input.now ?? (() => new Date()))().toISOString();
  const result = {
    status: "completed" as const,
    traceFiles: names.length,
    scannedLines,
    candidateLines,
    migratedEvents,
  };
  const temporary = `${marker}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ migrationVersion: MIGRATION_VERSION, completedAt, ...result })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await rename(temporary, marker);
  return result;
}
