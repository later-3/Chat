import { expect, test, type Page } from "@playwright/test";

/**
 * Chat 移动端布局真实浏览器门（iPhone 视口 + 真实 DSH Host）。
 * 合同：Composer 底行控件不重叠、无横向滚动、侧边栏展开为全屏抽屉且遮罩
 * 点按关闭、视口合同含 viewport-fit 与软键盘缩放；桌面布局不受移动规则影响。
 * 这些断言同时是升级上游 DSH 版本时的选择器漂移合同。
 */

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

async function box(page: Page, selector: string) {
  const handle = page.locator(selector).first();
  await handle.waitFor({ state: "attached" });
  return handle.boundingBox();
}

async function dismissNoticeIfPresent(page: Page) {
  // E2E 隔离 profile 每次首启都会弹 DSH "Internal Testing Notice" 模态，
  // 其遮罩会拦截全部点击；真实用户只需关闭一次，测试中每次 goto 后先关闭。
  const noticeContinue = page.locator('[role="dialog"] button:has-text("Continue")');
  if (await noticeContinue.count()) {
    await noticeContinue.first().click();
    await expect(noticeContinue).toHaveCount(0);
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  // 等 DSH 客户端与 bridge 插件完成首屏装配。
  await page.locator('button[aria-label="Send message"]').waitFor({ state: "visible" });
  await dismissNoticeIfPresent(page);
});

test("视口合同升级且无横向滚动", async ({ page }) => {
  const viewport = await page.getAttribute('meta[name="viewport"]', "content");
  expect(viewport).toContain("viewport-fit=cover");
  expect(viewport).toContain("interactive-widget=resizes-content");
  const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});

test("Composer 底行控件互不重叠", async ({ page }) => {
  // Access mode 在手机上隐藏（安全边界在后端，桌面可调）。
  await expect(page.locator('button[aria-label*="Access mode" i]')).toBeHidden();
  const commands = await box(page, 'button[aria-label="Commands"]');
  const workflow = await box(page, ".lifeos-workflow-toggle");
  const model = await box(page, 'button[aria-label*="Select model" i]');
  const send = await box(page, 'button[aria-label="Send message"]');
  for (const [name, b] of Object.entries({ commands, workflow, model, send })) {
    expect(b, `${name} 必须可见`).not.toBeNull();
    expect(b!.width, `${name} 必须有可点击宽度`).toBeGreaterThan(20);
  }
  const controls = { commands: commands!, workflow: workflow!, model: model!, send: send! };
  const names = Object.keys(controls);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = controls[names[i] as keyof typeof controls];
      const b = controls[names[j] as keyof typeof controls];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      expect(
        overlapX,
        `${names[i]} 与 ${names[j]} 不得横向重叠（${Math.round(overlapX)}px）`,
      ).toBeLessThanOrEqual(1);
    }
  }
  // 最右的 send 不能超出视口。
  expect(send!.x + send!.width).toBeLessThanOrEqual(391);
});

test("侧边栏展开为全屏抽屉，遮罩点按关闭", async ({ page }) => {
  await page.click('button[aria-label="Open sidebar"]');
  const col = page.locator('[class*="sidebarCol"]').first();
  await expect(page.locator('button[aria-label="Collapse sidebar"]')).toBeVisible();
  // 展开态：固定定位浮层 + 遮罩存在。
  await expect(col).toHaveCSS("position", "fixed");
  const scrim = page.locator(".chat-mobile-scrim");
  await expect(scrim).toBeVisible();
  const colBox = await col.boundingBox();
  expect(colBox!.width).toBeLessThanOrEqual(320);
  // 点遮罩关闭抽屉：抽屉宽 ≤320px，遮罩可见区在其右侧。
  await page.mouse.click(350, 400);
  await expect(page.locator('button[aria-label="Open sidebar"]')).toBeVisible();
  await expect(page.locator(".chat-mobile-scrim")).toHaveCount(0);
});

test("桌面布局不受移动规则影响", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.locator('button[aria-label="Send message"]').waitFor({ state: "visible" });
  await dismissNoticeIfPresent(page);
  // 桌面默认展开或收起，侧边栏都必须是文档流列，且永远没有移动遮罩。
  const col = page.locator('[class*="sidebarCol"]').first();
  await expect(col).toHaveCSS("position", "static");
  await expect(page.locator(".chat-mobile-scrim")).toHaveCount(0);
  // Access mode 在桌面保持可见（只在小视口隐藏）。
  await expect(page.locator('button[aria-label*="Access mode" i]')).toBeVisible();
});
