import { expect, test } from "@playwright/test";
import { DSH_REAL_E2E_PORTS } from "../../../scripts/e2e/dsh-real-environment.mjs";

/**
 * Chat PWA 真实浏览器门（Chromium，真实 DSH Host + Gateway）：
 * 可安装清单、图标、Service Worker 注册与离线外壳边界。
 * 边界沿用 P1.2 合同：只缓存同源版本化静态外壳；/api 与 /lifeos 永不进入缓存。
 */

test.beforeAll(async ({ request }) => {
  // Gateway healthz 就绪早于 DSH 插件激活；具名路由注册完成前，未命中请求被
  // SPA fallback 以 200 回退成 text/html。轮询到 bridge PWA 路由真实接管。
  await expect(async () => {
    const probe = await request.get("/pwa/register.js");
    expect(probe.status()).toBe(200);
    expect(String(probe.headers()["content-type"] ?? "")).toContain("application/javascript");
  }).toPass({ timeout: 90_000, intervals: [500, 1_000, 2_000] });
});

test("manifest 覆盖上游占位并携带可安装图标", async ({ request }) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.status()).toBe(200);
  expect(String(response.headers()["cache-control"] ?? "")).toContain("no-cache");
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = (await response.json()) as {
    name: string;
    display: string;
    icons: Array<{ src: string; sizes: string }>;
  };
  expect(manifest.name).toBe("Chat");
  expect(manifest.display).toBe("standalone");
  const sizes = manifest.icons.map((icon) => icon.sizes);
  expect(sizes).toContain("192x192");
  expect(sizes).toContain("512x512");
  for (const icon of manifest.icons) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.status(), icon.src).toBe(200);
    expect(iconResponse.headers()["content-type"]).toBe("image/png");
    expect(iconResponse.headers()["cache-control"]).toContain("immutable");
  }
});

test("index 注入 PWA 标签且 Service Worker 真实激活", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/pwa/icons/apple-touch-icon.png",
  );
  await expect(page.locator('script[src="/pwa/register.js"]')).toHaveCount(1);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    "content",
    "yes",
  );

  const swResponse = await page.request.get("/sw.js");
  expect(swResponse.status()).toBe(200);
  expect(swResponse.headers()["service-worker-allowed"]).toBe("/");

  // 等待注册脚本完成 Service Worker 激活。
  await page.waitForFunction(async () => {
    if (!("serviceWorker" in navigator)) return false;
    const registration = await navigator.serviceWorker.getRegistration("/");
    return registration?.active !== null && registration?.active !== undefined;
  });
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return registration?.scope ?? "";
  });
  expect(scope).toBe(`http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.web)}/`);
});

test("离线时导航回退到缓存外壳且 /lifeos 不被缓存", async ({ page, context }) => {
  await page.goto("/");
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return registration?.active != null;
  });
  // 让 SW 有机会缓存外壳与静态资产。
  await page.reload();
  await page.waitForLoadState("networkidle");

  await context.setOffline(true);
  try {
    // 产品 API 离线必须明确失败，绝不返回缓存的假数据。
    const apiResult = await page.evaluate(async () => {
      try {
        const response = await fetch("/lifeos/sessions/offline-probe");
        return { ok: response.ok, status: response.status };
      } catch {
        return { ok: false, status: 0 };
      }
    });
    expect(apiResult.ok).toBe(false);

    // 导航回退：缓存外壳或内置离线页，二选一都必须是真实 HTML 而非浏览器错误页。
    const response = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    const content = await page.content();
    expect(content.length).toBeGreaterThan(100);
  } finally {
    await context.setOffline(false);
  }
});
