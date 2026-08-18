import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const API = "http://127.0.0.1:43111";

async function waitForSubmitted(request: APIRequestContext): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request.get(`${API}/api/runs/run_trajectory1`);
    if (response.status() === 200) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("trajectory fixture did not receive the DSH message");
}

async function openReadyConversation(page: Page): Promise<void> {
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
  if (!(await composer.isEnabled())) {
    await page.getByRole("button", { name: /选择工作区|Choose workspace/u }).click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  }
  await expect(composer).toBeEnabled();
  await composer.fill("验证Pi执行轨迹实时显示");
  await page.getByRole("button", { name: /发送消息|Send message/u }).click();
}

test("rc.6 DSH原生轨迹实时呈现远端Pi工具输入、运行态和结果", async ({ page, request }) => {
  await openReadyConversation(page);
  await waitForSubmitted(request);

  const intent = await request.post(`${API}/__trajectory/intent`);
  expect(intent.status()).toBe(200);
  const trajectoryTab = page.getByRole("tab", { name: /轨迹|Trajectory/u });
  await expect(trajectoryTab).toBeVisible();
  await trajectoryTab.click();
  const toolRecord = page.getByText(/lifeos_trace|node --version/u).first();
  await expect(toolRecord).toBeVisible({ timeout: 30_000 });
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

  const browserSurface = await page.evaluate(() => document.documentElement.innerHTML);
  for (const marker of ["DASHSCOPE_API_KEY", "hookToken", "piRuntimeSessionId"]) {
    expect(browserSurface).not.toContain(marker);
  }
});
