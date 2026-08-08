import { describe, expect, it } from "vitest";
import {
  assertMemoryImportTransition,
  computeMessageSha256,
  normalizeMemoryImportTags,
  resolveMemoryImportContent,
} from "./memory-import.js";
import { sha256Hex } from "./canonical-hash.js";

const message = {
  schemaVersion: "message.v1",
  messageId: "msg_memory1",
  sessionId: "psn_memory1",
  sessionSequence: 1,
  role: "user",
  content: { format: "markdown", text: "发布窗口是 2026-09-17 🚀，口令 M2_CANARY。" },
  revision: 1,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
} as const;

describe("Memory Import领域规则", () => {
  it("按UTF-16范围从权威Message重建Emoji选区", () => {
    const start = message.content.text.indexOf("🚀");
    const selected = message.content.text.slice(start, start + 2);
    expect(selected).toBe("🚀");
    expect(
      resolveMemoryImportContent({
        message,
        selection: {
          kind: "utf16_range",
          sourceMessageId: message.messageId,
          sourceMessageSha256: computeMessageSha256(message),
          startUtf16: start,
          endUtf16: start + 2,
          selectedTextSha256: sha256Hex(selected),
        },
        maxContentChars: 100,
      }),
    ).toBe("🚀");
  });

  it("拒绝越界、陈旧Message与伪造选区Hash", () => {
    const base = {
      kind: "utf16_range" as const,
      sourceMessageId: message.messageId,
      sourceMessageSha256: computeMessageSha256(message),
      startUtf16: 0,
      endUtf16: 2,
      selectedTextSha256: sha256Hex(message.content.text.slice(0, 2)),
    };
    expect(() =>
      resolveMemoryImportContent({
        message,
        selection: { ...base, endUtf16: 999 },
        maxContentChars: 100,
      }),
    ).toThrow("选区范围无效");
    expect(() =>
      resolveMemoryImportContent({
        message,
        selection: { ...base, sourceMessageSha256: "a".repeat(64) },
        maxContentChars: 100,
      }),
    ).toThrow("Message版本已变化");
    expect(() =>
      resolveMemoryImportContent({
        message,
        selection: { ...base, selectedTextSha256: "b".repeat(64) },
        maxContentChars: 100,
      }),
    ).toThrow("选区内容已变化");
  });

  it("标签规范化为去重、小写、稳定排序", () => {
    expect(normalizeMemoryImportTags([" Release ", "project", "release"])).toEqual([
      "project",
      "release",
    ]);
  });

  it("只允许冻结状态机中的转换", () => {
    const queued = {
      schemaVersion: "memory-import-result.v1",
      memoryImportResultId: "mir_1",
      memoryImportIntentId: "mii_1",
      status: "queued",
      dispatchAttempts: 0,
      reconcileAttempts: 0,
      revision: 1,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    } as const;
    expect(() => assertMemoryImportTransition(queued, "dispatching")).not.toThrow();
    expect(() => assertMemoryImportTransition(queued, "materialized")).toThrow(
      "不允许queued -> materialized",
    );
  });
});
