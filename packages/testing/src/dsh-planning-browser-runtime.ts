import { serve } from "@hono/node-server";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWorkflowMemoryProviderRegistry } from "@chat/memory-runtime";
import { JsonProductStore } from "@chat/product-store-json";
import { createApiApp } from "@chat/api";
import { OutboxDispatcher } from "@chat/api/outbox-dispatcher";
import { DEBUG_PRINCIPAL_ID, createIdFactory, createRuleIdFactory } from "@chat/api/composition";

const repoRoot = resolve(process.env.CHAT_REPO_ROOT ?? process.cwd());
const dataRoot = resolve(repoRoot, ".data/e2e/dsh-planning-faux-real");
if (resolve(process.env.CHAT_DSH_E2E_DATA_ROOT ?? "") !== dataRoot) {
  throw new Error("确定性Planning浏览器Runtime必须使用受管数据根");
}
const apiPort = Number.parseInt(process.env.PORT ?? "45611", 10);
const workflowPort = Number.parseInt(process.env.CHAT_WORKFLOW_PORT ?? "45612", 10);
if (![apiPort, workflowPort].every((port) => Number.isSafeInteger(port) && port > 1023)) {
  throw new Error("确定性Planning浏览器Runtime端口无效");
}

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
if (visible.length > 0) throw new Error(`Planning Faux子进程看到了禁止环境：${visible.join(",")}`);
for (const [name, expected] of [
  ["CHAT_ALLOW_PAID_TESTS", "0"],
  ["CHAT_ALLOW_EXTERNAL_WRITES", "0"],
  ["CHAT_MEMORY_ENABLED", "0"],
  ["CHAT_CODE_WORKBENCH_ENABLED", "0"],
] as const) {
  if (process.env[name] !== expected) throw new Error(`Planning Faux没有冻结${name}=${expected}`);
}

await mkdir(dataRoot, { recursive: true });
await writeFile(
  resolve(dataRoot, "environment-sentinel.json"),
  `${JSON.stringify({ providerCredentialsVisible: false, checked: forbiddenCredentialNames })}\n`,
  { mode: 0o600 },
);

const store = await JsonProductStore.open({
  filePath: resolve(dataRoot, "product-store.v1.json"),
  now: () => new Date().toISOString(),
});
const workflowMemoryProviders = createWorkflowMemoryProviderRegistry({});
const deps = {
  store,
  now: () => new Date().toISOString(),
  ids: createIdFactory(),
  ruleIds: createRuleIdFactory(),
  workflowMemoryProviders,
};
const credential = "rtk_dshplanningfauxe2e00000000";
const api = createApiApp({
  traceSink: null,
  product: { deps, principalId: DEBUG_PRINCIPAL_ID },
  internalRuntime: { credential },
});
const apiServer = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: apiPort });
const dispatcher = new OutboxDispatcher({
  deps,
  workflowRuntimeBaseUrl: `http://127.0.0.1:${String(workflowPort)}`,
  credential,
  intervalMs: 50,
  dispatcherInstanceId: "dsh-planning-faux-e2e",
});
dispatcher.start();

async function closeServer(server: ReturnType<typeof serve>): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
}

async function shutdown(): Promise<void> {
  dispatcher.stop();
  await closeServer(apiServer);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown().then(() => process.exit(0)));
}
