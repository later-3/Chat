import "../../../scripts/load-env.mjs";
import { serve } from "@hono/node-server";
import {
  createDirectAgentRuntimeApiCallbacks,
  createPiDirectExecutorService,
  createPiExecutorService,
  loadPiExecutorWorkspaceRoots,
  PiDirectExecutorOperationStore,
  PiExecutorOperationStore,
} from "@chat/pi-runtime/coding-executor";
import { createRuntimeApiClient, loadRuntimeCredential } from "@chat/workflows";

/**
 * 独立Pi Coding Executor进程。只监听loopback私有端口；Product事实仍由API/Application
 * 拥有，Workflow只用稳定Operation协议启动/查询，AgentSession与Journal由本进程拥有。
 */
const HOSTNAME = "127.0.0.1";
const PORT = Number.parseInt(process.env.CHAT_PI_EXECUTOR_PORT ?? "43115", 10);
const repoRoot = process.env.CHAT_REPO_ROOT ?? process.cwd();
const dataRoot = process.env.CHAT_PI_EXECUTOR_DATA_DIR ?? `${repoRoot}/.data/pi-executor`;
const credential = await loadRuntimeCredential(repoRoot);
const store = await PiExecutorOperationStore.open(`${dataRoot}/operations`);
const directStore = await PiDirectExecutorOperationStore.open(`${dataRoot}/direct-operations`);
const api = createRuntimeApiClient({
  baseUrl: process.env.CHAT_API_INTERNAL_BASE_URL ?? "http://127.0.0.1:43111",
  credential,
});
const workspaceRoots = await loadPiExecutorWorkspaceRoots(process.env);
const runtime = createPiExecutorService({
  credential,
  store,
  workspaceRoots,
  emptyWorkspaceRoot: `${dataRoot}/empty-workspaces`,
  agentDir: process.env.CHAT_PI_EXECUTOR_AGENT_DIR ?? `${dataRoot}/agent`,
  sessionsDir: `${dataRoot}/sessions`,
  authorizeOperation: (input) => api.authorizeExecutorOperation(input),
});
const directCallbacks = createDirectAgentRuntimeApiCallbacks({
  baseUrl: process.env.CHAT_API_INTERNAL_BASE_URL ?? "http://127.0.0.1:43111",
  credential,
});
const directRuntime = createPiDirectExecutorService({
  credential,
  store: directStore,
  workspaceRoots,
  emptyWorkspaceRoot: `${dataRoot}/direct-empty-workspaces`,
  agentDir: process.env.CHAT_PI_EXECUTOR_AGENT_DIR ?? `${dataRoot}/agent`,
  sessionsDir: `${dataRoot}/direct-sessions`,
  checkpointsDir: `${dataRoot}/direct-checkpoints`,
  ...directCallbacks,
});
runtime.app.route("/", directRuntime.app);
await directRuntime.recover();

const server = serve({ fetch: runtime.app.fetch, port: PORT, hostname: HOSTNAME }, (info) => {
  console.log(`chat-pi-executor listening on http://${HOSTNAME}:${String(info.port)}`);
});

let shutdownPromise: Promise<void> | undefined;
function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  shutdownPromise ??= (async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    await Promise.all([runtime.close(), directRuntime.close()]);
  })();
  void shutdownPromise.catch((error: unknown) => {
    console.error(
      `chat-pi-executor shutdown failed signal=${signal} cause=${
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
