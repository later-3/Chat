import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  piDirectExecutorEventSchema,
  startPiDirectExecutorOperationRequestSchema,
  type PiDirectExecutorEvent,
} from "@chat/pi-runtime";
import type { RunActivitySink } from "@chat/realtime";
import { z } from "zod";
import { piDirectExecutorActivities } from "./pi-direct-executor-activity.js";

const MARKER_FILE = ".pi-direct-journal-to-run-activity.v1.json";
const directRecordProjectionSchema = z
  .object({
    request: startPiDirectExecutorOperationRequestSchema,
    events: z.array(piDirectExecutorEventSchema).max(100_000),
    createdAt: z.iso.datetime(),
  })
  .passthrough();

export interface PiDirectActivityMigrationResult {
  readonly status: "completed" | "already_completed";
  readonly operations: number;
  readonly sourceEvents: number;
  readonly migratedActivities: number;
}

/**
 * Pi Direct Operation Journal是原生执行证据；启动时一次性把历史ID/状态/工具投影接回
 * Chat Run Activity。正文仍由Pi Session和Product Message各自拥有，不复制到此迁移层。
 */
export async function migratePiDirectJournalToRunActivity(input: {
  readonly operationsDir: string;
  readonly activitySink: RunActivitySink;
  readonly now?: () => Date;
}): Promise<PiDirectActivityMigrationResult> {
  mkdirSync(input.activitySink.dir, { recursive: true });
  const marker = join(input.activitySink.dir, MARKER_FILE);
  if (existsSync(marker)) {
    return {
      status: "already_completed",
      operations: 0,
      sourceEvents: 0,
      migratedActivities: 0,
    };
  }

  let names: string[] = [];
  try {
    names = (await readdir(input.operationsDir)).filter((name) =>
      /^pio_[A-Za-z0-9]+\.json$/u.test(name),
    );
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
  const records = await Promise.all(
    names.map(async (name) => {
      try {
        return {
          name,
          value: directRecordProjectionSchema.parse(
            JSON.parse(await readFile(join(input.operationsDir, name), "utf8")),
          ),
        };
      } catch (error) {
        throw new Error(
          `${name} Pi Direct Journal迁移失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
  records.sort((left, right) =>
    left.value.createdAt === right.value.createdAt
      ? left.name.localeCompare(right.name)
      : left.value.createdAt.localeCompare(right.value.createdAt),
  );

  let sourceEvents = 0;
  let migratedActivities = 0;
  for (const { value } of records) {
    const scope = {
      productRunId: value.request.productRunId,
      directAgentAttemptId: value.request.directAgentAttemptId,
    };
    for (const event of value.events as readonly PiDirectExecutorEvent[]) {
      sourceEvents += 1;
      for (const activity of piDirectExecutorActivities(scope, event)) {
        if (input.activitySink.emit(activity) !== undefined) migratedActivities += 1;
      }
    }
  }

  const result = {
    status: "completed" as const,
    operations: records.length,
    sourceEvents,
    migratedActivities,
  };
  const temporary = `${marker}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({
      migrationVersion: "pi-direct-journal-to-run-activity.v1",
      completedAt: (input.now ?? (() => new Date()))().toISOString(),
      ...result,
    })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await rename(temporary, marker);
  return result;
}
