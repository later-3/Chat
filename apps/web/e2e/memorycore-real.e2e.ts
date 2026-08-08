import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  memoryImportDtoSchema,
  productRunIdSchema,
  productSessionIdSchema,
} from "@chat/contracts/public";
import { z } from "zod";

const CANARY = "MEMORYCORE-PLAN-CANARY-9482";
const dataRoot = resolve(process.cwd(), "../..", ".data/e2e/memorycore-real");
const importsSchema = z
  .object({ memoryImports: z.array(memoryImportDtoSchema), nextCursor: z.string().optional() })
  .strict();
const FORBIDDEN_PUBLIC = [
  "chat-memorycore-e2e-local",
  "chat-memorycore-e2e-service",
  "chat-memorycore-e2e-team",
  "chat-memorycore-e2e-user",
  "chat-memorycore-e2e-agent",
  "127.0.0.1:18970",
  "x-tdai-service-id",
  "workflowRunId",
  "hookToken",
  "piSessionId",
] as const;

async function currentSessionId(page: Page): Promise<string> {
  return productSessionIdSchema.parse(
    await page.evaluate(() => {
      const raw = localStorage.getItem("chat:real-session:v1");
      return raw === null ? null : (JSON.parse(raw) as { sessionId?: unknown }).sessionId;
    }),
  );
}

async function activeRunId(page: Page): Promise<string> {
  const read = () =>
    page.evaluate(() => {
      const entry = Object.entries(localStorage).find(([key]) =>
        key.startsWith("chat:real-run:v1:"),
      );
      return entry?.[1] ?? null;
    });
  await expect.poll(read, { timeout: 30_000 }).not.toBeNull();
  return productRunIdSchema.parse(await read());
}

function traceText(): string {
  const root = resolve(dataRoot, "traces");
  const contents: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        contents.push(readFileSync(path, "utf8"));
      }
    }
  };
  visit(root);
  return contents.join("\n");
}

test("真实MemoryCore：浏览器选择、qwen规划采用、L0导入与accepted刷新恢复", async ({ page }) => {
  const publicJson: string[] = [];
  await page.route("**/api/**", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    const text = body.toString("utf8");
    if ((response.headers()["content-type"] ?? "").includes("application/json")) {
      publicJson.push(text);
      for (const marker of FORBIDDEN_PUBLIC) expect(text).not.toContain(marker);
    }
    await route.fulfill({ response, body });
  });

  await page.goto("/");
  await expect(page.getByLabel("当前模型")).toContainText("百炼 Qwen3.7 Plus");
  await page.locator(".context-picker-trigger").click();
  await page.getByRole("checkbox", { name: /使用 Memory 上下文/u }).check();
  await expect(page.getByLabel("Memory 后端")).toHaveValue("mbk_tencentmemorycore");
  await page.getByLabel("Memory 失败策略").selectOption("required");
  await expect(page.getByLabel("Memory 标签")).toHaveCount(0, { timeout: 5_000 });
  const layers = page.getByRole("group", { name: "层级" });
  await expect(layers.getByRole("checkbox", { name: "L1" })).toBeChecked();
  await expect(layers.getByRole("checkbox")).toHaveCount(1);
  await page.getByRole("button", { name: "关闭上下文设置" }).click();

  const prompt = `请规划M3发布验收，必须从选中的Memory逐字引用 ${CANARY}，并说明它来自长期记忆。`;
  await page.getByLabel("消息输入框").fill(prompt);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByLabel("计划第1版")).toContainText(CANARY, {
    timeout: 5 * 60_000,
  });
  await expect(page.locator(".context-summary")).toContainText("使用 Tencent MemoryCore 1 条");
  const runId = await activeRunId(page);
  expect(runId).toContain("run_");

  const userMessage = page.locator('.chat-message[data-role="user"]').last();
  await userMessage.getByRole("button", { name: "导入记忆" }).click();
  const dialog = page.getByRole("dialog", { name: "导入事实记忆" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("会话捕获（L0）")).toBeVisible();
  await expect(dialog.getByText("先保存原始事实，再由 MemoryCore 异步提炼")).toBeVisible();
  await expect(dialog.getByLabel("Memory 服务")).toHaveValue("mbk_tencentmemorycore");
  await expect(dialog.getByText("标题")).toHaveCount(0, { timeout: 5_000 });
  await expect(dialog.getByText("标签")).toHaveCount(0, { timeout: 5_000 });
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(userMessage.getByRole("status")).toHaveText("已接收，等待异步提炼", {
    timeout: 60_000,
  });

  const sessionId = await currentSessionId(page);
  const response = await page.evaluate(async (id) => {
    const result = await fetch(`/api/sessions/${encodeURIComponent(id)}/memory-imports`);
    return { status: result.status, body: await result.json() };
  }, sessionId);
  expect(response.status).toBe(200);
  const imports = importsSchema.parse(response.body).memoryImports;
  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatchObject({
    backendId: "mbk_tencentmemorycore",
    memoryLayer: "L0",
    status: "accepted",
    allowedActions: ["reconcile"],
  });

  await userMessage.getByRole("button", { name: "再次验证" }).click();
  await expect(userMessage.getByRole("status")).toHaveText("已接收，等待异步提炼");
  await page.reload();
  await expect(page.getByLabel("计划第1版")).toContainText(CANARY);
  await expect(
    page.locator('.chat-message[data-role="user"]').last().getByRole("status"),
  ).toHaveText("已接收，等待异步提炼");

  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await page.getByLabel("拒绝原因（可选）").fill("M3真实MemoryCore完成门结束");
  await page.getByRole("button", { name: "确认拒绝并结束" }).click();
  await expect(page.getByText("这次工作已取消。")).toBeVisible();

  const traces = traceText();
  expect(traces).not.toContain(prompt);
  expect(traces).not.toContain(CANARY);
  for (const marker of FORBIDDEN_PUBLIC) expect(traces).not.toContain(marker);
  expect(publicJson.length).toBeGreaterThan(0);
});
