import { expect, test, type Page } from "@playwright/test";
import { DSH_PROMPT_STUDIO_E2E_PORTS } from "../../../scripts/e2e/dsh-real-environment.mjs";

async function enterSettingsSection(
  page: Page,
  name: "Agent" | "提示词",
  testId: "lifeos-agent-settings" | "lifeos-prompt-studio",
): Promise<void> {
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
  const entry = page.getByRole("button", { name, exact: true }).last();
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await entry.click();
  await expect(page.getByTestId(testId)).toBeVisible();
}

async function enterPromptStudio(page: Page): Promise<void> {
  await enterSettingsSection(page, "提示词", "lifeos-prompt-studio");
}

async function enterAgentSettings(page: Page): Promise<void> {
  await enterSettingsSection(page, "Agent", "lifeos-agent-settings");
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
    const response = await request.get(
      `http://127.0.0.1:${String(DSH_PROMPT_STUDIO_E2E_PORTS.api)}/api/readyz`,
    );
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
  await expect(
    page
      .getByText("打开配置文件", { exact: true })
      .first()
      .or(page.getByText("本机打开不可用", { exact: true }).first()),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Agent 身份/u })).toHaveCount(0);
  await page.getByRole("button", { name: "查看要求区域的组件", exact: true }).click();
  await expect(page.getByLabel("按区域筛选")).toHaveValue("requirements");
  await expect(page.getByRole("button", { name: /透明交付要求/u })).toBeVisible();
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

  await page.getByRole("button", { name: /透明交付要求/u }).click();
  const sourceBody = page.getByLabel("来源文件原文");
  await expect(sourceBody).toBeVisible();
  await expect(sourceBody.getByText("Git 来源文件", { exact: true })).toBeVisible();
  await expect(sourceBody.getByText(/先给出直接可用的结果/u)).toBeVisible();
  const openSource = sourceBody.getByText("打开文件", { exact: true });
  if (await openSource.isVisible()) {
    await openSource.click();
    await expect(
      sourceBody.locator(".lifeos-prompt-source-open-menu button").first(),
    ).toBeVisible();
  } else {
    await expect(sourceBody.getByText("本机打开不可用", { exact: true })).toBeVisible();
  }

  await page.getByRole("button", { name: /基于 v\d+ 创建副本/u }).click();
  await expect(page.getByText("我的版本化组件", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑当前版本", exact: true }).click();
  await page.getByLabel("名称").fill("E2E 交付要求");
  await page.getByLabel("Markdown").fill("# E2E 交付要求\n\n只用于 Prompt Studio 真实浏览器验证。");
  await page.getByRole("button", { name: "保存为新版本", exact: true }).click();
  await expect(page.getByRole("button", { name: "v2", exact: true })).toBeVisible();
  await expect(page.getByText("E2E 交付要求", { exact: true })).toBeVisible();

  await page.reload();
  await enterPromptStudio(page);
  await expect(page.getByRole("button", { name: /E2E 交付要求/u })).toBeVisible();

  const body = await request.get("/lifeos/prompts/fragments?limit=100");
  const text = await body.text();
  expect(text).toContain("E2E 交付要求");
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
  const scopedAgentProfiles = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/lifeos/agents" &&
      url.searchParams.get("workspaceRootId") === "root_chat" &&
      response.status() === 200
    );
  });
  await openConfiguration.click();
  await scopedAgentProfiles;
  let dialog = page.getByRole("dialog", { name: /配置 · 执行 Agent/u });
  await expect(dialog.getByTestId("lifeos-workflow-agent-scope")).toContainText("root_chat");
  const workflowResources = dialog.getByTestId("lifeos-agent-resource-inventory");
  await expect(workflowResources).toContainText("本版按类别启停，逐项选择尚未接入");
  await expect(workflowResources).toContainText("Extensions");
  await expect(workflowResources).toContainText("Skills");
  await expect(workflowResources).toContainText("Prompt Templates");
  await expect(workflowResources).toContainText("Context Files");
  await expect(workflowResources).toContainText("<WORKSPACE_ROOT>/AGENTS.md");
  await expect(dialog).toContainText("选择不可变Agent Version");
  await expect(dialog).toContainText("Pi默认基线");
  await expect(dialog).toContainText("Agent Version / Workflow节点");
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
  await dialog.getByRole("button", { name: "应用到当前会话", exact: true }).click();

  await page.reload();
  await expect(page.getByTestId("lifeos-workflow-config-open")).toBeVisible();
  await page.getByTestId("lifeos-workflow-config-open").click();
  dialog = page.getByRole("dialog", { name: /配置 · 执行 Agent/u });
  await expect(dialog.getByRole("switch", { name: "发送前审核提示词，当前关闭" })).toHaveAttribute(
    "aria-checked",
    "false",
  );

  await dialog.getByRole("button", { name: "恢复默认", exact: true }).click();
  await dialog.getByRole("button", { name: "应用到当前会话", exact: true }).click();
});

test("Agent默认、Workflow节点实例与本次会话覆盖是三个清晰作用域", async ({ page }) => {
  await openReadyConversation(page);
  await page.getByTestId("lifeos-workflow-current").click();
  await page.getByRole("menuitem", { name: /^规划执行工作流 规划 · 系统$/u }).click();
  await page.getByTestId("lifeos-workflow-config-open").click();
  const workflowDialog = page.getByRole("dialog", { name: /配置 · 规划执行工作流/u });
  await expect(workflowDialog).toContainText("Pi默认基线");
  await expect(workflowDialog).toContainText("Agent Version / Workflow节点");
  await expect(workflowDialog).toContainText("本次会话");
  await expect(workflowDialog).toContainText("规划 Agent");
  await expect(workflowDialog).toContainText("Pi Coding Agent · 规划步骤执行");
  const plannerPrompt = workflowDialog.getByRole("textbox", {
    name: "生成计划 System Prompt",
  });
  await expect(plannerPrompt).toBeVisible();
  const inherited = await plannerPrompt.inputValue();
  await plannerPrompt.fill(`${inherited}\n\n<!-- e2e-session-agent-override -->`);
  await expect(workflowDialog).toContainText("本次会话临时修改");
  await expect(
    workflowDialog.getByRole("button", { name: "保存到 Workflow", exact: true }).first(),
  ).toBeEnabled();
  await workflowDialog.getByRole("button", { name: "应用到当前会话", exact: true }).click();
  await page.getByTestId("lifeos-workflow-config-open").click();
  const transientDialog = page.getByRole("dialog", { name: /配置 · 规划执行工作流/u });
  await expect(transientDialog).toContainText("本次会话临时修改");
  await transientDialog
    .getByRole("button", { name: "保存到 Workflow", exact: true })
    .first()
    .click();
  await expect(page.getByTestId("lifeos-workflow-current")).toContainText("我的配置");

  await page.getByTestId("lifeos-workflow-config-open").click();
  const persistedDialog = page.getByRole("dialog", { name: /配置 · .*我的配置/u });
  await expect(persistedDialog).toContainText("Workflow已修改");
  const persistedPrompt = persistedDialog.getByRole("textbox", {
    name: "生成计划 System Prompt",
  });
  await expect(persistedPrompt).toHaveValue(/e2e-session-agent-override/u);
  await expect(
    persistedDialog.getByRole("button", { name: "保存到 Workflow", exact: true }).first(),
  ).toBeDisabled();
  await persistedPrompt.fill(`${await persistedPrompt.inputValue()}\n<!-- only-this-session -->`);
  await persistedDialog
    .getByRole("button", { name: "恢复 Workflow 值", exact: true })
    .first()
    .click();
  await expect(persistedPrompt).not.toHaveValue(/only-this-session/u);
  await persistedDialog.getByRole("button", { name: "关闭工作流配置", exact: true }).click();

  await page.getByTestId("lifeos-prompt-composer-open").click();
  const promptDialog = page.getByRole("dialog", { name: "本次 Prompt" });
  await expect(promptDialog).toContainText("这里不定义Agent身份、不选择Workflow节点");
  await expect(promptDialog.getByRole("tab")).toHaveCount(0);
  await expect(promptDialog).not.toContainText("生成计划");
  await expect(promptDialog).not.toContainText("执行计划");
  await expect(promptDialog.getByTestId("lifeos-prompt-region-agent_identity")).toHaveCount(0);
  await promptDialog.getByRole("button", { name: "关闭本次 Prompt", exact: true }).click();

  await enterAgentSettings(page);
  const agents = page.getByTestId("lifeos-agent-settings");
  await expect(agents).toContainText("项目初始化 Agent");
  const scopedSettingsProfiles = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/lifeos/agents" &&
      url.searchParams.get("workspaceRootId") === "root_chat" &&
      response.status() === 200
    );
  });
  await agents
    .getByRole("combobox", { name: "Agent Runtime Profile作用域", exact: true })
    .selectOption("root_chat");
  await scopedSettingsProfiles;
  await expect(agents.getByTestId("lifeos-agent-profile-scope")).toContainText("root_chat");
  await agents.getByRole("button", { name: /Pi Coding Agent · 直接执行/u }).click();
  const piBaseline = agents.getByTestId("lifeos-agent-runtime-baseline");
  await expect(piBaseline).toContainText("Pi Coding Agent 运行时基线");
  await expect(piBaseline).toContainText("@earendil-works/pi-coding-agent@0.84.2");
  await expect(piBaseline).toContainText("You are an expert coding assistant operating inside pi");
  await expect(piBaseline).toContainText("当前Pi默认Variant不追加Chat只读约束");
  await expect(piBaseline).toContainText("read");
  const sourceFiles = piBaseline.getByLabel("真实来源文件").first();
  await expect(sourceFiles).toContainText("pi/packages/coding-agent/src/core/system-prompt.ts");
  await expect(sourceFiles).toContainText("pi/packages/coding-agent/src/core/agent-session.ts");
  await expect(
    sourceFiles.getByRole("button", {
      name: /用 Visual Studio Code 打开 .*system-prompt\.ts/u,
    }),
  ).toBeVisible();
  const settingsLayout = agents.locator(".lifeos-agent-settings-layout");
  const agentDetail = settingsLayout.locator(":scope > article");
  await expect(agentDetail).toBeVisible();
  const layoutBox = await settingsLayout.boundingBox();
  const detailBox = await agentDetail.boundingBox();
  expect(detailBox?.width ?? 0).toBeGreaterThanOrEqual((layoutBox?.width ?? 0) - 2);
  expect(
    await agentDetail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await expect(agents).toContainText("Chat可管理的完整覆盖");
  const versionManager = agents.getByTestId("lifeos-agent-versions");
  await expect(versionManager).toContainText("Agent Version");
  await expect(versionManager).toContainText("Pi 默认基线");
  const toolCatalog = versionManager.getByRole("group", { name: "可选工具目录", exact: true });
  await expect(toolCatalog.getByRole("checkbox").first()).toBeVisible();
  for (const toolName of ["read", "bash", "edit", "write"]) {
    await expect(toolCatalog.getByRole("checkbox", { name: toolName, exact: true })).toBeChecked();
  }
  await expect(
    versionManager.getByRole("group", { name: "运行时资源", exact: true }).getByRole("checkbox"),
  ).toHaveCount(4);
  const versionResources = versionManager.getByTestId("lifeos-agent-resource-inventory");
  await expect(versionResources).toContainText("portable ID / 路径");
  await expect(versionResources).toContainText("<WORKSPACE_ROOT>/AGENTS.md");
  await versionManager
    .getByRole("textbox", { name: "Agent Version名称", exact: true })
    .fill("E2E Direct Version");
  await versionManager.getByRole("button", { name: "保存为新 Agent Version", exact: true }).click();
  await expect(versionManager.getByRole("button", { name: /E2E Direct Version/u })).toBeVisible();
  await agents.getByRole("button", { name: /Pi Coding Agent · 规划步骤执行/u }).click();
  await expect(agents.getByTestId("lifeos-agent-runtime-baseline")).toBeVisible();
  await expect(agents.getByTestId("lifeos-agent-version-readonly")).toContainText(
    "只读展示真实Runtime基线",
  );
  await expect(agents.getByTestId("lifeos-agent-versions")).toHaveCount(0);
  await agents.getByRole("button", { name: /规划 Agent/u }).click();
  await agents.getByText("旧默认 Prompt Revision（兼容入口）", { exact: true }).click();
  const prompt = agents.getByRole("textbox", {
    name: "旧默认 Agent System Prompt",
    exact: true,
  });
  const original = await prompt.inputValue();
  await prompt.fill(`${original}\n\n<!-- e2e-agent-revision -->`);
  await agents.getByRole("button", { name: "保存旧Prompt Revision", exact: true }).click();
  await expect(agents).toContainText(/我的覆盖 v\d+/u);
  await agents.getByRole("button", { name: "恢复 Chat 内置默认", exact: true }).click();
  await expect(agents).toContainText("内置默认");
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
  const blankDialog = page.getByRole("dialog", { name: "本次 Prompt" });
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
    name: "预览完整 Prompt",
    exact: true,
  });
  await expect(blankBridgePreview).toBeEnabled();
  await blankBridgePreview.click();
  await expect(blankDialog.getByRole("alert")).toContainText("请先输入本轮消息");
  await blankDialog.getByRole("button", { name: "关闭本次 Prompt", exact: true }).click();

  const currentInput = "检查Prompt Assembly是否按区域组装";
  await composer.fill(currentInput);
  await page.getByTestId("lifeos-prompt-composer-open").click();

  const dialog = page.getByRole("dialog", { name: "本次 Prompt" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Chat 工作区");
  await expect(dialog).toContainText(
    "这些上下文会提供给当前工作流实际调用的Agent。这里不定义Agent身份、不选择Workflow节点",
  );
  await expect(dialog.getByRole("tab")).toHaveCount(0);

  const requirements = page.getByTestId("lifeos-prompt-region-requirements");
  await expect(requirements).toBeVisible();
  const builtinRequirement = requirements
    .locator(".lifeos-prompt-choice-row")
    .filter({ hasText: "透明交付要求" });
  const requirementCheckbox = builtinRequirement.getByRole("checkbox");
  await expect(requirementCheckbox).toBeEnabled();
  if (!(await requirementCheckbox.isChecked())) await requirementCheckbox.click();
  await expect(requirements.getByRole("button", { name: "追加", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(builtinRequirement.getByRole("checkbox")).toBeChecked();

  await builtinRequirement.getByRole("button", { name: "查看", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "查看或修改提示词组件" });
  await expect(detail).toContainText("prompts/fragments/requirements/transparent-delivery.md");
  await expect(detail.getByLabel("来源文件原文")).toContainText("先给出直接可用的结果");
  await detail.getByRole("button", { name: "关闭提示词组件管理", exact: true }).click();

  await requirements.getByRole("button", { name: "新建", exact: true }).nth(1).click();
  const createDialog = page.getByRole("dialog", { name: "新建提示词组件" });
  await expect(createDialog).toContainText("Chat 工作区");
  await expect(createDialog).toContainText("要求");
  await expect(createDialog.getByRole("textbox", { name: "名称", exact: true })).toBeVisible();
  await createDialog.getByRole("button", { name: "关闭提示词组件管理", exact: true }).click();

  await page.getByRole("button", { name: "预览提示词配置", exact: true }).click();
  const promptPreview = page.getByTestId("lifeos-prompt-configuration-preview");
  await expect(promptPreview).toBeVisible();
  await expect(promptPreview).toContainText("提示词配置预览");
  await expect(promptPreview).toContainText("requirements");
  await expect(promptPreview).not.toContainText("agent_identity");
  await expect(promptPreview).not.toContainText(currentInput);

  await page.getByRole("button", { name: "预览完整 Prompt", exact: true }).click();
  const bridgePreview = page.getByTestId("lifeos-dsh-bridge-send-preview");
  await expect(bridgePreview).toBeVisible();
  await expect(bridgePreview).toContainText("本次 Prompt 与发送边界");
  await expect(bridgePreview.getByTestId("lifeos-prompt-turn-preview")).toContainText(
    "You are an expert coding assistant operating inside pi",
  );
  await expect(bridgePreview.getByTestId("lifeos-prompt-turn-preview")).toContainText(currentInput);
  await expect(bridgePreview.getByTestId("lifeos-prompt-turn-preview")).toContainText(
    "- bash: Execute bash commands",
  );
  await expect(bridgePreview.getByTestId("lifeos-prompt-turn-preview")).toContainText(
    "本次冻结Tools：无",
  );
  await expect(bridgePreview).toContainText("所有Workflow · 发送冻结Prompt Selection");
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

  await dialog.getByRole("button", { name: "关闭本次 Prompt", exact: true }).click();
  await page.getByTestId("lifeos-debug-review-toggle").click();
  const debugReviewPanel = page.locator('[aria-label="调试审核设置"]');
  const sendReviewSwitch = debugReviewPanel.getByRole("switch", {
    name: "DSH → Bridge，当前关闭",
  });
  await expect(sendReviewSwitch).toBeVisible();
  await sendReviewSwitch.click();
  await expect(
    debugReviewPanel.getByRole("switch", { name: "DSH → Bridge，当前开启" }),
  ).toHaveAttribute("aria-checked", "true");

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
  const auditLayout = await sendReview.evaluate((element) => {
    const scroll = element.querySelector<HTMLElement>(".lifeos-prompt-audit-scroll");
    if (scroll === null) throw new Error("Prompt审查滚动容器不存在");
    const nestedVerticalScrollers = [
      ...scroll.querySelectorAll<HTMLElement>("pre, .lifeos-prompt-body, .lifeos-prompt-sections"),
    ].filter((candidate) => {
      const overflowY = getComputedStyle(candidate).overflowY;
      return (
        (overflowY === "auto" || overflowY === "scroll") &&
        candidate.scrollHeight > candidate.clientHeight
      );
    }).length;
    return {
      width: element.getBoundingClientRect().width,
      scrollOverflowY: getComputedStyle(scroll).overflowY,
      nestedVerticalScrollers,
    };
  });
  expect(auditLayout.width).toBeGreaterThan(600);
  expect(auditLayout.scrollOverflowY).toBe("auto");
  expect(auditLayout.nestedVerticalScrollers).toBe(0);
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

  const enabledSwitch = debugReviewPanel.getByRole("switch", {
    name: "DSH → Bridge，当前开启",
  });
  await enabledSwitch.click();
  await expect(
    debugReviewPanel.getByRole("switch", { name: "DSH → Bridge，当前关闭" }),
  ).toHaveAttribute("aria-checked", "false");
});
