import { serve } from "@hono/node-server";
import { access, mkdir, writeFile } from "node:fs/promises";
import {
  assertManagedPiForkCapabilities,
  createCapabilityGovernanceE2ERunner,
  createDirectAgentRuntimeApiCallbacks,
  createPiDirectExecutorService,
  createPiExecutorService,
  loadPiExecutorWorkspaceRoots,
  PiDirectExecutorOperationStore,
  PiExecutorOperationStore,
} from "@chat/pi-runtime/coding-executor";
import { createRuntimeApiClient } from "@chat/contracts";
import { loadRuntimeCredential } from "@chat/contracts/runtime-credential";

const HOSTNAME = "127.0.0.1";
const PORT = Number.parseInt(process.env.CHAT_PI_EXECUTOR_PORT ?? "45415", 10);
const repoRoot = process.env.CHAT_REPO_ROOT ?? process.cwd();
const dataRoot = process.env.CHAT_PI_EXECUTOR_DATA_DIR ?? `${repoRoot}/.data/e2e/pi-capability`;
const environmentSentinelPath = process.env.CHAT_CAPABILITY_E2E_ENV_SENTINEL_PATH;
const resultLossMarkerPath = process.env.CHAT_CAPABILITY_E2E_RESULT_LOSS_MARKER_PATH;
if (environmentSentinelPath === undefined || resultLossMarkerPath === undefined) {
  throw new Error("Capability E2E缺少隔离sentinel路径");
}
const forbiddenCredentialNames = [
  "DASHSCOPE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
] as const;
const visibleCredentials = forbiddenCredentialNames.filter(
  (name) => process.env[name]?.trim() !== undefined && process.env[name]?.trim() !== "",
);
if (visibleCredentials.length > 0) {
  throw new Error(`Capability E2E Pi子进程看到了禁止环境:${visibleCredentials.join(",")}`);
}
await mkdir(dataRoot, { recursive: true });
await writeFile(
  environmentSentinelPath,
  `${JSON.stringify({ providerCredentialsVisible: false, checked: forbiddenCredentialNames })}\n`,
  { mode: 0o600 },
);
assertManagedPiForkCapabilities();
const credential = await loadRuntimeCredential(repoRoot);
const store = await PiExecutorOperationStore.open(`${dataRoot}/operations`);
const directStore = await PiDirectExecutorOperationStore.open(`${dataRoot}/direct-operations`);
const apiBaseUrl = process.env.CHAT_API_INTERNAL_BASE_URL ?? "http://127.0.0.1:45411";
const api = createRuntimeApiClient({ baseUrl: apiBaseUrl, credential });
const workspaceRoots = await loadPiExecutorWorkspaceRoots(process.env);

const baseRunner = createCapabilityGovernanceE2ERunner();
const runner = {
  async run(input: Parameters<typeof baseRunner.run>[0]) {
    try {
      return await baseRunner.run(input);
    } catch (error) {
      console.error(
        `[capability-e2e] runner failed: ${error instanceof Error ? `${error.name}:${error.message}` : "unknown"}`,
      );
      throw error;
    }
  },
};

const runtime = createPiExecutorService({
  credential,
  store,
  workspaceRoots,
  emptyWorkspaceRoot: `${dataRoot}/empty-workspaces`,
  agentDir: `${dataRoot}/agent`,
  sessionsDir: `${dataRoot}/sessions`,
  authorizeOperation: (input) => api.authorizeExecutorOperation(input),
});
const directCallbacks = createDirectAgentRuntimeApiCallbacks({ baseUrl: apiBaseUrl, credential });
const baseToolExecutionProduct = directCallbacks.toolExecutionProduct;
if (baseToolExecutionProduct === undefined) {
  throw new Error("Capability E2E缺少Tool Execution Product回调");
}
const toolExecutionProduct = {
  ...baseToolExecutionProduct,
  async commitResult(input: Parameters<typeof baseToolExecutionProduct.commitResult>[0]) {
    await baseToolExecutionProduct.commitResult(input);
    if (input.outcome !== "completed") return;
    const alreadyInjected = await access(resultLossMarkerPath)
      .then(() => true)
      .catch(() => false);
    if (alreadyInjected) return;
    await writeFile(
      resultLossMarkerPath,
      "product result committed; response intentionally lost\n",
      {
        mode: 0o600,
      },
    );
    // 故意停在Product已提交、Pi尚未收到响应的窗口；测试必须杀掉本进程并由新进程恢复。
    await new Promise<never>(() => undefined);
  },
};
const directRuntime = createPiDirectExecutorService({
  credential,
  store: directStore,
  workspaceRoots,
  emptyWorkspaceRoot: `${dataRoot}/direct-empty-workspaces`,
  agentDir: `${dataRoot}/agent`,
  sessionsDir: `${dataRoot}/direct-sessions`,
  checkpointsDir: `${dataRoot}/direct-checkpoints`,
  runner,
  ...directCallbacks,
  toolExecutionProduct,
});
runtime.app.route("/", directRuntime.app);
await directRuntime.recover();

const server = serve({ fetch: runtime.app.fetch, port: PORT, hostname: HOSTNAME }, (info) => {
  console.log(`chat-pi-capability-e2e listening on http://${HOSTNAME}:${String(info.port)}`);
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  await Promise.all([runtime.close(), directRuntime.close()]);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().catch((error: unknown) => {
      console.error(
        `[capability-e2e] shutdown failed signal=${signal} cause=${error instanceof Error ? error.message : "unknown"}`,
      );
      process.exitCode = 1;
    });
  });
}
