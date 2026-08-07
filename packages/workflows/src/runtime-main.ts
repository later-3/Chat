import "../../../scripts/load-env.mjs";
import { serve } from "@hono/node-server";
import { createTraceSink } from "@chat/realtime";
import { loadRuntimeCredential } from "./runtime-credential.js";
import { createWorkflowRuntimeServer } from "./runtime-server.js";

/**
 * Workflow Runtime进程入口（固定端口43112，任务书§17）。
 * 端口被占用时@hono/node-server直接失败关闭，不自动换号。
 */
const WORKFLOW_PORT = Number.parseInt(process.env.CHAT_WORKFLOW_PORT ?? "43112", 10);
const HOSTNAME = "127.0.0.1";

const repoRoot = process.env.CHAT_REPO_ROOT ?? process.cwd();
const credential = await loadRuntimeCredential(repoRoot);
const { app } = await createWorkflowRuntimeServer({
  repoRoot,
  bundleDir:
    process.env.CHAT_WORKFLOW_BUNDLE_DIR ?? `${repoRoot}/packages/workflows/.workflow-bundle`,
  workflowDataDir: process.env.CHAT_WORKFLOW_DATA_DIR ?? `${repoRoot}/.data/workflow`,
  bindingsPath:
    process.env.CHAT_RUNTIME_BINDINGS_PATH ?? `${repoRoot}/.data/runtime/runtime-bindings.v1.json`,
  apiBaseUrl: process.env.CHAT_API_INTERNAL_BASE_URL ?? "http://127.0.0.1:43111",
  credential,
  traceSink: createTraceSink(),
});

serve({ fetch: app.fetch, port: WORKFLOW_PORT, hostname: HOSTNAME }, (info) => {
  console.log(`chat-workflow-runtime listening on http://${HOSTNAME}:${String(info.port)}`);
});
