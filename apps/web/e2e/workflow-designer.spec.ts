import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { width: 375, height: 812, layout: "linear" },
  { width: 768, height: 1024, layout: "two-column" },
  { width: 1440, height: 900, layout: "three-column" },
] as const;

async function expectNoPageHorizontalScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1);
}

async function openDesigner(page: Page, width: number): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("main", { name: "真实规划会话" })).toBeVisible();
  if (width <= 760) await page.getByRole("tab", { name: "工作", exact: true }).click();
  await page.getByRole("tab", { name: "工作流设计器" }).click();
  await expect(page.getByRole("region", { name: "工作流 Definition 设计器" })).toBeVisible();
  await expect(page.getByRole("region", { name: "复制系统 Definition" })).toBeVisible();
  if (width > 760) {
    await expect(page.getByRole("region", { name: "持续对话" })).toBeVisible();
    await expect(page.getByLabel("消息输入框")).toBeInViewport();
  }
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.width}px真实copy→edit→validate→save→publish→archive/restore`, async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const browserRequests: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) => browserRequests.push(new URL(request.url()).pathname));
    await page.setViewportSize(viewport);
    await openDesigner(page, viewport.width);

    const copyPanel = page.getByRole("region", { name: "复制系统 Definition" });
    const copyTitle = `S6 ${String(viewport.width)}px 受约束副本`;
    await copyPanel.getByLabel("副本名称").fill(copyTitle);
    await copyPanel.getByLabel("说明").fill("真实浏览器验证语义编辑、CAS命令和响应式布局");
    await copyPanel.getByRole("button", { name: "创建可编辑副本" }).click();
    await expect(page.getByRole("heading", { name: copyTitle })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("已创建可编辑副本");

    const memory = page.locator(
      '.designer-node-card[data-node-id="planning.memory"] .designer-node-main',
    );
    await memory.click();
    await page.getByLabel("默认状态").selectOption("skipped");
    await expect(page.getByRole("status")).toContainText("有未保存语义修改");
    await expect(memory).toContainText("默认跳过");

    const validate = page.getByRole("button", { name: "服务端校验" });
    await expect(validate).toBeEnabled();
    await validate.click();
    await expect(page.getByRole("status")).toContainText("服务端校验通过");

    await page.getByRole("button", { name: "保存草稿" }).click();
    await expect(page.getByRole("status")).toContainText("草稿已保存");
    await expect(validate).toBeEnabled();
    await validate.click();
    await expect(page.getByRole("status")).toContainText("服务端校验通过");
    await expect(page.getByRole("button", { name: "发布" })).toBeEnabled();
    await page.getByRole("button", { name: "发布" }).click();
    await expect(page.getByRole("status")).toContainText("新版本已发布");

    await page.getByRole("button", { name: "归档" }).click();
    await expect(page.getByRole("button", { name: "恢复" })).toBeVisible();
    await page.getByRole("button", { name: "恢复" }).click();
    await expect(page.getByRole("button", { name: "归档" })).toBeVisible();

    const grid = page.locator(".workflow-designer-grid");
    const layout = await grid.evaluate((element) => ({
      display: getComputedStyle(element).display,
      columns: getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
    }));
    if (viewport.layout === "linear") {
      expect(layout.display).toBe("block");
      await expect(page.getByRole("list", { name: "受约束顺序结构" }).first()).toHaveCSS(
        "flex-direction",
        "column",
      );
    } else {
      expect(layout.display).toBe("grid");
      expect(layout.columns).toBe(viewport.layout === "two-column" ? 2 : 3);
    }
    await expect(page.locator(".react-flow__handle")).toHaveCount(0);
    await expectNoPageHorizontalScroll(page);
    expect(browserRequests.some((path) => path.startsWith("/internal/"))).toBe(false);
    expect(consoleErrors).toEqual([]);
  });
}

test("1440px真实Choice双分支→BoundedLoop→save→publish纵向场景", async ({ page }) => {
  const browserRequests: string[] = [];
  page.on("request", (request) => browserRequests.push(new URL(request.url()).pathname));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDesigner(page, 1440);

  const copyPanel = page.getByRole("region", { name: "复制系统 Definition" });
  const copyTitle = `S6 Choice Loop ${Date.now().toString(36)}`;
  await copyPanel.getByLabel("副本名称").fill(copyTitle);
  await copyPanel.getByLabel("说明").fill("真实结构操作、CAS保存与发布闭环");
  await copyPanel.getByRole("button", { name: "创建可编辑副本" }).click();
  await expect(page.getByRole("heading", { name: copyTitle })).toBeVisible();

  await page.getByRole("button", { name: /Bounded Loop · 最多 5 次/u }).click();
  await page.getByRole("button", { name: "展开 Bounded Loop" }).click();
  await page.locator('[data-node-id="planning.review"] .designer-node-main').click();
  await page.getByRole("button", { name: "按固定 outcome 创建 Choice" }).click();
  await expect(page.getByRole("heading", { name: "approved" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "rejected" })).toBeVisible();

  await page.locator('[data-node-id="planning.memory"] .designer-node-main').click();
  await page.getByRole("button", { name: "移入 planning.review → approved" }).click();
  await expect(
    page
      .getByRole("heading", { name: "approved" })
      .locator("..")
      .locator('[data-node-id="planning.memory"]'),
  ).toBeVisible();

  await page.locator('[data-node-id="planning.review"] .designer-node-main').click();
  await page.getByLabel("Bounded Loop 终点").selectOption("6");
  await page.getByLabel("新 Bounded Loop 最大迭代次数").fill("2");
  await page.getByLabel("新 Bounded Loop 超限策略").selectOption("request_human");
  await page.getByRole("button", { name: "包装所选范围" }).click();
  await expect(page.getByRole("button", { name: /Bounded Loop · 最多 2 次/u })).toBeVisible();
  await expect(page.getByRole("heading", { name: "approved" })).toBeVisible();

  const validate = page.getByRole("button", { name: "服务端校验" });
  await validate.click();
  await expect(page.getByRole("status")).toContainText("服务端校验通过");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  await validate.click();
  await expect(page.getByRole("status")).toContainText("服务端校验通过");
  await page.getByRole("button", { name: "发布" }).click();
  await expect(page.getByRole("status")).toContainText("新版本已发布");

  await expect(page.locator(".react-flow__handle")).toHaveCount(0);
  expect(browserRequests.some((path) => path.startsWith("/internal/"))).toBe(false);
});
