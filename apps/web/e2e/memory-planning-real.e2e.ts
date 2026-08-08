import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  planDtoSchema,
  productRunIdSchema,
  runContextDtoSchema,
  type PlanDto,
  type RunContextDto,
} from "@chat/contracts/public";
import { z } from "zod";

const runContextResponseSchema = z.object({ context: runContextDtoSchema }).strict();
const plansResponseSchema = z.object({ items: z.array(planDtoSchema) }).strict();
const replaySummarySchema = z
  .object({
    schemaVersion: z.literal("chat-memory-run-replay-verification.v1"),
    productRunId: productRunIdSchema,
    runStatus: z.literal("succeeded"),
    runPhase: z.literal("completed"),
    timelineEventCount: z.number().int().positive(),
    failures: z.literal(0),
    contentIncluded: z.literal(false),
    versionEvidenceStatus: z.literal("ok"),
  })
  .strict();
const MEMORY_FACT = "Heliotrope-7319";
const MEMORY_DISTRACTOR = "Cobalt-2048";
const CONTROL_MARKER = "NO_MEMORY_CONTEXT_AVAILABLE";
const PUBLIC_FORBIDDEN_MARKERS = [
  "workflowRunId",
  "hookToken",
  "piSessionId",
  "x-chat-runtime-key",
  "DASHSCOPE_API_KEY",
  "CHAT_MEMMY_TOKEN",
  "127.0.0.1:18960",
  '"namespace"',
  '"sessionKey"',
] as const;

function expectNoHorizontalScroll(page: Page): Promise<void> {
  return page
    .evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }))
    .then((dimensions) => {
      expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
      expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
    });
}

async function activeRunId(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const entry = Object.entries(localStorage).find(([key]) => key.startsWith("chat:real-run:v1:"));
    return entry?.[1] ?? null;
  });
  return productRunIdSchema.parse(value);
}

async function publicRunContext(page: Page, runId: string): Promise<RunContextDto> {
  const response = await page.evaluate(async (id) => {
    const result = await fetch(`/api/runs/${encodeURIComponent(id)}/context`);
    return { status: result.status, body: await result.json() };
  }, runId);
  expect(response.status).toBe(200);
  return runContextResponseSchema.parse(response.body).context;
}

async function publicPlans(page: Page, runId: string): Promise<PlanDto[]> {
  const response = await page.evaluate(async (id) => {
    const result = await fetch(`/api/runs/${encodeURIComponent(id)}/plans`);
    return { status: result.status, body: await result.json() };
  }, runId);
  expect(response.status).toBe(200);
  return plansResponseSchema.parse(response.body).items;
}

function expectFrozenSourceRefs(
  plans: readonly PlanDto[],
  revision: number,
  source: NonNullable<RunContextDto["contextPackage"]>["sources"][number],
): void {
  const plan = plans.find((candidate) => candidate.planRevision === revision);
  if (plan === undefined) throw new Error(`缺少 Plan v${String(revision)}`);
  const expected = {
    refId: source.memoryResultSnapshotId,
    revision: source.revision,
    sha256: source.sha256,
  };
  const refs = plan.content.steps.flatMap((step) => step.inputRefs);
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) expect(ref).toEqual(expected);
}

async function rejectCurrentPlan(page: Page): Promise<void> {
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await page.getByLabel("拒绝原因（可选）").fill("真实 E2E 无 Memory 对照运行到此结束");
  await page.getByRole("button", { name: "确认拒绝并结束" }).click();
  await expect(page.getByText("这次工作已取消。")).toBeVisible();
}

function readTraceSurface(): string {
  const traceRoot = resolve(process.cwd(), "../..", ".data/e2e/memory-planning-real/traces");
  const parts: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        parts.push(readFileSync(path, "utf8"));
    }
  };
  visit(traceRoot);
  return parts.join("\n");
}

function verifyReplayWithoutContent(runId: string): void {
  const repoRoot = resolve(process.cwd(), "../..");
  const env: NodeJS.ProcessEnv = { ...process.env, CHAT_REPO_ROOT: repoRoot };
  delete env.DASHSCOPE_API_KEY;
  delete env.CHAT_MEMMY_TOKEN;
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@chat/api",
      "exec",
      "tsx",
      "../../scripts/e2e/verify-memory-run-replay.ts",
      "--run",
      runId,
    ],
    { cwd: repoRoot, env, encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Memory Run Replay 门失败（exit=${String(result.status)}）`);
  }
  const summary = replaySummarySchema.parse(JSON.parse(result.stdout));
  expect(summary.productRunId).toBe(runId);
}

test("固定 memmy + qwen3.7-plus：对照、查询、冻结修订、批准执行与手机恢复", async ({ page }) => {
  const publicJsonBodies: string[] = [];
  await page.route("**/api/**", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    const text = body.toString("utf8");
    if ((response.headers()["content-type"] ?? "").includes("application/json")) {
      publicJsonBodies.push(text);
      for (const marker of PUBLIC_FORBIDDEN_MARKERS) expect(text).not.toContain(marker);
    }
    await route.fulfill({ response, body });
  });

  await page.goto("/");
  await expect(page.getByLabel("当前模型")).toContainText("百炼 Qwen3.7 Plus");

  // 1. 无 Memory 对照：随机事实绝不能从模型猜出来；明确拒绝后再开始真实 Memory Run。
  await page
    .getByLabel("消息输入框")
    .fill(
      `只规划如何确认 Atlas 的生产部署代号。当前消息没有提供代号；若上下文也没有该事实，计划摘要必须逐字写 ${CONTROL_MARKER}，不得猜测任何代号。`,
    );
  await page.getByRole("button", { name: "发送" }).click();
  const controlPlan = page.getByLabel("计划第1版");
  await expect(controlPlan).toBeVisible({ timeout: 5 * 60_000 });
  await expect(controlPlan).toContainText(CONTROL_MARKER);
  await expect(controlPlan).not.toContainText(MEMORY_FACT);
  await expect(page.locator(".context-summary")).toHaveCount(0);
  const controlRunId = await activeRunId(page);
  const controlPlans = await publicPlans(page, controlRunId);
  expect(controlPlans).toHaveLength(1);
  expect(controlPlans[0]?.content.steps.every((step) => step.inputRefs.length === 0)).toBe(true);
  await rejectCurrentPlan(page);

  // 2. 真实手机入口：在 390×844 完成 Memory 选择、消息填写与 Enter 发送。
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
  const contextPicker = page.locator(".context-picker-trigger");
  await expect(contextPicker).toBeVisible();
  await contextPicker.click();
  await expect(page.getByLabel("Memory 上下文设置")).toBeVisible();
  const closeContextPicker = page.getByRole("button", { name: "关闭上下文设置" });
  await expect(closeContextPicker).toBeVisible();
  await page.getByRole("checkbox", { name: /使用 Memory 上下文/u }).check();
  await expect(page.getByLabel("Memory 后端")).toHaveValue("mbk_memmy");
  await page.getByLabel("Memory 失败策略").selectOption("required");
  await page.getByLabel("Memory 标签").fill("deployment-code");
  const layers = page.getByRole("group", { name: "层级" });
  await layers.getByRole("checkbox", { name: "L1" }).uncheck();
  await layers.getByRole("checkbox", { name: "L3" }).uncheck();
  await layers.getByRole("checkbox", { name: "Skill" }).uncheck();
  await expect(layers.getByRole("checkbox", { name: "L2" })).toBeChecked();
  await closeContextPicker.click();
  await expect(page.getByLabel("Memory 上下文设置")).toHaveCount(0);

  const mobileComposer = page.getByLabel("消息输入框");
  await expect(mobileComposer).toBeVisible();
  await mobileComposer.fill(
    "请规划 Atlas 的生产发布说明：必须从我选中的 Memory 找到部署代号，计划中逐字使用它；批准后生成包含该代号、风险和回滚步骤的 Markdown 交付。",
  );
  await expect(mobileComposer).toBeFocused();
  await mobileComposer.press("Enter");
  await expect(mobileComposer).toHaveValue("");
  await expect.poll(() => activeRunId(page), { timeout: 30_000 }).not.toBe(controlRunId);
  const runId = await activeRunId(page);

  // 已由手机端切换到新的权威 Run；切回桌面继续规划审核。
  await page.setViewportSize({ width: 1280, height: 720 });
  await expectNoHorizontalScroll(page);

  const memoryPlanV1 = page.getByLabel("计划第1版");
  await expect(memoryPlanV1).toContainText(MEMORY_FACT, { timeout: 5 * 60_000 });
  await expect(memoryPlanV1).not.toContainText(MEMORY_DISTRACTOR);
  const sourceSummary = page.locator(".context-summary");
  await expect(sourceSummary).toContainText("使用 memmy 1 条");
  await expect(sourceSummary.locator("span")).not.toHaveText("");

  const contextV1 = await publicRunContext(page, runId);
  expect(contextV1.memory).toMatchObject({
    requirement: "required",
    queryStatus: "completed",
    hitCount: 1,
    adoptedCount: 1,
  });
  expect(contextV1.contextPackage?.sources).toHaveLength(1);
  const frozenPackage = contextV1.contextPackage;
  if (frozenPackage === undefined) throw new Error("Memory Run 缺少冻结 ContextPackage");
  const frozenSource = frozenPackage.sources[0];
  if (frozenSource === undefined) throw new Error("Memory Run 缺少唯一冻结来源");
  expectFrozenSourceRefs(await publicPlans(page, runId), 1, frozenSource);

  // 等待审核时刷新：Plan 与安全来源摘要均从服务端恢复。
  await page.reload();
  await expect(page.getByLabel("计划第1版")).toContainText(MEMORY_FACT);
  await expect(page.locator(".context-summary")).toContainText("使用 memmy 1 条");
  expect((await publicRunContext(page, runId)).contextPackage).toEqual(frozenPackage);

  // Plan 修订只复用同一包，不再次查询漂移中的 Memory。
  await page.getByLabel("修改意见").fill("保留部署代号，并把回滚验证拆成独立步骤");
  await page.getByRole("button", { name: "要求修改" }).click();
  const memoryPlanV2 = page.getByLabel("计划第2版");
  await expect(memoryPlanV2).toBeVisible({ timeout: 5 * 60_000 });
  await expect(memoryPlanV2).toContainText(MEMORY_FACT);
  expect((await publicRunContext(page, runId)).contextPackage).toEqual(frozenPackage);
  const revisedPlans = await publicPlans(page, runId);
  expectFrozenSourceRefs(revisedPlans, 1, frozenSource);
  expectFrozenSourceRefs(revisedPlans, 2, frozenSource);

  // 390×844 完整手机视图与 390×390 聚焦场景均不得横向溢出或丢失焦点。
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
  await page.getByRole("tab", { name: "对话" }).click();
  await page.setViewportSize({ width: 390, height: 390 });
  const composer = page.getByLabel("消息输入框");
  await composer.scrollIntoViewIfNeeded();
  await composer.focus();
  await expect(composer).toBeFocused();
  await expectNoHorizontalScroll(page);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("button", { name: "通过" }).click();
  await expect(page.getByText("工作已完成，正式结果已作为Assistant消息进入对话。")).toBeVisible({
    timeout: 8 * 60_000,
  });
  const assistant = page.locator('.chat-message[data-role="assistant"]');
  await expect(assistant).toContainText(MEMORY_FACT);
  await expect(assistant).toContainText(/风险/u);
  await expect(assistant).toContainText(/回滚/u);

  // 完成后刷新，正式结果、Plan 与 ContextPackage 仍由服务端重建。
  await page.reload();
  await expect(page.locator('.chat-message[data-role="assistant"]')).toContainText(MEMORY_FACT);
  await expect(page.getByLabel("计划第2版")).toContainText(MEMORY_FACT);
  await expect(page.locator(".context-summary")).toContainText("使用 memmy 1 条");
  expect((await publicRunContext(page, runId)).contextPackage).toEqual(frozenPackage);
  await expectNoHorizontalScroll(page);

  const publicSurface = `${publicJsonBodies.join("\n")}\n${await page.locator("html").innerText()}`;
  for (const marker of PUBLIC_FORBIDDEN_MARKERS) expect(publicSurface).not.toContain(marker);

  const traceSurface = readTraceSurface();
  expect(traceSurface.length).toBeGreaterThan(0);
  for (const marker of [
    MEMORY_FACT,
    MEMORY_DISTRACTOR,
    "项目 Atlas 的生产部署代号",
    "127.0.0.1:18960",
    "CHAT_MEMMY_TOKEN",
    '"namespace"',
    '"sessionKey"',
    "workflowRunId",
    "hookToken",
    "piSessionId",
  ]) {
    expect(traceSurface).not.toContain(marker);
  }
  verifyReplayWithoutContent(runId);
});
