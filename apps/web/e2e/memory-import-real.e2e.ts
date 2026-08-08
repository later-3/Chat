import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  memoryImportDtoSchema,
  planDtoSchema,
  productRunIdSchema,
  productSessionIdSchema,
  runContextDtoSchema,
  type MemoryImportDto,
  type PlanDto,
} from "@chat/contracts/public";
import { z } from "zod";

const repoRoot = resolve(process.cwd(), "../..");
const dataRoot = resolve(repoRoot, ".data/e2e/memory-import-real");
const plansResponseSchema = z.object({ items: z.array(planDtoSchema) }).strict();
const contextResponseSchema = z.object({ context: runContextDtoSchema }).strict();
const importsResponseSchema = z
  .object({ memoryImports: z.array(memoryImportDtoSchema), nextCursor: z.string().optional() })
  .strict();
const CONTROL_MARKER = "NO_IMPORTED_MEMORY_AVAILABLE";
const FORBIDDEN_PUBLIC_MARKERS = [
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

async function currentSessionId(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const raw = localStorage.getItem("chat:real-session:v1");
    if (raw === null) return null;
    return (JSON.parse(raw) as { sessionId?: unknown }).sessionId ?? null;
  });
  return productSessionIdSchema.parse(value);
}

async function activeRunId(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const entry = Object.entries(localStorage).find(([key]) => key.startsWith("chat:real-run:v1:"));
    return entry?.[1] ?? null;
  });
  return productRunIdSchema.parse(value);
}

async function createNewSession(page: Page, previous: string): Promise<string> {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByLabel("当前模型")).toContainText("百炼 Qwen3.7 Plus");
  await expect.poll(() => currentSessionId(page), { timeout: 30_000 }).not.toBe(previous);
  return currentSessionId(page);
}

async function sessionImports(page: Page, sessionId: string): Promise<MemoryImportDto[]> {
  const response = await page.evaluate(async (id) => {
    const result = await fetch(`/api/sessions/${encodeURIComponent(id)}/memory-imports`);
    return { status: result.status, body: await result.json() };
  }, sessionId);
  expect(response.status).toBe(200);
  return importsResponseSchema.parse(response.body).memoryImports;
}

async function plans(page: Page, runId: string): Promise<PlanDto[]> {
  const response = await page.evaluate(async (id) => {
    const result = await fetch(`/api/runs/${encodeURIComponent(id)}/plans`);
    return { status: result.status, body: await result.json() };
  }, runId);
  expect(response.status).toBe(200);
  return plansResponseSchema.parse(response.body).items;
}

async function selectText(pre: ReturnType<Page["locator"]>, text: string): Promise<void> {
  await pre.evaluate((element, selected) => {
    const content = element.textContent ?? "";
    const start = content.indexOf(selected);
    if (start < 0 || element.firstChild === null) throw new Error("消息中找不到待导入选区");
    const range = document.createRange();
    range.setStart(element.firstChild, start);
    range.setEnd(element.firstChild, start + selected.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, text);
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const width = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);
  expect(width.body).toBeLessThanOrEqual(width.viewport + 1);
}

async function rejectCurrentPlan(page: Page, reason: string): Promise<void> {
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await page.getByLabel("拒绝原因（可选）").fill(reason);
  await page.getByRole("button", { name: "确认拒绝并结束" }).click();
  await expect(page.getByText("这次工作已取消。")).toBeVisible();
}

function requestServiceRestart(service: "api" | "workflow", requestId: string): void {
  writeFileSync(
    resolve(dataRoot, "restarts", `${service}.request.json`),
    `${JSON.stringify({ schemaVersion: "chat-e2e-service-restart.v1", requestId })}\n`,
    { mode: 0o600 },
  );
}

function generationRequestId(service: "api" | "workflow"): string | null {
  try {
    const value = JSON.parse(
      readFileSync(resolve(dataRoot, "restarts", `${service}.generation.json`), "utf8"),
    ) as { generation?: unknown; requestId?: unknown };
    return typeof value.generation === "number" &&
      value.generation >= 2 &&
      typeof value.requestId === "string"
      ? value.requestId
      : null;
  } catch {
    return null;
  }
}

async function restartApiAndWorkflow(page: Page): Promise<void> {
  const requestId = `restart-${randomUUID()}`;
  requestServiceRestart("workflow", requestId);
  requestServiceRestart("api", requestId);
  await expect.poll(() => generationRequestId("workflow"), { timeout: 60_000 }).toBe(requestId);
  await expect.poll(() => generationRequestId("api"), { timeout: 60_000 }).toBe(requestId);
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch("http://127.0.0.1:43112/healthz");
          return response.ok;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () => {
        try {
          const response = await page.request.get("/api/readyz");
          return response.ok();
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

function traceText(): string {
  const root = resolve(dataRoot, "traces");
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push(readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return files.join("\n");
}

function replay(kind: "run" | "import", id: string, canary: string): Record<string, unknown> {
  const args = [
    "--filter",
    "@chat/api",
    "exec",
    "tsx",
    "src/replay-main.ts",
    `--${kind}`,
    id,
    "--store",
    resolve(dataRoot, "product-store.v3.json"),
    "--dir",
    resolve(dataRoot, "traces"),
  ];
  if (kind === "run") {
    args.push("--evidence", resolve(dataRoot, "workflow/version-evidence", `${id}.json`));
  } else {
    args.push("--bindings", resolve(dataRoot, "runtime-bindings.v2.json"));
  }
  const env: NodeJS.ProcessEnv = { ...process.env, CHAT_REPO_ROOT: repoRoot };
  delete env.DASHSCOPE_API_KEY;
  delete env.CHAT_MEMMY_TOKEN;
  const stdout = execFileSync("pnpm", args, { cwd: repoRoot, env, encoding: "utf8" });
  expect(stdout).not.toContain(canary);
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("正式消息选区 -> 真实memmy -> 重启恢复 -> 新会话真实规划执行", async ({ page }) => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const canary = `M2-CANARY-${suffix}`;
  const tag = `m2-import-${suffix}`;
  const selectedFact = `发布验收口令为 ${canary}，发布窗口为周四 22:30。`;
  const publicJson: string[] = [];
  await page.route("**/api/**", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    const text = body.toString("utf8");
    if ((response.headers()["content-type"] ?? "").includes("application/json")) {
      publicJson.push(text);
      for (const marker of FORBIDDEN_PUBLIC_MARKERS) expect(text).not.toContain(marker);
    }
    await route.fulfill({ response, body });
  });

  await page.goto("/");
  await expect(page.getByLabel("当前模型")).toContainText("百炼 Qwen3.7 Plus");
  const sourceSessionId = await currentSessionId(page);
  await page
    .getByLabel("消息输入框")
    .fill(`${selectedFact}\n请先规划如何登记这条发布事实，等待我确认后再执行。`);
  await page.getByRole("button", { name: "发送" }).click();
  const sourceMessage = page.locator('.chat-message[data-role="user"]').last();
  await expect(sourceMessage).toContainText(canary);

  // 手机端从正式消息选择真实 UTF-16 选区；同一组件不得横向溢出。
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalScroll(page);
  await selectText(sourceMessage.locator("pre"), selectedFact);
  const importButton = sourceMessage.getByRole("button", { name: "导入记忆" });
  await expect(importButton).toBeEnabled();
  await importButton.click();
  const dialog = page.getByRole("dialog", { name: "导入事实记忆" });
  await expect(dialog).toContainText("当前选区");
  await expect(dialog).toContainText(canary);
  await dialog.getByLabel("标题").fill(`M2 发布事实 ${suffix}`);
  await dialog.getByLabel("标签").fill(tag);
  await dialog.getByRole("button", { name: "确认导入" }).click();
  await expect(sourceMessage.getByRole("status")).toHaveText("已写入并可查询", {
    timeout: 2 * 60_000,
  });
  const imported = (await sessionImports(page, sourceSessionId))[0];
  expect(imported).toMatchObject({ status: "materialized", selectionKind: "utf16_range" });
  if (imported === undefined) throw new Error("导入完成后缺少MemoryImport产品事实");

  // 真正重启两个后端进程，再由页面从服务端重建同一Import与待审核Plan。
  await expect(page.getByLabel("计划第1版")).toBeVisible({ timeout: 5 * 60_000 });
  await restartApiAndWorkflow(page);
  await page.reload();
  await expect(sourceMessage.getByRole("status")).toHaveText("已写入并可查询", {
    timeout: 60_000,
  });
  await expect(page.getByLabel("计划第1版")).toBeVisible();
  await rejectCurrentPlan(page, "导入源会话完成，进入新会话检索验证");

  // 新建无Memory对照会话，真实Planner不得凭空知道唯一canary。
  const controlSessionId = await createNewSession(page, sourceSessionId);
  await page
    .getByLabel("消息输入框")
    .fill(
      `只规划如何确认刚才的发布验收口令；当前消息没有口令。若上下文也没有，计划摘要必须逐字写 ${CONTROL_MARKER}，不得猜测。`,
    );
  await page.getByRole("button", { name: "发送" }).click();
  const controlPlan = page.getByLabel("计划第1版");
  await expect(controlPlan).toContainText(CONTROL_MARKER, { timeout: 5 * 60_000 });
  await expect(controlPlan).not.toContainText(canary);
  await rejectCurrentPlan(page, "无Memory对照完成");

  // 再开新会话，用户显式选择tag/L2/required；真实Query与Planner必须使用导入事实。
  await createNewSession(page, controlSessionId);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator(".context-picker-trigger").click();
  await page.getByRole("checkbox", { name: /使用 Memory 上下文/u }).check();
  await page.getByLabel("Memory 失败策略").selectOption("required");
  await page.getByLabel("Memory 标签").fill(tag);
  const layers = page.getByRole("group", { name: "层级" });
  await layers.getByRole("checkbox", { name: "L1" }).uncheck();
  await layers.getByRole("checkbox", { name: "L3" }).uncheck();
  await layers.getByRole("checkbox", { name: "Skill" }).uncheck();
  await page.getByRole("button", { name: "关闭上下文设置" }).click();
  await page
    .getByLabel("消息输入框")
    .fill(
      "规划一份发布确认单：必须从选中的Memory逐字取得验收口令与窗口；批准后交付包含口令、窗口、风险和回滚步骤的Markdown。",
    );
  await page.getByRole("button", { name: "发送" }).click();
  const runId = await activeRunId(page);
  const memoryPlan = page.getByLabel("计划第1版");
  await expect(memoryPlan).toContainText(canary, { timeout: 5 * 60_000 });
  await expect(page.locator(".context-summary")).toContainText("使用 memmy 1 条");
  const runContextResponse = await page.evaluate(async (id) => {
    const result = await fetch(`/api/runs/${encodeURIComponent(id)}/context`);
    return { status: result.status, body: await result.json() };
  }, runId);
  expect(runContextResponse.status).toBe(200);
  const runContext = contextResponseSchema.parse(runContextResponse.body).context;
  expect(runContext.memory).toMatchObject({
    queryStatus: "completed",
    hitCount: 1,
    adoptedCount: 1,
  });
  const source = runContext.contextPackage?.sources[0];
  if (source === undefined) throw new Error("导入记忆未进入冻结ContextPackage");
  for (const ref of (await plans(page, runId))[0]?.content.steps.flatMap(
    (step) => step.inputRefs,
  ) ?? []) {
    expect(ref).toEqual({
      refId: source.memoryResultSnapshotId,
      revision: source.revision,
      sha256: source.sha256,
    });
  }

  await page.getByRole("button", { name: "通过" }).click();
  await expect(page.getByText("工作已完成，正式结果已作为Assistant消息进入对话。")).toBeVisible({
    timeout: 8 * 60_000,
  });
  const assistant = page.locator('.chat-message[data-role="assistant"]').last();
  await expect(assistant).toContainText(canary);
  await expect(assistant).toContainText("周四 22:30");
  await expect(assistant).toContainText(/风险/u);
  await expect(assistant).toContainText(/回滚/u);

  const importReplay = replay("import", imported.memoryImportIntentId, canary);
  expect(importReplay["result"]).toMatchObject({ status: "materialized" });
  expect(importReplay["failures"]).toEqual([]);
  expect(importReplay["content"]).toEqual({ included: false });
  expect(importReplay["downstreamUse"]).toEqual(
    expect.arrayContaining([expect.objectContaining({ productRunId: runId })]),
  );
  const runReplay = replay("run", runId, canary);
  expect(runReplay["failures"]).toEqual([]);
  expect(runReplay["content"]).toEqual({ included: false });

  const traces = traceText();
  expect(traces.length).toBeGreaterThan(0);
  expect(traces).not.toContain(canary);
  expect(traces).not.toContain(selectedFact);
  const publicSurface = `${publicJson.join("\n")}\n${await page.locator("html").innerText()}`;
  for (const marker of FORBIDDEN_PUBLIC_MARKERS) expect(publicSurface).not.toContain(marker);
  await noHorizontalScroll(page);
});
