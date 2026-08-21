import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productRunIdSchema } from "@chat/contracts";
import { createRunActivitySink, readRunActivityEvents } from "@chat/realtime";
import { describe, expect, it } from "vitest";
import { migratePiDirectJournalToRunActivity } from "./pi-direct-activity-migration.js";

const SHA = "a".repeat(64);

describe("migratePiDirectJournalToRunActivity", () => {
  it("把历史Direct Operation的Agent终态接回所属Product Run且只执行一次", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-direct-activity-migration-"));
    const operationsDir = join(root, "direct-operations");
    const activityDir = join(root, "run-activity");
    mkdirSync(operationsDir, { recursive: true });
    const operationId = "pio_directmigration1";
    const productRunId = productRunIdSchema.parse("run_directmigration1");
    writeFileSync(
      join(operationsDir, `${operationId}.json`),
      JSON.stringify({
        request: {
          schemaVersion: "pi-direct-executor.v1",
          operationId,
          productRunId,
          directAgentAttemptId: "att_directmigration1",
          workflowRunSpecId: "wrs_directmigration1",
          workflowRunSpecSha256: SHA,
          inputManifestSha256: SHA,
        },
        createdAt: "2026-08-21T00:00:00.000Z",
        events: [
          {
            sequence: 1,
            timestamp: "2026-08-21T00:00:00.000Z",
            operationId,
            type: "operation.accepted",
            requestSha256: SHA,
          },
          {
            sequence: 2,
            timestamp: "2026-08-21T00:00:01.000Z",
            operationId,
            type: "operation.started",
            requestSha256: SHA,
          },
          {
            sequence: 3,
            timestamp: "2026-08-21T00:00:02.000Z",
            operationId,
            type: "operation.failed",
            errorCode: "direct_executor.authorization_failed",
          },
        ],
      }),
      "utf8",
    );
    const activitySink = createRunActivitySink({ dir: activityDir });
    const result = await migratePiDirectJournalToRunActivity({ operationsDir, activitySink });
    expect(result).toMatchObject({
      status: "completed",
      operations: 1,
      sourceEvents: 3,
      migratedActivities: 5,
    });
    const events = await readRunActivityEvents({ dir: activityDir, productRunId });
    expect(events.filter((event) => event.activityType === "agent")).toEqual([
      expect.objectContaining({ phase: "started", nodeKind: "direct_agent" }),
      expect.objectContaining({
        phase: "failed",
        errorCode: "direct_executor.authorization_failed",
      }),
    ]);
    expect(
      await migratePiDirectJournalToRunActivity({ operationsDir, activitySink }),
    ).toMatchObject({ status: "already_completed", migratedActivities: 0 });
  });
});
