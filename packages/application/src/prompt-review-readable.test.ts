import { describe, expect, it } from "vitest";
import { canonicalJsonStringify } from "@chat/domain";
import { projectPromptReviewReadableSections } from "./prompt-review-readable.js";

describe("Prompt Review readable source projection", () => {
  it("keeps source annotations separate from exact payload fields", () => {
    const payload = {
      messages: [
        { role: "system", content: "真实系统提示词" },
        { role: "user", content: [{ type: "text", text: "真实用户输入" }] },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read", description: "Read", parameters: { type: "object" } },
        },
      ],
      model: "qwen3.7-plus",
      stream: true,
    };

    const sections = projectPromptReviewReadableSections(canonicalJsonStringify(payload));
    expect(sections.map((section) => section.kind)).toEqual([
      "system_prompt",
      "user_message",
      "tool_definitions",
      "request_parameters",
    ]);
    expect(sections[0]?.content).toBe("真实系统提示词");
    expect(sections[0]?.sources.flatMap((source) => source.sourceFiles)).toContain(
      "pi/packages/coding-agent/src/core/system-prompt.ts",
    );
    expect(sections[0]?.sources.flatMap((source) => source.sourceFiles)).toContain(
      "packages/pi-runtime/src/direct-agent-executor.ts",
    );
    expect(JSON.parse(sections[1]?.content ?? "null")).toEqual(payload.messages[1]?.content);
    expect(sections[2]?.sources[0]?.sourceFiles).toContain(
      "pi/packages/coding-agent/src/core/tools/read.ts",
    );
    expect(JSON.stringify(sections)).not.toContain("模型请求提示词");
  });
});
