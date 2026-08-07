import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, HEALTH_REFETCH_INTERVAL_MS } from "./App.js";

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

function stubHealthzFail() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network down");
    }),
  );
}

function stubBrowserOnline(online: boolean) {
  vi.spyOn(Navigator.prototype, "onLine", "get").mockReturnValue(online);
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
  vi.useRealTimers();
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

  it("本地发送即时上屏并明确标记未发送", async () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    await screen.findByText("已连接");
    const input = screen.getByLabelText("消息输入框");
    fireEvent.change(input, { target: { value: "把失败原因再简化成一句话" } });
    fireEvent.click(screen.getByLabelText("发送"));
    expect(screen.getByText("把失败原因再简化成一句话")).toBeTruthy();
    expect(screen.getAllByText("本地预览 · 未发送")).toHaveLength(2);
    expect(input).toHaveProperty("value", "");
  });

  it("支持Enter发送、Shift+Enter换行和IME保护", async () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    await screen.findByText("已连接");
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

describe("P1.2 草稿与离线发送边界", () => {
  it("刷新等价重挂载后草稿恢复", async () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "刷新前留下的草稿" },
    });
    expect(window.localStorage.getItem("chat:draft:v1:okr")).toContain("刷新前留下的草稿");

    cleanup();
    renderApp();
    openOkrSession();
    await waitFor(() =>
      expect(screen.getByLabelText("消息输入框")).toHaveProperty("value", "刷新前留下的草稿"),
    );
  });

  it("不同会话只能看到自己的草稿，切换不串写", () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "OKR 会话的草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "打开会话 准备产品周会 PPT" }));
    expect(screen.getByLabelText("消息输入框")).toHaveProperty("value", "");
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "PPT 会话的草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "切换到工作空间 1 OKR整理" }));
    expect(screen.getByLabelText("消息输入框")).toHaveProperty("value", "OKR 会话的草稿");
    fireEvent.click(screen.getByRole("button", { name: "切换到工作空间 2 周会PPT" }));
    expect(screen.getByLabelText("消息输入框")).toHaveProperty("value", "PPT 会话的草稿");
  });

  it("离线时按钮与Enter都不能发送，草稿保留且不新增消息", async () => {
    stubBrowserOnline(false);
    stubHealthzFail();
    renderApp();
    openOkrSession();
    await screen.findByText("未连接");
    expect(screen.getByText("当前离线，草稿已保存在此设备，联网后请手动发送。")).toBeTruthy();

    const messageCount = screen.getAllByRole("listitem").length;
    const input = screen.getByLabelText("消息输入框");
    fireEvent.change(input, { target: { value: "离线时写下的内容" } });
    expect(screen.getByLabelText("发送")).toHaveProperty("disabled", true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByRole("listitem")).toHaveLength(messageCount);
    expect(input).toHaveProperty("value", "离线时写下的内容");
    expect(window.localStorage.getItem("chat:draft:v1:okr")).toContain("离线时写下的内容");
  });

  it("连接中也不能先产生成功结果", async () => {
    // fetch 永不 resolve，状态停在连接中
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    renderApp();
    openOkrSession();
    await screen.findByText("正在连接 Chat 服务，连接成功后才能发送。");
    const messageCount = screen.getAllByRole("listitem").length;
    const input = screen.getByLabelText("消息输入框");
    fireEvent.change(input, { target: { value: "连接中输入的内容" } });
    expect(screen.getByLabelText("发送")).toHaveProperty("disabled", true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByRole("listitem")).toHaveLength(messageCount);
  });

  it("恢复联网后草稿仍在，不会自动发送", async () => {
    stubBrowserOnline(false);
    stubHealthzFail();
    renderApp();
    openOkrSession();
    window.dispatchEvent(new Event("offline"));
    await screen.findByText("未连接");
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "断网期间的草稿" },
    });
    const messageCount = screen.getAllByRole("listitem").length;

    // 恢复网络：健康检查转成功并派发 online 事件
    stubHealthzOk();
    vi.spyOn(Navigator.prototype, "onLine", "get").mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await screen.findByText("已连接");

    expect(screen.getAllByRole("listitem")).toHaveLength(messageCount);
    expect(screen.getByLabelText("消息输入框")).toHaveProperty("value", "断网期间的草稿");
    expect(screen.getByLabelText("发送")).toHaveProperty("disabled", false);
  });

  it("在线发送成功后只清理当前会话草稿", async () => {
    stubHealthzOk();
    renderApp();
    openOkrSession();
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "OKR 待发送" },
    });
    fireEvent.click(screen.getByRole("button", { name: "打开会话 准备产品周会 PPT" }));
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "PPT 草稿保留" },
    });
    fireEvent.click(screen.getByRole("button", { name: "切换到工作空间 1 OKR整理" }));
    await screen.findByText("已连接");
    fireEvent.click(screen.getByLabelText("发送"));

    expect(screen.getByText("OKR 待发送")).toBeTruthy();
    expect(window.localStorage.getItem("chat:draft:v1:okr")).toBeNull();
    expect(window.localStorage.getItem("chat:draft:v1:ppt")).toContain("PPT 草稿保留");
    expect(screen.getByLabelText("消息输入框")).toHaveProperty("value", "");
  });

  it("API 中途宕机后收敛为未连接并阻止发送（浏览器仍在线）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubHealthzOk();
    renderApp();
    openOkrSession();
    await screen.findByText("已连接");
    fireEvent.change(screen.getByLabelText("消息输入框"), {
      target: { value: "宕机前输入的内容" },
    });
    expect(screen.getByLabelText("发送")).toHaveProperty("disabled", false);

    // 服务中途宕机，浏览器网络仍然在线：有限频率轮询后必须转为未连接
    stubHealthzFail();
    await vi.advanceTimersByTimeAsync(HEALTH_REFETCH_INTERVAL_MS + 1000);
    await screen.findByText("未连接");
    expect(screen.getByLabelText("发送")).toHaveProperty("disabled", true);
    expect(screen.getByText("当前离线，草稿已保存在此设备，联网后请手动发送。")).toBeTruthy();
    const messageCount = screen.getAllByRole("listitem").length;
    fireEvent.keyDown(screen.getByLabelText("消息输入框"), { key: "Enter" });
    expect(screen.getAllByRole("listitem")).toHaveLength(messageCount);
    expect(screen.getByLabelText("消息输入框")).toHaveProperty("value", "宕机前输入的内容");
  });

  it("没有等待激活的新版本时不显示更新提示，也不会强制刷新", () => {
    stubHealthzOk();
    renderApp();
    expect(document.querySelector(".pwa-update-banner")).toBeNull();
  });
});
