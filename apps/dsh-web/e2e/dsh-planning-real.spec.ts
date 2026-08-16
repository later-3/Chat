import { expect, test, type APIRequestContext, type Page, type Response } from "@playwright/test";
import { cursorPageSchema, messageDtoSchema, runDtoSchema } from "@chat/contracts/public";
import { z } from "zod";

const BRIDGE_PACKAGE = "@chat/dsh-lifeos-bridge";
const COMPLETION_MARKER = "DSH_REAL_E2E_COMPLETED_20260816";
const runResponseSchema = z.object({ run: runDtoSchema }).strict();
const messagesResponseSchema = cursorPageSchema(messageDtoSchema);
const projectionSchema = z
  .object({
    dshSessionId: z.string().min(1),
    run: z
      .object({
        productRunId: z.string().min(1),
        status: z.string().min(1),
        phase: z.string().min(1),
        failure: z.object({ code: z.string().min(1), summary: z.string().min(1) }).optional(),
      })
      .nullable(),
    plan: z.object({ planRevision: z.number().int().positive() }).nullable(),
    approval: z.object({ status: z.string().min(1) }).nullable(),
  })
  .passthrough();

const PRIVATE_MARKERS = [
  "workflowRunId",
  "hookToken",
  "piSessionId",
  "x-chat-runtime-key",
  "DASHSCOPE_API_KEY",
] as const;

type Projection = z.infer<typeof projectionSchema>;

function projectionResponse(response: Response): boolean {
  const url = new URL(response.url());
  return (
    url.origin === "http://127.0.0.1:43110" &&
    /^\/lifeos\/sessions\/[^/]+$/u.test(url.pathname) &&
    response.request().method() === "GET"
  );
}

async function readProjection(response: Response): Promise<Projection> {
  expect(response.status()).toBe(200);
  const text = await response.text();
  for (const marker of PRIVATE_MARKERS) expect(text).not.toContain(marker);
  return projectionSchema.parse(JSON.parse(text) as unknown);
}

async function waitForProjection(
  page: Page,
  predicate: (projection: Projection) => boolean,
): Promise<Projection> {
  for (;;) {
    const response = await page.waitForResponse(projectionResponse);
    const projection = await readProjection(response);
    if (predicate(projection)) return projection;
    if (
      projection.run !== null &&
      ["failed", "cancelled", "rejected"].includes(projection.run.status)
    ) {
      throw new Error(
        `LifeOS Run在完成目标前进入终态：status=${projection.run.status} phase=${projection.run.phase} code=${projection.run.failure?.code ?? "none"}`,
      );
    }
  }
}

async function apiJson(request: APIRequestContext, path: string): Promise<unknown> {
  const response = await request.get(`http://127.0.0.1:43111${path}`);
  expect(response.status()).toBe(200);
  const text = await response.text();
  for (const marker of PRIVATE_MARKERS) expect(text).not.toContain(marker);
  return JSON.parse(text) as unknown;
}

test("rc.6 DSH：发送 -> Plan等待人工 -> 刷新 -> 批准 -> 正式Assistant", async ({
  page,
  request,
}) => {
  const clientFactoryResponse = page.waitForResponse((response) =>
    response.url().includes(`/plugins/${BRIDGE_PACKAGE}/client.js?rev=`),
  );
  await page.goto("/");
  const internalTestingContinue = page.getByRole("button", { name: "Continue", exact: true });
  if (
    await internalTestingContinue
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await internalTestingContinue.click();
  }

  // 这两项一起证明页面不是旁路壳：Host生成的rc.6 Boot Manifest含真实Client row，
  // 浏览器又实际下载了带ModuleLoader factory的Bridge bundle。
  const bootEntry = await page.evaluate((id) => {
    const boot = (
      globalThis as typeof globalThis & {
        __DSH_BOOT__?: { entries?: Array<Record<string, unknown>> };
      }
    ).__DSH_BOOT__;
    return boot?.entries?.find((entry) => entry.id === id) ?? null;
  }, BRIDGE_PACKAGE);
  expect(bootEntry).toMatchObject({ id: BRIDGE_PACKAGE });
  expect(bootEntry).toHaveProperty("rev", expect.stringMatching(/^[a-f0-9]{12}$/u));
  const factoryResponse = await clientFactoryResponse;
  expect(factoryResponse.status()).toBe(200);
  const factoryBody = await factoryResponse.text();
  expect(factoryBody).toContain(`id: "${BRIDGE_PACKAGE}"`);
  expect(factoryBody).toContain("factory:");

  const composer = page.locator("textarea:visible").last();
  if (!(await composer.isEnabled())) {
    await page.getByRole("button", { name: /选择工作区|Choose workspace/u }).click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  }
  await expect(composer).toBeEnabled();
  await composer.fill(
    `请先给出一个只有一步的可审核计划。批准后只输出 ${COMPLETION_MARKER}，不要添加其他文字。`,
  );

  const waitingProjection = waitForProjection(
    page,
    (projection) =>
      projection.run?.status === "waiting_human" &&
      projection.run.phase === "plan_review" &&
      projection.plan?.planRevision === 1 &&
      projection.approval?.status === "open",
  );
  await page.getByRole("button", { name: /发送消息|Send message/u }).click();
  await expect(page.getByTestId("lifeos-plan-card")).toBeVisible();
  await expect(page.getByTestId("lifeos-run-status")).toHaveText("等待你审核");
  const beforeRefresh = await waitingProjection;
  if (beforeRefresh.run === null) throw new Error("Plan审核投影缺少Product Run");

  await page.reload();
  await expect(page.getByTestId("lifeos-plan-card")).toBeVisible();
  await expect(page.getByTestId("lifeos-run-status")).toHaveText("等待你审核");
  const afterRefresh = await waitForProjection(
    page,
    (projection) => projection.run?.status === "waiting_human",
  );
  expect(afterRefresh.run?.productRunId).toBe(beforeRefresh.run.productRunId);
  expect(afterRefresh.plan?.planRevision).toBe(1);

  const completedProjection = waitForProjection(
    page,
    (projection) => projection.run?.status === "succeeded" && projection.run.phase === "completed",
  );
  await page.getByTestId("lifeos-approve").click();
  const completed = await completedProjection;
  await expect(page.getByText(COMPLETION_MARKER, { exact: true })).toBeVisible({
    timeout: 8 * 60_000,
  });

  if (completed.run === null) throw new Error("完成投影缺少Product Run");
  const runId = completed.run.productRunId;
  const finalRun = runResponseSchema.parse(
    await apiJson(request, `/api/runs/${encodeURIComponent(runId)}`),
  ).run;
  expect(finalRun.status).toBe("succeeded");
  expect(finalRun.phase).toBe("completed");
  const finalMessages = messagesResponseSchema.parse(
    await apiJson(request, `/api/sessions/${encodeURIComponent(finalRun.sessionId)}/messages`),
  ).items;
  expect(finalMessages.filter((message) => message.role === "user")).toHaveLength(1);
  const assistants = finalMessages.filter((message) => message.role === "assistant");
  expect(assistants).toHaveLength(1);
  expect(assistants[0]?.sourceRunId).toBe(runId);
  expect(assistants[0]?.content.text).toContain(COMPLETION_MARKER);

  await page.reload();
  await expect(page.getByText(COMPLETION_MARKER, { exact: true })).toBeVisible();
  const publicBrowserSurface = await page.evaluate(() => ({
    html: document.documentElement.innerHTML,
    url: location.href,
    localStorage: Object.fromEntries(Object.entries(localStorage)),
  }));
  for (const marker of PRIVATE_MARKERS) {
    expect(JSON.stringify(publicBrowserSurface)).not.toContain(marker);
  }
});
