import "../../../scripts/load-env.mjs";
import { serve } from "@hono/node-server";
import { createTraceSink } from "@chat/realtime";
import { isBailianReady, loadBailianConfig } from "@chat/pi-runtime";
import { loadRuntimeCredential } from "@chat/workflows";
import { createApiApp } from "./app.js";
import { createApplicationDeps, DEBUG_PRINCIPAL_ID } from "./composition.js";
import { OutboxDispatcher } from "./outbox-dispatcher.js";

/**
 * Chat API入口。本地调试固定端口43111（任务书§8.1），可用PORT覆盖；
 * 端口被占用时@hono/node-server直接失败关闭，不自动换号。
 *
 * Product Store路径用CHAT_PRODUCT_STORE_PATH覆盖，默认仓库.data/product/；
 * Store损坏时open失败关闭，进程不启动。
 * 缺少DASHSCOPE_API_KEY时服务仍可启动（Provider not ready），
 * 但绝不切换为假Provider；真实付费路径在Planner处失败关闭。
 */
const port = Number.parseInt(process.env.PORT ?? "43111", 10);
const hostname = process.env.CHAT_API_HOST ?? "127.0.0.1";

const repoRoot = process.env.CHAT_REPO_ROOT ?? process.cwd();
const traceSink = createTraceSink();
const deps = await createApplicationDeps(undefined, (event) => {
  try {
    traceSink.emit(event);
  } catch {
    // Trace失败不影响业务；故障由Sink Owner看护
  }
});
const credential = await loadRuntimeCredential(repoRoot);
const bailian = loadBailianConfig(process.env);

const dispatcher = new OutboxDispatcher({
  deps,
  workflowRuntimeBaseUrl: process.env.CHAT_WORKFLOW_BASE_URL ?? "http://127.0.0.1:43112",
  credential,
});
dispatcher.start();

const app = createApiApp({
  traceSink,
  product: { deps, principalId: DEBUG_PRINCIPAL_ID },
  internalRuntime: { credential },
  providerReady: isBailianReady(bailian),
});

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`chat-api listening on http://${hostname}:${info.port}`);
});
