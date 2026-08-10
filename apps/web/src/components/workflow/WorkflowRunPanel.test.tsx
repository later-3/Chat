import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  workflowNodeDetailDtoSchema,
  workflowRunViewDtoSchema,
  type ApprovalDto,
  type PlanDto,
  type RunDto,
  type WorkflowNodeDetailDto,
} from "@chat/contracts/public";
import type { RealChainState } from "../../real/use-real-chain.js";
import { clearWorkflowProjectionTransportCache } from "../../api/client.js";
import { WorkflowRunPanel } from "./WorkflowRunPanel.js";

const NOW = "2026-08-10T10:00:00.000Z";
const VIEW_HASH = "a".repeat(64);

const run: RunDto = {
  schemaVersion: "chat-product-api.v1",
  productRunId: "run_viewer1" as never,
  sessionId: "psn_viewer1" as never,
  sourceMessageId: "msg_viewer1" as never,
  status: "waiting_human",
  phase: "plan_review",
  maxPlanRevisions: 5,
  currentPlan: {
    planId: "pln_viewer1" as never,
    planRevision: 1,
    status: "under_review",
    sha256: "b".repeat(64),
  },
  allowedActions: ["request_revision", "approve", "reject"],
  revision: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

const plan: PlanDto = {
  schemaVersion: "chat-product-api.v1",
  planId: "pln_viewer1" as never,
  planRevision: 1,
  status: "under_review",
  sha256: "b".repeat(64),
  content: {
    objective: "审核后执行任务",
    summary: "计划正文只在审核节点按需呈现",
    assumptions: [],
    openQuestions: [],
    steps: [
      {
        stepId: "step-1",
        title: "执行一步",
        purpose: "完成用户目标",
        dependsOn: [],
        inputRefs: [],
        expectedOutput: "正式结果",
        successCriteria: ["结果可读"],
        requestedCapabilities: [],
        risk: "low",
      },
    ],
    completionCriteria: ["正式结果已提交"],
    warnings: [],
  },
  createdAt: NOW,
  updatedAt: NOW,
};

const approval: ApprovalDto = {
  schemaVersion: "chat-product-api.v1",
  approvalRequestId: "apr_viewer1" as never,
  productRunId: run.productRunId,
  planId: plan.planId,
  planRevision: 1,
  planSha256: plan.sha256,
  status: "open",
  createdAt: NOW,
  expiresAt: "2030-08-10T10:00:00.000Z",
};

const view = workflowRunViewDtoSchema.parse({
  schemaVersion: "chat-workflow-api.v1",
  productRunId: run.productRunId,
  workflowViewDefinitionId: "wvd_viewer1",
  title: "规划—确认—执行",
  viewHash: VIEW_HASH,
  sourceKind: "legacy_code",
  historyCompleteness: "complete",
  definitionNodes: [
    {
      definitionNodeId: "context",
      nodeType: "context.compile",
      nodeSchemaVersion: "1",
      title: "整理<script>上下文",
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
      definitionNodeId: "commit",
      nodeType: "product.commit",
      nodeSchemaVersion: "1",
      title: "提交结果",
      kind: "product_commit",
      optional: false,
    },
  ],
  edges: [
    { from: "context", to: "review", kind: "control" },
    { from: "review", to: "commit", kind: "outcome", outcomeCode: "approve" },
  ],
  nodeRuns: [
    {
      workflowNodeRunId: "wnr_context1",
      definitionNodeId: "context",
      nodeType: "context.compile",
      title: "整理<script>上下文",
      kind: "task",
      optional: false,
      executionPath: [],
      attemptNumber: 1,
      status: "succeeded",
      publicSummary: "已采用安全上下文摘要",
      startedAt: NOW,
      finishedAt: NOW,
      durationMs: 42,
      revision: 2,
      updatedAt: NOW,
      allowedActions: ["inspect"],
    },
    {
      workflowNodeRunId: "wnr_review1",
      definitionNodeId: "review",
      nodeType: "human.plan_review",
      title: "审核计划",
      kind: "human_review",
      optional: false,
      executionPath: [{ containerNodeId: "review", iteration: 1 }],
      attemptNumber: 1,
      status: "waiting_human",
      startedAt: NOW,
      revision: 2,
      updatedAt: NOW,
      allowedActions: ["inspect", "submit_decision"],
    },
    {
      workflowNodeRunId: "wnr_commit1",
      definitionNodeId: "commit",
      nodeType: "product.commit",
      title: "提交结果",
      kind: "product_commit",
      optional: false,
      executionPath: [],
      attemptNumber: 1,
      status: "queued",
      revision: 1,
      updatedAt: NOW,
      allowedActions: ["inspect"],
    },
  ],
  revision: 8,
  updatedAt: NOW,
  allowedActions: ["inspect_nodes"],
});

function detailFor(
  nodeId: string,
  url: string,
  sourceView: typeof view = view,
): WorkflowNodeDetailDto {
  const node = sourceView.nodeRuns.find((candidate) => candidate.workflowNodeRunId === nodeId);
  if (node === undefined) throw new Error(`unknown node:${nodeId}`);
  const include = new URL(url, "http://chat.test").searchParams.get("include") ?? "";
  return workflowNodeDetailDtoSchema.parse({
    schemaVersion: "chat-workflow-api.v1",
    productRunId: run.productRunId,
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
                    id: "msg_viewer1",
                    revision: 1,
                    sha256: "c".repeat(64),
                    label: "<img src=x onerror=alert(1)>用户原话",
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
            {
              nodeSequence: 1,
              toStatus: "queued",
              reasonKind: "queued",
              occurredAt: NOW,
            },
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
              id: "plr_viewer1",
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

function chainFixture(): RealChainState {
  const query = (data?: unknown) => ({ data, isError: false }) as never;
  return {
    runContext: query(undefined),
    memoryBackends: query([]),
    pendingDecision: null,
    deciding: false,
    decisionError: null,
    submitDecision: vi.fn(),
    retryPendingDecision: vi.fn(),
    clearDecisionError: vi.fn(),
  } as unknown as RealChainState;
}

function installWorkflowApi(sourceView: typeof view = view): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/workflow-view")) {
      return new Response(JSON.stringify(sourceView), {
        status: 200,
        headers: { "content-type": "application/json", ETag: '"viewer-v1"' },
      });
    }
    const match = /\/workflow-nodes\/(wnr_[^?]+)/u.exec(url);
    if (match?.[1] !== undefined) {
      return new Response(JSON.stringify(detailFor(match[1], url, sourceView)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPanel(chain = chainFixture()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    chain,
    ...render(
      <QueryClientProvider client={queryClient}>
        <WorkflowRunPanel chain={chain} run={run} plans={[plan]} approval={approval} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  onlineManager.setOnline(true);
  window.history.replaceState({}, "", "/?view=real");
  clearWorkflowProjectionTransportCache();
});

afterEach(() => {
  cleanup();
  clearWorkflowProjectionTransportCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("真实Workflow Run Viewer", () => {
  it("手机线性路径自动定位等待节点，五Tab按需查询且不执行恶意标签", async () => {
    const fetchMock = installWorkflowApi();
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByRole("heading", { name: "审核计划" })).toBeTruthy();
    expect(await screen.findAllByLabelText("修改意见")).toHaveLength(1);
    expect(screen.getByRole("list", { name: "工作流节点顺序" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "输入" }));
    expect(await screen.findByText("<img src=x onerror=alert(1)>用户原话")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("include=manifests"))).toBe(
      true,
    );

    const inputTab = screen.getByRole("tab", { name: "输入" });
    await user.type(inputTab, "{ArrowRight}");
    expect(screen.getByRole("tab", { name: "输出" }).getAttribute("aria-selected")).toBe("true");
  });

  it("切换节点不丢审核草稿，返回后仍只有一个权威表单", async () => {
    installWorkflowApi();
    const user = userEvent.setup();
    renderPanel();
    const draft = await screen.findByLabelText("修改意见");
    await user.type(draft, "保留这条审核意见");

    await user.click(screen.getByRole("button", { name: /整理<script>上下文，已完成，查看详情/ }));
    expect(screen.queryByLabelText("修改意见")).toBeNull();
    await user.click(screen.getByRole("button", { name: /审核计划，等待人工审核，查看详情/ }));
    expect(((await screen.findByLabelText("修改意见")) as HTMLTextAreaElement).value).toBe(
      "保留这条审核意见",
    );
    expect(screen.getAllByLabelText("修改意见")).toHaveLength(1);
  });

  it("Note进入等待后也提供统一的审核节点入口", async () => {
    const noteView = workflowRunViewDtoSchema.parse({
      ...view,
      title: "默认笔记工作流",
      definitionNodes: view.definitionNodes.map((node) =>
        node.definitionNodeId === "review"
          ? { ...node, nodeType: "human.note_review", title: "审核笔记" }
          : node,
      ),
      nodeRuns: view.nodeRuns.map((node) =>
        node.definitionNodeId === "review"
          ? { ...node, nodeType: "human.note_review", title: "审核笔记" }
          : node,
      ),
    });
    window.history.replaceState(
      {},
      "",
      `/?workflowRun=${run.productRunId}&workflowNode=wnr_context1`,
    );
    installWorkflowApi(noteView);
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "转到等待审核节点" }));
    expect(await screen.findByRole("heading", { name: "审核笔记" })).toBeTruthy();
  });

  it("审核命令继续绑定Run revision与Plan hash，不在前端乐观改节点状态", async () => {
    installWorkflowApi();
    const chain = chainFixture();
    const user = userEvent.setup();
    renderPanel(chain);
    await user.click(await screen.findByRole("button", { name: "通过" }));
    expect(chain.submitDecision).toHaveBeenCalledWith({
      expectedRunRevision: run.revision,
      payload: {
        approvalRequestId: approval.approvalRequestId,
        planId: plan.planId,
        planRevision: plan.planRevision,
        planSha256: plan.sha256,
        kind: "approve",
      },
    });
    expect(screen.getAllByText("等待人工审核").length).toBeGreaterThan(0);
  });

  it("离线保留最后成功快照并明确标记陈旧", async () => {
    installWorkflowApi();
    renderPanel();
    await screen.findByText("规划—确认—执行");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
    expect(await screen.findByText("离线 · 显示上次快照")).toBeTruthy();
    expect(screen.getByRole("list", { name: "工作流节点顺序" })).toBeTruthy();
  });

  it("legacy_limited succeeded运行不会因缺证据queued节点被误报为不一致", async () => {
    const legacy = { ...view, historyCompleteness: "legacy_limited" as const };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/workflow-view")) {
        return new Response(JSON.stringify(legacy), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const match = /\/workflow-nodes\/(wnr_[^?]+)/u.exec(url);
      return new Response(JSON.stringify(detailFor(match?.[1] ?? "wnr_context1", url)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkflowRunPanel
          chain={chainFixture()}
          run={{ ...run, status: "succeeded", phase: "completed", allowedActions: [] }}
          plans={[plan]}
          approval={approval}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("旧运行 · 细节有限")).toBeTruthy();
    expect(screen.queryByText(/事实不一致/)).toBeNull();
  });
});
