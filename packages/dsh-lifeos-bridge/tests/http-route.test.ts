import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import test from "node:test";
import { BridgeRequestError } from "../src/bridge-service.ts";
import { ChatProductApiError } from "../src/chat-client.ts";
import { DshSessionHistoryAccessError } from "../src/dsh-session-history.ts";
import {
  assertSameOriginRequest,
  createLifeosRouteHandler,
  parseSessionRecordsChatQuery,
  parseSessionRecordsDshQuery,
} from "../src/http-route.ts";
import type { LifeosBridgeService } from "../src/bridge-service.ts";
import type { PromptSourceFileOpener } from "../src/prompt-source-file-opener.ts";
import type { PromptStudioBridgeService } from "../src/prompt-studio-bridge-service.ts";

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

test("Prompt来源文件只通过同源白名单打开器路由", async () => {
  const calls: unknown[] = [];
  const sourceFiles = {
    openers: () => ({
      schemaVersion: "chat-prompt-source-openers.v1",
      items: [{ id: "vscode", label: "Visual Studio Code" }],
    }),
    open: async (request: unknown) => {
      calls.push(request);
      return {
        schemaVersion: "chat-prompt-source-open.v1",
        status: "launched",
        relativePath: "prompts/regions/catalog.md",
        openerId: "vscode",
      };
    },
  } as unknown as PromptSourceFileOpener;
  const service = {} as LifeosBridgeService;
  const server = createServer(
    createLifeosRouteHandler(service, 43_110, () => undefined, undefined, undefined, sourceFiles),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const call = async (method: "GET" | "POST", path: string, body?: unknown) =>
    await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
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
          incoming.on("end", () =>
            resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    const openers = await call("GET", "/lifeos/prompts/source-openers");
    assert.equal(openers.status, 200);
    assert.match(openers.body, /Visual Studio Code/u);
    const opened = await call("POST", "/lifeos/prompts/source-files/open", {
      relativePath: "prompts/regions/catalog.md",
      openerId: "vscode",
    });
    assert.equal(opened.status, 202);
    assert.deepEqual(calls, [{ relativePath: "prompts/regions/catalog.md", openerId: "vscode" }]);
    assert.equal(
      (
        await call("POST", "/lifeos/prompts/source-files/open", {
          relativePath: "../AGENTS.md",
          openerId: "vscode",
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("session-record queries accept only bounded, non-repeated source cursors", () => {
  assert.deepEqual(
    parseSessionRecordsChatQuery(
      new URL("http://localhost/lifeos/sessions/dsh-1/records/chat?limit=100&cursor=opaque"),
    ),
    { cursor: "opaque", limit: 100 },
  );
  assert.deepEqual(
    parseSessionRecordsDshQuery(
      new URL("http://localhost/lifeos/sessions/dsh-1/records/dsh?afterSeq=0"),
    ),
    { afterSeq: 0, limit: 50 },
  );
  for (const url of [
    "http://localhost/x?limit=0",
    "http://localhost/x?limit=101",
    "http://localhost/x?limit=1&limit=2",
    "http://localhost/x?cursor=",
    "http://localhost/x?unknown=1",
  ]) {
    assert.throws(() => parseSessionRecordsChatQuery(new URL(url)), {
      code: "lifeos_session_records_query_invalid",
    });
  }
  for (const url of [
    "http://localhost/x?afterSeq=-1",
    "http://localhost/x?afterSeq=01",
    "http://localhost/x?afterSeq=9007199254740992",
    "http://localhost/x?afterSeq=1&afterSeq=2",
  ]) {
    assert.throws(() => parseSessionRecordsDshQuery(new URL(url)), {
      code: "lifeos_session_records_query_invalid",
    });
  }
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

test("same-origin context injection route reads the validated DSH session id", async () => {
  const calls: string[] = [];
  const projection = {
    schemaVersion: "chat-dsh-context-injections.v1",
    dshSessionId: "dsh-session-1",
    status: "not_assembled",
    revision: "a".repeat(64),
    chatForwarding: "latest_direct_user_message_and_workspace_instructions",
    items: [],
    totalItems: 0,
    omittedItems: 0,
    totalContentCharacters: 0,
  } as const;
  const service = {
    contextInjections: (sessionId: string) => {
      calls.push(sessionId);
      return projection;
    },
  } as unknown as LifeosBridgeService;
  const server = createServer(createLifeosRouteHandler(service, 43_110));
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
            path: "/lifeos/sessions/dsh-session-1/context-injections",
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
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), projection);
    assert.deepEqual(calls, ["dsh-session-1"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("same-origin Prompt selection and Studio scope routes forward only typed identities", async () => {
  const calls: unknown[] = [];
  const selectionProjection = {
    schemaVersion: "chat-dsh-prompt-selection.v1",
    workspace: { rootId: "root_chat", title: "Chat" },
    promptSelection: {
      schemaVersion: "prompt-turn-selection-input.v1",
      workspaceRootId: "root_chat",
      regions: [],
    },
  } as const;
  const service = {
    promptSelection: async (sessionId: string) => {
      calls.push({ kind: "read-selection", sessionId });
      return selectionProjection;
    },
    selectPrompt: async (sessionId: string, selection: unknown) => {
      calls.push({ kind: "write-selection", sessionId, selection });
      return selectionProjection;
    },
    bridgeSendPreview: async (sessionId: string, text: string) => {
      calls.push({ kind: "bridge-send-preview", sessionId, text });
      return { schemaVersion: "chat-dsh-bridge-send-preview.v1", text };
    },
    setDshSendReviewEnabled: async (sessionId: string, enabled: boolean) => {
      calls.push({ kind: "send-review-setting", sessionId, enabled });
      return { schemaVersion: "chat-dsh-lifeos-bridge.v3", dshSessionId: sessionId };
    },
    decideDshSendReview: async (sessionId: string, request: unknown) => {
      calls.push({ kind: "send-review-decision", sessionId, request });
      return { schemaVersion: "chat-dsh-lifeos-bridge.v3", dshSessionId: sessionId };
    },
  } as unknown as LifeosBridgeService;
  const studio = {
    workspaces: async () => ({
      schemaVersion: "chat-prompt-studio-api.v1",
      items: [{ schemaVersion: "chat-prompt-studio-api.v1", rootId: "root_chat", title: "Chat" }],
    }),
    fragments: async (query: unknown) => {
      calls.push({ kind: "fragments", query });
      return { schemaVersion: "chat-prompt-studio-api.v1", items: [] };
    },
    preview: async (request: unknown) => {
      calls.push({ kind: "preview", request });
      return {
        schemaVersion: "chat-prompt-studio-api.v1",
        profileVersion: "direct-agent-prompt-profile.v1",
        compilerVersion: "direct-agent-prompt-compiler.v1",
        regions: [],
        systemPromptAppend: "",
        userPrompt: "# 当前输入\n测试",
        sha256: "a".repeat(64),
      };
    },
    previewConfiguration: async (request: unknown) => {
      calls.push({ kind: "configuration-preview", request });
      return {
        schemaVersion: "chat-prompt-studio-api.v1",
        profileVersion: "direct-agent-prompt-profile.v1",
        compilerVersion: "direct-agent-prompt-compiler.v1",
        regions: [],
        systemPromptAppend: "",
        messageContext: "",
        sha256: "a".repeat(64),
      };
    },
  } as unknown as PromptStudioBridgeService;
  const server = createServer(
    createLifeosRouteHandler(service, 43_110, () => undefined, undefined, studio),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const call = async (method: "GET" | "POST" | "PUT", path: string, value?: unknown) =>
    await new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          method,
          headers: {
            host: "localhost:43110",
            origin: "http://localhost:43110",
            "sec-fetch-site": "same-origin",
            ...(value === undefined ? {} : { "content-type": "application/json" }),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(value === undefined ? undefined : JSON.stringify(value));
    });
  try {
    assert.equal((await call("GET", "/lifeos/prompts/workspaces")).status, 200);
    assert.equal(
      (await call("GET", "/lifeos/prompts/fragments?scopeKind=workspace&workspaceRootId=root_chat"))
        .status,
      200,
    );
    assert.equal(
      (await call("GET", "/lifeos/sessions/dsh-session-1/prompt-selection")).status,
      200,
    );
    assert.equal(
      (
        await call("PUT", "/lifeos/sessions/dsh-session-1/prompt-selection", {
          promptSelection: selectionProjection.promptSelection,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("POST", "/lifeos/prompts/assembly-previews", {
          text: "测试",
          selection: selectionProjection.promptSelection,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("POST", "/lifeos/prompts/configuration-previews", {
          selection: selectionProjection.promptSelection,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("POST", "/lifeos/sessions/dsh-session-1/bridge-send-previews", {
          text: "测试Bridge边界",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("PUT", "/lifeos/sessions/dsh-session-1/dsh-send-review-setting", {
          enabled: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("POST", "/lifeos/sessions/dsh-session-1/dsh-send-review-decisions", {
          reviewId: `dsr_${"a".repeat(32)}`,
          kind: "approve",
        })
      ).status,
      200,
    );
    assert.deepEqual(calls, [
      {
        kind: "fragments",
        query: { scopeKind: "workspace", workspaceRootId: "root_chat" },
      },
      { kind: "read-selection", sessionId: "dsh-session-1" },
      {
        kind: "write-selection",
        sessionId: "dsh-session-1",
        selection: selectionProjection.promptSelection,
      },
      {
        kind: "preview",
        request: { text: "测试", selection: selectionProjection.promptSelection },
      },
      {
        kind: "configuration-preview",
        request: { selection: selectionProjection.promptSelection },
      },
      {
        kind: "bridge-send-preview",
        sessionId: "dsh-session-1",
        text: "测试Bridge边界",
      },
      { kind: "send-review-setting", sessionId: "dsh-session-1", enabled: true },
      {
        kind: "send-review-decision",
        sessionId: "dsh-session-1",
        request: { reviewId: `dsr_${"a".repeat(32)}`, kind: "approve" },
      },
    ]);
    assert.doesNotMatch(JSON.stringify(calls), /\/Users\//u);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("same-origin Note decision route validates and forwards the observed candidate binding", async () => {
  const calls: unknown[] = [];
  const projection = {
    schemaVersion: "chat-dsh-lifeos-bridge.v3",
    dshSessionId: "dsh-session-1",
    run: null,
    plan: null,
    approval: null,
    pendingDecision: null,
    noteCandidate: null,
    pendingNoteDecision: null,
    workflowSelection: null,
  } as const;
  const service = {
    decideNote: async (sessionId: string, request: unknown) => {
      calls.push({ sessionId, request });
      return projection;
    },
  } as unknown as LifeosBridgeService;
  const server = createServer(createLifeosRouteHandler(service, 43_110));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const body = {
    kind: "confirm",
    binding: {
      productRunId: "run_note1",
      runRevision: 2,
      noteCandidateId: "ntc_note1",
      candidateRevision: 1,
      candidateSha256: "a".repeat(64),
    },
  };
  try {
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/lifeos/sessions/dsh-session-1/note-decisions",
            method: "POST",
            headers: {
              host: "localhost:43110",
              origin: "http://localhost:43110",
              "sec-fetch-site": "same-origin",
              "content-type": "application/json",
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
        request.end(JSON.stringify(body));
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), projection);
    assert.deepEqual(calls, [{ sessionId: "dsh-session-1", request: body }]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("same-origin session-record routes forward typed pagination without relaxing other routes", async () => {
  const calls: unknown[] = [];
  const service = {
    sessionRecordsChatPage: async (
      sessionId: string,
      cursor: string | undefined,
      limit: number,
    ) => {
      calls.push({ source: "chat", sessionId, cursor, limit });
      return {
        schemaVersion: "chat-dsh-session-records.v1",
        dshSessionId: sessionId,
        productSessionId: null,
        messages: { items: [] },
      };
    },
    sessionRecordsDshPage: async (
      sessionId: string,
      afterSeq: number | undefined,
      limit: number,
    ) => {
      calls.push({ source: "dsh", sessionId, afterSeq, limit });
      return {
        schemaVersion: "chat-dsh-session-records.v1",
        dshSessionId: sessionId,
        header: { version: 0, id: sessionId, createdAt: 1, cwd: "/workspace/chat" },
        items: [],
        hasMore: false,
      };
    },
  } as unknown as LifeosBridgeService;
  const server = createServer(createLifeosRouteHandler(service, 43_110));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const get = async (path: string): Promise<number | undefined> =>
    await new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          method: "GET",
          headers: {
            host: "localhost:43110",
            origin: "http://localhost:43110",
            "sec-fetch-site": "same-origin",
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.on("end", () => resolve(incoming.statusCode));
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  try {
    assert.equal(
      await get("/lifeos/sessions/dsh-session-1/records/chat?cursor=opaque&limit=25"),
      200,
    );
    assert.equal(await get("/lifeos/sessions/dsh-session-1/records/dsh?afterSeq=9&limit=10"), 200);
    assert.equal(await get("/lifeos/sessions/dsh-session-1?limit=1"), 400);
    assert.deepEqual(calls, [
      { source: "chat", sessionId: "dsh-session-1", cursor: "opaque", limit: 25 },
      { source: "dsh", sessionId: "dsh-session-1", afterSeq: 9, limit: 10 },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("DSH history authorization failures remain explicit safe Problems", async () => {
  const service = {
    sessionRecordsOverview: async () => {
      throw new DshSessionHistoryAccessError(
        403,
        "lifeos_dsh_session_forbidden",
        "DSH Session不属于Chat Workspace",
      );
    },
  } as unknown as LifeosBridgeService;
  const server = createServer(createLifeosRouteHandler(service, 43_110));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const outgoing = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/lifeos/sessions/dsh-session-1/records",
            method: "GET",
            headers: { host: "localhost:43110" },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("end", () =>
              resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body), {
      type: "about:blank",
      title: "DSH Session不属于Chat Workspace",
      status: 403,
      code: "lifeos_dsh_session_forbidden",
      retryable: false,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});
