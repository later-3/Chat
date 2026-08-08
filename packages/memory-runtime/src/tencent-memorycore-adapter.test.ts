import { describe, expect, it, vi } from "vitest";
import type { MemoryImportInput, MemoryQueryInput } from "@chat/application";
import { computeMemoryImportRequestSha256 } from "@chat/domain";
import {
  TENCENT_MEMORYCORE_BACKEND_ID,
  TencentMemoryCoreAdapter,
  type TencentMemoryCoreAdapterOptions,
} from "./tencent-memorycore-adapter.js";

const TOKEN = "private-memorycore-token";
const SERVICE = "chat-service";
const TEAM = "chat-team";
const USER = "chat-user";
const AGENT = "chat-agent";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function options(fetchImpl: typeof fetch): TencentMemoryCoreAdapterOptions {
  return {
    baseUrl: "http://127.0.0.1:18970",
    token: TOKEN,
    serviceId: SERVICE,
    teamId: TEAM,
    userId: USER,
    agentId: AGENT,
    configurationRevision: "memorycore-local-v1",
    credentialRevision: "memorycore-key-v1",
    fetchImpl,
  };
}

function queryInput(overrides: Partial<MemoryQueryInput> = {}): MemoryQueryInput {
  return {
    operationId: "mqy_tencent1",
    productRunId: "run_tencent1" as never,
    productSessionId: "psn_tencent1" as never,
    query: "发布前必须完成真实端到端测试",
    tags: [],
    layers: ["L1"],
    limit: 5,
    contextBudget: 1_800,
    ...overrides,
  };
}

function importInput(overrides: Partial<MemoryImportInput> = {}): MemoryImportInput {
  const shape = {
    kind: "tencent_conversation_capture" as const,
    content: "服务器性能较弱，必须在本地编译后再上传。",
    layer: "L0" as const,
    turnId: "msg_tencent1",
  };
  return {
    operationId: "mii_tencent1" as never,
    requestSha256: computeMemoryImportRequestSha256(shape),
    content: shape.content,
    layer: "L0",
    title: "部署约束",
    tags: [],
    source: "chat.explicit_import",
    sessionId: "psn_tencent1" as never,
    turnId: shape.turnId,
    ...overrides,
  };
}

describe("TencentMemoryCoreAdapter", () => {
  it("只公开安全能力，配置不完整时可见但不可用", async () => {
    const adapter = new TencentMemoryCoreAdapter({
      baseUrl: "http://127.0.0.1:18970",
      fetchImpl: vi.fn<typeof fetch>(),
    });
    expect(adapter.describe()).toMatchObject({
      backendId: TENCENT_MEMORYCORE_BACKEND_ID,
      kind: "tencent_memorycore",
      configured: false,
      authMode: "bearer",
      capabilities: { query: true, tags: false, layers: ["L1"] },
    });
    expect(adapter.describeImport().descriptor).toMatchObject({
      configured: false,
      capabilities: {
        mode: "conversation_capture",
        layers: ["L0"],
        title: false,
        tags: false,
      },
    });
    expect(JSON.stringify(adapter.describe())).not.toContain(TOKEN);
    await expect(adapter.health()).resolves.toEqual({
      status: "unavailable",
      errorCode: "memory.backend.not_configured",
    });
  });

  it("健康响应按固定源码合同严格校验", async () => {
    const validHealth = {
      status: "ok",
      version: "2.0.0-beta.1",
      uptime: 12,
      stores: { vectorStore: true, embeddingService: false },
      services: { timerScanner: null, pipelineWorker: null, stateBackend: "connected" },
    };
    const ready = new TencentMemoryCoreAdapter(
      options(vi.fn<typeof fetch>(async () => json(validHealth))),
    );
    await expect(ready.health()).resolves.toEqual({ status: "ready" });

    const contractDrift = new TencentMemoryCoreAdapter(
      options(
        vi.fn<typeof fetch>(async () =>
          json({ ...validHealth, services: { ...validHealth.services, privateToken: "never" } }),
        ),
      ),
    );
    await expect(contractDrift.health()).resolves.toEqual({
      status: "unavailable",
      errorCode: "memory.backend.contract_invalid",
    });
  });

  it("真实合同映射atomic/search并在Chat预算内组装L1 section", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("x-tdai-service-id")).toBe(SERVICE);
      expect(headers.get("x-tdai-team-id")).toBe(TEAM);
      expect(headers.get("x-tdai-user-id")).toBe(USER);
      expect(headers.get("x-tdai-agent-id")).toBe(AGENT);
      expect(JSON.parse(String(init?.body))).toEqual({
        team_id: TEAM,
        agent_id: AGENT,
        user_id: USER,
        query: "发布前必须完成真实端到端测试",
        limit: 5,
      });
      return json({
        code: 0,
        message: "ok",
        request_id: "req-memorycore-query-1",
        data: {
          items: [
            {
              id: "l1-release-gate",
              version: 1,
              type: "instruction",
              background: "发布门",
              content: "发布前必须运行真实浏览器、Workflow与模型端到端测试。",
              created_at: "2026-08-08T00:00:00.000Z",
              updated_at: "2026-08-08T00:00:01.000Z",
              team_id: TEAM,
              agent_id: AGENT,
              user_id: USER,
              score: 0.92,
            },
          ],
        },
      });
    });
    const output = await new TencentMemoryCoreAdapter(options(fetchImpl)).query(queryInput());
    expect(output).toMatchObject({
      externalQueryId: "req-memorycore-query-1",
      hitCount: 1,
      sections: [
        {
          externalObjectIds: ["l1-release-gate"],
          title: "发布门",
          kind: "policy",
          memoryLayer: "L1",
          tags: [],
          score: 0.92,
        },
      ],
    });
  });

  it("标签或非L1层在外呼前失败", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new TencentMemoryCoreAdapter(options(fetchImpl));
    await expect(adapter.query(queryInput({ tags: ["project"] }))).rejects.toMatchObject({
      code: "memory.backend.capability_unsupported",
    });
    await expect(adapter.query(queryInput({ layers: ["L2"] }))).rejects.toMatchObject({
      code: "memory.backend.capability_unsupported",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("导入只调用一次conversation/add，对账只读L0/L1并保持accepted", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path === "/v3/conversation/add") {
        expect(body).toEqual({
          team_id: TEAM,
          agent_id: AGENT,
          user_id: USER,
          session_id: "chat-import:mii_tencent1",
          messages: [{ role: "user", content: "服务器性能较弱，必须在本地编译后再上传。" }],
        });
        return json({
          code: 0,
          message: "ok",
          request_id: "req-add-1",
          data: {
            accepted_ids: ["msg-external-1"],
            accepted_versions: ["v1"],
            total_count: 1,
          },
        });
      }
      if (path === "/v3/conversation/query") {
        return json({
          code: 0,
          message: "ok",
          request_id: "req-l0-1",
          data: {
            messages: [
              {
                id: "msg-external-1",
                version: "v1",
                role: "user",
                content: "服务器性能较弱，必须在本地编译后再上传。",
                session_id: "chat-import:mii_tencent1",
                team_id: TEAM,
                user_id: USER,
                agent_id: AGENT,
              },
            ],
            total: 1,
          },
        });
      }
      if (path === "/v3/atomic/query") {
        return json({
          code: 0,
          message: "ok",
          request_id: "req-l1-empty",
          data: { items: [], total: 0 },
        });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new TencentMemoryCoreAdapter(options(fetchImpl));
    const input = importInput();
    const accepted = await adapter.import(input);
    expect(accepted).toMatchObject({
      externalObjectId: "chat-import:mii_tencent1",
      externalObjectVersion: "v1",
      externalStatus: "l0_accepted",
    });
    await expect(
      adapter.reconcile({ ...input, externalObjectId: accepted.externalObjectId }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(paths).toEqual(["/v3/conversation/add", "/v3/conversation/query", "/v3/atomic/query"]);
    expect(paths.filter((path) => path === "/v3/conversation/add")).toHaveLength(1);
    expect(paths).not.toContain("/v3/atomic/update");
  });

  it("只有同一stable session出现L1才返回materialized", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v3/conversation/query") {
        return json({
          code: 0,
          message: "ok",
          request_id: "req-l0-2",
          data: {
            messages: [
              {
                id: "msg-external-2",
                role: "user",
                content: "服务器性能较弱，必须在本地编译后再上传。",
                session_id: "chat-import:mii_tencent1",
                team_id: TEAM,
                user_id: USER,
                agent_id: AGENT,
              },
            ],
            total: 1,
          },
        });
      }
      if (path === "/v3/atomic/query") {
        return json({
          code: 0,
          message: "ok",
          request_id: "req-l1-2",
          data: {
            items: [
              {
                id: "l1-external-2",
                version: 0,
                type: "instruction",
                content: "服务器构建约束",
                session_id: "chat-import:mii_tencent1",
                team_id: TEAM,
                user_id: USER,
                agent_id: AGENT,
                created_at: "2026-08-08T00:00:00.000Z",
                updated_at: "2026-08-08T00:00:01.000Z",
              },
            ],
            total: 1,
          },
        });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new TencentMemoryCoreAdapter(options(fetchImpl));
    await expect(
      adapter.reconcile({
        ...importInput(),
        externalObjectId: "chat-import:mii_tencent1",
      }),
    ).resolves.toMatchObject({
      status: "materialized",
      verificationKind: "l0_and_session_l1",
      accepted: { externalStatus: "l1_materialized" },
    });
  });

  it("add断响应归类结果未知，对账绝不重放add", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v3/conversation/add") throw new TypeError("socket closed after write");
      if (path === "/v3/conversation/query") {
        return json({
          code: 0,
          message: "ok",
          request_id: "req-missing",
          data: { messages: [], total: 0 },
        });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new TencentMemoryCoreAdapter(options(fetchImpl));
    await expect(adapter.import(importInput())).rejects.toMatchObject({
      code: "memory.import.connection_lost",
      phase: "write_outcome_unknown",
    });
    await expect(adapter.reconcile(importInput())).resolves.toEqual({
      status: "outcome_unknown",
      errorCode: "memory.import.l0_not_found",
    });
    expect(
      fetchImpl.mock.calls.filter(
        ([url]) => new URL(String(url)).pathname === "/v3/conversation/add",
      ),
    ).toHaveLength(1);
  });
});
