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
  const composer = await openReadyConversation(page);
  const controlBar = page.getByTestId("lifeos-prompt-control-bar");
  await expect(controlBar).toBeVisible();
  const mobileBarBox = await controlBar.boundingBox();
  const mobileComposerBox = await composer.boundingBox();
  expect(mobileBarBox).not.toBeNull();
  expect(mobileComposerBox).not.toBeNull();
  expect(mobileBarBox!.y + mobileBarBox!.height).toBeLessThan(mobileComposerBox!.y);
  expect(mobileBarBox!.width).toBeLessThanOrEqual(390);
  await expect(controlBar.getByRole("switch")).toBeVisible();
  await expect(controlBar.getByTestId("lifeos-workflow-current")).toBeVisible();
  await expect(controlBar.getByTestId("lifeos-prompt-composer-open")).toBeVisible();
  await enterPromptStudio(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await expect(page.getByRole("button", { name: "新建组件", exact: true })).toBeVisible();
});

test("Direct Workflow可配置是否逐次审核提示词并在刷新后恢复", async ({ page }) => {
  await openReadyConversation(page);
  await page.getByTestId("lifeos-workflow-current").click();
  await page.getByRole("menuitem", { name: /执行 Agent（逐次提示词审核）/u }).click();

  const openConfiguration = page.getByTestId("lifeos-workflow-config-open");
  await expect(openConfiguration).toBeVisible();
  await openConfiguration.click();
  let dialog = page.getByRole("dialog", { name: /配置 · 执行 Agent/u });
  await expect(dialog).toContainText("配置只影响后续发送");
  await dialog.getByRole("button", { name: "恢复默认", exact: true }).click();
  const reviewSwitch = dialog.getByRole("switch", {
    name: "发送前审核提示词，当前开启",
  });
  await expect(reviewSwitch).toHaveAttribute("aria-checked", "true");
  await reviewSwitch.click();
  await expect(dialog.getByRole("switch", { name: "发送前审核提示词，当前关闭" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await dialog.getByRole("button", { name: "应用", exact: true }).click();

  await page.reload();
  await expect(page.getByTestId("lifeos-workflow-config-open")).toBeVisible();
  await page.getByTestId("lifeos-workflow-config-open").click();
  dialog = page.getByRole("dialog", { name: /配置 · 执行 Agent/u });
  await expect(dialog.getByRole("switch", { name: "发送前审核提示词，当前关闭" })).toHaveAttribute(
    "aria-checked",
    "false",
  );

  await dialog.getByRole("button", { name: "恢复默认", exact: true }).click();
  await dialog.getByRole("button", { name: "应用", exact: true }).click();
});

test("会话发送前分别预览Prompt配置与DSH到Bridge的真实发送边界", async ({ page }) => {
  const composer = await openReadyConversation(page);
  const controlBar = page.getByTestId("lifeos-prompt-control-bar");
  await expect(controlBar).toBeVisible();
  const controlBarBox = await controlBar.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(controlBarBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(controlBarBox!.y + controlBarBox!.height).toBeLessThan(composerBox!.y);
  expect(controlBarBox!.height).toBeLessThanOrEqual(44);
  const composerCard = composer.locator("xpath=ancestor::*[@data-composer-card]");
  await expect(composerCard.getByTestId("lifeos-workflow-current")).toHaveCount(0);
  await expect(composerCard.getByTestId("lifeos-prompt-composer-open")).toHaveCount(0);
  await expect(composerCard.getByRole("switch")).toHaveCount(0);
  await page.getByTestId("lifeos-workflow-current").click();
  await page.getByRole("menuitem", { name: /执行 Agent（逐次提示词审核）/u }).click();
  await page.getByTestId("lifeos-prompt-composer-open").click();
  const blankDialog = page.getByRole("dialog", { name: "本轮提示词" });
  const configurationPreview = blankDialog.getByRole("button", {
    name: "预览提示词配置",
    exact: true,
  });
  await expect(configurationPreview).toBeEnabled();
  await configurationPreview.click();
  const blankConfiguration = blankDialog.getByTestId("lifeos-prompt-configuration-preview");
  await expect(blankConfiguration).toBeVisible();
  await expect(blankConfiguration).toContainText("不包含用户输入或 DSH 上下文注入");
  const blankBridgePreview = blankDialog.getByRole("button", {
    name: "预览 DSH 发送",
    exact: true,
  });
  await expect(blankBridgePreview).toBeEnabled();
  await blankBridgePreview.click();
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

  await page.getByRole("button", { name: "预览提示词配置", exact: true }).click();
  const promptPreview = page.getByTestId("lifeos-prompt-configuration-preview");
  await expect(promptPreview).toBeVisible();
  await expect(promptPreview).toContainText("提示词配置预览");
  await expect(promptPreview).toContainText("agent_identity");
  await expect(promptPreview).not.toContainText(currentInput);

  await page.getByRole("button", { name: "预览 DSH 发送", exact: true }).click();
  const bridgePreview = page.getByTestId("lifeos-dsh-bridge-send-preview");
  await expect(bridgePreview).toBeVisible();
  await expect(bridgePreview).toContainText("DSH 前端发送预览");
  await expect(bridgePreview).toContainText("不是最终Provider HTTP请求");
  await expect(bridgePreview).toContainText("Direct · 发送Prompt Selection");
  await expect(bridgePreview).toContainText("一一对应证据");
  await expect(bridgePreview).toContainText("来源定位 · 仅界面注释，不发送");
  await expect(bridgePreview).toContainText("手动预览尚未进入Agent Loop");
  await expect(bridgePreview).toContainText("/promptSelection");
  await expect(bridgePreview).toContainText(currentInput);
  await expect(bridgePreview).toContainText("promptSelection");
  await bridgePreview.getByRole("tab", { name: "原始请求", exact: true }).click();
  await expect(bridgePreview.getByTestId("lifeos-dsh-adapter-request-pending")).toContainText(
    "尚未被Agent Loop组装",
  );
  await expect(bridgePreview.getByTestId("lifeos-bridge-chat-payload-raw")).toContainText(
    "promptSelection",
  );

  await dialog.getByRole("button", { name: "关闭本轮提示词", exact: true }).click();
  const sendReviewSwitch = page.getByRole("switch", { name: "DSH发送前审核，当前关闭" });
  await expect(sendReviewSwitch).toBeVisible();
  await sendReviewSwitch.click();
  await expect(page.getByRole("switch", { name: "DSH发送前审核，当前开启" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const sendReview = page.getByTestId("lifeos-dsh-send-review-card");
  await expect(sendReview).toBeVisible({ timeout: 15_000 });
  await expect(sendReview).toContainText("DSH → Bridge 发送前审核");
  await expect(sendReview).toContainText(currentInput);
  await expect(sendReview).toContainText("来源定位 · 仅界面注释，不发送");
  await expect(sendReview).toContainText("DSH → Bridge · 同一原始请求逐Pointer解析");
  await expect(sendReview).toContainText("/messages/");
  await expect(sendReview).toContainText("→ /text");
  await expect(sendReview).toContainText("逐值比较: 一致");
  await expect(sendReview).toContainText("dsh/packages/core/agent-loop/src/agent.ts");
  await sendReview.getByRole("tab", { name: "原始请求", exact: true }).click();
  const adapterRaw = sendReview.getByTestId("lifeos-dsh-adapter-request-raw");
  await expect(adapterRaw).toContainText('"provider": "lifeos"');
  await expect(adapterRaw).toContainText('"model": "workflow"');
  await expect(adapterRaw).toContainText('"messages"');
  await expect(adapterRaw).toContainText(currentInput);
  await expect(sendReview.getByTestId("lifeos-bridge-chat-payload-raw")).toContainText(
    "promptSelection",
  );
  await sendReview.getByRole("button", { name: "取消本次发送", exact: true }).click();
  await expect(sendReview).toBeHidden();

  const enabledSwitch = page.getByRole("switch", { name: "DSH发送前审核，当前开启" });
  await enabledSwitch.click();
  await expect(page.getByRole("switch", { name: "DSH发送前审核，当前关闭" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
});
