import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinitionPublishedDto } from "@chat/contracts/public";
import { WorkflowDesigner } from "./WorkflowDesigner.js";
import type { EditableWorkflowDefinitionDetail, WorkflowDefinitionSequence } from "./types.js";

const NOW = "2026-08-10T00:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

const ROOT: WorkflowDefinitionSequence = {
  kind: "sequence",
  elements: [
    {
      kind: "task",
      definitionNodeId: "planning.memory",
      nodeType: "context.memory",
      schemaVersion: 1,
      config: {},
      defaultActivation: "enabled",
    },
    {
      kind: "bounded_loop",
      body: {
        kind: "sequence",
        elements: [
          {
            kind: "task",
            definitionNodeId: "planning.plan",
            nodeType: "agent.plan",
            schemaVersion: 1,
            config: { maxSteps: 8 },
          },
          {
            kind: "task",
            definitionNodeId: "planning.review",
            nodeType: "human.plan_review",
            schemaVersion: 1,
            config: { reviewMode: "manual" },
          },
        ],
      },
      outcomeFromDefinitionNodeId: "planning.review",
      continueOutcomes: ["request_revision"],
      exitOutcomes: ["approved", "rejected"],
      maxIterations: 5,
      exceededPolicy: "fail",
    },
    {
      kind: "composite",
      definitionNodeId: "planning.execute",
      nodeType: "execute.plan",
      schemaVersion: 1,
      config: {},
    },
    {
      kind: "task",
      definitionNodeId: "planning.validate",
      nodeType: "result.validate",
      schemaVersion: 1,
      config: {},
    },
    {
      kind: "task",
      definitionNodeId: "planning.commit",
      nodeType: "product.commit",
      schemaVersion: 1,
      config: {},
    },
  ],
};

function summary(
  id: string,
  revisionId: string,
  ownerKind: "system" | "principal",
  title: string,
  hash = SHA_A,
): WorkflowDefinitionPublishedDto {
  return {
    schemaVersion: "chat-product-api.v1",
    workflowDefinitionId: id as never,
    workflowDefinitionRevisionId: revisionId as never,
    definitionRevision: 1,
    title,
    description: "受约束工作流",
    blueprintKey: "planning",
    blueprintVersion: 1,
    definitionSha256: hash as never,
    ownerKind,
    publishedAt: NOW,
    updatedAt: NOW,
    nodes: [],
  };
}

function detail(input: {
  readonly id: string;
  readonly revisionId: string;
  readonly title: string;
  readonly ownerKind: "system" | "principal";
  readonly revision?: number;
  readonly hash?: string;
  readonly semanticRoot?: WorkflowDefinitionSequence;
  readonly currentDraft?: { readonly id: string; readonly hash: string };
  readonly published?: { readonly id: string; readonly hash: string };
}): EditableWorkflowDefinitionDetail {
  const hash = input.hash ?? SHA_A;
  const revision = input.revision ?? 1;
  return {
    schemaVersion: "chat-product-api.v1",
    workflowDefinitionId: input.id as never,
    ownerKind: input.ownerKind,
    ...(input.ownerKind === "principal" ? { ownerPrincipalId: "usr_debug" as never } : {}),
    key: input.ownerKind === "system" ? "system.planning" : "user.planning",
    title: input.title,
    description: "受约束工作流",
    blueprintKey: "planning",
    blueprintVersion: 1,
    status: "active",
    revision,
    publishedRevision:
      input.published === undefined
        ? undefined
        : revisionSummary(input.published.id, input.published.hash, "published"),
    currentDraftRevision:
      input.currentDraft === undefined
        ? undefined
        : revisionSummary(input.currentDraft.id, input.currentDraft.hash, "draft"),
    slots: [
      {
        slotId: "planning.root.optional",
        address: [],
        label: "规划输入",
        allowedNodeTypes: ["context.memory", "agent.research"],
        minimumIndex: 0,
        maximumIndex: 1,
        maximumElements: 8,
      },
    ],
    allowedChoiceSourceTypes: ["human.plan_review"],
    createdAt: NOW,
    updatedAt: NOW,
    compatibility: "editable",
    semanticRoot: input.semanticRoot ?? ROOT,
    baseRevisionId: input.revisionId as never,
    baseDefinitionSha256: hash as never,
    allowedActions:
      input.ownerKind === "system"
        ? ["copy"]
        : ["copy", "save", "validate", "publish", "archive", "restore"],
  };
}

function revisionSummary(id: string, hash: string, state: "draft" | "published") {
  return {
    workflowDefinitionRevisionId: id as never,
    definitionRevision: 1,
    state,
    definitionSha256: hash as never,
    createdAt: NOW,
    ...(state === "published" ? { publishedAt: NOW } : {}),
  };
}

const SYSTEM_SUMMARY = summary(
  "wfd_systemplanningv1",
  "wfr_systemplanningv1",
  "system",
  "系统 Planning",
);
const SYSTEM_DETAIL = detail({
  id: SYSTEM_SUMMARY.workflowDefinitionId,
  revisionId: SYSTEM_SUMMARY.workflowDefinitionRevisionId,
  title: SYSTEM_SUMMARY.title,
  ownerKind: "system",
  published: { id: SYSTEM_SUMMARY.workflowDefinitionRevisionId, hash: SHA_A },
});

function catalogResponse() {
  const node = (
    nodeType: string,
    displayName: string,
    category: string,
    executorKind: string,
    riskPolicy: string,
    outcomes: string[],
    publicConfigFields: unknown[] = [],
  ) => ({
    nodeType,
    schemaVersion: 1,
    displayName,
    description: `${displayName}说明`,
    category,
    executorKind,
    riskPolicy,
    canDefaultSkip: nodeType === "context.memory" || nodeType === "agent.research",
    supportedBlueprints: ["planning"],
    publicConfigFields,
    outcomes,
  });
  return {
    catalog: {
      schemaVersion: "chat-product-api.v1",
      nodes: [
        node("context.memory", "读取记忆", "context", "step", "read_context", [
          "success",
          "optional_unavailable",
          "required_unavailable",
        ]),
        node(
          "agent.research",
          "调研",
          "agent",
          "step",
          "generate_candidate",
          ["researched", "no_evidence"],
          [
            {
              type: "bounded_integer",
              name: "maxSources",
              label: "最多来源",
              defaultValue: 8,
              minimum: 1,
              maximum: 20,
            },
          ],
        ),
        node("agent.plan", "生成计划", "agent", "step", "generate_candidate", [
          "planned",
          "needs_input",
        ]),
        node(
          "human.plan_review",
          "人工审核",
          "human",
          "human_review",
          "human_decision",
          ["approved", "request_revision", "rejected"],
          [
            {
              type: "review_mode",
              name: "reviewMode",
              label: "审核方式",
              defaultValue: "manual",
              options: ["manual", "auto_continue_if_policy_allows", "always_auto"],
            },
          ],
        ),
        node("execute.plan", "执行", "execution", "composite", "external_effect", [
          "success",
          "failed",
          "outcome_unknown",
        ]),
        node("result.validate", "验证", "validation", "step", "read_context", ["valid", "invalid"]),
        node("product.commit", "提交", "commit", "step", "product_commit", ["committed", "failed"]),
      ],
    },
  };
}

function blueprintResponse() {
  return {
    blueprints: {
      schemaVersion: "chat-product-api.v1",
      blueprints: [
        {
          schemaVersion: "chat-product-api.v1",
          blueprintKey: "planning",
          blueprintVersion: 1,
          title: "Planning",
          description: "规划",
          runnerFamily: "configurable-planning.v1",
          terminalNodeType: "product.commit",
          optionalNodeTypes: ["context.memory", "agent.research"],
          loopRules: [
            {
              outcomeNodeType: "human.plan_review",
              continueOutcomes: ["request_revision"],
              exitOutcomes: ["approved", "rejected"],
              maxIterations: 5,
            },
          ],
          perRunOverrides: [
            { nodeType: "context.memory", fields: ["enabled", "selection"] },
            { nodeType: "human.plan_review", fields: ["reviewMode"] },
          ],
          reviewModes: ["manual", "auto_continue_if_policy_allows", "always_auto"],
        },
      ],
    },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

function renderDesigner(localStorage = storage()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkflowDesigner storage={localStorage} />
    </QueryClientProvider>,
  );
}

function commonGet(url: string, definitions: WorkflowDefinitionPublishedDto[]) {
  if (url === "/api/workflow/definitions") {
    return json({ definitions: { schemaVersion: "chat-product-api.v1", definitions } });
  }
  if (url === "/api/workflow/catalog") return json(catalogResponse());
  if (url === "/api/workflow/blueprints") return json(blueprintResponse());
  return undefined;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkflowDesigner生命周期", () => {
  it("system只读复制后可编辑、校验、保存并发布，命令不含坐标或自由edge", async () => {
    let userDetail = detail({
      id: "wfd_userplanning1",
      revisionId: "wfr_userdraft1",
      title: "系统 Planning 副本",
      ownerKind: "principal",
      hash: SHA_B,
      currentDraft: { id: "wfr_userdraft1", hash: SHA_B },
      published: { id: "wfr_userpublished0", hash: SHA_A },
    });
    const writes: { readonly url: string; readonly body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const common = commonGet(url, [SYSTEM_SUMMARY]);
        if (common !== undefined) return common;
        if (url === `/api/workflow/definitions/${SYSTEM_SUMMARY.workflowDefinitionId}`) {
          return json(SYSTEM_DETAIL);
        }
        if (url === "/api/workflow/definitions/copies") {
          writes.push({ url, body: String(init?.body ?? "") });
          return json({
            definition: userDetail,
            affectedRevision: userDetail.currentDraftRevision,
          });
        }
        if (url === "/api/workflow/definitions/validate") {
          writes.push({ url, body: String(init?.body ?? "") });
          return json({
            schemaVersion: "chat-product-api.v1",
            valid: true,
            diagnostics: [],
            normalized: {
              semanticRoot: userDetail.semanticRoot,
              definitionSha256: SHA_C,
              nodeCount: 7,
            },
          });
        }
        if (url.endsWith("/drafts")) {
          writes.push({ url, body: String(init?.body ?? "") });
          const body = JSON.parse(String(init?.body)) as {
            payload: { semanticRoot: WorkflowDefinitionSequence };
          };
          userDetail = detail({
            id: "wfd_userplanning1",
            revisionId: "wfr_userdraft2",
            title: "系统 Planning 副本",
            ownerKind: "principal",
            revision: 2,
            hash: SHA_C,
            semanticRoot: body.payload.semanticRoot,
            currentDraft: { id: "wfr_userdraft2", hash: SHA_C },
            published: { id: "wfr_userpublished0", hash: SHA_A },
          });
          return json({
            definition: userDetail,
            affectedRevision: userDetail.currentDraftRevision,
          });
        }
        if (url.endsWith("/publish")) {
          writes.push({ url, body: String(init?.body ?? "") });
          userDetail = detail({
            id: "wfd_userplanning1",
            revisionId: "wfr_userpublished1",
            title: "系统 Planning 副本",
            ownerKind: "principal",
            revision: 3,
            hash: SHA_C,
            semanticRoot: userDetail.semanticRoot,
            published: { id: "wfr_userpublished1", hash: SHA_C },
          });
          return json({ definition: userDetail, affectedRevision: userDetail.publishedRevision });
        }
        return json({ code: "not_found" }, 404);
      }),
    );

    renderDesigner();
    expect(await screen.findByText("System Definition 只读")).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存草稿" }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "创建可编辑副本" }));
    await screen.findByRole("heading", { name: "系统 Planning 副本" });

    const memoryNode = screen
      .getAllByRole("button", { name: /读取记忆/u })
      .find((button) => button.getAttribute("aria-pressed") !== null);
    if (memoryNode === undefined) throw new Error("缺少Memory节点按钮");
    await userEvent.click(memoryNode);
    await userEvent.selectOptions(screen.getByLabelText("默认状态"), "skipped");
    expect(screen.getByText(/有未保存语义修改/u)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "服务端校验" }));
    await screen.findByText(/服务端校验通过 · 预览 Hash/u);
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText(/草稿已保存/u);
    await userEvent.click(screen.getByRole("button", { name: "服务端校验" }));
    await screen.findByText(/服务端校验通过/u);
    await userEvent.click(screen.getByRole("button", { name: "发布" }));
    await screen.findByText(/新版本已发布/u);

    const draftWrite = writes.find((entry) => entry.url.endsWith("/drafts"));
    expect(draftWrite).toBeDefined();
    expect(draftWrite?.body).toContain('"expectedRevision":1');
    expect(draftWrite?.body).toContain('"defaultActivation":"skipped"');
    expect(draftWrite?.body).not.toMatch(/position|edge|executorKey|http/iu);
    expect(writes.some((entry) => entry.url.endsWith("/publish"))).toBe(true);
  });

  it("CAS 409保留operation log并可在最新base重应用", async () => {
    const userSummary = summary(
      "wfd_userplanning2",
      "wfr_userpublished2",
      "principal",
      "我的 Planning",
      SHA_A,
    );
    const initial = detail({
      id: userSummary.workflowDefinitionId,
      revisionId: "wfr_userdrafta",
      title: userSummary.title,
      ownerKind: "principal",
      currentDraft: { id: "wfr_userdrafta", hash: SHA_A },
      published: { id: userSummary.workflowDefinitionRevisionId, hash: SHA_A },
    });
    const latest = detail({
      id: userSummary.workflowDefinitionId,
      revisionId: "wfr_userdraftb",
      title: userSummary.title,
      ownerKind: "principal",
      revision: 2,
      hash: SHA_B,
      currentDraft: { id: "wfr_userdraftb", hash: SHA_B },
      published: { id: userSummary.workflowDefinitionRevisionId, hash: SHA_A },
    });
    let detailReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const common = commonGet(url, [userSummary]);
        if (common !== undefined) return common;
        if (url.endsWith(userSummary.workflowDefinitionId)) {
          detailReads += 1;
          return json(detailReads === 1 ? initial : latest);
        }
        if (url.endsWith("/drafts")) {
          return json(
            {
              type: "https://chat.dev/problems/revision-conflict",
              title: "Definition revision冲突",
              status: 409,
              code: "revision_conflict",
              requestId: "req_designerconflict1",
              retryable: false,
              recoveryAction: "rehydrate_and_retry",
            },
            409,
          );
        }
        if (url === "/api/workflow/definitions/validate") {
          return json({
            schemaVersion: "chat-product-api.v1",
            valid: true,
            diagnostics: [],
            normalized: { semanticRoot: ROOT, definitionSha256: SHA_A, nodeCount: 7 },
          });
        }
        return json({ code: "not_found" }, 404);
      }),
    );
    renderDesigner();
    await screen.findByRole("heading", { name: "我的 Planning" });
    const memoryNode = screen
      .getAllByRole("button", { name: /读取记忆/u })
      .find((button) => button.getAttribute("aria-pressed") !== null);
    if (memoryNode === undefined) throw new Error("缺少Memory节点按钮");
    await userEvent.click(memoryNode);
    await userEvent.selectOptions(screen.getByLabelText("默认状态"), "skipped");
    await userEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByRole("alert", { name: "Definition 版本冲突" })).toBeTruthy();
    expect(screen.getByText(/本地 1 个语义操作仍保留/u)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "基于最新版本重应用" }));
    await screen.findByText(/本地语义操作已基于最新版本重新应用/u);
    expect(screen.getByText(/有未保存语义修改/u)).toBeTruthy();
  });

  it("快速编辑取消旧validate语义，迟到响应不能覆盖最新结果", async () => {
    const userSummary = summary(
      "wfd_userplanning3",
      "wfr_userpublished3",
      "principal",
      "竞态 Planning",
    );
    const current = detail({
      id: userSummary.workflowDefinitionId,
      revisionId: "wfr_userrace1",
      title: userSummary.title,
      ownerKind: "principal",
      currentDraft: { id: "wfr_userrace1", hash: SHA_A },
      published: { id: userSummary.workflowDefinitionRevisionId, hash: SHA_A },
    });
    let firstResolve: ((response: Response) => void) | undefined;
    let validateCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const common = commonGet(url, [userSummary]);
        if (common !== undefined) return common;
        if (url.endsWith(userSummary.workflowDefinitionId)) return json(current);
        if (url === "/api/workflow/definitions/validate") {
          validateCalls += 1;
          if (validateCalls === 1) {
            return new Promise<Response>((resolve) => {
              firstResolve = resolve;
            });
          }
          return json({
            schemaVersion: "chat-product-api.v1",
            valid: true,
            diagnostics: [],
            normalized: { semanticRoot: ROOT, definitionSha256: SHA_C, nodeCount: 7 },
          });
        }
        return json({ code: "not_found" }, 404);
      }),
    );
    renderDesigner();
    await screen.findByRole("heading", { name: "竞态 Planning" });
    await waitFor(() => expect(validateCalls).toBe(1), { timeout: 1_500 });
    const memoryNode = screen
      .getAllByRole("button", { name: /读取记忆/u })
      .find((button) => button.getAttribute("aria-pressed") !== null);
    if (memoryNode === undefined) throw new Error("缺少Memory节点按钮");
    await userEvent.click(memoryNode);
    await userEvent.selectOptions(screen.getByLabelText("默认状态"), "skipped");
    await waitFor(() => expect(validateCalls).toBe(2), { timeout: 1_500 });
    await screen.findByText(new RegExp(SHA_C.slice(0, 12), "u"));
    await act(async () => {
      firstResolve?.(
        json({
          schemaVersion: "chat-product-api.v1",
          valid: false,
          diagnostics: [
            {
              family: "definition_invalid",
              code: "stale.response",
              path: "$.semanticRoot",
              severity: "error",
              params: {},
            },
          ],
        }),
      );
      await Promise.resolve();
    });
    expect(screen.queryByText("stale.response")).toBeNull();
    expect(screen.getByText(new RegExp(SHA_C.slice(0, 12), "u"))).toBeTruthy();
  });

  it("键盘与移动端显式控件可完成Choice双分支和BoundedLoop重组", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const userSummary = summary(
      "wfd_userstructure1",
      "wfr_userstructure1",
      "principal",
      "结构 Planning",
    );
    const current = detail({
      id: userSummary.workflowDefinitionId,
      revisionId: "wfr_userstructuredraft1",
      title: userSummary.title,
      ownerKind: "principal",
      currentDraft: { id: "wfr_userstructuredraft1", hash: SHA_A },
      published: { id: userSummary.workflowDefinitionRevisionId, hash: SHA_A },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const common = commonGet(url, [userSummary]);
        if (common !== undefined) return common;
        if (url.endsWith(userSummary.workflowDefinitionId)) return json(current);
        if (url === "/api/workflow/definitions/validate") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            semanticRoot?: WorkflowDefinitionSequence;
          };
          return json({
            schemaVersion: "chat-product-api.v1",
            valid: true,
            diagnostics: [],
            normalized: {
              semanticRoot: body.semanticRoot ?? current.semanticRoot,
              definitionSha256: SHA_C,
              nodeCount: 7,
            },
          });
        }
        return json({ code: "not_found" }, 404);
      }),
    );

    const { container } = renderDesigner();
    await screen.findByRole("heading", { name: "结构 Planning" });
    await userEvent.click(screen.getByRole("button", { name: /Bounded Loop · 最多/u }));
    await userEvent.click(screen.getByRole("button", { name: "展开 Bounded Loop" }));

    const review = screen
      .getAllByRole("button", { name: /人工审核/u })
      .find((button) => button.getAttribute("aria-pressed") !== null);
    if (review === undefined) throw new Error("缺少审核节点按钮");
    await userEvent.click(review);
    await userEvent.click(screen.getByRole("button", { name: "按固定 outcome 创建 Choice" }));
    expect(screen.getByText("approved")).toBeTruthy();
    expect(screen.getByText("rejected")).toBeTruthy();

    const memory = screen
      .getAllByRole("button", { name: /读取记忆/u })
      .find((button) => button.getAttribute("aria-pressed") !== null);
    if (memory === undefined) throw new Error("缺少Memory节点按钮");
    await userEvent.click(memory);
    await userEvent.click(screen.getByRole("button", { name: "移入 planning.review → approved" }));

    const reviewAfterMove = screen
      .getAllByRole("button", { name: /人工审核/u })
      .find((button) => button.getAttribute("aria-pressed") !== null);
    if (reviewAfterMove === undefined) throw new Error("移动后缺少审核节点按钮");
    await userEvent.click(reviewAfterMove);
    await userEvent.selectOptions(screen.getByLabelText("Bounded Loop 终点"), "3");
    await userEvent.selectOptions(
      screen.getByLabelText("新 Bounded Loop 超限策略"),
      "request_human",
    );
    await userEvent.click(screen.getByRole("button", { name: "包装所选范围" }));

    expect(screen.getByRole("button", { name: /Bounded Loop · 最多 5 次/u })).toBeTruthy();
    expect(screen.getByText("approved")).toBeTruthy();
    expect(container.querySelector(".react-flow__handle")).toBeNull();
  });

  it("375px仍暴露同一线性语义树和纯键盘结构按钮", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const common = commonGet(url, [SYSTEM_SUMMARY]);
        if (common !== undefined) return common;
        if (url.endsWith(SYSTEM_SUMMARY.workflowDefinitionId)) return json(SYSTEM_DETAIL);
        return json({ code: "not_found" }, 404);
      }),
    );
    const { container } = renderDesigner();
    await screen.findByRole("heading", { name: "系统 Planning" });
    expect(screen.getAllByRole("list", { name: "受约束顺序结构" }).length).toBeGreaterThan(1);
    expect(screen.getByText(/手机自动切换为同一语义的线性树/u)).toBeTruthy();
    expect(container.querySelector(".react-flow__handle")).toBeNull();
    expect(screen.getAllByRole("button", { name: /读取记忆/u }).length).toBeGreaterThan(0);
  });
});
