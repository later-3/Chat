import { describe, expect, it } from "vitest";
import {
  assertMemoryWriteTransition,
  normalizeWorkflowMemorySections,
  resolveMemoryWriteContent,
  WorkflowMemoryInvariantError,
} from "./workflow-memory.js";
import { computeWorkflowMemoryMessageSha256 } from "./workflow-memory.js";

describe("Workflow Memory领域规则", () => {
  it("按字符预算确定性裁剪Provider结果", () => {
    const selected = normalizeWorkflowMemorySections({
      hitCount: 3,
      maxResults: 2,
      maxContextCharacters: 12,
      sections: [
        {
          externalObjectIds: ["b", "a", "a"],
          title: " 一 ",
          category: "fact",
          content: "1234",
          labels: ["Release", "release"],
        },
        {
          externalObjectIds: ["c"],
          title: "二",
          category: "procedure",
          content: "1234567890",
          labels: [],
        },
      ],
    });
    expect(selected).toEqual([
      {
        externalObjectIds: ["a", "b"],
        title: "一",
        category: "fact",
        content: "1234",
        labels: ["release"],
      },
    ]);
  });

  it("写入选区始终从权威Message重建", () => {
    const message = {
      messageId: "msg_1",
      sessionId: "psn_1",
      sessionSequence: 1,
      role: "user" as const,
      content: { format: "markdown" as const, text: "记住发布前要跑真实测试" },
    };
    expect(
      resolveMemoryWriteContent({
        message,
        selection: {
          kind: "full_message",
          sourceMessageId: message.messageId,
          sourceMessageSha256: computeWorkflowMemoryMessageSha256(message),
        },
        maxContentCharacters: 100,
      }),
    ).toBe(message.content.text);
  });

  it("外部写入结果未知后只能对账收敛，不能回到dispatching", () => {
    expect(() =>
      assertMemoryWriteTransition({ status: "outcome_unknown" }, "accepted"),
    ).not.toThrow();
    expect(() => assertMemoryWriteTransition({ status: "outcome_unknown" }, "dispatching")).toThrow(
      WorkflowMemoryInvariantError,
    );
  });
});
