import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:8031";

test("个人工作台按角色呈现Project并导出同源Obsidian目录", async ({ page }, testInfo) => {
  const marker = `${testInfo.project.name}-${Date.now()}`;
  const title = `英语口语 ${marker}`;
  const projectResponse = await page.request.post(`${API}/api/harness/projects`, {
    data: {
      command_id: `e2e:projection:project:${marker}`,
      kind: "learning",
      title,
      goal: "完成十分钟英文对话并保留可复习的错误证据",
      status: "active",
    },
  });
  expect(projectResponse.status()).toBe(201);
  const project = (await projectResponse.json()) as { id: string };

  const workResponse = await page.request.post(`${API}/api/harness/work-items`, {
    data: {
      command_id: `e2e:projection:work:${marker}`,
      project_id: project.id,
      kind: "learning_unit",
      title: "自我介绍练习",
      objective: "录制并复盘两分钟自我介绍",
      status: "ready",
    },
  });
  expect(workResponse.status()).toBe(201);
  const work = (await workResponse.json()) as { id: string };

  for (const [assigneeKind, actionTitle] of [
    ["user", "录制第一次自我介绍"],
    ["agent", "生成三轮追问练习"],
    ["external", "请老师反馈发音"],
  ] as const) {
    const response = await page.request.post(`${API}/api/harness/action-items`, {
      data: {
        command_id: `e2e:projection:action:${assigneeKind}:${marker}`,
        project_id: project.id,
        work_item_id: work.id,
        title: actionTitle,
        assignee_kind: assigneeKind,
        status: "ready",
      },
    });
    expect(response.status()).toBe(201);
  }

  const noteResponse = await page.request.post(`${API}/api/harness/notes`, {
    data: {
      command_id: `e2e:projection:note:${marker}`,
      kind: "learning_note",
      title: "本周发音薄弱点",
      content: "th发音需要刻意练习。",
      links: [{ resource_kind: "project", resource_id: project.id }],
    },
  });
  expect(noteResponse.status()).toBe(201);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /早上好，Later/ })).toBeVisible({
    timeout: 15_000,
  });
  const navigation = page.getByRole("navigation", {
    name: testInfo.project.name === "mobile-chromium" ? "手机主导航" : "主导航",
  });
  await navigation.getByRole("button", { name: "工作台" }).click();

  await expect(page.getByRole("heading", { name: "我的工作台" })).toBeVisible();
  await expect(page.getByText("当前为固定本地Scope的只读Projection")).toBeVisible();
  await page
    .getByRole("navigation", { name: "工作台领域筛选" })
    .getByRole("button", { name: /学习/ })
    .click();

  const card = page.locator(".workspace-project-card").filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(card.getByText("你 1", { exact: true })).toBeVisible();
  await expect(card.getByText("AI 1", { exact: true })).toBeVisible();
  await expect(card.getByText("外部 1", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "打开档案" }).click();

  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("heading", { name: "谁来做什么" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "你来做" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chat / AI执行" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "外部协作" })).toBeVisible();
  await expect(page.getByText("本周发音薄弱点", { exact: true })).toBeVisible();
  await expect(page.getByText("th发音需要刻意练习。", { exact: true })).toBeVisible();
  await expect(page.getByText("schedule_not_implemented", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "预览目录结构" }).click();
  await expect(page.getByText(`Projects/${project.id}/README.md`, { exact: true })).toBeVisible();
  await expect(
    page.getByText(`Projects/${project.id}/Responsibilities/agent.md`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`Projects/${project.id}/Learning/review-queue.md`, { exact: true }),
  ).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载ZIP" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`chat-project-${project.id}.zip`);
  expect(await download.failure()).toBeNull();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  if (testInfo.project.name === "chromium") {
    const results = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
    expect(results.violations).toEqual([]);
  }
});
