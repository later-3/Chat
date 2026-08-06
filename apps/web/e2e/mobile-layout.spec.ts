import { expect, test } from "@playwright/test";

/**
 * 手机宽度布局边界：页面根节点不允许横向滚动；
 * 工作流画布等宽内容只能在自己的容器内滚动。
 * 真实设备软键盘与安全区验收见任务书 §7.4（人工）。
 */

const PORTRAIT_WIDTHS = [320, 375, 390, 430] as const;
const LANDSCAPE = { width: 844, height: 390 } as const;

async function expectNoHorizontalScroll(page: import("@playwright/test").Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

test.describe("手机竖屏无页面级横向滚动", () => {
  for (const width of PORTRAIT_WIDTHS) {
    test(`${width}px 今日页与会话页无横向滚动`, async ({ page }) => {
      await page.setViewportSize({ width, height: 760 });
      await page.goto("/");
      await expect(page.getByRole("main", { name: "今日" })).toBeVisible();
      await expectNoHorizontalScroll(page);

      await page
        .getByRole("navigation", { name: "手机主导航" })
        .getByRole("button", { name: "会话" })
        .click();
      await page.getByRole("button", { name: "打开会话 整理季度 OKR 进展" }).click();
      await expect(page.getByLabel("消息输入框")).toBeVisible();
      await expectNoHorizontalScroll(page);

      // 工作流画布在自己的容器内滚动，不撑宽页面
      await page.getByRole("tab", { name: "工作" }).click();
      await expect(page.getByRole("region", { name: "工作窗口" })).toBeVisible();
      await expectNoHorizontalScroll(page);
    });
  }

  test("手机横屏无页面级横向滚动", async ({ page }) => {
    await page.setViewportSize(LANDSCAPE);
    await page.goto("/");
    await expect(page.getByRole("main", { name: "今日" })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("手机触控目标不小于 44px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "手机主导航" })
      .getByRole("button", { name: "会话" })
      .click();
    await page.getByRole("button", { name: "打开会话 整理季度 OKR 进展" }).click();

    const targets = [
      page.getByRole("tab", { name: "对话" }),
      page.getByRole("tab", { name: "工作" }),
      page.getByLabel("发送"),
      ...((await page
        .getByRole("navigation", { name: "手机主导航" })
        .getByRole("button")
        .all()) as []),
    ];
    for (const target of targets) {
      const box = await target.boundingBox();
      expect(box, (await target.textContent()) ?? "unknown target").toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
  });
});
