import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import test from "node:test";
import { BridgeRequestError } from "../src/bridge-service.ts";
import { ChatProductApiError } from "../src/chat-client.ts";
import {
  assertSameOriginRequest,
  createLifeosRouteHandler,
  createServiceWorkerRetirementHandler,
} from "../src/http-route.ts";
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

async function getRetirementWorker(): Promise<{
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}> {
  const server = createServer(createServiceWorkerRetirementHandler(43_110));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    return await new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/sw.js",
          method: "GET",
          headers: {
            host: "127.0.0.1:43110",
            origin: "http://127.0.0.1:43110",
            "sec-fetch-site": "same-origin",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.on("error", reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

test("/sw.js retires only this origin's legacy PWA worker without caching", async () => {
  const response = await getRetirementWorker();
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/javascript; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["service-worker-allowed"], "/");
  assert.match(response.body, /skipWaiting/);
  assert.match(response.body, /caches\.keys/);
  assert.match(response.body, /clients\.claim/);
  assert.match(response.body, /registration\.unregister/);
  assert.match(response.body, /client\.navigate\(client\.url\)/);
  assert.doesNotMatch(response.body, /indexedDB|localStorage|sessionStorage|cookie/);
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
