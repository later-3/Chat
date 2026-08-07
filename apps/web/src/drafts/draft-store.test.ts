import { beforeEach, describe, expect, it } from "vitest";
import { clearDraft, draftStorageKey, readDraft, writeDraft } from "./draft-store.js";

function createStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

function createThrowingStorage(): Storage {
  const fail = () => {
    throw new Error("storage unavailable");
  };
  return {
    length: 0,
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("草稿存储", () => {
  it("没有草稿时返回空字符串", () => {
    expect(readDraft(window.localStorage, "okr")).toBe("");
  });

  it("写入后可以按会话读回，键名包含产品前缀、版本和会话ID", () => {
    writeDraft(window.localStorage, "okr", "先记下这个想法");
    expect(draftStorageKey("okr")).toBe("chat:draft:v1:okr");
    expect(window.localStorage.getItem("chat:draft:v1:okr")).toBe(
      JSON.stringify({ version: 1, text: "先记下这个想法" }),
    );
    expect(readDraft(window.localStorage, "okr")).toBe("先记下这个想法");
  });

  it("不同会话的草稿互相隔离", () => {
    writeDraft(window.localStorage, "okr", "OKR 的草稿");
    writeDraft(window.localStorage, "ppt", "PPT 的草稿");
    expect(readDraft(window.localStorage, "okr")).toBe("OKR 的草稿");
    expect(readDraft(window.localStorage, "ppt")).toBe("PPT 的草稿");
  });

  it("写入空文本等于清除草稿", () => {
    writeDraft(window.localStorage, "okr", "有内容");
    writeDraft(window.localStorage, "okr", "");
    expect(readDraft(window.localStorage, "okr")).toBe("");
    expect(window.localStorage.getItem("chat:draft:v1:okr")).toBeNull();
  });

  it("clearDraft 只清理对应会话", () => {
    writeDraft(window.localStorage, "okr", "OKR 的草稿");
    writeDraft(window.localStorage, "ppt", "PPT 的草稿");
    clearDraft(window.localStorage, "okr");
    expect(readDraft(window.localStorage, "okr")).toBe("");
    expect(readDraft(window.localStorage, "ppt")).toBe("PPT 的草稿");
  });

  it.each([
    ["非JSON内容", "not-json{{{"],
    ["JSON但不是对象", JSON.stringify("just a string")],
    ["未知Schema版本", JSON.stringify({ version: 2, text: "未来版本" })],
    ["text字段缺失", JSON.stringify({ version: 1 })],
    ["text不是字符串", JSON.stringify({ version: 1, text: 42 })],
  ])("损坏值回退为空草稿：%s", (_label, raw) => {
    window.localStorage.setItem("chat:draft:v1:okr", raw);
    expect(readDraft(window.localStorage, "okr")).toBe("");
  });

  it("Storage抛错时读取回退为空、写入不抛出", () => {
    const storage = createThrowingStorage();
    expect(readDraft(storage, "okr")).toBe("");
    expect(() => writeDraft(storage, "okr", "内容")).not.toThrow();
    expect(() => clearDraft(storage, "okr")).not.toThrow();
  });

  it("内存Storage替身行为一致", () => {
    const storage = createStorage();
    writeDraft(storage, "code", "审查到一半");
    expect(readDraft(storage, "code")).toBe("审查到一半");
    clearDraft(storage, "code");
    expect(readDraft(storage, "code")).toBe("");
  });
});
