import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  currentProjectCandidateResponseSchema,
  projectCandidateDtoSchema,
  projectWorkspaceDtoSchema,
} from "@chat/contracts/public";

const CONTENT_MARKER = "TRACE_CONTENT_MUST_NEVER_BE_WRITTEN_PROJECT_E2E";
const ADVANCEMENT_MARKER = "TRACE_MUST_NOT_COPY_PROJECT_ADVANCEMENT_BODY";
const UPDATE_MARKER = "负责人确认当前仍有真实恢复验证待完成";
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

test("真实Project：对话建项→推进修订/确认→项目账本→管理与恢复", async ({ page, context }) => {
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
  const firstDecisionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/project-candidates/") &&
      response.url().endsWith("/decisions"),
  );
  const secondDecisionResponse = second.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/project-candidates/") &&
      response.url().endsWith("/decisions"),
  );
  await Promise.all([
    page.getByRole("button", { name: "确认建立项目" }).click(),
    second.getByRole("button", { name: "确认建立项目" }).click(),
  ]);
  expect(
    [(await firstDecisionResponse).status(), (await secondDecisionResponse).status()].sort(),
  ).toEqual([201, 409]);
  // 不假定哪一页赢得CAS；两页都重新Query权威事实后必须收敛到同一Project。
  await page.reload();
  await second.reload();
  await expect(page.getByRole("heading", { name: "Chat产品工程" })).toBeVisible();
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

  // 同一个Chat显式进入“推进项目”，真实模型只生成临时Understanding。
  await page.getByRole("button", { name: "推进项目" }).click();
  await page
    .getByLabel("消息输入框")
    .fill(
      `进入PS2阶段：阶段目标是打通项目推进闭环，关键结果是Stage、Milestone和负责人更新可以跨重启恢复；当前有风险。${ADVANCEMENT_MARKER}`,
    );
  await page.getByRole("button", { name: "发送" }).click();
  const advancementCard = page.getByLabel("项目推进方案");
  await expect(advancementCard).toBeVisible();
  const oldAdvancementResponse = await page.evaluate(async (id) => {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(String(id))}/project-candidates/current`,
    );
    return response.json();
  }, sessionId);
  const oldAdvancement =
    currentProjectCandidateResponseSchema.parse(oldAdvancementResponse).candidate;
  if (
    oldAdvancement === null ||
    oldAdvancement.candidateKind !== "advancement" ||
    oldAdvancement.status !== "under_review"
  ) {
    throw new Error("真实推进Candidate未进入审核态");
  }
  await advancementCard
    .getByRole("textbox", { name: "当前阶段名称", exact: true })
    .fill("PS2 项目推进闭环");
  await advancementCard
    .getByRole("textbox", { name: "阶段目标", exact: true })
    .fill("让用户只靠对话维护阶段目标、关键结果和可信的负责人更新");
  await advancementCard
    .getByRole("combobox", { name: "健康判断", exact: true })
    .selectOption("at_risk");
  await advancementCard
    .getByRole("textbox", { name: "负责人更新", exact: true })
    .fill(UPDATE_MARKER);
  if ((await advancementCard.getByLabel("关键结果1").count()) === 0) {
    await advancementCard.getByRole("button", { name: "新增关键结果" }).click();
  }
  await advancementCard.getByLabel("关键结果1").fill("完成真实模型与浏览器推进闭环");
  await advancementCard
    .getByLabel("验收标准1（每行一项）")
    .fill("真实百炼调用、浏览器确认与重启恢复全部通过");
  await advancementCard.getByRole("button", { name: "保存推进方案" }).click();
  await expect(
    advancementCard.getByRole("textbox", { name: "当前阶段名称", exact: true }),
  ).toHaveValue("PS2 项目推进闭环");

  // 旧revision/Hash不能确认新候选，且失败不能产生任何项目事实。
  const staleStatus = await page.evaluate(
    async ({ candidateId, revision, candidateSha256 }) => {
      const response = await fetch(
        `/api/project-advancements/${encodeURIComponent(candidateId)}/decisions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: "cmd_projectadvancemente2estale",
            expectedRevision: revision,
            payload: { kind: "confirm", candidateSha256 },
          }),
        },
      );
      return response.status;
    },
    {
      candidateId: oldAdvancement.projectCandidateId,
      revision: oldAdvancement.revision,
      candidateSha256: oldAdvancement.candidateSha256,
    },
  );
  expect(staleStatus).toBe(409);
  await advancementCard.getByRole("button", { name: "确认阶段与发布更新" }).click();
  await expect(page.getByLabel("当前阶段").getByRole("heading")).toHaveText("PS2 项目推进闭环");
  await expect(page.getByText("完成真实模型与浏览器推进闭环", { exact: true })).toBeVisible();
  await expect(page.getByLabel("最新项目更新")).toContainText(UPDATE_MARKER);

  await page.reload();
  await expect(page.getByLabel("当前阶段").getByRole("heading")).toHaveText("PS2 项目推进闭环");
  await expect(page.getByLabel("最新项目更新")).toContainText(UPDATE_MARKER);

  await page.getByRole("button", { name: "管理项目" }).click();
  await page.getByLabel("项目管理动作").selectOption("action");
  await page.getByLabel("消息输入框").fill("新增待办：完成PS1真实验收");
  await page.getByRole("button", { name: "发送" }).click();
  const actionCandidate = page.getByLabel("项目管理方案");
  await expect(actionCandidate).toBeVisible();
  await actionCandidate.getByRole("button", { name: "确认写入项目账本" }).click();
  await expect(page.getByText("完成PS1真实验收", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "管理项目" }).click();
  await page.getByLabel("项目管理动作").selectOption("decision");
  await page.getByLabel("消息输入框").fill(`记录决定：${DECISION_MARKER}`);
  await page.getByRole("button", { name: "发送" }).click();
  const decisionCandidate = page.getByLabel("项目管理方案");
  await expect(decisionCandidate).toBeVisible();
  await decisionCandidate.getByLabel("决定问题").fill("BMAD与模型是否成为项目事实源？");
  await decisionCandidate
    .getByLabel("决定理由")
    .fill("Project事实由Chat Product Store和用户确认拥有");
  await decisionCandidate.getByRole("button", { name: "保存管理方案" }).click();
  await decisionCandidate.getByRole("button", { name: "确认写入项目账本" }).click();
  await expect(page.getByText(DECISION_MARKER, { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "管理项目" }).click();
  await page.getByLabel("项目管理动作").selectOption("contribution");
  await page.getByLabel("消息输入框").fill("记录贡献：用户完成PS1范围与方法边界确认");
  await page.getByRole("button", { name: "发送" }).click();
  const contributionCandidate = page.getByLabel("项目管理方案");
  await expect(contributionCandidate).toBeVisible();
  await contributionCandidate.getByRole("button", { name: "确认写入项目账本" }).click();
  await expect(
    page.getByText("用户完成PS1范围与方法边界确认", { exact: true }).first(),
  ).toBeVisible();
  const observationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/observations"),
  );
  await page.getByRole("button", { name: "刷新观察" }).click();
  expect((await observationResponse).status()).toBe(201);

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
  const traceEvents = traceLines.map(
    (line) => JSON.parse(line) as { eventName?: string; outcome?: string },
  );
  expect(
    traceEvents.filter((event) => event.eventName === "project.understanding.started"),
  ).toHaveLength(2);
  expect(
    traceEvents.filter((event) => event.eventName === "project.understanding.completed"),
  ).toHaveLength(2);
  expect(
    traceEvents.filter((event) => event.eventName === "project.understanding.failed"),
  ).toHaveLength(0);
  const traceText = traceLines.join("\n");
  expect(traceText).toContain('"providerName":"bailian"');
  expect(traceText).toContain('"modelId":"qwen3.7-plus"');
  expect(traceText).not.toContain(CONTENT_MARKER);
  expect(traceText).not.toContain(ADVANCEMENT_MARKER);
  expect(traceText).not.toContain(UPDATE_MARKER);
  expect(traceText).not.toContain(DECISION_MARKER);
  expect(traceText).not.toContain(resolve(process.cwd(), "../.."));
  expect(traceText).not.toContain("DASHSCOPE_API_KEY");
  expect(
    traceEvents.filter((event) => event.eventName === "project.advancement.candidate_published"),
  ).toHaveLength(1);
  expect(
    traceEvents.filter((event) => event.eventName === "project.advancement.confirmed"),
  ).toHaveLength(1);
  expect(
    traceEvents.filter((event) => event.eventName === "project.update.published"),
  ).toHaveLength(1);

  // Public Candidate合同不含provider/model；模型替换不会改变产品对象。
  if (pending !== null) {
    const serialized = JSON.stringify(projectCandidateDtoSchema.parse(pending));
    expect(serialized).not.toContain("providerName");
    expect(serialized).not.toContain("modelId");
  }
  await page.unrouteAll({ behavior: "wait" });
});
