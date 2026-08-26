import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import type { LifeosBridgeService } from "../src/bridge-service.ts";
import { createLifeosRouteHandler } from "../src/http-route.ts";
import type { MemoryManagementBridgeService } from "../src/memory-management-bridge-service.ts";

const SHA = "a".repeat(64);

async function start(service: MemoryManagementBridgeService) {
  const server = createServer(
    createLifeosRouteHandler(
      {} as LifeosBridgeService,
      43_110,
      () => undefined,
      undefined,
      undefined,
      undefined,
      service,
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return { server, port: address.port };
}

async function call(
  port: number,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<{ status: number | undefined; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          host: "localhost:43110",
          origin: "http://localhost:43110",
          "sec-fetch-site": "same-origin",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: incoming.statusCode,
            body: text === "" ? undefined : JSON.parse(text),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("Memory管理面只暴露严格的同源窄路由，并逐一转交给Bridge service", async () => {
  const calls: unknown[] = [];
  const memory = {
    candidates: async (query: unknown) => {
      calls.push({ route: "candidates", query });
      return { candidates: [] };
    },
    candidate: async (candidateId: string) => {
      calls.push({ route: "candidate", candidateId });
      return { candidate: {} };
    },
    decide: async (candidateId: string, request: unknown) => {
      calls.push({ route: "decision", candidateId, request });
      return { candidate: {}, decision: {} };
    },
    providers: async () => {
      calls.push({ route: "providers" });
      return { providers: [] };
    },
    compare: async (request: unknown) => {
      calls.push({ route: "comparison", request });
      return { comparison: {} };
    },
    sources: async (kind: string, limit?: number) => {
      calls.push({ route: "sources", kind, limit });
      return { sources: [] };
    },
    previewImport: async (request: unknown) => {
      calls.push({ route: "previewImport", request });
      return { preview: {} };
    },
    createImport: async (request: unknown) => {
      calls.push({ route: "createImport", request });
      return { memorySessionImport: {} };
    },
    imports: async (limit?: number) => {
      calls.push({ route: "imports", limit });
      return { memorySessionImports: [] };
    },
  } as unknown as MemoryManagementBridgeService;
  const { server, port } = await start(memory);
  const source = { kind: "chat", productSessionId: "psn_1" };
  try {
    assert.equal(
      (await call(port, "/lifeos/memory/write-candidates?status=pending_review&limit=20", "GET"))
        .status,
      200,
    );
    assert.equal((await call(port, "/lifeos/memory/write-candidates/mwc_1", "GET")).status, 200);
    assert.equal(
      (
        await call(port, "/lifeos/memory/write-candidates/mwc_1/decisions", "POST", {
          commandId: "cmd_1",
          payload: {
            kind: "approve",
            expectedCandidateRevision: 1,
            expectedCandidateSha256: SHA,
          },
        })
      ).status,
      201,
    );
    assert.equal((await call(port, "/lifeos/memory/providers", "GET")).status, 200);
    assert.equal(
      (
        await call(port, "/lifeos/memory/provider-comparison-previews", "POST", {
          source,
          query: "发布前需要完成什么？",
          providerIds: ["mbk_1", "mbk_2"],
        })
      ).status,
      200,
    );
    assert.equal(
      (await call(port, "/lifeos/memory/session-sources?kind=chat&limit=20", "GET")).status,
      200,
    );
    assert.equal(
      (
        await call(port, "/lifeos/memory/session-import-previews", "POST", {
          source,
          providerId: "mbk_1",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(port, "/lifeos/memory/session-imports", "POST", {
          commandId: "cmd_2",
          payload: {
            source,
            providerId: "mbk_1",
            sourceSnapshotSha256: SHA,
            previewSha256: "b".repeat(64),
          },
        })
      ).status,
      201,
    );
    assert.equal((await call(port, "/lifeos/memory/session-imports?limit=20", "GET")).status, 200);
    const invalid = await call(port, "/lifeos/memory/session-sources?kind=chat&debug=true", "GET");
    assert.equal(invalid.status, 400);
    assert.equal((invalid.body as { code: string }).code, "lifeos_memory_query_invalid");
    const invalidCandidate = await call(
      port,
      "/lifeos/memory/write-candidates/not-a-product-id",
      "GET",
    );
    assert.equal(invalidCandidate.status, 400);
    assert.equal(
      (invalidCandidate.body as { code: string }).code,
      "lifeos_memory_candidate_invalid",
    );
    assert.deepEqual(calls, [
      { route: "candidates", query: { status: "pending_review", limit: 20 } },
      { route: "candidate", candidateId: "mwc_1" },
      {
        route: "decision",
        candidateId: "mwc_1",
        request: {
          commandId: "cmd_1",
          payload: {
            kind: "approve",
            expectedCandidateRevision: 1,
            expectedCandidateSha256: SHA,
          },
        },
      },
      { route: "providers" },
      {
        route: "comparison",
        request: {
          source,
          query: "发布前需要完成什么？",
          providerIds: ["mbk_1", "mbk_2"],
          maxResults: 8,
          maxContextCharacters: 8000,
        },
      },
      { route: "sources", kind: "chat", limit: 20 },
      { route: "previewImport", request: { source, providerId: "mbk_1" } },
      {
        route: "createImport",
        request: {
          commandId: "cmd_2",
          payload: {
            source,
            providerId: "mbk_1",
            sourceSnapshotSha256: SHA,
            previewSha256: "b".repeat(64),
          },
        },
      },
      { route: "imports", limit: 20 },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});
