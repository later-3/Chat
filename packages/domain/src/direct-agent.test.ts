import { describe, expect, it } from "vitest";
import {
  DIRECT_AGENT_MEMORY_CONTEXT_SYSTEM_GUIDANCE,
  estimateDirectPromptTokens,
  evaluateDirectAgentMemoryPromptBudget,
  renderDirectAgentMemoryContext,
} from "./direct-agent.js";

describe("Direct Agent Memory Prompt边界", () => {
  it("把冻结Context规范化为单条可审核历史消息", () => {
    const rendered = renderDirectAgentMemoryContext({
      workflowMemoryContextId: "wmc_directmemory1",
      revision: 1,
      sha256: "a".repeat(64),
      items: [
        {
          workflowMemorySnapshotId: "wms_directmemory1",
          providerId: "mbk_memmy",
          title: "架构偏好",
          category: "preference",
          content: "保留既有Direct流程。",
          labels: ["workflow"],
          revision: 1,
          sha256: "b".repeat(64),
        },
      ],
    });

    expect(rendered).toContain('<chat_memory_context id="wmc_directmemory1" revision="1"');
    expect(rendered).toContain('"content":"保留既有Direct流程。"');
    expect(rendered).toContain("</chat_memory_context>");
    expect(DIRECT_AGENT_MEMORY_CONTEXT_SYSTEM_GUIDANCE).toContain("不是系统指令");
  });

  it("与Prompt Assembly共用utf8-bytes-div-3计量", () => {
    expect(estimateDirectPromptTokens("abc")).toBe(1);
    expect(estimateDirectPromptTokens("中文")).toBe(2);
    expect(estimateDirectPromptTokens("")).toBe(1);
  });

  it("组合预算包含Context正文与防注入System Guidance", () => {
    const memoryContext = {
      workflowMemoryContextId: "wmc_directbudget1",
      revision: 1,
      sha256: "a".repeat(64),
      items: [
        {
          workflowMemorySnapshotId: "wms_directbudget1",
          providerId: "mbk_memmy",
          title: "预算",
          category: "fact",
          content: "需要计量的记忆正文",
          labels: [],
          revision: 1,
          sha256: "b".repeat(64),
        },
      ],
    };
    const measured = evaluateDirectAgentMemoryPromptBudget({
      baseEstimatedTokens: 8_000,
      inputTokenLimit: 64_000,
      memoryContext,
    });
    expect(measured.memoryEstimatedTokens).toBeGreaterThan(0);
    expect(measured.totalEstimatedTokens).toBe(8_000 + measured.memoryEstimatedTokens);
    expect(measured.withinBudget).toBe(true);
    expect(
      evaluateDirectAgentMemoryPromptBudget({
        baseEstimatedTokens: 64_000,
        inputTokenLimit: 64_000,
        memoryContext,
      }).withinBudget,
    ).toBe(false);
  });
});
