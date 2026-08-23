import { describe, expect, it } from "vitest";
import {
  computeMemorySessionSnapshotSha256,
  convertMemorySessionToItems,
  type NormalizedMemorySessionSnapshot,
} from "./memory-session-import.js";

const snapshot: NormalizedMemorySessionSnapshot = {
  sourceKind: "codex",
  sourceSessionId: "019db07f-953c-7fc2-95b6-d38228810e64",
  title: "Memory开发",
  updatedAt: "2026-08-24T09:00:00.000Z",
  messages: [
    {
      sourceMessageKey: "turn-1:user",
      role: "user",
      text: "请实现 Session 导入。",
      createdAt: "2026-08-24T08:00:00.000Z",
    },
    {
      sourceMessageKey: "turn-1:assistant",
      role: "assistant",
      text: "先预览，再冻结哈希。",
      createdAt: "2026-08-24T08:00:01.000Z",
    },
    {
      sourceMessageKey: "turn-2:user",
      role: "user",
      text: "重复导入呢？",
      createdAt: "2026-08-24T08:01:00.000Z",
    },
  ],
};

describe("Memory Session确定性转换", () => {
  it("按用户轮次组合可见正文并得到稳定Hash", () => {
    const first = convertMemorySessionToItems({ snapshot, maxContentCharacters: 50_000 });
    const second = convertMemorySessionToItems({
      snapshot: structuredClone(snapshot),
      maxContentCharacters: 50_000,
    });

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      sourceItemKey: "turn-1:user",
      title: "第 1 轮 · 请实现 Session 导入。",
      content: "用户：\n请实现 Session 导入。\n\n助手：\n先预览，再冻结哈希。",
    });
    expect(first[1]?.content).toBe("用户：\n重复导入呢？");
    expect(computeMemorySessionSnapshotSha256(snapshot)).toBe(
      computeMemorySessionSnapshotSha256(structuredClone(snapshot)),
    );
  });

  it("长轮次按Provider上限稳定拆分，来源变化会改变Hash", () => {
    const long = {
      ...snapshot,
      messages: [{ ...snapshot.messages[0]!, text: "A".repeat(400) }],
    };
    const items = convertMemorySessionToItems({ snapshot: long, maxContentCharacters: 128 });

    expect(items.length).toBeGreaterThan(1);
    expect(items.every((item) => item.content.length <= 128)).toBe(true);
    expect(new Set(items.map((item) => item.sourceItemKey)).size).toBe(items.length);
    expect(computeMemorySessionSnapshotSha256(long)).not.toBe(
      computeMemorySessionSnapshotSha256(snapshot),
    );
  });
});
