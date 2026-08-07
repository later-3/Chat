import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock virtual:pwa-register/react，直接控制 needRefresh 与回调，验证提示行为
const mockRegisterSW = vi.hoisted(() => ({
  needRefresh: false,
  setNeedRefresh: vi.fn(),
  updateServiceWorker: vi.fn(async () => undefined),
  lastOptions: undefined as { onRegisterError?: (error: unknown) => void } | undefined,
}));

vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: (options?: { onRegisterError?: (error: unknown) => void }) => {
    mockRegisterSW.lastOptions = options;
    return {
      needRefresh: [mockRegisterSW.needRefresh, mockRegisterSW.setNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: mockRegisterSW.updateServiceWorker,
    };
  },
}));

import { PwaUpdatePrompt } from "./PwaUpdatePrompt.js";

beforeEach(() => {
  mockRegisterSW.needRefresh = false;
  mockRegisterSW.setNeedRefresh.mockClear();
  mockRegisterSW.updateServiceWorker.mockClear();
  mockRegisterSW.lastOptions = undefined;
});

afterEach(() => {
  cleanup();
});

describe("PWA 更新提示", () => {
  it("没有等待激活的新版本时不渲染提示", () => {
    render(<PwaUpdatePrompt />);
    expect(document.querySelector(".pwa-update-banner")).toBeNull();
  });

  it("新版本等待激活时展示提示，用户确认前不触发更新", () => {
    mockRegisterSW.needRefresh = true;
    render(<PwaUpdatePrompt />);
    expect(screen.getByText("新版本可用")).toBeTruthy();
    expect(mockRegisterSW.updateServiceWorker).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "刷新更新" }));
    expect(mockRegisterSW.updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it("选择“稍后”只关闭提示，不激活新版本", () => {
    mockRegisterSW.needRefresh = true;
    render(<PwaUpdatePrompt />);
    fireEvent.click(screen.getByRole("button", { name: "稍后更新" }));
    expect(mockRegisterSW.setNeedRefresh).toHaveBeenCalledWith(false);
    expect(mockRegisterSW.updateServiceWorker).not.toHaveBeenCalled();
  });

  it("注册失败记录脱敏诊断日志，不抛出也不渲染提示", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<PwaUpdatePrompt />);
    const onRegisterError = mockRegisterSW.lastOptions?.onRegisterError;
    expect(onRegisterError).toBeTruthy();
    expect(() => onRegisterError?.(new Error("TypeError: fetch failed"))).not.toThrow();
    expect(warn).toHaveBeenCalledWith("[pwa] Service Worker 注册失败：", "Error");
    expect(document.querySelector(".pwa-update-banner")).toBeNull();
    warn.mockRestore();
  });
});
