import { serve } from "@hono/node-server";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRuntimeApiClient } from "@chat/contracts";
import { loadRuntimeCredential } from "@chat/contracts/runtime-credential";
import {
  assertManagedPiForkCapabilities,
  createPiExecutorService,
  createPlanningE2EPiCodingRunner,
  loadPiExecutorWorkspaceRoots,
  PiExecutorOperationStore,
} from "@chat/pi-runtime/coding-executor";

const HOSTNAME = "127.0.0.1";
const PORT = Number.parseInt(process.env.CHAT_PI_EXECUTOR_PORT ?? "45615", 10);
const repoRoot = resolve(process.env.CHAT_REPO_ROOT ?? process.cwd());
const expectedRoot = resolve(repoRoot, ".data/e2e/dsh-planning-faux-real/pi-executor");
const dataRoot = resolve(process.env.CHAT_PI_EXECUTOR_DATA_DIR ?? "");
if (dataRoot !== expectedRoot) throw new Error("Planning Faux Pi必须使用受管数据根");
const forbiddenCredentialNames = [
  "DASHSCOPE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "PLANE_API_TOKEN",
  "SSH_AUTH_SOCK",
] as const;
const visible = forbiddenCredentialNames.filter((name) => process.env[name]?.trim());
if (visible.length > 0) throw new Error(`Planning Faux Pi看到了禁止环境：${visible.join(",")}`);

await mkdir(dataRoot, { recursive: true });
await writeFile(
  resolve(dataRoot, "environment-sentinel.json"),
  `${JSON.stringify({ providerCredentialsVisible: false, checked: forbiddenCredentialNames })}\n`,
  { mode: 0o600 },
);
assertManagedPiForkCapabilities();
const credential = await loadRuntimeCredential(repoRoot);
const store = await PiExecutorOperationStore.open(resolve(dataRoot, "operations"));
const api = createRuntimeApiClient({
  baseUrl: process.env.CHAT_API_INTERNAL_BASE_URL ?? "http://127.0.0.1:45611",
  credential,
});
const runtime = createPiExecutorService({
  credential,
  store,
  workspaceRoots: await loadPiExecutorWorkspaceRoots(process.env),
  emptyWorkspaceRoot: resolve(dataRoot, "empty-workspaces"),
  agentDir: resolve(dataRoot, "agent"),
  sessionsDir: resolve(dataRoot, "sessions"),
  authorizeOperation: (input) => api.authorizeExecutorOperation(input),
  runner: createPlanningE2EPiCodingRunner(),
});
const server = serve({ fetch: runtime.app.fetch, port: PORT, hostname: HOSTNAME });

async function shutdown(): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
  await runtime.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown());
}
