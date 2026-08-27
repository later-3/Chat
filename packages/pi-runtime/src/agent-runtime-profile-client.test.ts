import { describe, expect, it, vi } from "vitest";
import { agentRuntimeBaselineDtoSchema, type AgentRuntimeBaselineDto } from "@chat/contracts";
import { createPiAgentRuntimeProfileClient } from "./agent-runtime-profile-client.js";
import { readRuntimeToolFixture } from "./runtime-profile-test-fixture.js";

function runtimeBaseline(): AgentRuntimeBaselineDto {
  return agentRuntimeBaselineDtoSchema.parse({
    kind: "pi_coding_agent",
    title: "Pi Coding Agent",
    packageName: "@earendil-works/pi-coding-agent",
    packageVersion: "0.84.2",
    managedSource: "later-3/pi@codex/later-custom",
    managedSourceRevision: "1".repeat(40),
    compositionStrategy: "pi_default_or_custom_then_chat_runtime_then_context",
    chatRuntimeAppend: {
      bodyMarkdown: "Chat runtime append",
      sha256: "a".repeat(64),
      sourceRelativePath: "packages/pi-runtime/src/direct-agent-executor.ts",
    },
    variants: [
      {
        variantKey: "read_only",
        title: "只读执行",
        description: "真实Pi只读工具集合",
        capabilityCatalogSha256: "c".repeat(64),
        readiness: "available",
        diagnostics: [],
        enabledToolNames: ["read"],
        piSystemPrompt: {
          bodyMarkdown: "You are an expert coding assistant operating inside pi",
          sha256: "b".repeat(64),
          dynamicPlaceholders: ["WORKSPACE_ROOT"],
          sourceRelativePaths: ["pi/packages/coding-agent/src/core/system-prompt.ts"],
        },
        tools: [readRuntimeToolFixture()],
      },
    ],
    finalReviewNote: "最终内容以Provider发送前审核为准。",
  });
}

describe("Pi Agent运行时配置私有客户端", () => {
  it("只请求Pi-backed Agent，携带Workspace与私有凭据且每次刷新投影", async () => {
    let requestedUrl: string | URL | Request | undefined;
    let requestedInit: RequestInit | undefined;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      requestedUrl = input;
      requestedInit = init;
      return new Response(JSON.stringify(runtimeBaseline()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createPiAgentRuntimeProfileClient({
      baseUrl: "http://executor.test/",
      credential: "rtk_profile_test",
      fetchFn,
    });

    await expect(client.read("planner")).resolves.toBeUndefined();
    const first = await client.read("direct", "root_chat");
    const second = await client.read("direct", "root_chat");

    expect(first).toEqual(runtimeBaseline());
    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(requestedUrl).toBe(
      "http://executor.test/internal/pi-executor/v1/agent-runtime-profiles/direct?workspaceRootId=root_chat",
    );
    expect(requestedInit?.headers).toMatchObject({
      accept: "application/json",
      "x-chat-runtime-key": "rtk_profile_test",
    });
  });

  it("失败后Pi Executor恢复可重新读取", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(runtimeBaseline()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = createPiAgentRuntimeProfileClient({
      baseUrl: "http://executor.test",
      credential: "rtk_profile_test",
      fetchFn,
    });

    await expect(client.read("coding_executor")).rejects.toThrow("Pi Agent运行时配置不可用:503");
    await expect(client.read("coding_executor")).resolves.toEqual(runtimeBaseline());
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
