import { expect, test, type Page } from "@playwright/test";

const FORBIDDEN_PUBLIC_MARKERS = [
  "workflowRunId",
  "hookToken",
  "piSessionId",
  "x-chat-runtime-key",
  "DASHSCOPE_API_KEY",
] as const;

function guardPublicResponse(contentType: string, body: string): void {
  if (!contentType.includes("application/json")) return;
  for (const marker of FORBIDDEN_PUBLIC_MARKERS) {
    if (body.includes(marker)) throw new Error(`公开API响应包含私有Runtime标识:${marker}`);
  }
}

function responseWasDisposed(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Response has been disposed");
}

async function openWaitingNoteReview(page: Page): Promise<void> {
  const jump = page.getByRole("button", { name: "转到等待审核节点" });
  await expect
    .poll(
      async () =>
        (await page.getByRole("region", { name: "笔记候选审核" }).count()) > 0 ||
        (await jump.count()) > 0,
    )
    .toBe(true);
  if ((await page.getByRole("region", { name: "笔记候选审核" }).count()) === 0) await jump.click();
  await expect(page.getByRole("region", { name: "笔记候选审核" })).toBeVisible();
}

test("真实Note：配置输入→候选→编辑确认→正式Revision→打开Designer副本", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    try {
      const response = await route.fetch();
      const body = await response.body();
      guardPublicResponse(response.headers()["content-type"] ?? "", body.toString("utf8"));
      await route.fulfill({ response, body });
    } catch (error) {
      // 页面结束/导航时会取消仍在轮询的只读Query；该Response已不再交付给浏览器，
      // 不能把Playwright释放对象误报成产品或泄密失败。
      if (!responseWasDisposed(error)) throw error;
    }
  });

  await page.goto("/");
  const message = "候选必须先人工确认，再成为正式笔记；请保存为学习笔记。";
  await page.getByLabel("消息输入框").fill(message);
  await page.getByLabel("选择规划工作流").selectOption("wfr_systemnotev1");
  await page.getByLabel("默认 Note 类型").selectOption("learning");
  await page.getByLabel("Note 建议标签").fill("Workflow,审核");
  await page.getByRole("button", { name: "发送" }).click();

  await openWaitingNoteReview(page);
  const review = page.getByRole("region", { name: "笔记候选审核" });
  const editedTitle = "人工确认边界（浏览器编辑）";
  await review.getByLabel("标题").fill(editedTitle);
  await review.getByRole("button", { name: "确认编辑后的候选" }).click();
  await expect(page.getByText("工作已完成，正式结果已作为Assistant消息进入对话。")).toBeVisible();

  await page.getByRole("tab", { name: "笔记", exact: true }).click();
  const notes = page.getByRole("region", { name: "笔记" });
  await expect(notes.getByText(editedTitle)).toBeVisible();
  await notes.getByRole("button", { name: new RegExp(editedTitle, "u") }).click();
  await expect(page.getByRole("region", { name: "笔记详情" })).toContainText(editedTitle);

  await page.getByRole("tab", { name: "工作流设计器" }).click();
  await page.getByLabel("选择要设计的 Definition").selectOption("wfd_systemnotev1");
  const copy = page.getByRole("region", { name: "复制系统 Definition" });
  await copy.getByLabel("副本名称").fill("真实 Note 浏览器副本");
  await copy.getByLabel("说明").fill("来自真实Note闭环的受约束Designer组合验证");
  await copy.getByRole("button", { name: "创建可编辑副本" }).click();
  await expect(page.getByRole("heading", { name: "真实 Note 浏览器副本" })).toBeVisible();

  const publicSurface = JSON.stringify(
    await page.evaluate(() => ({
      html: document.documentElement.innerHTML,
      storage: Object.fromEntries(Object.entries(localStorage)),
    })),
  );
  for (const marker of FORBIDDEN_PUBLIC_MARKERS) expect(publicSurface).not.toContain(marker);
});
