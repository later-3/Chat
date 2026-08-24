import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { DSH_REAL_E2E_PORTS } from "../../../scripts/e2e/dsh-real-environment.mjs";

const API = `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.api)}`;
const FULL_PROMPT = `验证Pi执行轨迹实时显示\n${"完整会话正文-".repeat(
  300,
)}END_OF_UNTRUNCATED_SESSION_MESSAGE`;

async function waitForSubmitted(request: APIRequestContext): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request.get(`${API}/api/runs/run_trajectory1`);
    if (response.status() === 200) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("trajectory fixture did not receive the DSH message");
}

async function openReadyConversation(page: Page) {
  await page.goto("/");
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  if (
    await continueButton
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await continueButton.click();
  }
  const composer = page.locator("textarea:visible").last();
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  if (!(await composer.isEnabled())) {
    await page.getByRole("button", { name: /选择工作区|Choose workspace/u }).click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  }
  await expect(composer).toBeEnabled();
  return composer;
}

test("rc.6 DSH原生轨迹、双源会话记录与上下文注入保留完整过程", async ({ page, request }) => {
  test.setTimeout(120_000);
  const composer = await openReadyConversation(page);

  // 空会话没有纯预演合同：管理面板必须如实显示尚未组装，而不是复制
  // AGENTS/权限/Skill的上游逻辑来猜测首次请求内容。
  await page.getByTestId("lifeos-context-injections-open").click();
  const contextDialog = page.getByRole("dialog", { name: "DSH 宿主上下文" });
  await expect(contextDialog).toBeVisible();
  await expect(page.getByTestId("lifeos-context-not-assembled")).toBeVisible();
  await page.getByRole("button", { name: "关闭 DSH 宿主上下文" }).click();

  await composer.fill(FULL_PROMPT);
  await page.getByRole("button", { name: /发送消息|Send message/u }).click();
  await waitForSubmitted(request);

  // 首次pre-step完成后读取真实Session.deriveMessages surface；当前隔离Profile
  // 实际生成的Context均可追溯，且面板明确声明它不会绕过Prompt选择自动进入Chat。
  await page.getByTestId("lifeos-context-injections-open").click();
  await expect(contextDialog).toBeVisible();
  await expect(contextDialog.getByText("DSH Workspace 指令", { exact: true })).toBeVisible();
  await expect(contextDialog.getByText("DSH 运行时上下文", { exact: true })).toBeVisible();
  await expect(contextDialog).toContainText("只读 · 不自动转发到 Chat", { timeout: 30_000 });
  const workspaceInstructions = contextDialog.locator("details", {
    hasText: "DSH Workspace 指令",
  });
  await workspaceInstructions.locator("summary").click();
  await expect(workspaceInstructions).toContainText("Chat 项目协作规则");
  await page.getByRole("button", { name: "关闭 DSH 宿主上下文" }).click();

  const intent = await request.post(`${API}/__trajectory/intent`);
  expect(intent.status()).toBe(200);
  const trajectoryTab = page.getByRole("tab", { name: /轨迹|Trajectory/u });
  await expect(trajectoryTab).toBeVisible();
  await trajectoryTab.click();
  const toolRecord = page.getByText(/工具.*bash|node --version/u).first();
  await expect(toolRecord).toBeVisible({ timeout: 30_000 });
  // DSH的Trajectory可访问文本会折叠名称中的装饰分隔符“·”；
  // 用语义上稳定的Workflow标签和标题校验，不绑定具体排版字符。
  const workflowRecord = page.getByText(/Workflow.*轨迹验证工作流/u).first();
  await expect(workflowRecord).toBeVisible({ timeout: 30_000 });
  const timeline = page.getByRole("region", { name: "Trajectory timeline" });
  await expect(timeline).toBeVisible();
  const trajectoryTable = page.getByRole("table");
  await expect(
    // 顶层行的可访问名称包含轮次前缀（例如“Turn 1 TOOL”）；只绑定
    // 稳定的类型后缀，不把DSH的轮次展示文案冻结成Chat合同。
    trajectoryTable.getByRole("cell", { name: /TOOL$/u }).first(),
  ).toBeVisible();
  await expect(trajectoryTable.getByRole("cell", { name: "SUBTOOL", exact: true })).toHaveCount(9);
  const expandCalls = page.getByRole("button", { name: /展开调用|Expand calls/u });
  if (await expandCalls.isVisible().catch(() => false)) await expandCalls.click();
  for (const label of [
    /DSH.*用户输入与原生会话/u,
    /Bridge.*选择、审核与身份映射/u,
    /Chat.*Product Run 与 Workflow/u,
    /执行轨迹验证/u,
    /运行node --version/u,
    /执行 Agent/u,
    /模型：fixture\/model/u,
    /工具：bash/u,
  ]) {
    await expect(trajectoryTable.getByText(label).first()).toBeVisible();
  }
  await expect(page.getByText("TRACE_UI_RESULT_OK")).toHaveCount(0);

  const result = await request.post(`${API}/__trajectory/result`);
  expect(result.status()).toBe(200);
  const visibleResult = page.getByText("TRACE_UI_RESULT_OK").first();
  if (
    !(await visibleResult
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false))
  ) {
    await toolRecord.click();
  }
  await expect(visibleResult).toBeVisible({ timeout: 30_000 });

  const complete = await request.post(`${API}/__trajectory/complete`);
  expect(complete.status()).toBe(200);
  await page.getByRole("tab", { name: /对话|Chat/u }).click();
  await expect(page.getByText("TRAJECTORY_E2E_COMPLETED", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByTestId("lifeos-chat-session-open").click();
  const sessionDialog = page.getByRole("dialog", { name: "Chat Session 预览" });
  await expect(sessionDialog).toBeVisible();
  await expect(sessionDialog.getByText("Product Session", { exact: true })).toBeVisible();
  await expect(sessionDialog.getByText("DSH Session", { exact: true })).toBeVisible();
  await expect(sessionDialog.getByText(FULL_PROMPT, { exact: true })).toBeVisible();
  await expect(sessionDialog.getByText("TRAJECTORY_E2E_COMPLETED", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭 Chat Session 预览" }).click();

  await page.getByRole("tab", { name: "会话记录", exact: true }).click();
  const records = page.getByTestId("lifeos-session-records");
  await expect(records).toBeVisible();
  await expect(records.getByText("Product Session", { exact: true })).toBeVisible();
  await expect(records.getByText("DSH Session", { exact: true })).toBeVisible();
  await expect(records.getByText(FULL_PROMPT, { exact: true })).toBeVisible();
  await expect(records.getByText("TRAJECTORY_E2E_COMPLETED", { exact: true })).toBeVisible();

  await records.getByRole("tab", { name: "DSH 原始日志", exact: true }).click();
  const userEvent = records.locator("details", { hasText: "user/message" }).first();
  await userEvent.locator("summary").click();
  await expect(userEvent).toContainText("END_OF_UNTRUNCATED_SESSION_MESSAGE");

  const browserSurface = await page.evaluate(() => document.documentElement.innerHTML);
  for (const marker of ["DASHSCOPE_API_KEY", "hookToken", "piRuntimeSessionId"]) {
    expect(browserSurface).not.toContain(marker);
  }
});
