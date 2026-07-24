import assert from "node:assert/strict";
import test from "node:test";

import {
  readSessionDraft,
  writeSessionDraft,
} from "../src/features/mobile/session-draft-storage.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("Product Session本机草稿相互隔离，并在清空后移除", () => {
  const storage = new MemoryStorage();
  writeSessionDraft("session-a", "继续项目A", storage);
  writeSessionDraft("session-b", "学习数学", storage);

  assert.equal(readSessionDraft("session-a", storage), "继续项目A");
  assert.equal(readSessionDraft("session-b", storage), "学习数学");

  writeSessionDraft("session-a", "", storage);
  assert.equal(readSessionDraft("session-a", storage), "");
  assert.equal(readSessionDraft("session-b", storage), "学习数学");
});
