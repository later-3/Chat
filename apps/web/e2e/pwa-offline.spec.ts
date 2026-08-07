import { expect, test, type Page } from "@playwright/test";

/**
 * 真实 Service Worker 离线场景（生产构建 + vite preview + 真实 API）。
 * 不得用 Mock navigator.serviceWorker 代替。
 */

async function openOkrSession(page: Page) {
  await page
    .getByRole("navigation", { name: "全局导航" })
    .getByRole("button", { name: "会话" })
    .click();
  await page.getByRole("button", { name: "打开会话 整理季度 OKR 进展" }).click();
}

async function waitForServiceWorkerControl(page: Page) {
  // 首次访问：等待 SW 完成激活（activate 事件中的预缓存清理结束）
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker?.getRegistration();
    return registration?.active?.state === "activated";
  });
  // 激活完成后的下一次导航才由 SW 控制；若导航撞上激活窗口期则重试
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.reload();
    const controlled = await page
      .waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, {
        timeout: 5_000,
      })
      .then(() => true)
      .catch(() => false);
    if (controlled) return;
  }
  throw new Error("Service Worker 未能控制页面");
}

test.describe("PWA 安装元数据与产物", () => {
  test("Manifest 字段、图标与 Service Worker 产物有效", async ({ page, request }) => {
    await page.goto("/?view=fixture");

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBeTruthy();

    const manifest = await (await request.get("/manifest.webmanifest")).json();
    expect(manifest.name).toBe("Chat");
    expect(manifest.short_name).toBe("Chat");
    expect(manifest.lang).toBe("zh-CN");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    const sizes = manifest.icons.map(
      (icon: { sizes: string; purpose?: string }) => `${icon.sizes}:${icon.purpose ?? "any"}`,
    );
    expect(sizes).toContain("192x192:any");
    expect(sizes).toContain("512x512:any");
    expect(sizes).toContain("512x512:maskable");

    for (const iconPath of [
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/icon-maskable-512.png",
      "/icons/apple-touch-icon.png",
    ]) {
      const response = await request.get(iconPath);
      expect(response.ok()).toBeTruthy();
      expect(response.headers()["content-type"]).toContain("image/png");
    }

    // Service Worker 只预缓存静态外壳：包含 index.html，不包含任何 /api 或写队列
    const swSource = await (await request.get("/sw.js")).text();
    expect(swSource).toContain("index.html");
    expect(swSource).not.toContain("/api/");
    expect(swSource).not.toContain("BackgroundSync");
  });

  test("Service Worker 激活后控制页面", async ({ page }) => {
    await page.goto("/?view=fixture");
    await waitForServiceWorkerControl(page);
    await expect(page.getByText("已连接")).toBeVisible();
  });
});

test.describe("离线外壳与草稿边界", () => {
  test("默认真实入口离线恢复草稿并禁止发送", async ({ page, context }) => {
    await page.goto("/");
    const input = page.getByLabel("消息输入框");
    // 先等真实Session bootstrap落盘，再允许SW helper触发reload；否则首次导航
    // 会在CreateSession响应前被中断，离线外壳没有可恢复的公开sessionId。
    await expect(input).toBeVisible();
    await waitForServiceWorkerControl(page);
    await input.fill("真实入口离线前草稿");
    await page.reload();
    await expect(page.getByLabel("消息输入框")).toHaveValue("真实入口离线前草稿");

    await context.setOffline(true);
    await page.goto("/");
    await expect(page.getByLabel("消息输入框")).toHaveValue("真实入口离线前草稿");
    await expect(page.getByLabel("发送")).toBeDisabled();
    await expect(page.getByText("当前离线，草稿已保存在此设备，联网后请手动发送。")).toBeVisible();

    await context.setOffline(false);
    await page.reload();
    await expect(page.getByLabel("消息输入框")).toHaveValue("真实入口离线前草稿");
    await expect(page.getByLabel("发送")).toBeEnabled();
  });

  test("离线重开外壳、草稿恢复、离线发送被阻止、恢复后不自动发送", async ({ page, context }) => {
    await page.goto("/?view=fixture");
    await waitForServiceWorkerControl(page);
    await expect(page.getByText("已连接")).toBeVisible();

    // 场景C：在线输入草稿，刷新后恢复
    await openOkrSession(page);
    const input = page.getByLabel("消息输入框");
    await input.fill("断网前要保留的草稿");
    await page.reload();
    await openOkrSession(page);
    await expect(page.getByLabel("消息输入框")).toHaveValue("断网前要保留的草稿");

    // 场景B：断网后重新导航，外壳仍能打开且明确显示未连接
    await context.setOffline(true);
    await page.goto("/?view=fixture");
    await expect(page.getByText("未连接")).toBeVisible();
    await expect(page.getByRole("main", { name: "今日" })).toBeVisible();

    // 离线时 /api/healthz 必须真实失败，不能命中旧缓存
    const healthzResult = await page.evaluate(async () => {
      try {
        const response = await fetch("/api/healthz");
        return { ok: response.ok, status: response.status };
      } catch {
        return { ok: false, status: 0 };
      }
    });
    expect(healthzResult.ok).toBe(false);

    // 场景D：离线发送被阻止——按钮禁用、Enter 无效、草稿保留、消息数不变
    await openOkrSession(page);
    const offlineInput = page.getByLabel("消息输入框");
    await expect(offlineInput).toHaveValue("断网前要保留的草稿");
    const messageCount = await page.getByRole("listitem").count();
    await expect(page.getByLabel("发送")).toBeDisabled();
    await expect(page.getByText("当前离线，草稿已保存在此设备，联网后请手动发送。")).toBeVisible();
    await offlineInput.press("Enter");
    expect(await page.getByRole("listitem").count()).toBe(messageCount);
    await expect(offlineInput).toHaveValue("断网前要保留的草稿");
    await expect(page.getByText("本地预览 · 未发送")).toHaveCount(
      await page.getByText("本地预览 · 未发送").count(),
    );

    // 恢复联网：只恢复发送能力，不自动重放草稿
    await context.setOffline(false);
    await page.reload();
    await openOkrSession(page);
    await expect(page.getByText("已连接")).toBeVisible();
    expect(await page.getByRole("listitem").count()).toBe(messageCount);
    await expect(page.getByLabel("消息输入框")).toHaveValue("断网前要保留的草稿");
    await expect(page.getByLabel("发送")).toBeEnabled();
  });
});
