import { expect, test, type Page } from "@playwright/test";

async function enterPromptStudio(page: Page): Promise<void> {
  // 首启Notice不是稳定必现状态：等它短暂挂载，出现则关闭，不出现就走正常设置入口。
  const notice = page.locator('[role="dialog"][aria-label="Internal Testing Notice"]').last();
  if (
    await notice
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await notice.getByText("Continue", { exact: true }).last().click();
  }
  // dsh-mobile-hanui在手机布局中把左侧栏收进可拖拽FAB；设置入口仍由DSH拥有。
  if ((page.viewportSize()?.width ?? 1_024) <= 1_023) {
    const mobileMenu = page.getByRole("button", { name: "打开菜单", exact: true });
    await expect(mobileMenu).toBeVisible({ timeout: 15_000 });
    await mobileMenu.click();
  }
  // rc.6窄侧栏只渲染设置图标，触发按钮没有可访问文本；公开合同是aria-haspopup=dialog。
  const settings = page.locator('button[aria-haspopup="dialog"]').last();
  await expect(settings).toBeVisible({ timeout: 15_000 });
  await settings.click();
  const promptEntry = page.getByRole("button", { name: "提示词", exact: true }).last();
  await expect(promptEntry).toBeVisible({ timeout: 15_000 });
  await promptEntry.click();
  await expect(page.getByTestId("lifeos-prompt-studio")).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  await expect(async () => {
    const response = await request.get("http://127.0.0.1:45111/api/readyz");
    expect(response.status(), await response.text()).toBe(200);
  }).toPass({ timeout: 30_000, intervals: [500, 1_000] });
  await expect(async () => {
    const response = await request.get("/lifeos/prompts/regions");
    expect(response.status()).toBe(200);
    expect(String(response.headers()["content-type"] ?? "")).toContain("application/json");
  }).toPass({ timeout: 20_000, intervals: [500, 1_000, 2_000] });
});

test("DSH Prompt Studio：查看Git来源、派生副本、保存新Revision并刷新恢复", async ({
  page,
  request,
}) => {
  const regions = await request.get("/lifeos/prompts/regions");
  const regionsText = await regions.text();
  expect(regionsText).toContain("agent_identity");
  expect(regionsText).toContain("prompts/regions/catalog.md");

  await page.goto("/");
  await enterPromptStudio(page);
  await page.getByRole("button", { name: "新建组件", exact: true }).click();
  await page.locator(".lifeos-prompt-studio-editor select").first().selectOption("custom_context");
  await page.getByLabel("名称").fill("E2E 自定义上下文");
  await page.getByLabel("Key").fill("target_audience");
  await page.getByLabel("Markdown").fill("面向需要审阅 Prompt 来源的设计者。");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByText("target_audience", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← 返回组件列表", exact: true }).click();

  await page.getByRole("button", { name: /通用 Chat Agent 身份/u }).click();
  await expect(
    page.getByText("prompts/fragments/agent-identity/general-chat-agent.md"),
  ).toBeVisible();
  await expect(page.getByText(/你是 Chat 产品中的任务协作 Agent/u)).toBeVisible();

  await page.getByRole("button", { name: "创建我的副本", exact: true }).click();
  await expect(page.getByText("我的版本化组件", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑当前版本", exact: true }).click();
  await page.getByLabel("名称").fill("E2E 任务 Agent");
  await page
    .getByLabel("Markdown")
    .fill("# E2E 任务 Agent\n\n只用于 Prompt Studio 真实浏览器验证。");
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await expect(page.getByRole("button", { name: "v2", exact: true })).toBeVisible();
  await expect(page.getByText("E2E 任务 Agent", { exact: true })).toBeVisible();

  await page.reload();
  await enterPromptStudio(page);
  await expect(page.getByRole("button", { name: /E2E 任务 Agent/u })).toBeVisible();

  const body = await request.get("/lifeos/prompts/fragments?limit=100");
  const text = await body.text();
  expect(text).toContain("E2E 任务 Agent");
  expect(text).not.toContain("只用于 Prompt Studio 真实浏览器验证");
});

test("Prompt Studio mobile 390×844保持单列且无横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await enterPromptStudio(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await expect(page.getByRole("button", { name: "新建组件", exact: true })).toBeVisible();
});
