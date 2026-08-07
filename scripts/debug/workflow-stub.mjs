import { createServer } from "node:http";

/**
 * Workflow本地运行时占位（B1）。
 *
 * B4将用真实Vercel Workflow运行时替换本进程；端口与/healthz合同保持不变，
 * 以便.vscode调试链与等待脚本无需改动。
 */

const port = Number.parseInt(process.env.WORKFLOW_PORT ?? "43112", 10);
const hostname = "127.0.0.1";

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "chat-workflow" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: 404 }));
});

server.listen(port, hostname, () => {
  console.log(`chat-workflow stub listening on http://${hostname}:${port}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
