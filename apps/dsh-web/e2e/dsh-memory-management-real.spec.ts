import { expect, test, type Page } from "@playwright/test";
import { DSH_MEMORY_MANAGEMENT_E2E_PORTS } from "../../../scripts/e2e/dsh-real-environment.mjs";

async function dismissNoticeIfPresent(page: Page): Promise<void> {
  const notice = page.locator('[role="dialog"][aria-label="Internal Testing Notice"]').last();
  if (
    await notice
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await notice.getByText("Continue", { exact: true }).last().click();
  }
}

async function enterMemorySettings(page: Page): Promise<void> {
  await page.goto("/");
  await dismissNoticeIfPresent(page);
  if ((page.viewportSize()?.width ?? 1_024) <= 1_023) {
    const mobileMenu = page.getByRole("button", { name: "打开菜单", exact: true });
    await expect(mobileMenu).toBeVisible({ timeout: 15_000 });
    await mobileMenu.click();
  }
  // rc.6侧栏的Settings触发器只承诺dialog语义，不暴露稳定可访问文本。
  const settings = page.locator('button[aria-haspopup="dialog"]').last();
  await expect(settings).toBeVisible({ timeout: 15_000 });
  await settings.click();
  const entry = page.getByRole("button", { name: "Memory", exact: true }).last();
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await entry.click();
  await expect(page.getByTestId("lifeos-memory-management")).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  await expect(async () => {
    const ready = await request.get(
      `http://127.0.0.1:${String(DSH_MEMORY_MANAGEMENT_E2E_PORTS.api)}/api/readyz`,
    );
    expect(ready.status(), await ready.text()).toBe(200);
  }).toPass({ timeout: 30_000, intervals: [500, 1_000] });

  // 通过真实 DSH Host/Bridge 同源路由验证默认-off Registry，不能直连API绕过Host。
  await expect(async () => {
    const response = await request.get("/lifeos/memory/providers");
    expect(response.status(), await response.text()).toBe(200);
    expect(String(response.headers()["content-type"] ?? "")).toContain("application/json");
    expect(await response.json()).toEqual({ providers: [] });
  }).toPass({ timeout: 30_000, intervals: [500, 1_000, 2_000] });
});

test("默认-off：桌面 Settings 的 Memory 三页签真实可见", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await enterMemorySettings(page);
  const surface = page.getByTestId("lifeos-memory-management");
  await expect(surface.getByRole("tab", { name: "写入候选", exact: true })).toBeVisible();
  await expect(surface.getByRole("tab", { name: "Provider 比较", exact: true })).toBeVisible();
  await expect(surface.getByRole("tab", { name: "Session 导入", exact: true })).toBeVisible();
  await expect(surface.getByTestId("lifeos-memory-candidates")).toContainText("目前没有待审核");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
});

test("默认-off：390px Settings 的 Memory 三页签无页面横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enterMemorySettings(page);
  const surface = page.getByTestId("lifeos-memory-management");
  await expect(surface.getByRole("tab", { name: "写入候选", exact: true })).toBeVisible();
  await expect(surface.getByRole("tab", { name: "Provider 比较", exact: true })).toBeVisible();
  await expect(surface.getByRole("tab", { name: "Session 导入", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
});
