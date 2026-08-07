import { serve } from "@hono/node-server";
import { createApiApp } from "./app.js";

/**
 * Chat API入口。本地调试固定端口43111（任务书§8.1），可用PORT覆盖；
 * 端口被占用时@hono/node-server直接失败关闭，不自动换号。
 */
const port = Number.parseInt(process.env.PORT ?? "43111", 10);
const hostname = process.env.CHAT_API_HOST ?? "127.0.0.1";

serve({ fetch: createApiApp().fetch, port, hostname }, (info) => {
  console.log(`chat-api listening on http://${hostname}:${info.port}`);
});
