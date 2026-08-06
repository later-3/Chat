import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

function stubHealthzOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ status: "ok", service: "chat-api" }))),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("P1.1 会话外壳", () => {
  it("默认渲染空态、顶栏和禁用的发送按钮", async () => {
    stubHealthzOk();
    renderApp();
    expect(screen.getByText("Chat")).toBeTruthy();
    expect(screen.getByText("开始一段对话")).toBeTruthy();
    expect(screen.getByLabelText("消息输入框")).toBeTruthy();
    expect(screen.getByLabelText("发送")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("选择模型")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
  });

  it("API不可达时界面仍完整渲染，显示未连接而非假成功", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    renderApp();
    await waitFor(() => expect(screen.getByText("未连接")).toBeTruthy());
    expect(screen.getByText("开始一段对话")).toBeTruthy();
    expect(screen.getByLabelText("消息输入框")).toBeTruthy();
  });

  it("healthz响应不符合合同时显示未连接，不伪造成功", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "degraded" }))),
    );
    renderApp();
    await waitFor(() => expect(screen.getByText("未连接")).toBeTruthy());
  });

  it("发送按钮把消息本地即时上屏并清空输入框", async () => {
    stubHealthzOk();
    renderApp();
    const input = screen.getByLabelText("消息输入框");
    fireEvent.change(input, { target: { value: "帮我整理这个季度的 OKR" } });
    const sendButton = screen.getByLabelText("发送");
    expect(sendButton).toHaveProperty("disabled", false);
    fireEvent.click(sendButton);
    expect(screen.getByText("帮我整理这个季度的 OKR")).toBeTruthy();
    expect(input).toHaveProperty("value", "");
    expect(screen.queryByText("开始一段对话")).toBeNull();
  });

  it("Enter发送、Shift+Enter换行、纯空白不发送", async () => {
    stubHealthzOk();
    renderApp();
    const input = screen.getByLabelText("消息输入框");

    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByLabelText("发送")).toHaveProperty("disabled", true);

    fireEvent.change(input, { target: { value: "第一条消息" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("第一条消息")).toBeTruthy();
    expect(input).toHaveProperty("value", "");
  });

  it("模型选择即时生效并保存为界面偏好", async () => {
    stubHealthzOk();
    renderApp();
    const select = screen.getByLabelText("选择模型");
    expect(select).toHaveProperty("value", "claude-sonnet-4.5");
    fireEvent.change(select, { target: { value: "gpt-5.2" } });
    expect(select).toHaveProperty("value", "gpt-5.2");
    expect(window.localStorage.getItem("chat-model")).toBe("gpt-5.2");
  });

  it("主题切换写入data-theme并保存手动偏好", async () => {
    stubHealthzOk();
    renderApp();
    const toggle = screen.getByRole("button", { name: "切换到深色主题" });
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("chat-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "切换到浅色主题" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
