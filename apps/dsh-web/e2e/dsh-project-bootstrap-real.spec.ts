import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { DSH_PROJECT_BOOTSTRAP_E2E_PORTS } from "../../../scripts/e2e/dsh-real-environment.mjs";

const API = `http://127.0.0.1:${String(DSH_PROJECT_BOOTSTRAP_E2E_PORTS.api)}`;

interface BootstrapState {
  decisionCommandCount: number;
  providerReleased: boolean;
  providerCalls: {
    workspaceProvision: number;
    workspaceReconcile: number;
    planeProvision: number;
    planeReconcile: number;
  };
  submissions: unknown[];
  submissionBindings: Array<{ productSessionId: string; productRunId: string }>;
  candidate: {
    status: string;
    revision: number;
    sourceProductSessionId: string;
    sourceProductRunId: string;
  } | null;
  operation: { status: string; revision: number } | null;
  binding: { status: string; directoryName: string } | null;
  bootstrapOutbox: { status: string; dispatchAttempts: number } | null;
}

async function readState(request: APIRequestContext): Promise<BootstrapState> {
  const response = await request.get(`${API}/__project-bootstrap/state`);
  expect(response.status()).toBe(200);
  return (await response.json()) as BootstrapState;
}

async function openReadyConversation(page: Page, target = "/") {
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
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
    await page
      .getByRole("button", { name: /选择工作区|Choose workspace/u })
      .click({ timeout: 10_000 });
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click({ timeout: 10_000 });
  }
  await expect(composer).toBeEnabled();
  return composer;
}

test("真实DSH确认后关闭页面，耐久Outbox仍完成建项且下一轮恢复普通Workflow", async ({
  page,
  context,
  request,
}) => {
  await openReadyConversation(page);
  await page.getByTestId("lifeos-create-project").click();
  const composer = page.locator("textarea:visible").last();
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  await composer.fill("创建一个持续学习AI课程、论文和开源项目的项目");
  await page.getByRole("button", { name: /发送消息|Send message/u }).click();

  const card = page.getByTestId("lifeos-project-bootstrap-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("AI学习");
  await expect(page.getByTestId("lifeos-project-bootstrap-review")).toBeVisible();

  const confirmation = page.waitForResponse(
    (response) =>
      response.url().includes("/project-bootstrap-decisions") &&
      response.request().method() === "POST",
  );
  await page.getByTestId("lifeos-confirm-project-bootstrap").click();
  expect((await confirmation).status()).toBe(200);
  const persistedSessionUrl = page.url();

  await expect(async () => {
    const state = await readState(request);
    expect(state.decisionCommandCount).toBe(1);
    expect(state.operation?.status).toMatch(/queued|dispatching/u);
    expect(state.binding).toBeNull();
    expect(state.submissionBindings).toHaveLength(1);
    expect(state.candidate?.sourceProductSessionId).toBe(
      state.submissionBindings[0]?.productSessionId,
    );
    expect(state.candidate?.sourceProductRunId).toBe(state.submissionBindings[0]?.productRunId);
  }).toPass({ timeout: 10_000, intervals: [50, 100, 250] });

  // Provider闸门尚未释放；关闭真实浏览器页面后，后台API进程和Product Store继续存活。
  await page.close();
  const release = await request.post(`${API}/__project-bootstrap/release`);
  expect(release.status()).toBe(200);
  await expect(async () => {
    const state = await readState(request);
    expect(state.providerReleased).toBe(true);
    expect(state.candidate?.status).toBe("ready");
    expect(state.operation?.status).toBe("ready");
    expect(state.binding).toMatchObject({ status: "active", directoryName: "ai-learning" });
    expect(state.bootstrapOutbox?.status).toBe("acknowledged");
    expect(state.providerCalls).toEqual({
      workspaceProvision: 1,
      workspaceReconcile: 0,
      planeProvision: 1,
      planeReconcile: 0,
    });
  }).toPass({ timeout: 30_000, intervals: [50, 100, 250, 500] });

  // DSH Host持有会话；新页面恢复同一会话，ready目标仍来自Product Query而非页面内存。
  const restoredPage = await context.newPage();
  const restoredComposer = await openReadyConversation(restoredPage, persistedSessionUrl);
  await expect(restoredPage.getByTestId("lifeos-project-bootstrap-ready")).toBeVisible({
    timeout: 30_000,
  });
  await expect(restoredPage.getByTestId("lifeos-enter-project-workspace")).toBeVisible();
  await expect(restoredPage.getByTestId("lifeos-open-plane-project")).toBeVisible();

  await restoredComposer.fill("继续普通讨论，不再创建项目");
  await restoredPage.getByRole("button", { name: /发送消息|Send message/u }).click();
  await expect(async () => {
    const state = await readState(request);
    expect(state.submissions).toHaveLength(2);
    expect(state.submissionBindings).toHaveLength(2);
    expect(state.submissionBindings[1]?.productSessionId).toBe(
      state.submissionBindings[0]?.productSessionId,
    );
    expect(state.submissionBindings[1]?.productRunId).not.toBe(
      state.submissionBindings[0]?.productRunId,
    );
    expect(JSON.stringify(state.submissions[0])).toContain("project_bootstrap");
    expect(JSON.stringify(state.submissions[1])).not.toContain("project_bootstrap");
    expect(state.decisionCommandCount).toBe(1);
    expect(state.providerCalls.workspaceProvision).toBe(1);
    expect(state.providerCalls.planeProvision).toBe(1);
  }).toPass({ timeout: 30_000, intervals: [100, 250, 500] });
});
