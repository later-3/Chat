import "../../../scripts/load-env.mjs";
import { serve } from "@hono/node-server";
import {
  createRunActivitySink,
  createConfiguredTraceSink,
  migrateLegacyTraceToRunActivity,
  resolveTraceDir,
} from "@chat/realtime";
import { loadRuntimeCredential } from "./runtime-credential.js";
import { createWorkflowRuntimeServer } from "./runtime-server.js";
import { migratePiDirectJournalToRunActivity } from "./pi-direct-activity-migration.js";

/**
 * Workflow Runtime进程入口（production 43112；隔离debug实例44112）。
 * 端口被占用时@hono/node-server直接失败关闭，不自动换号。
 */
const WORKFLOW_PORT = Number.parseInt(process.env.CHAT_WORKFLOW_PORT ?? "43112", 10);
const HOSTNAME = "127.0.0.1";

const repoRoot = process.env.CHAT_REPO_ROOT ?? process.cwd();
const credential = await loadRuntimeCredential(repoRoot);
const workflowTraceSink = createConfiguredTraceSink({ scope: "workflow" });
const piTraceSink = createConfiguredTraceSink({ scope: "pi" });
const providerTraceSink = createConfiguredTraceSink({ scope: "provider" });
const toolTraceSink = createConfiguredTraceSink({ scope: "tool" });
const traceSink = {
  emit(event: Parameters<NonNullable<typeof workflowTraceSink>["emit"]>[0]) {
    const target = event.eventName.startsWith("pi.tool.")
      ? toolTraceSink
      : event.eventName.startsWith("provider.")
        ? providerTraceSink
        : event.eventName.startsWith("pi.")
          ? piTraceSink
          : workflowTraceSink;
    return target?.emit(event);
  },
};
const activitySink = createRunActivitySink();
const migration = await migrateLegacyTraceToRunActivity({
  traceDir: resolveTraceDir(),
  activitySink,
});
if (migration.status === "completed") {
  console.log(
    `[session] legacy_trace_migration completed files=${String(migration.traceFiles)} ` +
      `lines=${String(migration.scannedLines)} activities=${String(migration.migratedEvents)}`,
  );
}
const directMigration = await migratePiDirectJournalToRunActivity({
  operationsDir:
    process.env.CHAT_PI_EXECUTOR_DATA_DIR === undefined
      ? `${repoRoot}/.data/pi-executor/direct-operations`
      : `${process.env.CHAT_PI_EXECUTOR_DATA_DIR}/direct-operations`,
  activitySink,
});
if (directMigration.status === "completed") {
  console.log(
    `[session] pi_direct_migration completed operations=${String(directMigration.operations)} ` +
      `events=${String(directMigration.sourceEvents)} activities=${String(directMigration.migratedActivities)}`,
  );
}
const runtime = await createWorkflowRuntimeServer({
  repoRoot,
  bundleDir:
    process.env.CHAT_WORKFLOW_BUNDLE_DIR ?? `${repoRoot}/packages/workflows/.workflow-bundle`,
  workflowDataDir: process.env.CHAT_WORKFLOW_DATA_DIR ?? `${repoRoot}/.data/workflow`,
  bindingsPath:
    process.env.CHAT_RUNTIME_BINDINGS_PATH ?? `${repoRoot}/.data/runtime/runtime-bindings.v1.json`,
  apiBaseUrl: process.env.CHAT_API_INTERNAL_BASE_URL ?? "http://127.0.0.1:43111",
  executorBaseUrl: process.env.CHAT_PI_EXECUTOR_INTERNAL_BASE_URL ?? "http://127.0.0.1:43115",
  credential,
  ...(workflowTraceSink === undefined &&
  piTraceSink === undefined &&
  providerTraceSink === undefined &&
  toolTraceSink === undefined
    ? {}
    : { traceSink }),
  activitySink,
});

const server = serve(
  { fetch: runtime.app.fetch, port: WORKFLOW_PORT, hostname: HOSTNAME },
  (info) => {
    console.log(`chat-workflow-runtime listening on http://${HOSTNAME}:${String(info.port)}`);
  },
);

let shutdownPromise: Promise<void> | undefined;
function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  shutdownPromise ??= (async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    } finally {
      await runtime.close();
    }
  })();
  void shutdownPromise.catch((error: unknown) => {
    console.error(
      `chat-workflow-runtime shutdown failed signal=${signal} cause=${
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "unknown"
      }`,
    );
    process.exitCode = 1;
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
