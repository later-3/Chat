import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /早上好，Later/ })).toBeVisible({
    timeout: 15_000,
  });
  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("navigation", { name: "手机主导航" }).getByText("对话").click();
  } else {
    await page.getByRole("navigation", { name: "主导航" }).getByText("对话").click();
  }
  await expect(page.getByLabel("发送消息")).toBeEnabled({ timeout: 15_000 });
});

test("主页默认展示真实继续事项、协作日历和明确的能力桩", async ({ page }, testInfo) => {
  if (testInfo.project.name === "mobile-chromium") {
    await page.getByRole("navigation", { name: "手机主导航" }).getByText("主页").click();
  } else {
    await page.getByRole("navigation", { name: "主导航" }).getByText("主页").click();
  }

  await expect(page.getByRole("heading", { name: "年度协作日历" })).toBeVisible();
  await expect(
    page.getByText("颜色只表示这一天发生了什么层级的真实活动，不是效率评分。"),
  ).toBeVisible();
  await expect(page.getByText("完整协作日接入中")).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近产物" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "灵感花园" })).toBeVisible();
});

test("对话页刷新后仍加载桌面活动导航样式", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "桌面活动导航回归");

  // beforeEach 已从主页进入对话并写入 sessionStorage；整页刷新会直接恢复对话视图，
  // 因而能够发现 ActivityRail 错误依赖懒加载 HomeView 样式的回归。
  await page.reload();
  await expect(page.getByLabel("发送消息")).toBeEnabled({ timeout: 15_000 });

  const activityRail = page.getByRole("navigation", { name: "主导航" });
  await expect(activityRail).toBeVisible();
  await expect(activityRail).toHaveCSS("flex-direction", "column");
  await expect(activityRail).toHaveCSS("width", "78px");
  await expect(activityRail.getByRole("button", { name: "对话" })).toHaveCSS("width", "58px");

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
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

test("手机主导航可以进入个人工作台并明确返回对话", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "仅验证手机信息架构");

  const mobileNav = page.getByRole("navigation", { name: "手机主导航" });
  await expect(mobileNav).toBeVisible();
  await mobileNav.getByRole("button", { name: "工作台" }).click();
  await expect(page.getByRole("heading", { name: "我的工作台" })).toBeVisible();

  await mobileNav.getByRole("button", { name: "对话" }).click();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByLabel("发送消息")).toBeVisible();

  await mobileNav.getByRole("button", { name: "配置" }).click();
  await expect(page.getByRole("dialog", { name: "配置中心" })).toBeVisible();
  await page.getByRole("button", { name: "关闭配置中心" }).click();
});

test("Project可以只读连接Repository并在桌面和手机管理生命周期", async ({ page }, testInfo) => {
  const marker = `${testInfo.project.name}-${Date.now()}`;
  const projectResponse = await page.request.post("http://127.0.0.1:8031/api/harness/projects", {
    data: {
      command_id: `e2e:create-repository-project:${marker}`,
      kind: "delivery",
      title: `Repository E2E ${marker}`,
      goal: "验证Project Repository只读绑定与浏览器交互",
      status: "active",
    },
  });
  expect(projectResponse.status()).toBe(201);

  let markRootRequestObserved = () => {};
  const rootRequestObserved = new Promise<void>((resolve) => {
    markRootRequestObserved = resolve;
  });
  let releaseRootRequest = () => {};
  const rootRequestRelease = new Promise<void>((resolve) => {
    releaseRootRequest = resolve;
  });
  let holdRootRequests = true;
  await page.route("**/api/harness/repository-roots", async (route) => {
    if (!holdRootRequests) {
      await route.continue();
      return;
    }
    markRootRequestObserved();
    await rootRequestRelease;
    await route.continue();
  });

  await page.reload();
  await expect(page.getByLabel("发送消息")).toBeEnabled({ timeout: 15_000 });
  await openProjectManagement(page, testInfo.project.name);

  const workbench = page.getByRole("complementary", { name: "我的项目 工作台" });
  await expect(workbench).toBeVisible();
  await expect(
    workbench.getByText(`Repository E2E ${marker}`, { exact: true }).first(),
  ).toBeVisible();
  await rootRequestObserved;
  await workbench.getByRole("button", { name: "连接仓库" }).click();

  const dialog = page.getByRole("dialog", { name: "连接代码仓库" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("还没有可用的Workspace Root")).toBeVisible();
  holdRootRequests = false;
  releaseRootRequest();
  await expect(dialog.getByLabel("允许根")).toHaveValue("e2e-code");
  await page.unroute("**/api/harness/repository-roots");
  await dialog.getByRole("button", { name: /chat-e2e-repository/ }).click();
  await expect(dialog.getByText("Git仓库", { exact: true })).toBeVisible();

  if (testInfo.project.name === "mobile-chromium") {
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(380);
    expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) - (viewport?.height ?? 0))).toBeLessThan(12);
  }

  await dialog.getByRole("button", { name: "检查并连接" }).click();
  const repositoryCard = workbench.locator(".repository-card").filter({
    hasText: "chat-e2e-repository",
  });
  await expect(repositoryCard).toBeVisible();
  await expect(repositoryCard.getByText("可用", { exact: true })).toBeVisible();
  await expect(repositoryCard).not.toContainText("/tmp/");

  await repositoryCard.getByRole("button", { name: "查看基线" }).click();
  await expect(repositoryCard.getByText("代码基线", { exact: true })).toBeVisible();
  await expect(repositoryCard.getByText("工作树干净。", { exact: true })).toBeVisible();
  await expect(repositoryCard.getByText("尚未进入本轮Context", { exact: true })).toBeVisible();

  await repositoryCard.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(repositoryCard.getByText("可用", { exact: true })).toBeVisible();

  await repositoryCard.getByRole("button", { name: "重绑", exact: true }).click();
  const rebindDialog = page.getByRole("dialog", { name: "重新连接代码仓库" });
  await expect(rebindDialog).toBeVisible();
  await rebindDialog.getByRole("button", { name: "检查并重新连接" }).click();
  await expect(rebindDialog).toBeHidden();

  await repositoryCard.getByRole("button", { name: "解除", exact: true }).click();
  await expect(repositoryCard.getByText("解除后保留历史Snapshot", { exact: true })).toBeVisible();
  await repositoryCard.getByRole("button", { name: "确认解除" }).click();
  await expect(repositoryCard.getByText("已解除", { exact: true })).toBeVisible();
  await expect(repositoryCard.getByText(/历史基线/)).toBeVisible();
});

test("Repository来源在本轮Context中公开版本、采用原因并可按需载入正文", async ({
  page,
}, testInfo) => {
  const semanticHash = "f4c2f17044586f7352108bd3d1b63d513eba98f60ff8c09496f9009e53dc88b2";
  const baseItems = [
    {
      source_kind: "repository_snapshot",
      source_id: "binding-e2e",
      source_revision: semanticHash,
      title: "Chat · Repository Snapshot",
      content: '{"dirty":false,"head_ref":"refs/heads/main","head_short":"abc1234567"}',
      adopted: true,
      locked: false,
      selection_origin: "system",
      reason: "选定Project的默认代码基线",
      token_estimate: 28,
    },
    {
      source_kind: "repository_governance",
      source_id: "binding-e2e:AGENTS.md",
      source_revision: semanticHash,
      title: "Chat · AGENTS.md",
      content: "所有模型调用发送前都必须经过用户确认。",
      adopted: true,
      locked: false,
      selection_origin: "system",
      reason: "当前开发意图需要该仓库治理文档，正文Hash已与Repository Snapshot核对",
      token_estimate: 18,
    },
    {
      source_kind: "repository_governance_manifest",
      source_id: "binding-e2e:PROJECT_PLAN.md",
      source_revision: semanticHash,
      title: "Chat · PROJECT_PLAN.md",
      content:
        '{"body_loaded":false,"kind":"project_plan","path":"PROJECT_PLAN.md","size_bytes":128}',
      adopted: false,
      locked: false,
      selection_origin: "system",
      reason: "当前意图未默认选择该治理文档；可在Context工作台按需载入",
      token_estimate: 22,
    },
  ];
  let currentContext = {
    id: "context-e2e-v2",
    session_id: "session-e2e",
    run_id: "run-context-e2e",
    stage: "detail",
    revision: 2,
    previous_package_id: "context-e2e-v1",
    selected_project_id: "project-e2e",
    selected_work_item_id: null,
    token_budget: 6000,
    estimated_tokens: 68,
    package_hash: "context-hash-v2",
    status: "adopted",
    revision_reason: "系统按当前Project装配",
    created_by: "system",
    created_at: "2026-07-24T00:00:00Z",
    items: baseItems,
  };
  let submittedRevision: Record<string, unknown> | null = null;

  await page.route("**/api/harness/sessions/*/context/latest", async (route) => {
    await route.fulfill({ json: { context_package: currentContext } });
  });
  await page.route("**/api/runs/run-context-e2e/step-inputs", async (route) => {
    await route.fulfill({ json: { step_inputs: [] } });
  });
  await page.route("**/api/harness/context-packages/context-e2e-v2/revisions", async (route) => {
    submittedRevision = route.request().postDataJSON() as Record<string, unknown>;
    currentContext = {
      ...currentContext,
      id: "context-e2e-v3",
      revision: 3,
      previous_package_id: "context-e2e-v2",
      package_hash: "context-hash-v3",
      estimated_tokens: 94,
      revision_reason: "用户选择载入Project计划",
      items: [
        ...baseItems.slice(0, 2),
        {
          ...baseItems[2],
          source_kind: "repository_governance",
          content: "# Plan\n\n完成SD1-C浏览器验证。",
          adopted: true,
          selection_origin: "human",
          reason: "用户明确选择并由服务端核对Snapshot后载入",
        },
      ],
    };
    await route.fulfill({
      json: {
        ...currentContext,
        previous_package_hash: "context-hash-v2",
        execution_invalidation: {
          invalidated: true,
          draft_ids: ["draft-e2e"],
          decision_request_ids: ["decision-e2e"],
          requires_recompile: true,
        },
      },
    });
  });

  await page.reload();
  await expect(page.getByLabel("发送消息")).toBeEnabled({ timeout: 15_000 });
  await openProjectManagement(page, testInfo.project.name);
  const workbench = page.getByRole("complementary", { name: "我的项目 工作台" });
  await expect(workbench).toBeVisible();
  await workbench
    .getByRole("navigation", { name: "工作台视图" })
    .getByText("本轮", { exact: true })
    .click();

  const contextWorkbench = page.getByRole("complementary", { name: "本轮协作信息 工作台" });
  await expect(contextWorkbench.getByText("revision 2", { exact: true })).toBeVisible();
  const adoptedRule = contextWorkbench.locator("article").filter({ hasText: "Chat · AGENTS.md" });
  await expect(adoptedRule.getByText("仓库治理正文", { exact: true })).toBeVisible();
  await expect(adoptedRule.getByText(semanticHash.slice(0, 10), { exact: true })).toBeVisible();
  await expect(adoptedRule).toContainText("正文Hash已与Repository Snapshot核对");

  await contextWorkbench.getByRole("button", { name: "调整本轮信息" }).click();
  const planEditor = contextWorkbench
    .locator(".context-edit-item")
    .filter({ hasText: "Chat · PROJECT_PLAN.md" });
  await planEditor.locator('input[type="checkbox"]').check();
  await contextWorkbench.getByRole("button", { name: "保存并重新检查" }).click();

  await expect(contextWorkbench.getByText("revision 3", { exact: true })).toBeVisible();
  const submittedItems = submittedRevision?.item_changes as
    | Array<Record<string, unknown>>
    | undefined;
  expect(submittedItems?.[2]?.materialize).toBe(true);
  expect(submittedItems?.[2]?.adopted).toBe(true);
  const materializedRule = contextWorkbench
    .locator("article")
    .filter({ hasText: "Chat · PROJECT_PLAN.md" });
  await expect(materializedRule.getByText("仓库治理正文", { exact: true })).toBeVisible();
  await expect(materializedRule).toContainText("用户明确选择并由服务端核对Snapshot后载入");
});

test("断网时保留界面但禁止制造已发送假象", async ({ context, page }) => {
  await context.setOffline(true);
  await expect(page.getByText("当前设备离线。你可以保留输入")).toBeVisible();
  await expect(page.getByLabel("发送消息")).toBeEnabled();
  await page.getByLabel("发送消息").fill("离线时保留的草稿");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByLabel("发送消息")).toHaveValue("离线时保留的草稿");
  await page.reload();
  await expect(page.getByLabel("发送消息")).toHaveValue("离线时保留的草稿");
});

async function openProjectManagement(page: import("@playwright/test").Page, projectName: string) {
  const navigation = page.getByRole("navigation", {
    name: projectName === "mobile-chromium" ? "手机主导航" : "主导航",
  });
  await navigation.getByRole("button", { name: "工作台" }).click();
  await expect(page.getByRole("heading", { name: "我的工作台" })).toBeVisible();
  await page.getByRole("button", { name: "管理Project与资源" }).click();
}

test("localhost开发入口注册PWA壳", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "只执行一次PWA注册合同");

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref).toBeTruthy();
  const manifestResponse = await page.request.get(manifestHref ?? "/manifest.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return registration.active?.state ?? null;
      }),
    )
    .toBe("activated");
});
