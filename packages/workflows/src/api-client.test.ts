import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeApiClient } from "./api-client.js";

describe("RuntimeApiClient M1 Context", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("分别调用begin与persist私有命令并解析严格checkpoint合同", async () => {
    let requestIndex = 0;
    const fetchMock = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => {
      requestIndex += 1;
      if (requestIndex === 1) {
        return new Response(
          JSON.stringify({
            schemaVersion: "chat-internal-runtime.v1",
            status: "dispatch_required",
            query: {
              memoryQueryId: "mqy_query1",
              contextRequestId: "ctxr_request1",
              productRunId: "run_context1",
              productSessionId: "psn_session1",
              backendId: "mbk_memmy",
              backendDescriptor: {
                backendId: "mbk_memmy",
                displayName: "memmy 本地记忆",
                kind: "memmy",
                adapterContractVersion: "memmy-http-query.v1",
                configured: true,
                authMode: "bearer",
                credentialRevision: "workflow-test-key-1",
                configurationFingerprint: "b".repeat(64),
                capabilities: {
                  query: true,
                  tags: true,
                  layers: ["L2"],
                  maxLimit: 20,
                  maxContextBudget: 8192,
                },
              },
              backendDescriptorSha256: "c".repeat(64),
              requirement: "required",
              sourceMessageSha256: "d".repeat(64),
              queryText: "查询历史",
              tags: [],
              layers: ["L2"],
              limit: 3,
              contextBudget: 512,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          schemaVersion: "chat-internal-runtime.v1",
          status: "optional_failed",
          contextPackageRef: {
            contextPackageId: "ctxp_package1",
            revision: 1,
            sha256: "a".repeat(64),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createRuntimeApiClient({
      baseUrl: "http://127.0.0.1:43111",
      credential: "rtk_test",
    });

    const begun = await client.beginPlanningContext({
      commandId: "cmd_preparecontext1" as never,
      productRunId: "run_context1" as never,
      attemptId: "att_workflow1" as never,
      planRevision: 1,
    });
    expect(begun.status).toBe("dispatch_required");
    if (begun.status !== "dispatch_required") throw new Error("缺少查询派发");

    const result = await client.persistPlanningContextResult({
      commandId: "cmd_persistcontext1" as never,
      productRunId: "run_context1" as never,
      attemptId: "att_workflow1" as never,
      memoryQueryId: begun.query.memoryQueryId,
      result: { outcome: "failure", errorCode: "memory.backend.timeout" },
    });
    expect(result.status).toBe("optional_failed");
    if (result.status !== "ready" && result.status !== "optional_failed") {
      throw new Error("缺少ContextPackage引用");
    }
    expect(result.contextPackageRef.contextPackageId).toBe("ctxp_package1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:43111/internal/runtime/v1/begin-planning-context");
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      "x-chat-runtime-key": "rtk_test",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      schemaVersion: "chat-internal-runtime.v1",
      commandId: "cmd_preparecontext1",
      productRunId: "run_context1",
      attemptId: "att_workflow1",
      planRevision: 1,
    });
    const [persistUrl, persistInit] = fetchMock.mock.calls[1] ?? [];
    expect(persistUrl).toBe(
      "http://127.0.0.1:43111/internal/runtime/v1/persist-planning-context-result",
    );
    expect(JSON.parse(String(persistInit?.body))).toEqual({
      schemaVersion: "chat-internal-runtime.v1",
      commandId: "cmd_persistcontext1",
      productRunId: "run_context1",
      attemptId: "att_workflow1",
      memoryQueryId: "mqy_query1",
      result: { outcome: "failure", errorCode: "memory.backend.timeout" },
    });
  });
});
