import { describe, expect, it } from "vitest";
import type { PromptAssemblyV2 } from "@chat/contracts";
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
    expect(sections[0]?.sources.map((source) => source.explanation).join("\n")).not.toContain(
      "只读",
    );
    expect(sections[2]?.sources[0]?.explanation).toContain("本次实际工具集合");
    expect(JSON.stringify(sections)).not.toContain("模型请求提示词");
  });

  it("V2区分正式历史、本轮用户输入与Pi运行时新消息", () => {
    const payload = {
      messages: [
        { role: "system", content: "Pi基础\nChat选择" },
        { role: "user", content: [{ type: "text", text: "上一问" }] },
        { role: "assistant", content: [{ type: "text", text: "上一答" }] },
        { role: "user", content: [{ type: "text", text: "当前问题" }] },
        { role: "assistant", content: [{ type: "text", text: "本轮工具调用" }] },
      ],
      model: "qwen3.7-plus",
    };
    const assembly = {
      schemaVersion: "prompt-assembly.v2",
      compilerVersion: "direct-agent-prompt-compiler.v2",
      regions: [
        {
          placement: "system",
          title: "规则",
          fragments: [
            {
              title: "证据优先",
              promptFragmentRevisionId: "pfr_evidence",
              sha256: "a".repeat(64),
              scope: { kind: "global" },
              sourceRelativePath: "prompts/fragments/rules/evidence-first.md",
            },
          ],
        },
      ],
      messages: [
        {
          role: "user",
          text: "上一问",
          source: {
            kind: "product_message",
            messageId: "msg_historyuser",
            sha256: "b".repeat(64),
          },
        },
        {
          role: "assistant",
          text: "上一答",
          source: {
            kind: "product_message",
            messageId: "msg_historyassistant",
            sha256: "c".repeat(64),
          },
        },
        {
          role: "user",
          text: "当前问题",
          source: { kind: "current_input", messageId: "msg_current", sha256: "d".repeat(64) },
        },
      ],
    } as unknown as PromptAssemblyV2;

    const sections = projectPromptReviewReadableSections(canonicalJsonStringify(payload), assembly);
    expect(sections[0]?.sources.flatMap((source) => source.sourceFiles)).toContain(
      "prompts/fragments/rules/evidence-first.md",
    );
    expect(sections[1]?.sources[0]?.addedBy).toContain("Product Session");
    expect(sections[1]?.sources[0]?.explanation).toContain("msg_historyuser");
    expect(sections[2]?.sources[0]?.addedBy).toContain("Product Session");
    expect(sections[3]?.sources[0]?.addedBy).toContain("用户输入");
    expect(sections[4]?.sources[0]?.addedBy).toContain("Pi AgentSession历史");
  });
});
