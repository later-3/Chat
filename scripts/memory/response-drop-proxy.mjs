import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";

const listenPort = 18_960;
const upstreamPort = 18_961;
let droppedAdd = false;

/**
 * 专用真实故障代理：第一次add完整到达真实memmy且后端响应结束后，才销毁客户端连接。
 * 只记录方法、路径、状态与请求Hash；绝不记录正文、Header或秘密。
 */
const server = createServer((incoming, outgoing) => {
  const hash = createHash("sha256");
  incoming.on("data", (chunk) => hash.update(chunk));
  const dropThisResponse =
    !droppedAdd &&
    incoming.method === "POST" &&
    new URL(incoming.url ?? "/", "http://127.0.0.1").pathname === "/api/v1/memory/add";
  if (dropThisResponse) droppedAdd = true;

  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: upstreamPort,
      method: incoming.method,
      path: incoming.url,
      headers: {
        ...incoming.headers,
        host: `127.0.0.1:${String(upstreamPort)}`,
      },
    },
    (response) => {
      if (dropThisResponse) {
        response.resume();
        response.once("end", () => {
          console.error(
            `[response-drop] method=POST path=/api/v1/memory/add upstream=${String(response.statusCode ?? 0)} requestSha256=${hash.digest("hex")} action=destroy_response`,
          );
          outgoing.destroy();
        });
        return;
      }
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.once("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
});

server.listen(listenPort, "127.0.0.1", () => {
  console.log(
    `[response-drop] listening=127.0.0.1:${String(listenPort)} upstream=${String(upstreamPort)}`,
  );
});

function stop() {
  server.close(() => process.exit(0));
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
