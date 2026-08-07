import { serve } from "@hono/node-server";
import { createApiApp } from "./app.js";
import { createApplicationDeps, DEBUG_PRINCIPAL_ID } from "./composition.js";

/**
 * Chat API入口。本地调试固定端口43111（任务书§8.1），可用PORT覆盖；
 * 端口被占用时@hono/node-server直接失败关闭，不自动换号。
 *
 * Product Store路径用CHAT_PRODUCT_STORE_PATH覆盖，默认仓库.data/product/；
 * Store损坏时open失败关闭，进程不启动。
 */
const port = Number.parseInt(process.env.PORT ?? "43111", 10);
const hostname = process.env.CHAT_API_HOST ?? "127.0.0.1";

const deps = await createApplicationDeps();
const app = createApiApp({ product: { deps, principalId: DEBUG_PRINCIPAL_ID } });

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`chat-api listening on http://${hostname}:${info.port}`);
});
