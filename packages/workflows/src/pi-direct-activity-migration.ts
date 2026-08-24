import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  piDirectExecutorEventSchema,
  legacyStartPiDirectExecutorOperationRequestSchema,
  startPiDirectExecutorOperationRequestSchema,
  type PiDirectExecutorEvent,
} from "@chat/pi-runtime";
import type { RunActivitySink } from "@chat/realtime";
import { z } from "zod";
import { piDirectExecutorActivities } from "./pi-direct-executor-activity.js";

const directRecordProjectionSchema = z
  .object({
    request: z.union([
      legacyStartPiDirectExecutorOperationRequestSchema,
      startPiDirectExecutorOperationRequestSchema,
    ]),
    events: z.array(piDirectExecutorEventSchema).max(100_000),
    createdAt: z.iso.datetime(),
  })
  .passthrough();

export interface PiDirectActivityMigrationResult {
  readonly status: "completed";
  readonly operations: number;
  readonly sourceEvents: number;
  readonly migratedActivities: number;
}

/**
 * Pi Direct Operation Journal是原生执行证据；每次启动都幂等扫描全部source sequence。
 * Activity Sink耐久保存sourceKey/payload，高水位之后的新事件会补齐，冲突payload失败关闭。
 */
export async function migratePiDirectJournalToRunActivity(input: {
  readonly operationsDir: string;
  readonly activitySink: RunActivitySink;
}): Promise<PiDirectActivityMigrationResult> {
  mkdirSync(input.activitySink.dir, { recursive: true });

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
  return result;
}
