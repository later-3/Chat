import { expect, test, type Page } from "@playwright/test";
import {
  approvalDtoSchema,
  cursorPageSchema,
  messageDtoSchema,
  planDtoSchema,
  problemDetailSchema,
  productRunIdSchema,
  runDtoSchema,
  serviceStatusSchema,
} from "@chat/contracts/public";
import { z } from "zod";

const runResponseSchema = z.object({ run: runDtoSchema }).strict();
const plansResponseSchema = z.object({ items: z.array(planDtoSchema) }).strict();
const approvalResponseSchema = z.object({ approval: approvalDtoSchema.nullable() }).strict();
const messagesResponseSchema = cursorPageSchema(messageDtoSchema);

const FORBIDDEN_PUBLIC_MARKERS = [
  "workflowRunId",
  "hookToken",
  "piSessionId",
  "x-chat-runtime-key",
  "DASHSCOPE_API_KEY",
] as const;

function expectNoPrivateRuntimeIdentity(contentType: string, body: string): void {
  if (!contentType.includes("application/json")) return;
  for (const marker of FORBIDDEN_PUBLIC_MARKERS) {
    if (body.includes(marker)) throw new Error(`公开API响应包含私有Runtime标识：${marker}`);
  }
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function getActiveRunId(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const entry = Object.entries(localStorage).find(([key]) => key.startsWith("chat:real-run:v1:"));
    return entry?.[1] ?? null;
  });
  return productRunIdSchema.parse(value);
}

async function publicGet(page: Page, path: string): Promise<unknown> {
  const response = await page.evaluate(async (requestPath) => {
    const result = await fetch(requestPath);
    return { status: result.status, body: await result.json() };
  }, path);
  expect(response.status).toBe(200);
  return response.body;
}

async function submitStaleApproval(
  page: Page,
  input: {
    runId: string;
    expectedRevision: number;
    approvalRequestId: string;
    planId: string;
    planRevision: number;
    planSha256: string;
  },
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async (request) => {
    const result = await fetch(`/api/runs/${encodeURIComponent(request.runId)}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: "cmd_e2estaleplanapproval0001",
        expectedRevision: request.expectedRevision,
        payload: {
          approvalRequestId: request.approvalRequestId,
          planId: request.planId,
          planRevision: request.planRevision,
          planSha256: request.planSha256,
          kind: "approve",
        },
      }),
    });
    return { status: result.status, body: await result.json() };
  }, input);
}

test("真实 qwen3.7-plus：发送 -> Plan v1 -> 修改 -> v2 -> 批准 -> 正式结果", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    expectNoPrivateRuntimeIdentity(response.headers()["content-type"] ?? "", body.toString("utf8"));
    await route.fulfill({ response, body });
  });

  await page.goto("/");
  await expect(page.getByText("模型由服务端配置", { exact: true })).toBeVisible();
  expect(serviceStatusSchema.parse(await publicGet(page, "/api/readyz"))).toMatchObject({
    status: "ok",
    provider: { name: "bailian", ready: true },
  });
  await page
    .getByLabel("消息输入框")
    .fill(
      "本周完成登录模块联调并修复两个崩溃问题；下周进行支付对接。请先规划，再生成结构清楚的Markdown周报，必须包含风险与下一步。",
    );
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByRole("status")).toContainText(/正在规划|等待你确认计划/);

  const v1 = page.getByLabel("计划第1版");
  await expect(v1).toBeVisible();
  await expect(page.getByText("等待你确认计划")).toBeVisible();
  const v1Sha = await v1.getAttribute("data-plan-sha256");
  expect(v1Sha).toMatch(/^[a-f0-9]{64}$/);
  const runId = await getActiveRunId(page);
  const v1Approval = approvalResponseSchema.parse(
    await publicGet(page, `/api/runs/${encodeURIComponent(runId)}/approvals/current`),
  ).approval;
  expect(v1Approval?.planRevision).toBe(1);

  // 等待Hook期间刷新：只从服务端恢复同一Plan，不重新发送或启动第二条Run。
  await page.reload();
  await expect(page.getByLabel("计划第1版")).toBeVisible();
  await expect(page.getByLabel("计划第1版")).toHaveAttribute("data-plan-sha256", v1Sha ?? "");

  // 同一条真实路径切到375px，验证手机“对话/工作”切换与页面无横向滚动。
  await page.setViewportSize({ width: 375, height: 760 });
  await expectNoHorizontalScroll(page);
  await page.getByRole("tab", { name: "工作" }).click();
  await expect(page.getByRole("region", { name: "工作窗口" })).toBeVisible();

  await page.getByLabel("修改意见").fill("把风险单独成节，并增加下周三个行动项");
  await page.getByRole("button", { name: "要求修改" }).click();
  // 保留用户正在查看的旧review节点；新revision到达后由用户显式切到新的等待点。
  await page.getByRole("button", { name: "转到等待审核节点" }).click();
  const v2 = page.getByLabel("计划第2版");
  await expect(v2).toBeVisible();
  await expect(page.getByText("已被新版本取代")).toBeVisible();
  const v2Sha = await v2.getAttribute("data-plan-sha256");
  expect(v2Sha).toMatch(/^[a-f0-9]{64}$/);
  expect(v2Sha).not.toBe(v1Sha);

  const runBeforeApproval = runResponseSchema.parse(
    await publicGet(page, `/api/runs/${encodeURIComponent(runId)}`),
  ).run;
  const plansBeforeApproval = plansResponseSchema.parse(
    await publicGet(page, `/api/runs/${encodeURIComponent(runId)}/plans`),
  ).items;
  expect(plansBeforeApproval).toHaveLength(2);
  expect(plansBeforeApproval[0]?.status).toBe("superseded");
  expect(plansBeforeApproval[1]?.status).toBe("under_review");
  if (v1Approval === null) throw new Error("Plan v1 Approval缺失");
  const stale = await submitStaleApproval(page, {
    runId,
    expectedRevision: runBeforeApproval.revision,
    approvalRequestId: v1Approval.approvalRequestId,
    planId: v1Approval.planId,
    planRevision: v1Approval.planRevision,
    planSha256: v1Approval.planSha256,
  });
  expect(stale.status).toBe(409);
  expect(problemDetailSchema.parse(stale.body).code).toBe("approval_already_decided");

  await page.getByRole("button", { name: "通过" }).click();
  await expect(page.getByRole("status")).toContainText(/正在执行|正在验证|已完成/);
  await expect(page.getByText("工作已完成，正式结果已作为Assistant消息进入对话。")).toBeVisible({
    timeout: 8 * 60_000,
  });
  await page.getByRole("tab", { name: "对话" }).click();
  const assistantMessage = page.locator('.chat-message[data-role="assistant"]');
  await expect(assistantMessage).toContainText("风险");
  await expect(assistantMessage).toContainText(/下一步|下周计划|行动项/);

  // 完成后刷新：正式Assistant Message仍来自Message Query。
  await page.reload();
  const restoredAssistantMessage = page.locator('.chat-message[data-role="assistant"]');
  await expect(restoredAssistantMessage).toContainText("风险");
  await expect(restoredAssistantMessage).toContainText(/下一步|下周计划|行动项/);
  await expectNoHorizontalScroll(page);

  const finalRun = runResponseSchema.parse(
    await publicGet(page, `/api/runs/${encodeURIComponent(runId)}`),
  ).run;
  expect(finalRun.status).toBe("succeeded");
  expect(finalRun.phase).toBe("completed");
  const sessionId = await page.evaluate(() => {
    const raw = localStorage.getItem("chat:real-session:v1");
    return raw === null ? null : (JSON.parse(raw) as { sessionId?: unknown }).sessionId;
  });
  expect(typeof sessionId).toBe("string");
  const finalMessages = messagesResponseSchema.parse(
    await publicGet(page, `/api/sessions/${encodeURIComponent(String(sessionId))}/messages`),
  ).items;
  expect(finalMessages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(finalMessages.filter((message) => message.role === "assistant")).toHaveLength(1);

  const browserState = await page.evaluate(() => ({
    url: location.href,
    localStorage: Object.fromEntries(Object.entries(localStorage)),
    html: document.documentElement.innerHTML,
  }));
  const publicSurface = JSON.stringify(browserState);
  for (const marker of FORBIDDEN_PUBLIC_MARKERS) expect(publicSurface).not.toContain(marker);
});
