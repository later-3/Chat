import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("发送消息")).toBeEnabled({ timeout: 15_000 });
});

test("用户能创建会话并完成确定性AG-UI回合", async ({ page }, testInfo) => {
  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("button", { name: "打开会话列表" }).click();
    await page.getByRole("button", { name: "创建会话" }).click();
  } else {
    await page.getByRole("button", { name: "新对话" }).click();
  }
  await expect(page.getByLabel("发送消息")).toBeEnabled();

  await page.getByLabel("发送消息").fill("Q05_BROWSER_E2E");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  await expect(
    page.getByText(
      "AG-UI 已连接到 Microsoft Agent Framework。当前未配置模型密钥，因此由确定性启动 Agent 返回此消息。",
    ),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("发送消息")).toBeEnabled();
});

test("会话侧栏与Workflow工作台可以独立收起和展开", async ({ page }, testInfo) => {
  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("button", { name: "打开会话列表" }).click();
    await expect(page.getByRole("complementary", { name: "会话列表" })).toBeVisible();
    await page.getByRole("button", { name: "关闭会话列表" }).click();
  } else {
    await page.getByRole("button", { name: "收起会话列表" }).click();
    await expect(page.getByRole("button", { name: "展开会话列表" })).toBeVisible();
    await page.getByRole("button", { name: "展开会话列表" }).click();
    await expect(page.getByRole("complementary", { name: "会话列表" })).toBeVisible();
  }

  const workbench = page.getByRole("complementary", {
    name: "Workflow Run 工作台",
  });
  if (await workbench.isVisible()) {
    await page.getByRole("button", { name: "关闭工作台" }).click();
  }
  await page.getByRole("button", { name: "打开 Workflow Run 工作台" }).click();
  await expect(page.getByRole("complementary", { name: "Workflow Run 工作台" })).toBeVisible();
});

test("设计者可以定位、展开多个Workflow节点并明确返回对话", async ({ page }, testInfo) => {
  const nodes = Array.from({ length: 25 }, (_, index) => ({
    id: `node_${index + 1}`,
    label: `真实节点 ${index + 1}`,
    description: `用于验证设计者运行视图的第 ${index + 1} 个节点`,
    kind: index % 4 === 0 ? "agent" : "workflow",
    runtime_type: index % 4 === 0 ? "agent" : "executor",
    parent_id: null,
    depth: 0,
  }));
  await page.route("**/api/workflows", async (route) => {
    await route.fulfill({
      json: {
        workflows: [
          {
            id: "designer-e2e-workflow",
            name: "设计者 E2E Workflow",
            version: "1.0.0",
            description: "包含25个真实节点的浏览器交互合同。",
            endpoint: "/api/workflows/designer-e2e/run",
            selectable: true,
            nodes,
            edges: nodes.slice(1).map((node, index) => ({
              source: nodes[index].id,
              target: node.id,
            })),
          },
        ],
      },
    });
  });
  await page.reload();
  await expect(page.getByLabel("发送消息")).toBeEnabled({ timeout: 15_000 });

  const workbench = page.getByRole("complementary", {
    name: "Workflow Run 工作台",
  });
  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("button", { name: "打开 Workflow Run 工作台" }).click();
  }
  await expect(workbench).toBeVisible();

  await expect(workbench.getByText("Workflow 运行视图", { exact: true })).toBeVisible();
  await expect(workbench.getByRole("region", { name: "Workflow思维导图" })).toBeVisible();
  await workbench.getByRole("button", { name: "查看全部 25 个节点" }).click();
  const workflowNodes = workbench.locator(".execution-stage-list--workflow-nodes article");
  await expect(workflowNodes).toHaveCount(25);

  const firstNode = workflowNodes.nth(0).getByRole("button");
  const secondNode = workflowNodes.nth(1).getByRole("button");
  await firstNode.click();
  await secondNode.click();
  await expect(firstNode).toHaveAttribute("aria-expanded", "true");
  await expect(secondNode).toHaveAttribute("aria-expanded", "true");

  await workbench.getByRole("button", { name: "收起内容", exact: true }).click();
  await expect(firstNode).toHaveAttribute("aria-expanded", "false");
  await expect(secondNode).toHaveAttribute("aria-expanded", "false");

  const closeButton = workbench.getByRole("button", { name: "关闭工作台" });
  if (testInfo.project.name === "mobile-chromium") {
    await expect(closeButton.getByText("返回对话")).toBeVisible();
  }
  await closeButton.click();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("button", { name: "打开 Workflow Run 工作台" })).toBeFocused();
});

test("主工作区没有严重自动可访问性问题", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "桌面项目执行完整axe扫描");
  const results = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
  expect(results.violations).toEqual([]);
});
