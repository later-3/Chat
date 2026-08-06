import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function openOkrSession() {
  const globalNavigation = screen.getByRole("navigation", { name: "全局导航" });
  fireEvent.click(within(globalNavigation).getByRole("button", { name: "会话" }));
  fireEvent.click(screen.getByRole("button", { name: "打开会话 整理季度 OKR 进展" }));
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        bezierCurveTo: vi.fn(),
        stroke: vi.fn(),
        strokeStyle: "",
        globalAlpha: 1,
        lineWidth: 1,
      }) as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("P1.1 平铺工作空间", () => {
  it("默认渲染今日总览，不把fixture伪装成正在运行的真实会话", async () => {
    stubHealthzOk();
    renderApp();
    expect(screen.getByRole("main", { name: "今日" })).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "从今日总览进入不同会话，每个会话恢复自己的工作台。",
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("本地示例", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("消息输入框")).toBeNull();
    await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());
  });

  it("API不可达时工作空间仍完整渲染，显示未连接而非假成功", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    renderApp();
    await waitFor(() => expect(screen.getByText("未连接")).toBeTruthy());
    expect(screen.getByRole("main", { name: "今日" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "全局导航" })).toBeTruthy();
  });

  it("打开会话后同时提供持续对话与工作窗口", () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    expect(screen.getByRole("region", { name: "持续对话" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "工作窗口" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "切换到工作空间 1 OKR整理" })).toBeTruthy();
    expect(screen.getByText("4 / 6 个步骤已结束 · 本地示例数据")).toBeTruthy();
  });

  it("本地发送即时上屏并明确标记未发送", () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    const input = screen.getByLabelText("消息输入框");
    fireEvent.change(input, { target: { value: "把失败原因再简化成一句话" } });
    fireEvent.click(screen.getByLabelText("发送"));
    expect(screen.getByText("把失败原因再简化成一句话")).toBeTruthy();
    expect(screen.getAllByText("本地预览 · 未发送")).toHaveLength(2);
    expect(input).toHaveProperty("value", "");
  });

  it("支持Enter发送、Shift+Enter换行和IME保护", () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    const input = screen.getByLabelText("消息输入框");
    const messageCount = screen.getAllByRole("listitem").length;
    fireEvent.change(input, { target: { value: "第一条消息" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getAllByRole("listitem")).toHaveLength(messageCount);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(screen.getAllByRole("listitem")).toHaveLength(messageCount);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByRole("listitem")).toHaveLength(messageCount + 1);
    expect(screen.getByText("第一条消息")).toBeTruthy();
  });

  it("模型与主题只保存为浏览器界面偏好", () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    const select = screen.getByLabelText("选择模型");
    fireEvent.change(select, { target: { value: "gpt-5.2" } });
    expect(select).toHaveProperty("value", "gpt-5.2");
    expect(window.localStorage.getItem("chat-model")).toBe("gpt-5.2");

    fireEvent.click(screen.getByRole("button", { name: "切换到深色主题" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("chat-theme")).toBe("dark");
  });

  it("会话中的当前工作只聚焦右侧运行，不离开会话", () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    fireEvent.click(screen.getByRole("button", { name: "在当前会话中聚焦工作 整理季度 OKR 进展" }));
    expect(screen.getByRole("button", { name: "运行" })).toHaveProperty(
      "className",
      "work-tab active",
    );
    expect(screen.getByLabelText("消息输入框")).toBeTruthy();
  });

  it("分栏比例、最大化与侧栏折叠都可键盘操作", () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    const separator = screen.getByRole("separator", { name: "调整对话与工作区域大小" });
    expect(separator.getAttribute("aria-valuenow")).toBe("46");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("50");

    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(screen.getByRole("button", { name: "还原" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "还原" }));
    expect(screen.getByRole("region", { name: "持续对话" })).toBeTruthy();

    const globalNavigation = screen.getByRole("navigation", { name: "全局导航" });
    fireEvent.click(within(globalNavigation).getByRole("button", { name: "收起" }));
    expect(screen.getByRole("button", { name: "导航" })).toBeTruthy();
  });

  it("点击工作流节点会打开用户可读详情，关闭后移出页面结构", () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    fireEvent.click(screen.getByRole("button", { name: "计算指标，失败，点击查看详情" }));
    const inspector = screen.getByRole("complementary", { name: "计算指标详情" });
    expect(within(inspector).getByText("数据服务暂时无法访问，尚未形成完成度结果。")).toBeTruthy();
    fireEvent.click(within(inspector).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("complementary", { name: "计算指标详情" })).toBeNull();
  });

  it("手机对话/工作Tab切换不丢失会话输入", () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    const input = screen.getByLabelText("消息输入框");
    fireEvent.change(input, { target: { value: "继续保留这段草稿" } });
    fireEvent.click(screen.getByRole("tab", { name: "工作" }));
    expect(screen.getByRole("tab", { name: "工作" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "对话" }));
    expect(input).toHaveProperty("value", "继续保留这段草稿");
  });

  it("不同会话恢复各自工作窗口和打开的空间标签", () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    fireEvent.click(screen.getByRole("button", { name: "打开会话 准备产品周会 PPT" }));
    expect(screen.getByRole("button", { name: "幻灯片" })).toHaveProperty(
      "className",
      "work-tab active",
    );
    expect(screen.getByRole("button", { name: "切换到工作空间 1 OKR整理" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "切换到工作空间 2 周会PPT" })).toBeTruthy();
  });
});
