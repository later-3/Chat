import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  currentProjectCandidateResponseSchema,
  projectCandidateDtoSchema,
  projectWorkspaceDtoSchema,
} from "@chat/contracts/public";

const CONTENT_MARKER = "TRACE_CONTENT_MUST_NEVER_BE_WRITTEN_PROJECT_E2E";
const DECISION_MARKER = "BMAD只作为方法输入，不绑定任何模型";
const FORBIDDEN_PUBLIC_MARKERS = [
  "workflowRunId",
  "hookToken",
  "piSessionId",
  "x-chat-runtime-key",
  "DASHSCOPE_API_KEY",
] as const;

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function readTraceLines(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  return (
    await Promise.all(files.map((entry) => readFile(resolve(directory, entry.name), "utf8")))
  ).flatMap((content) => content.split("\n").filter(Boolean));
}

test("真实Project Intake：对话建项→修改/并发确认→项目账本→管理与恢复", async ({
  page,
  context,
}) => {
  await page.route("**/api/**", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    if ((response.headers()["content-type"] ?? "").includes("application/json")) {
      const text = body.toString("utf8");
      for (const marker of FORBIDDEN_PUBLIC_MARKERS) expect(text).not.toContain(marker);
    }
    await route.fulfill({ response, body });
  });

  await page.goto("/");
  await expect(page.getByLabel("模型配置")).toContainText("模型由服务端配置");
  await page.getByRole("button", { name: "建立项目" }).click();
  await expect(page.getByLabel("项目资源")).toHaveValue("root_chat");
  await page
    .getByLabel("消息输入框")
    .fill(
      `把Chat仓库建成长期项目，目标是持续开发Chat产品并明确谁在做什么、有哪些待办。${CONTENT_MARKER}`,
    );
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("建项方案 · 等待你的确认")).toBeVisible();

  // 删除浏览器Candidate定位并刷新，必须由服务端Session Query恢复同一未决方案。
  const sessionId = await page.evaluate(() => {
    localStorage.removeItem("chat.project.activeCandidate.v1");
    const raw = localStorage.getItem("chat:real-session:v1");
    return raw === null ? null : (JSON.parse(raw) as { sessionId?: unknown }).sessionId;
  });
  expect(typeof sessionId).toBe("string");
  await page.reload();
  await expect(page.getByText("建项方案 · 等待你的确认")).toBeVisible();
  const pendingResponse = await page.evaluate(async (id) => {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(String(id))}/project-candidates/current`,
    );
    return response.json();
  }, sessionId);
  const pending = currentProjectCandidateResponseSchema.parse(pendingResponse).candidate;
  expect(pending?.status).toBe("under_review");

  await page.getByLabel("项目名称").fill("Chat产品工程");
  await page.getByLabel("项目目标").fill("持续推进Chat产品并用真实证据维护项目账本");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByLabel("项目名称")).toHaveValue("Chat产品工程");

  // 两个页面同时确认；Product Store CAS只能允许一个提交成功。
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByText("建项方案 · 等待你的确认")).toBeVisible();
  await Promise.all([
    page.getByRole("button", { name: "确认建立项目" }).click(),
    second.getByRole("button", { name: "确认建立项目" }).click(),
  ]);
  await expect(page.getByRole("heading", { name: "Chat产品工程" })).toBeVisible();
  await second.reload();
  await expect(second.getByRole("heading", { name: "Chat产品工程" })).toBeVisible();

  const projectResponse = await page.evaluate(async () => {
    const response = await fetch("/api/projects");
    const body = (await response.json()) as { projects: { projectId: string }[] };
    const projectId = body.projects[0]?.projectId;
    const workspace = await fetch(`/api/projects/${encodeURIComponent(projectId ?? "")}`);
    return workspace.json();
  });
  const initialWorkspace = projectWorkspaceDtoSchema.parse(
    (projectResponse as { project: unknown }).project,
  );
  expect(initialWorkspace.resources[0]?.latestObservationId).toBeDefined();
  expect(initialWorkspace.participants).toHaveLength(1);
  expect(initialWorkspace.works.length).toBeGreaterThan(0);

  await page.getByLabel("新待办标题").fill("完成PS1真实验收");
  await page.getByRole("button", { name: "确认新增待办" }).click();
  await expect(page.getByText("完成PS1真实验收", { exact: true }).first()).toBeVisible();

  await page.getByLabel("决定问题").fill("BMAD与模型是否成为项目事实源？");
  await page.getByLabel("决定选择").fill(DECISION_MARKER);
  await page.getByLabel("决定理由").fill("Project事实由Chat Product Store和用户确认拥有");
  await page.getByRole("button", { name: "确认记录决定" }).click();
  await expect(page.getByText(DECISION_MARKER, { exact: true }).first()).toBeVisible();

  await page.getByLabel("贡献摘要").fill("用户完成PS1范围与方法边界确认");
  await page.getByRole("button", { name: "确认记录贡献" }).click();
  await expect(
    page.getByText("用户完成PS1范围与方法边界确认", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "刷新观察" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "工作" }).click();
  await expect(page.getByRole("region", { name: "工作窗口" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.reload();
  await page.getByRole("tab", { name: "工作" }).click();
  await expect(page.getByText("完成PS1真实验收", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(DECISION_MARKER, { exact: true }).first()).toBeVisible();

  const currentCandidateResponse = await page.evaluate(async (id) => {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(String(id))}/project-candidates/current`,
    );
    return response.json();
  }, sessionId);
  expect(currentProjectCandidateResponseSchema.parse(currentCandidateResponse)).toEqual({
    candidate: null,
  });

  // 真实Model Profile证据与隐私门：Trace只含身份/Hash/耗时，不复制任何正文或路径。
  await expect
    .poll(async () => {
      const lines = await readTraceLines(
        resolve(process.cwd(), "../../.data/e2e/project-intake-real/traces"),
      );
      return lines.some((line) => line.includes('"eventName":"project.understanding.completed"'));
    })
    .toBe(true);
  const traceLines = await readTraceLines(
    resolve(process.cwd(), "../../.data/e2e/project-intake-real/traces"),
  );
  const traceText = traceLines.join("\n");
  expect(traceText).toContain('"providerName":"bailian"');
  expect(traceText).toContain('"modelId":"qwen3.7-plus"');
  expect(traceText).not.toContain(CONTENT_MARKER);
  expect(traceText).not.toContain(DECISION_MARKER);
  expect(traceText).not.toContain(resolve(process.cwd(), "../.."));
  expect(traceText).not.toContain("DASHSCOPE_API_KEY");

  // Public Candidate合同不含provider/model；模型替换不会改变产品对象。
  if (pending !== null) {
    const serialized = JSON.stringify(projectCandidateDtoSchema.parse(pending));
    expect(serialized).not.toContain("providerName");
    expect(serialized).not.toContain("modelId");
  }
});
