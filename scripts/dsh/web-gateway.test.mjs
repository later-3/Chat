import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertPublicWorkbenchRequest,
  isWorkbenchPath,
  rewriteWorkbenchPath,
  startWebGateway,
} from "./web-gateway.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      resolve(address.port);
    });
  });
}

function listenSocket(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.once("error", reject);
    request.end();
  });
}

test("Workbench路径只剥离受管前缀并保留query", () => {
  assert.equal(isWorkbenchPath("/workbench/code"), true);
  assert.equal(isWorkbenchPath("/workbench/code/stable-a?token=1"), true);
  assert.equal(isWorkbenchPath("/workbench/code-forged"), false);
  assert.equal(rewriteWorkbenchPath("/workbench/code"), "/");
  assert.equal(rewriteWorkbenchPath("/workbench/code/stable-a?token=1"), "/stable-a?token=1");
});

test("Workbench虚拟Host拒绝127主源、跨站与伪造Origin", () => {
  const req = (value) => ("headers" in value ? value : { headers: value });
  assert.doesNotThrow(() =>
    assertPublicWorkbenchRequest(
      req({
        host: "localhost:43110",
        origin: "http://localhost:43110",
        "sec-fetch-site": "same-origin",
      }),
    ),
  );
  assert.doesNotThrow(() =>
    assertPublicWorkbenchRequest(
      req({
        method: "GET",
        url: "/workbench/code/",
        headers: {
          host: "localhost:43110",
          referer: "http://127.0.0.1:43110/session/current?view=chat",
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "iframe",
        },
      }),
    ),
  );
  assert.throws(() => assertPublicWorkbenchRequest(req({ host: "127.0.0.1:43110" })), /localhost/u);
  assert.throws(
    () =>
      assertPublicWorkbenchRequest(
        req({ host: "localhost:43110", origin: "http://127.0.0.1:43110" }),
      ),
    /Origin/u,
  );
  assert.throws(
    () =>
      assertPublicWorkbenchRequest(
        req({ host: "localhost:43110", "sec-fetch-site": "cross-site" }),
      ),
    /Cross-site/u,
  );
  for (const forged of [
    {
      method: "GET",
      url: "/workbench/code/stable-forged",
      headers: {
        host: "localhost:43110",
        referer: "http://127.0.0.1:43110/",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "iframe",
      },
    },
    {
      method: "POST",
      url: "/workbench/code/",
      headers: {
        host: "localhost:43110",
        referer: "http://127.0.0.1:43110/",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "iframe",
      },
    },
    {
      method: "GET",
      url: "/workbench/code/",
      headers: {
        host: "localhost:43110",
        origin: "https://attacker.invalid",
        referer: "http://127.0.0.1:43110/",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "iframe",
      },
    },
    {
      method: "GET",
      url: "/workbench/code/",
      headers: {
        host: "localhost:43110",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "iframe",
      },
    },
    {
      method: "GET",
      url: "/workbench/code/",
      headers: {
        host: "localhost:43110",
        referer: "https://attacker.invalid/",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "iframe",
      },
    },
  ]) {
    assert.throws(() => assertPublicWorkbenchRequest(forged), /Cross-site/u);
  }
});

test("Gateway隔离DSH与Workbench虚拟Host并代理HTTP和任意upgrade路径", async () => {
  const dsh = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin }));
  });
  const workbench = createServer((req, res) => {
    res.setHeader(
      "content-type",
      req.url?.startsWith("/document.html") ? "text/html; charset=utf-8" : "application/json",
    );
    res.setHeader("service-worker-allowed", "/");
    if (req.url?.startsWith("/document.html")) {
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; frame-ancestors *; img-src 'self'",
      );
    }
    res.end(
      JSON.stringify({
        url: req.url,
        host: req.headers.host,
        origin: req.headers.origin,
        referer: req.headers.referer,
      }),
    );
  });
  workbench.on("upgrade", (req, socket) => {
    socket.end(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Upstream-Path: ${req.url}\r\nX-Upstream-Host: ${req.headers.host}\r\nX-Upstream-Origin: ${req.headers.origin}\r\n\r\n`,
    );
  });
  const dshPort = await listen(dsh);
  const socketRoot = mkdtempSync(join(tmpdir(), "chat-gateway-test-"));
  const workbenchSocket = join(socketRoot, "workbench.sock");
  await listenSocket(workbench, workbenchSocket);
  const gateway = await startWebGateway({
    publicPort: 0,
    targets: {
      dsh: { host: "127.0.0.1", port: dshPort },
      workbench: { socketPath: workbenchSocket },
    },
  });
  try {
    const main = await get(gateway.port, "/lifeos/sessions/one", {
      host: "127.0.0.1:43110",
      origin: "http://127.0.0.1:43110",
    });
    assert.equal(main.status, 200);
    assert.deepEqual(JSON.parse(main.body), {
      url: "/lifeos/sessions/one",
      host: "127.0.0.1:43110",
      origin: "http://127.0.0.1:43110",
    });

    const redirect = await get(gateway.port, "/workbench/code/?folder=%2Frepo", {
      host: "127.0.0.1:43110",
    });
    assert.equal(redirect.status, 302);
    assert.equal(
      redirect.headers.location,
      "http://localhost:43110/workbench/code/?folder=%2Frepo",
    );

    const isolated = await get(gateway.port, "/workbench/code/_static/sw.js", {
      host: "localhost:43110",
      origin: "http://localhost:43110",
      "sec-fetch-site": "same-origin",
      referer: "not a valid URL",
    });
    assert.equal(isolated.status, 200);
    assert.equal(isolated.headers["service-worker-allowed"], "/workbench/code/");
    assert.deepEqual(JSON.parse(isolated.body), {
      url: "/_static/sw.js",
      host: "localhost",
      origin: "http://localhost",
    });

    const outsideReferer = await get(gateway.port, "/workbench/code/", {
      host: "localhost:43110",
      referer: "http://localhost:43110/lifeos/sessions/private",
    });
    assert.equal(outsideReferer.status, 200);
    assert.equal(JSON.parse(outsideReferer.body).referer, undefined);

    const framed = await get(gateway.port, "/workbench/code/document.html", {
      host: "localhost:43110",
      origin: "http://localhost:43110",
      "sec-fetch-site": "same-origin",
    });
    assert.equal(
      framed.headers["content-security-policy"],
      "default-src 'self'; img-src 'self'; frame-ancestors http://127.0.0.1:43110",
    );

    const forbidden = await get(gateway.port, "/lifeos/sessions/one", {
      host: "localhost:43110",
    });
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.body, /reserved for Code Workbench/u);

    const upgradeResponse = await new Promise((resolve, reject) => {
      const socket = connect(gateway.port, "127.0.0.1");
      let data = "";
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.once("end", () => resolve(data));
      socket.once("connect", () => {
        socket.write(
          [
            "GET /workbench/code/stable-any-commit?reconnectionToken=one HTTP/1.1",
            "Host: localhost:43110",
            "Origin: http://localhost:43110",
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "",
            "",
          ].join("\r\n"),
        );
      });
    });
    assert.match(upgradeResponse, /^HTTP\/1\.1 101/u);
    assert.match(upgradeResponse, /X-Upstream-Path: \/stable-any-commit\?reconnectionToken=one/iu);
    assert.match(upgradeResponse, /X-Upstream-Host: localhost/iu);
    assert.match(upgradeResponse, /X-Upstream-Origin: http:\/\/localhost/iu);
  } finally {
    await gateway.close();
    await Promise.all([close(dsh), close(workbench)]);
    rmSync(socketRoot, { recursive: true, force: true });
  }
});
