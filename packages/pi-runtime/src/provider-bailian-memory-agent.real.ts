import "../../../scripts/load-env.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_MODEL } from "@chat/contracts";
import { isBailianReady, loadBailianConfig } from "./config.js";
import {
  MEMORY_RETRIEVAL_AGENT_TOKEN_BUDGET,
  MEMORY_WRITE_AGENT_TOKEN_BUDGET,
  type MemoryAgentSearchSection,
  runPiMemoryRetrievalAgent,
  runPiMemoryWriteAgent,
} from "./memory-agents.js";

/**
 * 独立真实付费门：固定的本地输入只会传给百炼模型，Memory搜索由闭包提供且绝不触发
 * 外部Memory Provider。证据只记录脱敏调用元数据、usage和所选下标，不保存输入或候选正文。
 */
const config = loadBailianConfig(process.env);
const repoRoot =
  process.env.CHAT_REPO_ROOT ?? resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function writeEvidence(call: Record<string, unknown>): void {
  const directory = resolve(repoRoot, ".data/provider-evidence");
  mkdirSync(directory, { recursive: true });
  const file = resolve(directory, `bailian-memory-agent-${Date.now()}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        provider: "bailian",
        model: PROVIDER_MODEL,
        endpointHost: config.endpointHost,
        recordedAt: new Date().toISOString(),
        call,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`[provider-evidence] ${file}`);
}

function assertUsage(
  usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined,
) {
  if (usage === undefined) throw new Error("Memory Agent响应缺少真实usage");
  expect(usage.inputTokens).toBeGreaterThan(0);
  expect(usage.outputTokens).toBeGreaterThan(0);
}

describe("真实百炼Memory Agent（付费，显式运行）", () => {
  it("缺少DASHSCOPE_API_KEY时明确失败且不Skip", () => {
    if (!isBailianReady(config)) {
      throw new Error(
        "缺少DASHSCOPE_API_KEY：请配置后重跑 pnpm test:provider:bailian:memory-agent（本测试不Skip）",
      );
    }
  });

  it("检索Agent只从两条固定本地原始结果中选择相关下标与正文", async () => {
    if (!isBailianReady(config)) throw new Error("缺少DASHSCOPE_API_KEY");
    const sections: readonly MemoryAgentSearchSection[] = [
      {
        externalObjectIds: ["local-memory-unrelated"],
        title: "临时会议记录",
        category: "episode" as const,
        content: "一次性会议安排，不构成个人待办看板偏好。",
        labels: ["临时"],
      },
      {
        externalObjectIds: ["local-memory-relevant"],
        title: "待办看板偏好",
        category: "preference" as const,
        content: "个人待办看板默认按项目阶段分组。",
        labels: ["看板", "偏好"],
      },
    ];
    let localSearchCalls = 0;
    let providerRequests = 0;
    const result = await runPiMemoryRetrievalAgent({
      config,
      sourceText: "请继续整理我的个人待办看板。",
      maxResults: 1,
      search: async () => {
        localSearchCalls += 1;
        return { externalQueryId: "local-fixed-query", hitCount: sections.length, sections };
      },
      onProviderRequestStart: () => {
        providerRequests += 1;
      },
    });
    const call = {
      node: "memory_retrieval_agent",
      kind: result.kind,
      localSearchCalls,
      providerRequests,
      providerRequestCount: result.providerRequestCount,
      selectedOriginalIndexes:
        result.kind === "selected"
          ? result.output.sections.map((section) => sections.indexOf(section))
          : undefined,
      usage: result.kind === "selected" ? result.usage : undefined,
      tokenBudgetPerRequest: MEMORY_RETRIEVAL_AGENT_TOKEN_BUDGET,
    };
    writeEvidence(call);

    expect(localSearchCalls).toBe(1);
    expect(providerRequests).toBe(2);
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.providerRequestCount).toBe(2);
      // 身份和正文比较都只产生布尔失败信息，避免付费门失败时回显固定输入正文。
      expect(result.output.sections.length).toBe(1);
      expect(result.output.sections[0] === sections[1]).toBe(true);
      expect(result.output.sections[0]?.content === sections[1]?.content).toBe(true);
      assertUsage(result.usage);
    }
    console.log(
      "[provider-evidence] Memory retrieval真实调用次数: 2（本地搜索=1，外部Memory Provider=0）",
    );
  }, 240_000);

  it("写入Agent只产生有证据下标的待审核候选，或明确空集合", async () => {
    if (!isBailianReady(config)) throw new Error("缺少DASHSCOPE_API_KEY");
    let providerRequests = 0;
    const evidence = [
      {
        label: "固定用户证据",
        role: "user" as const,
        content: "我的个人待办看板默认按项目阶段分组。",
      },
      {
        label: "固定助手证据",
        role: "assistant" as const,
        content: "已知悉该看板分组偏好。",
      },
    ];
    const result = await runPiMemoryWriteAgent({
      config,
      evidence,
      maxItems: 2,
      onProviderRequestStart: () => {
        providerRequests += 1;
      },
    });
    const call = {
      node: "memory_write_agent",
      kind: result.kind,
      providerRequests,
      providerRequestCount: result.providerCallCount,
      candidateItemCount: result.kind === "candidate" ? result.candidate.items.length : undefined,
      evidenceIndexes:
        result.kind === "candidate"
          ? result.candidate.items.map((item) => [...item.evidenceIndexes])
          : undefined,
      usage: result.usage,
      tokenBudget: MEMORY_WRITE_AGENT_TOKEN_BUDGET,
    };
    writeEvidence(call);

    expect(providerRequests).toBe(1);
    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") {
      expect(result.providerCallCount).toBe(1);
      expect(result.providerMeta.toolCallCount).toBe(1);
      expect(result.candidate.items.every((item) => item.evidenceIndexes.length > 0)).toBe(true);
      expect(
        result.candidate.items.every((item) =>
          item.evidenceIndexes.every((index) => index >= 0 && index < evidence.length),
        ),
      ).toBe(true);
      assertUsage(result.usage);
    }
    console.log(
      "[provider-evidence] Memory write真实调用次数: 1（仅待审核候选，不调用Memory Provider）",
    );
  }, 180_000);
});
