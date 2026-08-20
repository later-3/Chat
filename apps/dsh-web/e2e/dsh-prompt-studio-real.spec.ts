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

async function openReadyConversation(page: Page) {
  await page.goto("/");
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  if (
    await continueButton
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await continueButton.click();
  }
  const composer = page.locator("textarea:visible").last();
  if (!(await composer.isEnabled())) {
    await page.getByRole("button", { name: /选择工作区|Choose workspace/u }).click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  }
  await expect(composer).toBeEnabled();
  return composer;
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
  await page.getByRole("button", { name: "区域说明", exact: true }).click();
  await expect(page.getByText("Chat 基础 Workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("工作对象 Workspace", { exact: true })).toBeVisible();
  await expect(page.getByText("打开配置文件", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "查看Agent 身份区域的组件", exact: true }).click();
  await expect(page.getByLabel("按区域筛选")).toHaveValue("agent_identity");
  await expect(page.getByRole("button", { name: /通用 Chat Agent 身份/u })).toBeVisible();
  await page.getByLabel("按区域筛选").selectOption("all");
  await page.getByRole("button", { name: "新建组件", exact: true }).click();
  const createForm = page.locator("form.lifeos-prompt-studio-editor");
  await expect(createForm).toBeVisible();
  await createForm
    .getByRole("combobox", { name: "区域", exact: true })
    .selectOption("custom_context");
  await createForm.getByRole("textbox", { name: "名称", exact: true }).fill("E2E 自定义上下文");
  await createForm.getByRole("textbox", { name: "Key", exact: true }).fill("target_audience");
  await createForm
    .getByRole("textbox", { name: "Markdown", exact: true })
    .fill("面向需要审阅 Prompt 来源的设计者。");
  await createForm.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByText("target_audience", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← 返回组件列表", exact: true }).click();

  await page.getByRole("button", { name: /通用 Chat Agent 身份/u }).click();
  const sourceBody = page.getByLabel("来源文件原文");
  await expect(sourceBody).toBeVisible();
  await expect(sourceBody.getByText("Git 来源文件", { exact: true })).toBeVisible();
  await expect(sourceBody.getByText(/你是 Chat 产品中的任务协作 Agent/u)).toBeVisible();
  await sourceBody.getByText("打开文件", { exact: true }).click();
  await expect(
    sourceBody.getByRole("button", { name: "Visual Studio Code", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: /基于 v\d+ 创建副本/u }).click();
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

test("会话发送前按Region选择并预览Direct Prompt Assembly", async ({ page }) => {
  const composer = await openReadyConversation(page);
  await page.getByTestId("lifeos-prompt-composer-open").click();
  const blankDialog = page.getByRole("dialog", { name: "本轮提示词" });
  const blankPreview = blankDialog.getByRole("button", { name: "预览本轮组装", exact: true });
  await expect(blankPreview).toBeEnabled();
  await blankPreview.click();
  await expect(blankDialog.getByRole("alert")).toContainText("请先输入本轮消息");
  await blankDialog.getByRole("button", { name: "关闭本轮提示词", exact: true }).click();

  const currentInput = "检查Prompt Assembly是否按区域组装";
  await composer.fill(currentInput);
  await page.getByTestId("lifeos-prompt-composer-open").click();

  const dialog = page.getByRole("dialog", { name: "本轮提示词" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Chat 工作区");
  await expect(dialog).toContainText("当前首版只在“执行 Agent（逐次提示词审核）”工作流发送时生效");

  const identity = page.getByTestId("lifeos-prompt-region-agent_identity");
  await expect(identity).toBeVisible();
  const builtinIdentity = identity
    .locator(".lifeos-prompt-choice-row")
    .filter({ hasText: "通用 Chat Agent 身份" });
  await expect(builtinIdentity.getByRole("checkbox")).toBeEnabled();
  await builtinIdentity.getByRole("checkbox").click();
  await expect(identity.getByRole("button", { name: "追加", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(builtinIdentity.getByRole("checkbox")).toBeChecked();

  await builtinIdentity.getByRole("button", { name: "查看", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "查看或修改提示词组件" });
  await expect(detail).toContainText("prompts/fragments/agent-identity/general-chat-agent.md");
  await expect(detail.getByLabel("来源文件原文")).toContainText("你是 Chat 产品中的任务协作 Agent");
  await detail.getByRole("button", { name: "关闭提示词组件管理", exact: true }).click();

  await identity.getByRole("button", { name: "新建", exact: true }).nth(1).click();
  const createDialog = page.getByRole("dialog", { name: "新建提示词组件" });
  await expect(createDialog).toContainText("Chat 工作区");
  await expect(createDialog).toContainText("Agent 身份");
  await expect(createDialog.getByRole("textbox", { name: "名称", exact: true })).toBeVisible();
  await createDialog.getByRole("button", { name: "关闭提示词组件管理", exact: true }).click();

  await page.getByRole("button", { name: "预览本轮组装", exact: true }).click();
  const preview = page.getByTestId("lifeos-prompt-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("前端发送前语义预览");
  await expect(preview).toContainText("不是最终 Provider HTTP 请求");
  await expect(preview).toContainText("agent_identity");
  await preview.getByText("查看编译后的 User Prompt", { exact: true }).click();
  await expect(preview).toContainText(currentInput);
});
