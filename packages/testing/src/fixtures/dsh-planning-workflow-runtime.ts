import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import type { MemoryBackendRegistryPort } from "@chat/application";
import { createWorkflowMemoryProviderRegistry } from "@chat/memory-runtime";
import { createWorkflowRuntimeServer } from "@chat/workflows";
import { createRunActivitySink } from "@chat/realtime";

const repoRoot = resolve(process.env.CHAT_REPO_ROOT ?? process.cwd());
const dataRoot = resolve(repoRoot, ".data/e2e/dsh-planning-faux-real");
if (resolve(process.env.CHAT_DSH_E2E_DATA_ROOT ?? "") !== dataRoot) {
  throw new Error("确定性Planning Workflow必须使用受管数据根");
}
const workflowPort = Number.parseInt(process.env.CHAT_WORKFLOW_PORT ?? "45612", 10);
const apiPort = Number.parseInt(process.env.PORT ?? "45611", 10);
if (![workflowPort, apiPort].every((port) => Number.isSafeInteger(port) && port > 1023)) {
  throw new Error("确定性Planning Workflow端口无效");
}

const forbidden = [
  "DASHSCOPE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "PLANE_API_TOKEN",
  "SSH_AUTH_SOCK",
].filter((name) => process.env[name]?.trim());
if (forbidden.length > 0) {
  throw new Error(`Planning Workflow看到了禁止环境：${forbidden.join(",")}`);
}

const emptyMemoryBackends: MemoryBackendRegistryPort = { list: () => [], get: () => undefined };
const workflowMemoryProviders = createWorkflowMemoryProviderRegistry({});
const credential = "rtk_dshplanningfauxe2e00000000";
const activitySink = createRunActivitySink({ dir: resolve(dataRoot, "run-activity") });
type DeterministicOverrides = ReturnType<
  typeof import("@chat/pi-runtime/coding-executor").createDeterministicPlanningE2EOverrides
>;
let overridesPromise: Promise<DeterministicOverrides> | undefined;
const loadOverrides = () =>
  (overridesPromise ??= import("@chat/pi-runtime/coding-executor").then((module) =>
    module.createDeterministicPlanningE2EOverrides(),
  ));
// Node 24首次加载Pi SDK时会先建立内置fetch的Dispatcher1兼容wrapper。把真实pi
// loop延迟到Workflow网络策略完成安装后的第一个Step，不能放宽生产网络策略。
const overrides = {
  planner: async (...args: Parameters<DeterministicOverrides["planner"]>) =>
    (await loadOverrides()).planner(...args),
};
const runtime = await createWorkflowRuntimeServer({
  repoRoot,
  bundleDir: resolve(repoRoot, "packages/workflows/.workflow-bundle"),
  workflowDataDir: resolve(dataRoot, "workflow"),
  bindingsPath: resolve(dataRoot, "runtime-bindings.v1.json"),
  apiBaseUrl: `http://127.0.0.1:${String(apiPort)}`,
  executorBaseUrl: process.env.CHAT_PI_EXECUTOR_INTERNAL_BASE_URL ?? "http://127.0.0.1:45615",
  credential,
  activitySink,
  runtimeOverrides: {
    memoryBackends: emptyMemoryBackends,
    workflowMemoryProviders,
    bailian: {
      apiKey: "deterministic-faux",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      endpointHost: "dashscope.aliyuncs.com",
    },
    ...overrides,
  },
});
const server = serve({ fetch: runtime.app.fetch, hostname: "127.0.0.1", port: workflowPort });

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
  await runtime.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown().then(() => process.exit(0)));
}
