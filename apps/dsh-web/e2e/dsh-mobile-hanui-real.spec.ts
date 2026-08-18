import { expect, test } from "@playwright/test";

/**
 * dsh-mobile-hanui 移动端外壳真实浏览器合同（iPhone 视口 + 真实 DSH Host）。
 * 外壳由固定版本 dsh-mobile-hanui@0.2.4 提供：≤1023px 生效，桌面零影响。
 * 本文件同时守护两件事：
 * 1. 2026-08-17 HTML 注入事故回归——上游样式表标签必须完整存活；
 * 2. hanui 外壳在手机视口真实激活（FAB/遮罩/dsh-mobile-shell 类），
 *    且 Chat 自有 workflow 选择器与其共存。
 */

async function dismissNoticeIfPresent(page: import("@playwright/test").Page) {
  const noticeContinue = page.locator('[role="dialog"] button:has-text("Continue")');
  if (await noticeContinue.count()) {
    await noticeContinue.first().click();
    await expect(noticeContinue).toHaveCount(0);
  }
}

test.beforeAll(async ({ request }) => {
  // Gateway healthz 就绪早于 DSH 插件激活；具名路由注册完成前，未命中请求被
  // SPA fallback 以 200 回退成上游 dist index。轮询到 bridge PWA 路由真实接管。
  await expect(async () => {
    const probe = await request.get("/pwa/register.js");
    expect(probe.status()).toBe(200);
    expect(String(probe.headers()["content-type"] ?? "")).toContain("application/javascript");
  }).toPass({ timeout: 90_000, intervals: [500, 1_000, 2_000] });
});

test("index HTML 完整：上游样式表未被注入截断", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const html = await response.text();
  // 上游主样式表与 vendor 样式表标签必须完整（2026-08-17 事故回归）。
  expect(html).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/vendor-[^"]+\.css">/u);
  expect(html).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/index-[^"]+\.css">/u);
  // 注入块只能出现在 </head> 紧邻之前。
  const headEnd = html.indexOf("</head>");
  expect(html.indexOf("/pwa/register.js")).toBeGreaterThan(-1);
  expect(html.indexOf("/pwa/register.js")).toBeLessThan(headEnd);
  expect(html.slice(html.indexOf("/pwa/register.js"))).toMatch(/<\/script>\s*<\/head>/u);
  expect(html).toContain("viewport-fit=cover");
});

test.describe("手机视口", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.locator('button[aria-label="Send message"]').waitFor({ state: "visible" });
    await dismissNoticeIfPresent(page);
  });

  test("hanui 外壳激活：html 类、样式标签与 FAB", async ({ page }) => {
    await expect(page.locator("html.dsh-mobile-shell")).toHaveCount(1);
    await expect(page.locator('style[data-plugin="dsh-mobile-hanui"]')).toHaveCount(1);
    const fab = page.locator('button.dshMobMenu[aria-label="打开菜单"]');
    await expect(fab).toBeVisible();
    const box = await fab.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(40);
  });

  test("FAB 打开抽屉，遮罩点按关闭，workflow 选择器共存", async ({ page }) => {
    await page.click('button.dshMobMenu[aria-label="打开菜单"]');
    const backdrop = page.locator('button.dshMobBackdrop[aria-label="关闭面板"]');
    await expect(backdrop).toBeVisible();
    // Chat 自有 workflow 选择器仍然可见（唯一保留的自建 Composer 控件）。
    await expect(page.locator(".lifeos-workflow-toggle")).toBeVisible();
    await backdrop.click({ force: true });
    await expect(backdrop).toBeHidden();
  });
});

test("桌面视口 hanui 外壳不生效", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator('button[aria-label="Send message"]').waitFor({ state: "visible" });
  await dismissNoticeIfPresent(page);
  await expect(page.locator("html.dsh-mobile-shell")).toHaveCount(0);
  await expect(page.locator("button.dshMobMenu")).toHaveCount(0);
});
