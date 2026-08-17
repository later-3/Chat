import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import test from "node:test";
import { BridgeRequestError } from "../src/bridge-service.ts";
import { ChatProductApiError } from "../src/chat-client.ts";
import { assertSameOriginRequest, createLifeosRouteHandler } from "../src/http-route.ts";
import type { LifeosBridgeService } from "../src/bridge-service.ts";

function request(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

function expectRejected(headers: IncomingMessage["headers"], status: number, code: string): void {
  assert.throws(
    () => assertSameOriginRequest(request(headers), 43_110),
    (error) =>
      error instanceof BridgeRequestError && error.status === status && error.code === code,
  );
}

test("same-origin guard accepts only loopback on the exact managed port", () => {
  assert.equal(
    assertSameOriginRequest(
      request({
        host: "127.0.0.1:43110",
        origin: "http://127.0.0.1:43110",
        "sec-fetch-site": "same-origin",
      }),
      43_110,
    ),
    "127.0.0.1:43110",
  );
  assert.equal(
    assertSameOriginRequest(request({ host: "[::1]:43110", "sec-fetch-site": "none" }), 43_110),
    "[::1]:43110",
  );
  expectRejected(
    { host: "localhost:43111", origin: "http://localhost:43111" },
    403,
    "lifeos_host_forbidden",
  );
  expectRejected({}, 400, "lifeos_host_required");
  expectRejected(
    { host: "localhost:43110", "sec-fetch-site": "cross-site" },
    403,
    "lifeos_cross_site_forbidden",
  );
  expectRejected(
    { host: "localhost:43110", origin: "http://127.0.0.1:43110" },
    403,
    "lifeos_origin_forbidden",
  );
  expectRejected(
    { host: "localhost:43110", origin: "http://localhost:43110/forged" },
    403,
    "lifeos_origin_forbidden",
  );
});

test("public hostname is accepted only in server mode with https Origin", () => {
  assert.equal(
    assertSameOriginRequest(
      request({
        host: "chat.ai4child.asia",
        origin: "https://chat.ai4child.asia",
        "sec-fetch-site": "same-origin",
      }),
      43_110,
      "chat.ai4child.asia",
    ),
    "chat.ai4child.asia",
  );
  // 未配置公开主机名时同样的请求必须被拒绝（本地开发姿态不变）。
  expectRejected(
    { host: "chat.ai4child.asia", origin: "https://chat.ai4child.asia" },
    403,
    "lifeos_host_forbidden",
  );
  // 公网入口不接受 http Origin 或伪造端口。
  assert.throws(
    () =>
      assertSameOriginRequest(
        request({ host: "chat.ai4child.asia", origin: "http://chat.ai4child.asia" }),
        43_110,
        "chat.ai4child.asia",
      ),
    (error) =>
      error instanceof BridgeRequestError &&
      error.status === 403 &&
      error.code === "lifeos_origin_forbidden",
  );
  assert.throws(
    () =>
      assertSameOriginRequest(
        request({ host: "chat.ai4child.asia:43110" }),
        43_110,
        "chat.ai4child.asia",
      ),
    (error) =>
      error instanceof BridgeRequestError &&
      error.status === 403 &&
      error.code === "lifeos_host_forbidden",
  );
});

test("a known Chat 4xx is returned as a safe same-origin Problem instead of a false 502", async () => {
  let unexpectedReports = 0;
  const service = {
    projection: async () => {
      throw new ChatProductApiError(
        409,
        "revision_conflict",
        false,
        "refresh_run",
        "Run revision changed",
      );
    },
  } as unknown as LifeosBridgeService;
  const server = createServer(
    createLifeosRouteHandler(service, 43_110, () => {
      unexpectedReports += 1;
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/lifeos/sessions/dsh-session-1",
            method: "GET",
            headers: {
              host: "localhost:43110",
              origin: "http://localhost:43110",
              "sec-fetch-site": "same-origin",
            },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("end", () =>
              resolve({
                status: incoming.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        request.on("error", reject);
        request.end();
      },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(response.body), {
      type: "about:blank",
      title: "Run revision changed",
      status: 409,
      code: "revision_conflict",
      retryable: false,
      recoveryAction: "refresh_run",
    });
    assert.equal(unexpectedReports, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});
