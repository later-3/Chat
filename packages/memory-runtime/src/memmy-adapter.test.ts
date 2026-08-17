import {
  MemoryBackendError,
  MemoryImportBackendError,
  type MemoryImportInput,
  type MemoryQueryInput,
} from "@chat/application";
import {
  memoryImportIntentIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
} from "@chat/contracts";
import { computeMemoryImportRequestSha256 } from "@chat/domain";
import { describe, expect, it } from "vitest";
import { MEMMY_BACKEND_ID, MemmyMemoryAdapter, type MemmyAdapterOptions } from "./memmy-adapter.js";
import { createEmptyMemoryBackendRegistry, createMemoryBackendRegistry } from "./registry.js";

const TEST_TIME = "2026-08-08T00:00:00.000Z";

describe("Memory runtime activation", () => {
  it("provides an empty Registry without instantiating external adapters", () => {
    expect(createEmptyMemoryBackendRegistry().list()).toEqual([]);
  });
});

function queryInput(overrides: Partial<MemoryQueryInput> = {}): MemoryQueryInput {
  return {
    operationId: "mqy_memmytest",
    productRunId: productRunIdSchema.parse("run_memmytest"),
    productSessionId: productSessionIdSchema.parse("psn_memmytest"),
    query: "Which historical fact applies?",
    tags: ["project", "planning"],
    layers: ["L2"],
    limit: 3,
    contextBudget: 512,
    ...overrides,
  };
}

function healthBody(tools: string[] = ["memory.search"]): Record<string, unknown> {
  const model = {
    provider: "local_only",
    model: "",
    configured: false,
    remote: false,
  };
  return {
    ok: true,
    version: "1.0.4",
    uptimeMs: 42,
    mode: "local",
    activeProfile: "byok",
    storage: {
      backend: "sqlite",
      backendId: "sqlite-local",
      schemaVersion: "24",
      ready: true,
      fullText: "fts5",
      vector: "native",
      changeLog: true,
      idempotency: true,
      jobs: true,
      importExport: true,
    },
    models: {
      summary: model,
      evolution: model,
      embedding: {
        ...model,
        provider: "local",
        model: "Xenova/all-MiniLM-L6-v2",
        configured: true,
      },
    },
    capabilities: {
      routes: ["GET /api/v1/health", "POST /api/v1/memory/search"],
      tools,
      memoryLayers: ["L1", "L2", "L3", "Skill"],
      supportsCli: true,
    },
    serverTime: TEST_TIME,
  };
}

function hit(input: {
  id: string;
  title: string;
  tags: string[];
  score: number;
  updatedAt?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    kind: "policy",
    memoryLayer: "L2",
    status: "activated",
    title: input.title,
    snippet: `${input.title} snippet`,
    score: input.score,
    tags: input.tags,
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    source: "search",
  };
}

function verboseSearchBody(): Record<string, unknown> {
  return {
    injectedContext: "<memmy_memory_context>adopted context</memmy_memory_context>",
    debug: {
      searchEventId: "recall_query_1",
      hits: [
        hit({
          id: "memory_1",
          title: "First",
          tags: ["alpha", "shared"],
          score: 0.8,
          updatedAt: TEST_TIME,
        }),
        hit({ id: "memory_2", title: "Second", tags: ["beta", "shared"], score: 0.7 }),
        hit({ id: "memory_not_adopted", title: "Third", tags: ["gamma"], score: 0.6 }),
      ],
      // 固定服务可能重复列出合成 section 的来源；用户计数必须按来源去重。
      sourceMemoryIds: ["memory_1", "memory_1", "memory_2"],
      status: ["llm_filter:disabled"],
      sections: [
        {
          id: "memory-memory_1",
          title: "Experience",
          kind: "policy",
          memoryLayer: "L2",
          memoryIds: ["memory_1"],
          content: "Use the first historical fact.",
          tokenEstimate: 10,
        },
        {
          id: "memory-memory_2",
          title: "Experience",
          kind: "policy",
          memoryLayer: "L2",
          memoryIds: ["memory_2"],
          content: "Use the second historical fact.",
          tokenEstimate: 10,
        },
      ],
      tokenEstimate: 22,
      serverTime: TEST_TIME,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchStub(
  run: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return run as typeof fetch;
}

function adapter(fetchImpl: typeof fetch, options: Partial<MemmyAdapterOptions> = {}) {
  return new MemmyMemoryAdapter({
    baseUrl: "http://127.0.0.1:18960",
    fetchImpl,
    ...options,
  });
}

function importInput(overrides: Partial<MemoryImportInput> = {}): MemoryImportInput {
  const shape = {
    content: "M2 canary：发布前必须完成真实浏览器验收。",
    layer: "L2" as const,
    title: "M2 验收规则",
    tags: ["m2", "release"],
    turnId: "msg_importtest",
  };
  return {
    operationId: memoryImportIntentIdSchema.parse("mii_importtest"),
    requestSha256: computeMemoryImportRequestSha256(shape),
    ...shape,
    source: "chat.explicit_import",
    sessionId: productSessionIdSchema.parse("psn_importtest"),
    ...overrides,
  };
}

function addBody(): Record<string, unknown> {
  return {
    id: "memory_import_1",
    kind: "policy",
    memoryLayer: "L2",
    status: "activated",
    title: "M2 验收规则",
    summary: "M2 canary",
    tags: ["manual", "m2", "release"],
    createdAt: TEST_TIME,
    serverTime: TEST_TIME,
  };
}

function detailBody(): Record<string, unknown> {
  const detail = {
    id: "memory_import_1",
    kind: "policy",
    memoryLayer: "L2",
    status: "activated",
    title: "M2 验收规则",
    summary: "M2 canary",
    tags: ["manual", "m2", "release"],
    metadata: {},
    createdAt: TEST_TIME,
    updatedAt: TEST_TIME,
    version: 1,
    body: "M2 canary：发布前必须完成真实浏览器验收。",
    sourceMemoryIds: [],
    policy: { evidenceMemoryIds: [], repairHints: [] },
  };
  return { ...detail, item: { ...detail, refs: {} }, refs: {}, etag: "etag-import-1" };
}

function importSearchBody(): Record<string, unknown> {
  return {
    injectedContext: "<memmy_memory_context>M2 canary</memmy_memory_context>",
    debug: {
      searchEventId: "search_import_1",
      hits: [
        hit({
          id: "memory_import_1",
          title: "M2 验收规则",
          tags: ["manual", "m2", "release"],
          score: 1,
        }),
      ],
      sourceMemoryIds: ["memory_import_1"],
      status: ["ok"],
      sections: [
        {
          id: "memory-memory_import_1",
          title: "M2 验收规则",
          kind: "policy",
          memoryLayer: "L2",
          memoryIds: ["memory_import_1"],
          content: "M2 canary：发布前必须完成真实浏览器验收。",
          tokenEstimate: 20,
        },
      ],
      tokenEstimate: 20,
      serverTime: TEST_TIME,
    },
  };
}

async function backendError(promise: Promise<unknown>): Promise<MemoryBackendError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryBackendError);
    return error as MemoryBackendError;
  }
  throw new Error("expected MemoryBackendError");
}

async function importError(promise: Promise<unknown>): Promise<MemoryImportBackendError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryImportBackendError);
    return error as MemoryImportBackendError;
  }
  throw new Error("expected MemoryImportBackendError");
}

describe("MemmyMemoryAdapter", () => {
  it("按固定合同发送L2 add，requestId使用稳定Intent身份且响应严格归一化", async () => {
    let captured: unknown;
    const memory = adapter(
      fetchStub(async (input, init) => {
        expect(String(input)).toBe("http://127.0.0.1:18960/api/v1/memory/add");
        captured = JSON.parse(String(init?.body));
        return jsonResponse(addBody());
      }),
    );
    const result = await memory.import(importInput());
    expect(captured).toEqual({
      requestId: "mii_importtest",
      adapterId: "chat",
      namespace: { source: "chat", profileId: "chat-debug", sessionKey: "psn_importtest" },
      content: "M2 canary：发布前必须完成真实浏览器验收。",
      layer: "L2",
      title: "M2 验收规则",
      tags: ["m2", "release"],
      turnId: "msg_importtest",
      deferProcessing: false,
    });
    expect(result).toMatchObject({
      externalObjectId: "memory_import_1",
      externalStatus: "activated",
    });
    expect(result.responseSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("严格区分请求前失败、明确拒绝与请求发出后结果未知", async () => {
    const invalidHash = await importError(
      adapter(fetchStub(async () => jsonResponse(addBody()))).import(
        importInput({ requestSha256: "a".repeat(64) }),
      ),
    );
    expect(invalidHash).toMatchObject({
      code: "memory.import.request_hash_mismatch",
      phase: "before_external_call",
    });

    const protocolContent = "<memmy_memory_context>不能静默删除</memmy_memory_context>";
    const protocolShape = {
      content: protocolContent,
      layer: "L2" as const,
      title: "协议块",
      tags: [],
      turnId: "msg_protocol",
    };
    const normalized = await importError(
      adapter(fetchStub(async () => jsonResponse(addBody()))).import(
        importInput({
          ...protocolShape,
          requestSha256: computeMemoryImportRequestSha256(protocolShape),
        }),
      ),
    );
    expect(normalized).toMatchObject({
      code: "memory.import.content_requires_normalization",
      phase: "before_external_call",
    });

    const conflict = await importError(
      adapter(fetchStub(async () => jsonResponse({}, 409))).import(importInput()),
    );
    expect(conflict).toMatchObject({
      code: "memory.import.idempotency_conflict",
      phase: "rejected_before_write",
    });

    const disconnected = await importError(
      adapter(fetchStub(async () => Promise.reject(new Error("secret upstream detail")))).import(
        importInput(),
      ),
    );
    expect(disconnected).toMatchObject({
      code: "memory.import.connection_lost",
      phase: "write_outcome_unknown",
    });
    expect(disconnected.message).not.toContain("secret upstream detail");

    const invalidSuccess = await importError(
      adapter(fetchStub(async () => new Response("{broken", { status: 200 }))).import(
        importInput(),
      ),
    );
    expect(invalidSuccess).toMatchObject({
      code: "memory.import.response_invalid",
      phase: "write_outcome_unknown",
    });
  });

  it("使用已知外部ID执行GET+Search双重验证后才返回materialized", async () => {
    const calls: string[] = [];
    const memory = adapter(
      fetchStub(async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/api/v1/memory/memory_import_1")) return jsonResponse(detailBody());
        if (url.endsWith("/api/v1/memory/search")) return jsonResponse(importSearchBody());
        throw new Error("unexpected URL");
      }),
    );
    const result = await memory.reconcile({
      ...importInput(),
      externalObjectId: "memory_import_1",
    });
    expect(result).toMatchObject({
      status: "materialized",
      accepted: { externalObjectId: "memory_import_1", externalObjectVersion: "1" },
    });
    expect(calls).toEqual([
      "http://127.0.0.1:18960/api/v1/memory/memory_import_1",
      "http://127.0.0.1:18960/api/v1/memory/search",
    ]);
  });

  it("结果未知且没有外部ID时只用相同requestId做一次memmy原生幂等对账", async () => {
    const requestIds: string[] = [];
    const memory = adapter(
      fetchStub(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/v1/memory/add")) {
          requestIds.push((JSON.parse(String(init?.body)) as { requestId: string }).requestId);
          return jsonResponse({ ...addBody(), duplicate: true });
        }
        if (url.endsWith("/api/v1/memory/memory_import_1")) return jsonResponse(detailBody());
        if (url.endsWith("/api/v1/memory/search")) return jsonResponse(importSearchBody());
        throw new Error("unexpected URL");
      }),
    );
    await expect(memory.reconcile(importInput())).resolves.toMatchObject({
      status: "materialized",
    });
    expect(requestIds).toEqual(["mii_importtest"]);
  });
  it("发送固定 verbose query，并用去重 sourceMemoryIds 计算来源数", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const memory = adapter(
      fetchStub(async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return jsonResponse(verboseSearchBody());
      }),
    );

    const result = await memory.query(queryInput());

    expect(capturedUrl).toBe("http://127.0.0.1:18960/api/v1/memory/search");
    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      requestId: "mqy_memmytest",
      adapterId: "chat",
      namespace: {
        source: "chat",
        profileId: "chat-debug",
        sessionKey: "psn_memmytest",
      },
      query: "Which historical fact applies?",
      layers: ["L2"],
      tags: ["project", "planning"],
      limit: 3,
      contextBudget: 512,
      includeInjectedContext: true,
      verbose: true,
    });
    expect(result).toMatchObject({
      externalQueryId: "recall_query_1",
      hitCount: 2,
      tokenEstimate: 22,
      sections: [
        {
          externalObjectIds: ["memory_1"],
          tags: ["alpha", "shared"],
          score: 0.8,
          tokenEstimate: 11,
          sourceUpdatedAt: TEST_TIME,
        },
        {
          externalObjectIds: ["memory_2"],
          tags: ["beta", "shared"],
          score: 0.7,
          tokenEstimate: 11,
        },
      ],
    });
  });

  it.each([
    [401, "memory.backend.unauthorized", false],
    [403, "memory.backend.forbidden", false],
    [429, "memory.backend.rate_limited", true],
    [503, "memory.backend.unavailable", true],
  ] as const)("把 HTTP %i 映射为稳定错误", async (status, code, retryable) => {
    const memory = adapter(
      fetchStub(async () => jsonResponse({ error: { message: "private upstream body" } }, status)),
    );
    const error = await backendError(memory.query(queryInput()));
    expect(error).toMatchObject({ code, retryable });
    expect(error.message).not.toContain("private upstream body");
  });

  it("把 Abort/Timeout 映射为可重试超时且不传播底层错误", async () => {
    const timeout = new Error("private timeout diagnostics");
    timeout.name = "TimeoutError";
    const memory = adapter(fetchStub(async () => Promise.reject(timeout)));
    const error = await backendError(memory.query(queryInput()));
    expect(error).toMatchObject({ code: "memory.backend.timeout", retryable: true });
    expect(error.message).not.toContain("private timeout diagnostics");
  });

  it("拒绝坏 JSON", async () => {
    const memory = adapter(fetchStub(async () => new Response("{broken", { status: 200 })));
    await expect(memory.query(queryInput())).rejects.toMatchObject({
      code: "memory.backend.contract_invalid",
      retryable: false,
    });
  });

  it("在JSON解析前拒绝Content-Length或流式正文超过字节上限", async () => {
    const announced = adapter(
      fetchStub(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-length": "2000000" },
          }),
      ),
    );
    await expect(announced.query(queryInput())).rejects.toMatchObject({
      code: "memory.backend.contract_invalid",
    });

    const streamed = adapter(
      fetchStub(async () => new Response("x".repeat(1_500_001), { status: 200 })),
    );
    const error = await importError(streamed.import(importInput()));
    expect(error).toMatchObject({
      code: "memory.import.response_invalid",
      phase: "write_outcome_unknown",
    });
  });

  it("拒绝固定合同外的多余响应字段", async () => {
    const body = { ...verboseSearchBody(), unexpected: "must fail closed" };
    const memory = adapter(fetchStub(async () => jsonResponse(body)));
    await expect(memory.query(queryInput())).rejects.toMatchObject({
      code: "memory.backend.contract_invalid",
      retryable: false,
    });
  });

  it("不信任 memmy 低报的 tokenEstimate，按正文重新计算超预算", async () => {
    const body = verboseSearchBody();
    const debug = body["debug"] as Record<string, unknown>;
    debug["sourceMemoryIds"] = ["memory_1"];
    debug["hits"] = [hit({ id: "memory_1", title: "First", tags: ["alpha"], score: 0.8 })];
    debug["sections"] = [
      {
        id: "memory-memory_1",
        title: "Experience",
        kind: "policy",
        memoryLayer: "L2",
        memoryIds: ["memory_1"],
        content: "x".repeat(600),
        tokenEstimate: 1,
      },
    ];
    debug["tokenEstimate"] = 1;
    const memory = adapter(fetchStub(async () => jsonResponse(body)));
    await expect(memory.query(queryInput({ contextBudget: 128 }))).rejects.toMatchObject({
      code: "memory.response.over_budget",
      retryable: false,
    });
  });

  it("health 只有在 strict 合同、storage ready 且具备 memory.search 时才 ready", async () => {
    const ready = adapter(fetchStub(async () => jsonResponse(healthBody())));
    await expect(ready.health()).resolves.toEqual({ status: "ready" });

    const missingCapability = adapter(
      fetchStub(async () => jsonResponse(healthBody(["memory.add"]))),
    );
    await expect(missingCapability.health()).resolves.toEqual({
      status: "unavailable",
      errorCode: "memory.backend.capability_missing",
    });

    const extra = { ...healthBody(), endpoint: "must not be accepted" };
    const invalid = adapter(fetchStub(async () => jsonResponse(extra)));
    await expect(invalid.health()).resolves.toEqual({
      status: "unavailable",
      errorCode: "memory.backend.contract_invalid",
    });

    let authorization: string | null = null;
    const protectedHealth = adapter(
      fetchStub(async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return jsonResponse(healthBody());
      }),
      { token: "health-private-token", credentialRevision: "health-key-1" },
    );
    await expect(protectedHealth.health()).resolves.toEqual({ status: "ready" });
    expect(authorization).toBe("Bearer health-private-token");
  });

  it("从服务端配置规范化 URL/Token，但 profile、错误和异常不泄漏私密值", async () => {
    const privateToken = "private-token-never-expose";
    const privateEndpointMarker = "private-endpoint-marker";
    let capturedUrl = "";
    let capturedAuthorization: string | undefined;
    const registry = createMemoryBackendRegistry(
      {
        CHAT_MEMMY_BASE_URL: "http://127.0.0.1:18960///",
        CHAT_MEMMY_TOKEN: `  ${privateToken}  `,
        CHAT_MEMMY_CREDENTIAL_REVISION: "memmy-key-2026-08",
      },
      {
        memmy: {
          fetchImpl: fetchStub(async (input, init) => {
            capturedUrl = String(input);
            capturedAuthorization = new Headers(init?.headers).get("authorization") ?? undefined;
            return jsonResponse(verboseSearchBody());
          }),
        },
      },
    );
    const configured = registry.get(MEMMY_BACKEND_ID);
    expect(configured).toBeDefined();
    await configured!.query(queryInput());
    expect(capturedUrl).toBe("http://127.0.0.1:18960/api/v1/memory/search");
    expect(capturedAuthorization).toBe(`Bearer ${privateToken}`);
    expect(configured!.describe()).toMatchObject({
      authMode: "bearer",
      credentialRevision: "memmy-key-2026-08",
    });
    expect(JSON.stringify(configured!.describe())).not.toContain(privateToken);
    expect(JSON.stringify(configured!.describe())).not.toContain("127.0.0.1");

    let configError: unknown;
    try {
      new MemmyMemoryAdapter({
        baseUrl: `http://user:${privateEndpointMarker}@127.0.0.1:18960`,
      });
    } catch (error) {
      configError = error;
    }
    expect(configError).toBeInstanceOf(MemoryBackendError);
    expect(String(configError)).not.toContain(privateEndpointMarker);
    expect(String(configError)).not.toContain(privateToken);
  });

  it("Bearer Token缺少显式非秘密凭据版本时失败关闭，且指纹能发现认证配置漂移", () => {
    const missingRevisionToken = "private-token-never-expose";
    let missingRevisionError: unknown;
    try {
      createMemoryBackendRegistry({
        CHAT_MEMMY_BASE_URL: "http://127.0.0.1:18960",
        CHAT_MEMMY_TOKEN: missingRevisionToken,
      });
    } catch (error) {
      missingRevisionError = error;
    }
    expect(missingRevisionError).toBeInstanceOf(MemoryBackendError);
    expect(String(missingRevisionError)).not.toContain(missingRevisionToken);

    const noAuth = adapter(fetchStub(async () => jsonResponse(verboseSearchBody()))).describe();
    const keyOne = adapter(
      fetchStub(async () => jsonResponse(verboseSearchBody())),
      {
        token: "private-token-one",
        credentialRevision: "memmy-key-1",
      },
    ).describe();
    const keyTwo = adapter(
      fetchStub(async () => jsonResponse(verboseSearchBody())),
      {
        token: "private-token-two",
        credentialRevision: "memmy-key-2",
      },
    ).describe();
    const sameRevisionDifferentToken = adapter(
      fetchStub(async () => jsonResponse(verboseSearchBody())),
      { token: "private-token-rotated-but-not-declared", credentialRevision: "memmy-key-1" },
    ).describe();

    expect(noAuth).toMatchObject({ authMode: "none", credentialRevision: "none" });
    expect(keyOne).toMatchObject({ authMode: "bearer", credentialRevision: "memmy-key-1" });
    expect(noAuth.configurationFingerprint).not.toBe(keyOne.configurationFingerprint);
    expect(keyOne.configurationFingerprint).not.toBe(keyTwo.configurationFingerprint);
    // 指纹只依赖显式keyId/revision，绝不哈希Token；轮换凭据必须同步提升revision。
    expect(sameRevisionDifferentToken.configurationFingerprint).toBe(
      keyOne.configurationFingerprint,
    );
    const serialized = JSON.stringify([noAuth, keyOne, keyTwo, sameRevisionDifferentToken]);
    expect(serialized).not.toContain("private-token-one");
    expect(serialized).not.toContain("private-token-two");
  });

  it("只允许loopback使用HTTP，远端memmy在发送Bearer前必须使用HTTPS", () => {
    for (const baseUrl of ["http://memory.example.com", "http://192.0.2.10:18960"]) {
      expect(
        () =>
          new MemmyMemoryAdapter({
            baseUrl,
            token: "private-token-never-send-over-http",
            credentialRevision: "memmy-key-1",
          }),
      ).toThrowError(
        expect.objectContaining({
          code: "memory.backend.config_invalid",
          message: "远端memmy必须使用HTTPS",
        }),
      );
    }
    expect(
      () =>
        new MemmyMemoryAdapter({
          baseUrl: "https://memory.example.com",
          token: "private-token-https-only",
          credentialRevision: "memmy-key-1",
        }),
    ).not.toThrow();
    expect(() => new MemmyMemoryAdapter({ baseUrl: "http://[::1]:18960" })).not.toThrow();
  });

  it("网络异常即使包含 Token，也只越过稳定错误", async () => {
    const privateToken = "network-private-token";
    const memory = adapter(
      fetchStub(async () => {
        throw new Error(`upstream echoed ${privateToken}`);
      }),
      { token: privateToken, credentialRevision: "network-test-key-1" },
    );
    const error = await backendError(memory.query(queryInput()));
    expect(error).toMatchObject({ code: "memory.backend.unavailable", retryable: true });
    expect(error.message).not.toContain(privateToken);
    expect(JSON.stringify(error)).not.toContain(privateToken);
  });
});
