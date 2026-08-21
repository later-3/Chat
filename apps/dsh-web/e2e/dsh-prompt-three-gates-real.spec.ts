import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { DSH_PROMPT_THREE_GATES_E2E_PORTS } from "../../../scripts/e2e/dsh-real-environment.mjs";

const API_ORIGIN = `http://127.0.0.1:${String(DSH_PROMPT_THREE_GATES_E2E_PORTS.api)}`;
const API_READY_URL = `${API_ORIGIN}/api/readyz`;
const RUN_KEY = `three_gates_${Date.now().toString(36)}`;
const RULES_TITLE = `三闸门规则 ${RUN_KEY}`;
const RULES_BODY_MARKER = `THREE_GATE_RULE_BODY_${RUN_KEY}`;
const FIRST_USER_MARKER = `THREE_GATE_USER_ONE_${RUN_KEY}`;
const FIRST_ASSISTANT_MARKER = `THREE_GATE_ASSISTANT_ONE_${RUN_KEY}`;
const SECOND_USER_MARKER = `THREE_GATE_USER_TWO_${RUN_KEY}`;
const SECOND_ASSISTANT_MARKER = `THREE_GATE_ASSISTANT_TWO_${RUN_KEY}`;
const DIRECT_SYSTEM_OVERRIDE = `THREE_GATE_DIRECT_SYSTEM_OVERRIDE_${RUN_KEY}`;

async function overrideDirectAgentPrompt(request: APIRequestContext): Promise<void> {
  const currentResponse = await request.get(`${API_ORIGIN}/api/agent-profiles/direct`);
  expect(currentResponse.status(), await currentResponse.text()).toBe(200);
  const current = (await currentResponse.json()) as {
    systemPrompt: { aggregateRevision: number };
  };
  const response = await request.post(`${API_ORIGIN}/api/agent-profiles/direct/prompt-revisions`, {
    data: {
      commandId: `cmd_threegates${Date.now().toString(36)}`,
      payload: {
        expectedAggregateRevision: current.systemPrompt.aggregateRevision,
        bodyMarkdown: [
          "# Direct Agent E2E Override",
          "",
          DIRECT_SYSTEM_OVERRIDE,
          "",
          "严格完成当前用户请求，不扩大权限。",
        ].join("\n"),
      },
    },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function dismissNotice(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Continue", exact: true });
  if (
    await button
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await button.click();
  }
}

async function openConversation(page: Page): Promise<Locator> {
  await page.goto("/");
  await dismissNotice(page);
  const composer = page.locator("textarea:visible").last();
  if (!(await composer.isEnabled())) {
    await page.getByRole("button", { name: /选择工作区|Choose workspace/u }).click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  }
  await expect(composer).toBeEnabled();
  return composer;
}

async function chooseDirectWorkflow(page: Page): Promise<void> {
  await page.getByTestId("lifeos-workflow-current").click();
  await page.getByRole("menuitem", { name: /执行 Agent（逐次提示词审核）/u }).click();
  await expect(page.getByTestId("lifeos-workflow-current")).toContainText(
    "执行 Agent（逐次提示词审核）",
  );
}

async function configureVersionedPrompts(page: Page): Promise<void> {
  await page.getByTestId("lifeos-prompt-composer-open").click();
  const promptDialog = page.getByRole("dialog", { name: "本次 Prompt" });
  await expect(promptDialog).toBeVisible();
  await expect(page.getByTestId("lifeos-prompt-region-agent_identity")).toHaveCount(0);

  const rules = page.getByTestId("lifeos-prompt-region-rules");
  await rules.getByRole("button", { name: "新建", exact: true }).first().click();
  const create = page.getByRole("dialog", { name: "新建提示词组件" });
  await expect(create).toContainText("规则与规范");
  await create.getByRole("textbox", { name: "名称", exact: true }).fill(RULES_TITLE);
  await create
    .getByRole("textbox", { name: "Markdown 内容", exact: true })
    .fill(
      [
        `# ${RULES_TITLE}`,
        "",
        RULES_BODY_MARKER,
        "",
        "不得调用任何工具。回复必须且只能是当前用户在 OUTPUT= 后给出的标记。",
      ].join("\n"),
    );
  await create.getByRole("button", { name: "创建组件", exact: true }).click();
  const createdManager = page.getByRole("dialog", { name: "查看或修改提示词组件" });
  await expect(createdManager).toContainText(RULES_BODY_MARKER);
  await createdManager.getByRole("button", { name: "关闭提示词组件管理", exact: true }).click();

  const createdRules = rules.locator(".lifeos-prompt-choice-row").filter({ hasText: RULES_TITLE });
  await expect(createdRules.getByRole("checkbox", { name: `选择${RULES_TITLE}` })).toBeEnabled();
  await createdRules.getByRole("checkbox", { name: `选择${RULES_TITLE}` }).click();
  await expect(createdRules.getByRole("checkbox", { name: `选择${RULES_TITLE}` })).toBeChecked();

  await promptDialog.getByRole("button", { name: "预览提示词配置", exact: true }).click();
  const preview = promptDialog.getByTestId("lifeos-prompt-configuration-preview");
  await expect(preview).toContainText(RULES_TITLE);
  await expect(preview).toContainText(RULES_BODY_MARKER);
  await expect(preview).not.toContainText("agent_identity");
  await expect(preview).toContainText("rules");
  await promptDialog.getByRole("button", { name: "关闭本次 Prompt", exact: true }).click();
  await expect(page.getByTestId("lifeos-prompt-composer-open")).toContainText("1");
}

async function enableBothBridgeGates(page: Page): Promise<void> {
  const control = page.getByTestId("lifeos-debug-review-toggle");
  await expect(control).toHaveAttribute("aria-label", "调试审核，已开启0项，共2项");
  await control.click();
  const dsh = page.getByRole("switch", { name: "DSH → Bridge，当前关闭", exact: true });
  const bridge = page.getByRole("switch", {
    name: "Bridge → Chat后端，当前关闭",
    exact: true,
  });
  await dsh.click();
  await expect(
    page.getByRole("switch", { name: "DSH → Bridge，当前开启", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await bridge.click();
  await expect(
    page.getByRole("switch", { name: "Bridge → Chat后端，当前开启", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(control).toHaveAttribute("aria-label", "调试审核，已开启2项，共2项");
  await control.click();
}

async function approveDshGate(
  page: Page,
  currentInput: string,
  history?: { readonly user: string; readonly assistant: string },
): Promise<void> {
  const card = page.getByTestId("lifeos-dsh-send-review-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("DSH → Bridge 发送前审核");
  await card.getByRole("tab", { name: "易读视图", exact: true }).click();
  const friendly = card.getByTestId("lifeos-dsh-bridge-readable");
  await expect(friendly).toContainText(currentInput);
  await expect(friendly).toContainText("逐值比较: 一致");
  await expect(friendly).toContainText("/promptSelection");
  if (history !== undefined) {
    await expect(friendly).toContainText(history.user);
    await expect(friendly).toContainText(history.assistant);
  }

  const toolGroup = card.getByTestId("lifeos-dsh-tool-group");
  await expect(toolGroup).toBeVisible();
  await expect(toolGroup).not.toHaveAttribute("open", "");
  await expect(toolGroup).toContainText("默认折叠，展开后可逐个检查");
  await toolGroup.locator(":scope > summary").click();
  const firstTool = toolGroup.getByTestId("lifeos-dsh-tool-item").first();
  await expect(firstTool).toBeVisible();
  await expect(firstTool).not.toHaveAttribute("open", "");
  await firstTool.locator(":scope > summary").click();
  await expect(firstTool).toContainText("/tools/0");
  await expect(firstTool).toContainText("该Pointer对应的完整原始JSON值");

  await card.getByRole("tab", { name: "原始请求", exact: true }).click();
  const dshRaw = card.getByTestId("lifeos-dsh-adapter-request-raw");
  const bridgeRaw = card.getByTestId("lifeos-bridge-chat-payload-raw");
  await expect(dshRaw).toContainText(currentInput);
  await expect(bridgeRaw).toContainText(currentInput);
  await expect(bridgeRaw).toContainText('"promptSelection"');
  await expect(bridgeRaw).not.toContainText('"agent_identity"');
  await expect(bridgeRaw).toContainText('"rules"');
  await expect(bridgeRaw).not.toContainText(RULES_BODY_MARKER);
  await expect(bridgeRaw).not.toContainText('"context"');
  if (history !== undefined) {
    await expect(dshRaw).toContainText(history.user);
    await expect(dshRaw).toContainText(history.assistant);
    await expect(bridgeRaw).not.toContainText(history.user);
    await expect(bridgeRaw).not.toContainText(history.assistant);
  }
  await card.getByRole("button", { name: "批准并进入 Bridge", exact: true }).click();
}

async function approveBridgeGate(
  page: Page,
  currentInput: string,
  excludedHistory?: { readonly user: string; readonly assistant: string },
): Promise<void> {
  const card = page.getByTestId("lifeos-bridge-dispatch-review-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Bridge → Chat后端 发送前审核");
  await expect(card).toContainText("HTTP操作：1");
  await card.getByRole("tab", { name: "易读视图", exact: true }).click();
  const friendly = card.getByTestId("lifeos-bridge-dispatch-readable");
  await expect(friendly).toContainText(currentInput);
  await expect(friendly).toContainText("Prompt区域选择");
  await expect(friendly).not.toContainText("agent_identity");
  await expect(friendly).toContainText("rules");
  await expect(friendly).not.toContainText(RULES_BODY_MARKER);

  await card.getByRole("tab", { name: "原始请求", exact: true }).click();
  const raw = card.getByTestId("lifeos-bridge-dispatch-raw");
  await expect(raw).toContainText(currentInput);
  await expect(raw).toContainText('"commandId"');
  await expect(raw).toContainText('"promptSelection"');
  await expect(raw).not.toContainText('"agent_identity"');
  await expect(raw).toContainText('"rules"');
  await expect(raw).not.toContainText(RULES_BODY_MARKER);
  if (excludedHistory !== undefined) {
    await expect(raw).not.toContainText(excludedHistory.user);
    await expect(raw).not.toContainText(excludedHistory.assistant);
  }
  await card.getByRole("button", { name: "批准并发送到Chat后端", exact: true }).click();
}

async function waitForProviderReviewOrAssistant(
  page: Page,
  approvedRequestIndex: number,
  assistantMarker: string,
): Promise<"assistant" | number> {
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    if (
      await page
        .getByText(assistantMarker, { exact: true })
        .last()
        .isVisible()
        .catch(() => false)
    ) {
      return "assistant";
    }
    const card = page.getByTestId("lifeos-prompt-review-card");
    if (await card.isVisible().catch(() => false)) {
      const text = await card
        .getByText(/Pi Coding Agent · 第 \d+ 次发送审核/u)
        .textContent()
        .catch(() => null);
      const requestIndex = /第\s+(\d+)\s+次/u.exec(text ?? "")?.[1];
      if (requestIndex !== undefined && Number(requestIndex) > approvedRequestIndex) {
        return Number(requestIndex);
      }
    }
    const failure = page.getByText("This turn failed", { exact: false });
    if (await failure.isVisible().catch(() => false)) {
      throw new Error(`真实Direct轮次失败：${(await failure.textContent()) ?? "unknown"}`);
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`等待Provider下一次审核或Assistant超时：${assistantMarker}`);
}

async function approveProviderUntilAssistant(input: {
  readonly page: Page;
  readonly assistantMarker: string;
  readonly inspectFirstReview: (card: Locator) => Promise<void>;
}): Promise<readonly number[]> {
  const indexes: number[] = [];
  let nextIndex = 1;
  for (;;) {
    const card = input.page.getByTestId("lifeos-prompt-review-card");
    await expect(card).toBeVisible({ timeout: 6 * 60_000 });
    await expect(
      card.getByText(`Pi Coding Agent · 第 ${String(nextIndex)} 次发送审核`, { exact: true }),
    ).toBeVisible();
    if (indexes.length === 0) await input.inspectFirstReview(card);
    indexes.push(nextIndex);
    await card.getByTestId("lifeos-approve-prompt").click();
    const outcome = await waitForProviderReviewOrAssistant(
      input.page,
      nextIndex,
      input.assistantMarker,
    );
    if (outcome === "assistant") {
      console.log(
        `[three-gates-e2e] ${input.assistantMarker} provider request indexes=${indexes.join(",")}`,
      );
      return indexes;
    }
    nextIndex = outcome;
  }
}

test.beforeAll(async ({ request }) => {
  await expect(async () => {
    const response = await request.get(API_READY_URL);
    expect(response.status(), await response.text()).toBe(200);
  }).toPass({ timeout: 60_000, intervals: [500, 1_000, 2_000] });
});

test("真实DSH两轮会话依次通过三道审核并保持Prompt Revision与正式历史", async ({
  page,
  request,
}) => {
  const composer = await test.step("打开真实DSH会话", () => openConversation(page));
  await test.step("选择Direct审核工作流", () => chooseDirectWorkflow(page));
  await test.step("把Direct Agent完整覆盖为本次E2E身份", () => overrideDirectAgentPrompt(request));
  await test.step("创建并选择会话规则Prompt", () => configureVersionedPrompts(page));
  await test.step("开启DSH与Bridge两道调试审核", () => enableBothBridgeGates(page));

  const firstInput = `${FIRST_USER_MARKER}。不要调用工具。OUTPUT=${FIRST_ASSISTANT_MARKER}`;
  await composer.fill(firstInput);
  await page.getByRole("button", { name: /发送消息|Send message/u }).click();

  await test.step("第一轮批准DSH到Bridge", () => approveDshGate(page, firstInput));
  await test.step("第一轮批准Bridge到Chat", () => approveBridgeGate(page, firstInput));
  const firstProviderIndexes = await approveProviderUntilAssistant({
    page,
    assistantMarker: FIRST_ASSISTANT_MARKER,
    inspectFirstReview: async (card) => {
      const readable = card.getByTestId("lifeos-prompt-readable");
      await expect(readable).toContainText(DIRECT_SYSTEM_OVERRIDE);
      await expect(readable).not.toContainText(
        "You are an expert coding assistant operating inside pi",
      );
      await expect(readable).toContainText(RULES_BODY_MARKER);
      await expect(readable).toContainText(firstInput);
      await expect(readable).toContainText("Chat Prompt Assembly · System区域");
      await card.getByRole("tab", { name: "原始请求", exact: true }).click();
      const raw = card.getByTestId("lifeos-prompt-raw");
      await expect(raw).toContainText(DIRECT_SYSTEM_OVERRIDE);
      await expect(raw).not.toContainText("You are an expert coding assistant operating inside pi");
      await expect(raw).toContainText(RULES_BODY_MARKER);
      await expect(raw).toContainText(firstInput);
    },
  });
  expect(firstProviderIndexes.length).toBeGreaterThanOrEqual(1);
  await expect(page.getByText(FIRST_ASSISTANT_MARKER, { exact: true }).last()).toBeVisible();

  const secondComposer = page.locator("textarea:visible").last();
  await expect(secondComposer).toBeEnabled({ timeout: 60_000 });
  const secondInput = `${SECOND_USER_MARKER}。沿用本会话已经选择的Prompt，不要调用工具。OUTPUT=${SECOND_ASSISTANT_MARKER}`;
  await secondComposer.fill(secondInput);
  await page.getByTestId("lifeos-prompt-composer-open").click();
  const secondPromptDialog = page.getByRole("dialog", { name: "本次 Prompt" });
  await secondPromptDialog.getByRole("button", { name: "预览完整 Prompt", exact: true }).click();
  const promptTurnPreview = secondPromptDialog.getByTestId("lifeos-prompt-turn-preview");
  await expect(promptTurnPreview.getByTestId("lifeos-prompt-messages")).toContainText(firstInput);
  await expect(promptTurnPreview.getByTestId("lifeos-prompt-messages")).toContainText(
    FIRST_ASSISTANT_MARKER,
  );
  await expect(promptTurnPreview.getByTestId("lifeos-prompt-messages")).toContainText(secondInput);
  await expect(promptTurnPreview).toContainText(DIRECT_SYSTEM_OVERRIDE);
  await expect(promptTurnPreview).not.toContainText(
    "You are an expert coding assistant operating inside pi",
  );
  await secondPromptDialog.getByRole("button", { name: "关闭本次 Prompt", exact: true }).click();
  await page.getByRole("button", { name: /发送消息|Send message/u }).click();

  const firstHistory = { user: firstInput, assistant: FIRST_ASSISTANT_MARKER } as const;
  await test.step("第二轮批准DSH到Bridge", () => approveDshGate(page, secondInput, firstHistory));
  await test.step("第二轮批准Bridge到Chat", () =>
    approveBridgeGate(page, secondInput, firstHistory));
  const secondProviderIndexes = await approveProviderUntilAssistant({
    page,
    assistantMarker: SECOND_ASSISTANT_MARKER,
    inspectFirstReview: async (card) => {
      await card.getByRole("tab", { name: "易读视图", exact: true }).click();
      const readable = card.getByTestId("lifeos-prompt-readable");
      await expect(readable).toContainText(DIRECT_SYSTEM_OVERRIDE);
      await expect(readable).not.toContainText(
        "You are an expert coding assistant operating inside pi",
      );
      await expect(readable).toContainText(RULES_BODY_MARKER);
      await expect(readable).toContainText(firstInput);
      await expect(readable).toContainText(FIRST_ASSISTANT_MARKER);
      await expect(readable).toContainText(secondInput);
      await expect(readable).toContainText("Chat Product Session · 已提交历史消息");
      await expect(readable).toContainText("模型历史回复");
      await card.getByRole("tab", { name: "原始请求", exact: true }).click();
      const raw = card.getByTestId("lifeos-prompt-raw");
      await expect(raw).toContainText(DIRECT_SYSTEM_OVERRIDE);
      await expect(raw).not.toContainText("You are an expert coding assistant operating inside pi");
      await expect(raw).toContainText(RULES_BODY_MARKER);
      await expect(raw).toContainText(firstInput);
      await expect(raw).toContainText(FIRST_ASSISTANT_MARKER);
      await expect(raw).toContainText(secondInput);
    },
  });
  expect(secondProviderIndexes.length).toBeGreaterThanOrEqual(1);
  await expect(page.getByText(SECOND_ASSISTANT_MARKER, { exact: true }).last()).toBeVisible();
  await expect(page.getByTestId("lifeos-prompt-review-card")).toHaveCount(0);
});
