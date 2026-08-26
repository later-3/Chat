import type { WorkflowMemoryQueryInput, WorkflowMemoryWriteInput } from "@chat/application";
import { describe, expect, it, vi } from "vitest";
import { MemmyMemoryAdapter } from "./memmy-adapter.js";

const TEST_TIME = "2026-08-24T00:00:00.000Z";
const CONTENT = "用户要求发布前完成真实浏览器验收。";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function adapter(fetchImpl: typeof fetch): MemmyMemoryAdapter {
  return new MemmyMemoryAdapter({
    baseUrl: "http://127.0.0.1:18960",
    expectedPrincipalId: "usr_memmy1",
    fetchImpl,
  });
}

function queryInput(): WorkflowMemoryQueryInput {
  return {
    operationId: "wmq_memmy1" as never,
    productRunId: "run_memmy1" as never,
    productSessionId: "psn_memmy1" as never,
    principalId: "usr_memmy1" as never,
    query: "发布前需要做什么？",
    maxResults: 5,
    maxContextCharacters: 8_000,
  };
}

function comparisonQueryInput(): WorkflowMemoryQueryInput {
  return {
    operationId: "wmq_memmycompare1",
    sessionKey: "codex-session:019db07f-953c-7fc2-95b6-d38228810e64",
    principalId: "usr_memmy1" as never,
    query: "发布前需要做什么？",
    maxResults: 5,
    maxContextCharacters: 8_000,
  };
}

function writeInput(): WorkflowMemoryWriteInput {
  return {
    operationId: "mwi_memmy1" as never,
    requestSha256: "a".repeat(64),
    content: CONTENT,
    contentType: "conversation_turn",
    principalId: "usr_memmy1" as never,
    sessionKey: "psn_memmy1",
    turnKey: "msg_memmy1",
  };
}

function searchBody(): Record<string, unknown> {
  return {
    injectedContext: `<memmy_memory_context>${CONTENT}</memmy_memory_context>`,
    debug: {
      searchEventId: "search_memmy_1",
      hits: [
        {
          id: "memory_memmy_1",
          kind: "policy",
          memoryLayer: "L2",
          status: "activated",
          title: "发布验收",
          snippet: CONTENT,
          score: 0.91,
          tags: ["manual", "release"],
          updatedAt: TEST_TIME,
          source: "search",
        },
      ],
      sourceMemoryIds: ["memory_memmy_1"],
      status: ["ok"],
      sections: [
        {
          id: "section_memmy_1",
          title: "发布验收",
          kind: "policy",
          memoryLayer: "L2",
          memoryIds: ["memory_memmy_1"],
          content: CONTENT,
          tokenEstimate: 20,
        },
      ],
      tokenEstimate: 20,
      serverTime: TEST_TIME,
    },
  };
}

function addBody(duplicate = false): Record<string, unknown> {
  return {
    id: "memory_memmy_1",
    kind: "policy",
    memoryLayer: "L2",
    status: "activated",
    title: "conversation_turn",
    summary: CONTENT,
    tags: ["manual"],
    createdAt: TEST_TIME,
    serverTime: TEST_TIME,
    ...(duplicate ? { duplicate: true } : {}),
  };
}

function detailBody(): Record<string, unknown> {
  const detail = {
    id: "memory_memmy_1",
    kind: "policy",
    memoryLayer: "L2",
    status: "activated",
    title: "conversation_turn",
    summary: CONTENT,
    tags: ["manual"],
    metadata: { info: { turn_id: "msg_memmy1" } },
    createdAt: TEST_TIME,
    updatedAt: TEST_TIME,
    version: 1,
    body: CONTENT,
    sourceMemoryIds: [],
    policy: { evidenceMemoryIds: [], repairHints: [] },
  };
  return { ...detail, item: { ...detail, refs: {} }, refs: {}, etag: "etag-memmy-1" };
}

function panelBody(): Record<string, unknown> {
  const detail = detailBody() as { item: Record<string, unknown> };
  const source = detail.item;
  const item = Object.fromEntries(
    [
      "id",
      "kind",
      "memoryLayer",
      "status",
      "title",
      "summary",
      "tags",
      "metadata",
      "createdAt",
      "updatedAt",
      "version",
      "processing",
    ].flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  );
  return {
    items: [item],
    page: 1,
    pageSize: 20,
    total: 1,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
    serverTime: TEST_TIME,
  };
}

describe("memmy Workflow Memory Adapter", () => {
  it("只公开通用HTTP能力，不把层级、namespace或凭据写进descriptor", () => {
    const descriptor = adapter(vi.fn<typeof fetch>()).describeProvider();
    expect(descriptor).toMatchObject({
      providerKind: "memmy",
      transport: "http",
      configured: true,
      capabilities: {
        query: { maxResults: 20, maxContextCharacters: 50_000 },
        write: {
          maxContentCharacters: 50_000,
          materialization: "synchronous",
          idempotency: "provider_key",
        },
        reconcile: true,
      },
    });
    expect(JSON.stringify(descriptor)).not.toMatch(/L1|L2|L3|Skill|namespace|token/u);
  });

  it("把通用query映射到固定verbose search并归一化分类", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/api/v1/memory/search");
      expect(JSON.parse(String(init?.body))).toEqual({
        requestId: "wmq_memmy1",
        adapterId: "chat",
        namespace: {
          source: "chat",
          profileId: "chat-debug",
          sessionKey: "psn_memmy1",
          userId: "usr_memmy1",
        },
        query: "发布前需要做什么？",
        layers: ["L1", "L2", "L3", "Skill"],
        tags: [],
        limit: 5,
        contextBudget: 8_192,
        includeInjectedContext: true,
        verbose: true,
      });
      expect(new Headers(init?.headers).get("x-memmy-user-id")).toBe("usr_memmy1");
      return json(searchBody());
    });
    await expect(adapter(fetchImpl).queryMemory(queryInput())).resolves.toMatchObject({
      externalQueryId: "search_memmy_1",
      hitCount: 1,
      sections: [
        {
          externalObjectIds: ["memory_memmy_1"],
          category: "procedure",
          labels: ["manual", "release"],
          content: CONTENT,
        },
      ],
    });
  });

  it("查询响应损坏时越过稳定Provider错误而不是原始解析异常", async () => {
    const memory = adapter(vi.fn<typeof fetch>(async () => new Response("{broken")));
    await expect(memory.queryMemory(queryInput())).rejects.toMatchObject({
      code: "memory.provider.contract_invalid",
      retryable: false,
    });
  });

  it("比较Preview使用通用sessionKey查询同一Codex namespace", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        requestId: "wmq_memmycompare1",
        namespace: {
          sessionKey: "codex-session:019db07f-953c-7fc2-95b6-d38228810e64",
          userId: "usr_memmy1",
        },
      });
      return json(searchBody());
    });
    await expect(adapter(fetchImpl).queryMemory(comparisonQueryInput())).resolves.toMatchObject({
      hitCount: 1,
    });
  });

  it("写入使用稳定mwi requestId并严格归一化响应", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/api/v1/memory/add");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        requestId: "mwi_memmy1",
        namespace: { sessionKey: "psn_memmy1", userId: "usr_memmy1" },
        content: CONTENT,
        layer: "L2",
        title: "conversation_turn",
        tags: [],
        turnId: "msg_memmy1",
        deferProcessing: false,
      });
      expect(new Headers(init?.headers).get("x-memmy-user-id")).toBe("usr_memmy1");
      return json(addBody());
    });
    await expect(adapter(fetchImpl).writeMemory(writeInput())).resolves.toMatchObject({
      externalObjectId: "memory_memmy_1",
      externalStatus: "activated",
      responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it.each([
    ["lost", vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("socket lost")))],
    ["corrupt", vi.fn<typeof fetch>(async () => new Response("{broken"))],
  ] as const)("写响应%s都进入outcome_unknown且不允许普通重试", async (_kind, fetchImpl) => {
    await expect(adapter(fetchImpl).writeMemory(writeInput())).rejects.toMatchObject({
      phase: "write_outcome_unknown",
    });
  });

  it("响应失联后只用GET候选+详情对账，不重发memory.add", async () => {
    const requestIds: string[] = [];
    let addCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/memory/add") {
        requestIds.push((JSON.parse(String(init?.body)) as { requestId: string }).requestId);
        addCalls += 1;
        throw new TypeError("response lost after write");
      }
      if (path === "/api/v1/panel/items") return json(panelBody());
      if (path === "/api/v1/memory/memory_memmy_1") return json(detailBody());
      throw new Error(`unexpected path ${path}`);
    });
    const memory = adapter(fetchImpl);
    await expect(memory.writeMemory(writeInput())).rejects.toMatchObject({
      phase: "write_outcome_unknown",
    });
    await expect(memory.reconcileMemoryWrite(writeInput())).resolves.toMatchObject({
      status: "materialized",
      accepted: { externalObjectId: "memory_memmy_1", externalObjectVersion: "1" },
      verificationKind: "read_by_id",
    });
    expect(requestIds).toEqual(["mwi_memmy1"]);
    expect(addCalls).toBe(1);
  });

  it("非绑定Principal在任何HTTP调用前失败关闭", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const memory = adapter(fetchImpl);
    await expect(
      memory.queryMemory({ ...queryInput(), principalId: "usr_other" as never }),
    ).rejects.toMatchObject({
      code: "memory.provider.principal_not_configured",
      retryable: false,
    });
    await expect(
      memory.writeMemory({ ...writeInput(), principalId: "usr_other" as never }),
    ).rejects.toMatchObject({
      code: "memory.write.principal_not_configured",
      phase: "before_external_call",
    });
    await expect(
      memory.reconcileMemoryWrite({ ...writeInput(), principalId: "usr_other" as never }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "memory.write.principal_not_configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
