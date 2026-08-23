import { describe, expect, it, vi } from "vitest";
import type { WorkflowMemoryQueryInput, WorkflowMemoryWriteInput } from "@chat/application";
import { TencentMemoryCoreAdapter } from "./tencent-memorycore-adapter.js";

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

function adapter(fetchImpl: typeof fetch) {
  return new TencentMemoryCoreAdapter({
    baseUrl: "http://127.0.0.1:18970",
    token: TOKEN,
    serviceId: SERVICE,
    teamId: TEAM,
    userId: USER,
    agentId: AGENT,
    configurationRevision: "memorycore-local-v1",
    credentialRevision: "memorycore-key-v1",
    fetchImpl,
  });
}

function queryInput(): WorkflowMemoryQueryInput {
  return {
    operationId: "wmq_tencent1" as never,
    productRunId: "run_tencent1" as never,
    productSessionId: "psn_tencent1" as never,
    principalId: "usr_tencent1" as never,
    query: "发布前必须完成真实端到端测试",
    maxResults: 5,
    maxContextCharacters: 8_000,
  };
}

function writeInput(): WorkflowMemoryWriteInput {
  return {
    operationId: "mwi_tencent1" as never,
    requestSha256: "a".repeat(64),
    content: "服务器性能较弱，必须在本地编译后再上传。",
    contentType: "conversation_turn",
    principalId: "usr_tencent1" as never,
    sessionKey: "psn_tencent1",
    turnKey: "msg_tencent1",
  };
}

describe("Tencent Workflow Memory Adapter", () => {
  it("向Workflow只公开通用能力，不公开L0/L1", () => {
    const descriptor = adapter(vi.fn<typeof fetch>()).describeProvider();
    expect(descriptor).toMatchObject({
      providerKind: "tencent_memorycore",
      transport: "http",
      capabilities: {
        query: { maxResults: 20 },
        write: { materialization: "accepted_only", idempotency: "chat_reconcile" },
        reconcile: true,
      },
    });
    expect(JSON.stringify(descriptor)).not.toMatch(/L0|L1|token|serviceId|teamId/u);
  });

  it("把通用query映射到atomic/search并归一化分类", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/v3/atomic/search");
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
        request_id: "req-query-1",
        data: {
          items: [
            {
              id: "memory-1",
              version: 1,
              type: "instruction",
              background: "发布门",
              content: "发布前运行真实测试。",
              created_at: "2026-08-18T00:00:00.000Z",
              updated_at: "2026-08-18T00:00:01.000Z",
              score: 0.9,
            },
          ],
        },
      });
    });
    await expect(adapter(fetchImpl).queryMemory(queryInput())).resolves.toMatchObject({
      externalQueryId: "req-query-1",
      sections: [{ category: "procedure", content: "发布前运行真实测试。" }],
    });
  });

  it("写入使用mwi稳定session，响应丢失映射为write outcome_unknown", async () => {
    const successful = vi.fn<typeof fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        session_id: "chat-import:mwi_tencent1",
      });
      return json({
        code: 0,
        message: "ok",
        request_id: "req-write-1",
        data: {
          accepted_ids: ["external-1"],
          accepted_versions: ["v1"],
          total_count: 1,
        },
      });
    });
    await expect(adapter(successful).writeMemory(writeInput())).resolves.toMatchObject({
      externalObjectId: "chat-import:mwi_tencent1",
      externalStatus: "l0_accepted",
    });

    const dropped = vi.fn<typeof fetch>(async () => {
      throw new TypeError("socket closed after write");
    });
    await expect(adapter(dropped).writeMemory(writeInput())).rejects.toMatchObject({
      code: "memory.write.connection_lost",
      phase: "write_outcome_unknown",
    });
  });
});
