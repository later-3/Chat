import { expect, test, type Page, type Route } from "@playwright/test";
import {
  approvalDtoSchema,
  planDtoSchema,
  runDtoSchema,
  workflowNodeDetailDtoSchema,
  workflowRunViewDtoSchema,
} from "@chat/contracts/public";

const NOW = "2026-08-10T10:00:00.000Z";
const RUN_ID = "run_browserviewer1";
const SESSION_ID = "psn_browserviewer1";
const VIEW_HASH = "a".repeat(64);

const run = runDtoSchema.parse({
  schemaVersion: "chat-product-api.v1",
  productRunId: RUN_ID,
  sessionId: SESSION_ID,
  sourceMessageId: "msg_browserviewer1",
  status: "waiting_human",
  phase: "plan_review",
  maxPlanRevisions: 5,
  currentPlan: {
    planId: "pln_browserviewer1",
    planRevision: 1,
    status: "under_review",
    sha256: "b".repeat(64),
  },
  allowedActions: ["request_revision", "approve", "reject"],
  revision: 4,
  createdAt: NOW,
  updatedAt: NOW,
});

const plan = planDtoSchema.parse({
  schemaVersion: "chat-product-api.v1",
  planId: "pln_browserviewer1",
  planRevision: 1,
  status: "under_review",
  sha256: "b".repeat(64),
  content: {
    objective: "在审核后整理项目资料",
    summary: "先读取上下文，再由用户确认执行。",
    assumptions: [],
    openQuestions: [],
    steps: [
      {
        stepId: "step-1",
        title: "整理资料",
        purpose: "形成可审核结果",
        dependsOn: [],
        inputRefs: [],
        expectedOutput: "Markdown摘要",
        successCriteria: ["内容可读"],
        requestedCapabilities: [],
        risk: "low",
      },
    ],
    completionCriteria: ["正式结果已提交"],
    warnings: [],
  },
  createdAt: NOW,
  updatedAt: NOW,
});

const approval = approvalDtoSchema.parse({
  schemaVersion: "chat-product-api.v1",
  approvalRequestId: "apr_browserviewer1",
  productRunId: RUN_ID,
  planId: plan.planId,
  planRevision: 1,
  planSha256: plan.sha256,
  status: "open",
  createdAt: NOW,
  expiresAt: "2030-08-10T10:00:00.000Z",
});

const view = workflowRunViewDtoSchema.parse({
  schemaVersion: "chat-workflow-api.v1",
  productRunId: RUN_ID,
  workflowViewDefinitionId: "wvd_browserviewer1",
  title: "规划—确认—执行",
  viewHash: VIEW_HASH,
  sourceKind: "legacy_code",
  historyCompleteness: "complete",
  definitionNodes: [
    {
      definitionNodeId: "context",
      nodeType: "context.compile",
      nodeSchemaVersion: "1",
      title: "整理上下文",
      kind: "task",
      optional: false,
    },
    {
      definitionNodeId: "plan",
      nodeType: "agent.plan",
      nodeSchemaVersion: "1",
      title: "生成计划",
      kind: "task",
      optional: false,
    },
    {
      definitionNodeId: "review",
      nodeType: "human.plan_review",
      nodeSchemaVersion: "1",
      title: "审核计划",
      kind: "human_review",
      optional: false,
    },
    {
      definitionNodeId: "execute",
      nodeType: "execute.plan",
      nodeSchemaVersion: "1",
      title: "执行计划",
      kind: "composite",
      optional: false,
    },
    {
      definitionNodeId: "validate",
      nodeType: "result.validate",
      nodeSchemaVersion: "1",
      title: "验证结果",
      kind: "task",
      optional: false,
    },
    {
      definitionNodeId: "commit",
      nodeType: "product.commit",
      nodeSchemaVersion: "1",
      title: "提交结果",
      kind: "product_commit",
      optional: false,
    },
  ],
  edges: [
    { from: "context", to: "plan", kind: "control" },
    { from: "plan", to: "review", kind: "control" },
    { from: "review", to: "plan", kind: "loop_back", outcomeCode: "revise" },
    { from: "review", to: "execute", kind: "outcome", outcomeCode: "approve" },
    { from: "execute", to: "validate", kind: "control" },
    { from: "validate", to: "commit", kind: "control" },
  ],
  nodeRuns: [
    ["wnr_browsercontext1", "context", "context.compile", "整理上下文", "succeeded"],
    ["wnr_browserplan1", "plan", "agent.plan", "生成计划", "succeeded"],
    ["wnr_browserreview1", "review", "human.plan_review", "审核计划", "waiting_human"],
    ["wnr_browserexecute1", "execute", "execute.plan", "执行计划", "queued"],
    ["wnr_browservalidate1", "validate", "result.validate", "验证结果", "queued"],
    ["wnr_browsercommit1", "commit", "product.commit", "提交结果", "queued"],
  ].map(([workflowNodeRunId, definitionNodeId, nodeType, title, status]) => ({
    workflowNodeRunId,
    definitionNodeId,
    nodeType,
    title,
    kind:
      definitionNodeId === "review"
        ? "human_review"
        : definitionNodeId === "execute"
          ? "composite"
          : definitionNodeId === "commit"
            ? "product_commit"
            : "task",
    optional: false,
    executionPath:
      definitionNodeId === "plan" || definitionNodeId === "review"
        ? [{ containerNodeId: "review", iteration: 1 }]
        : [],
    attemptNumber: 1,
    status,
    ...(status === "succeeded" ? { startedAt: NOW, finishedAt: NOW, durationMs: 80 } : {}),
    ...(status === "waiting_human" ? { startedAt: NOW } : {}),
    revision: status === "queued" ? 1 : 2,
    updatedAt: NOW,
    allowedActions: status === "waiting_human" ? ["inspect", "submit_decision"] : ["inspect"],
  })),
  revision: 12,
  updatedAt: NOW,
  allowedActions: ["inspect_nodes"],
});

function nodeDetail(url: string) {
  const nodeId = /\/workflow-nodes\/(wnr_[^?]+)/u.exec(url)?.[1];
  const node = view.nodeRuns.find((candidate) => candidate.workflowNodeRunId === nodeId);
  if (node === undefined) throw new Error(`未知Node:${String(nodeId)}`);
  const include = new URL(url).searchParams.get("include") ?? "";
  return workflowNodeDetailDtoSchema.parse({
    schemaVersion: "chat-workflow-api.v1",
    productRunId: RUN_ID,
    viewHash: VIEW_HASH,
    node,
    ...(include.includes("manifests")
      ? {
          input: {
            direction: "input",
            slots: [
              {
                name: "source",
                refs: [
                  {
                    kind: "message",
                    id: "msg_browserviewer1",
                    revision: 1,
                    sha256: "c".repeat(64),
                    label: "用户正式消息",
                  },
                ],
              },
            ],
            sha256: "d".repeat(64),
            revision: 1,
          },
        }
      : {}),
    ...(include.includes("timeline")
      ? {
          timeline: [
            { nodeSequence: 1, toStatus: "queued", reasonKind: "queued", occurredAt: NOW },
            {
              nodeSequence: 2,
              fromStatus: "queued",
              toStatus: node.status,
              reasonKind: node.status === "waiting_human" ? "waiting_human" : "completed",
              occurredAt: NOW,
            },
          ],
        }
      : {}),
    ...(include.includes("evidence")
      ? {
          evidence: [
            {
              kind: "plan_revision",
              id: "plr_browserviewer1",
              revision: 1,
              sha256: plan.sha256,
              label: "审核中的计划",
            },
          ],
        }
      : {}),
    revision: 3,
    updatedAt: NOW,
  });
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installApiProjection(page: Page, decisions: unknown[]): Promise<void> {
  await page.addInitScript(
    ({ sessionId, runId }) => {
      localStorage.setItem(
        "chat:real-session:v1",
        JSON.stringify({
          version: 1,
          sessionId,
          bootstrapCommandId: "cmd_browserbootstrap1",
        }),
      );
      localStorage.setItem(`chat:real-run:v1:${sessionId}`, runId);
    },
    { sessionId: SESSION_ID, runId: RUN_ID },
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = request.url();
    const pathname = new URL(url).pathname;
    if (pathname === "/api/healthz")
      return fulfillJson(route, { status: "ok", service: "chat-api" });
    if (pathname.endsWith("/workflow-view")) {
      if (request.headers()["if-none-match"] === '"browser-view-v1"') {
        return route.fulfill({ status: 304, headers: { ETag: '"browser-view-v1"' } });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { ETag: '"browser-view-v1"' },
        body: JSON.stringify(view),
      });
    }
    if (pathname.includes("/workflow-nodes/")) return fulfillJson(route, nodeDetail(url));
    if (pathname.endsWith("/decisions") && request.method() === "POST") {
      decisions.push(request.postDataJSON());
      return fulfillJson(
        route,
        {
          decision: {
            schemaVersion: "chat-product-api.v1",
            decisionId: "dec_browserviewer1",
            approvalRequestId: approval.approvalRequestId,
            productRunId: RUN_ID,
            planId: plan.planId,
            planRevision: 1,
            planSha256: plan.sha256,
            kind: "approve",
            createdAt: NOW,
          },
          run,
        },
        201,
      );
    }
    if (pathname.endsWith("/messages")) return fulfillJson(route, { items: [] });
    if (pathname.endsWith("/plans")) return fulfillJson(route, { items: [plan] });
    if (pathname.endsWith("/approvals/current")) return fulfillJson(route, { approval });
    if (pathname.endsWith("/context")) {
      return fulfillJson(route, {
        context: { schemaVersion: "chat-product-api.v1", productRunId: RUN_ID },
      });
    }
    if (pathname === `/api/runs/${RUN_ID}`) return fulfillJson(route, { run });
    if (pathname === "/api/workflow/catalog") {
      return fulfillJson(route, {
        catalog: { schemaVersion: "chat-product-api.v1", nodes: [] },
      });
    }
    if (pathname === "/api/workflow/blueprints") {
      return fulfillJson(route, {
        blueprints: { schemaVersion: "chat-product-api.v1", blueprints: [] },
      });
    }
    if (pathname === "/api/workflow/definitions") {
      return fulfillJson(route, {
        definitions: { schemaVersion: "chat-product-api.v1", definitions: [] },
      });
    }
    if (pathname === "/api/workflow/resources") {
      return fulfillJson(route, {
        resources: { schemaVersion: "chat-product-api.v1", resources: [] },
      });
    }
    if (pathname === `/api/runs/${RUN_ID}/workflow-config-summary`) {
      return fulfillJson(route, {
        summary: {
          schemaVersion: "chat-product-api.v1",
          productRunId: RUN_ID,
          runnerFamily: "legacy-planning.v1",
          runnerBundleVersion: "legacy-planning.bundle.v1",
          nodeCount: view.nodeRuns.length,
          resourceSummary: [],
          reviewSummary: [],
          createdAt: NOW,
        },
      });
    }
    if (pathname === "/api/memory-backends") return fulfillJson(route, { backends: [] });
    if (pathname.endsWith("/memory-imports")) return fulfillJson(route, { memoryImports: [] });
    if (pathname === "/api/project-roots") return fulfillJson(route, { roots: [] });
    if (pathname === "/api/projects") return fulfillJson(route, { projects: [] });
    if (pathname.endsWith("/project-candidates/current")) {
      return fulfillJson(route, { candidate: null });
    }
    return fulfillJson(
      route,
      {
        type: "https://chat.dev/problems/not-found",
        title: "不存在",
        status: 404,
        code: "not_found",
        requestId: "req_browserviewer1",
        retryable: false,
        recoveryAction: "none",
      },
      404,
    );
  });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const width = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(width.document).toBeLessThanOrEqual(width.client);
  expect(width.body).toBeLessThanOrEqual(width.client + 1);
}

for (const viewport of [
  { width: 375, height: 812, mode: "mobile" },
  { width: 768, height: 1024, mode: "canvas" },
  { width: 1440, height: 900, mode: "canvas" },
] as const) {
  test(`${viewport.width}px可找到等待节点、看依据并提交版本绑定决定`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const decisions: unknown[] = [];
    await installApiProjection(page, decisions);
    await page.setViewportSize(viewport);
    await page.goto("/");
    if (viewport.mode === "mobile") {
      await page.getByRole("tab", { name: "工作", exact: true }).click();
    }

    await expect(page.getByRole("heading", { name: "规划—确认—执行" })).toBeVisible();
    if (viewport.mode === "mobile") {
      await expect(page.getByRole("list", { name: "工作流节点顺序" })).toBeVisible();
    } else {
      await expect(
        page.getByLabel("工作流运行画布；节点不可移动或连线，可缩放和平移"),
      ).toBeVisible();
    }
    await expect(page.getByLabel("修改意见")).toHaveCount(1);
    await page.getByRole("tab", { name: "输入" }).click();
    await expect(page.getByText("用户正式消息")).toBeVisible();
    await page.getByRole("tab", { name: "证据" }).click();
    await expect(page.getByText("审核中的计划")).toBeVisible();
    await page.getByRole("tab", { name: "概览" }).click();
    await page.getByRole("button", { name: "通过" }).click();
    await expect.poll(() => decisions.length).toBe(1);
    expect(decisions[0]).toMatchObject({
      expectedRevision: run.revision,
      payload: {
        approvalRequestId: approval.approvalRequestId,
        planRevision: 1,
        planSha256: plan.sha256,
      },
    });
    await expectNoHorizontalScroll(page);
    expect(consoleErrors).toEqual([]);
  });
}
