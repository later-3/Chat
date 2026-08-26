import { describe, expect, it, vi } from "vitest";
import {
  PLANE_CE_AGENT_EXTERNAL_SOURCE,
  PlaneCeCoordinationError,
  PlaneCeProjectCoordination,
  createPlaneCeProjectCoordination,
  type PlaneCeAppendWorkItemCommentIntent,
  type PlaneCeEnsureWorkItemIntent,
  type PlaneCeWorkItemStateTransitionIntent,
} from "./plane-ce-coordination.js";

const projectId = "66cf0460-84e0-4d3d-b1ef-d193b83b7562";
const backlogStateId = "15a02252-87e1-4b5e-98bc-7bccb775d0fe";
const startedStateId = "5a0188d6-dc2c-4436-9268-8647718a39de";
const reviewStateId = "6a0188d6-dc2c-4436-9268-8647718a39de";
const doneStateId = "53f82173-6331-4a34-8c23-b8b2f88667e6";
const moduleId = "c776b52f-40e3-4ac3-ac77-75983259d732";
const workItemId = "af01905f-bcf3-437c-bc75-bf89edfd59a0";
const otherWorkItemId = "39b1d1aa-4b07-40e9-9e31-e296752e41df";
const commentId = "19df6194-169a-4186-b6a7-a1a3f413a51a";
const otherCommentId = "7873ad63-ea24-4be1-a080-ad03793c4835";

const backlogState = {
  id: backlogStateId,
  name: "Backlog",
  color: "#60646C",
  group: "backlog",
  sequence: 15_000,
};
const startedState = {
  id: startedStateId,
  name: "In Progress",
  color: "#F59E0B",
  group: "started",
  sequence: 35_000,
};
const reviewState = {
  id: reviewStateId,
  name: "Needs Review",
  color: "#8B5CF6",
  group: "started",
  sequence: 40_000,
};
const doneState = {
  id: doneStateId,
  name: "Done",
  color: "#46A758",
  group: "completed",
  sequence: 45_000,
};

function project() {
  return {
    id: projectId,
    name: "Chat",
    identifier: "CHAT",
    description: "Chat product",
    archived_at: null,
    external_source: "chat",
    external_id: "pbo_chat",
  };
}

function module() {
  return {
    id: moduleId,
    name: "Plane coordination",
    status: "in-progress",
    total_issues: 3,
    completed_issues: 1,
    cancelled_issues: 0,
    started_issues: 1,
    unstarted_issues: 1,
    backlog_issues: 0,
    external_source: "chat",
    external_id: "pbo_chat:module:1",
  };
}

function workItem(
  overrides: Partial<{
    id: string;
    sequence_id: number;
    name: string;
    description_html: string;
    priority: "none" | "urgent" | "high" | "medium" | "low";
    module_ids: string[];
    label_ids: string[];
    state: string;
    external_source: string | null;
    external_id: string | null;
  }> = {},
) {
  return {
    id: workItemId,
    sequence_id: 12,
    name: "实现 Plane Provider",
    description_html: "<p>严格 &lt;contract&gt; &amp; test</p>",
    priority: "high" as const,
    module_ids: [],
    label_ids: [],
    state: backlogStateId,
    updated_at: "2026-08-23T16:00:00Z",
    external_source: PLANE_CE_AGENT_EXTERNAL_SOURCE,
    external_id: "wi_chat_plane_provider",
    ...overrides,
  };
}

function comment(
  overrides: Partial<{
    id: string;
    issue: string;
    comment_html: string;
    access: "INTERNAL" | "EXTERNAL";
    created_at: string | null;
    updated_at: string | null;
    created_by: string | null;
    external_source: string | null;
    external_id: string | null;
  }> = {},
) {
  return {
    id: commentId,
    issue: workItemId,
    comment_html: "<p>完成 Provider 单测。</p>",
    access: "INTERNAL" as const,
    created_at: "2026-08-23T16:00:00Z",
    updated_at: "2026-08-23T16:00:00Z",
    created_by: null,
    external_source: PLANE_CE_AGENT_EXTERNAL_SOURCE,
    external_id: "comment_progress_1",
    ...overrides,
  };
}

function page(results: readonly unknown[], next = false, cursor = "1000:1:0") {
  return { results, next_page_results: next, next_cursor: cursor };
}

function json(body: unknown, status = 200, contentType = "application/json") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

function provider(fetchFn: typeof fetch) {
  return new PlaneCeProjectCoordination({
    baseUrl: new URL("http://127.0.0.1:8088"),
    apiToken: "private-test-token",
    workspaces: [{ slug: "engineering", displayName: "Engineering" }],
    fetchFn,
  });
}

function method(init: RequestInit | undefined): string {
  return init?.method ?? "GET";
}

function ensureIntent(): PlaneCeEnsureWorkItemIntent {
  return {
    workspaceSlug: "engineering",
    projectId,
    externalId: "wi_chat_plane_provider",
    name: "实现 Plane Provider",
    description: "严格 <contract> & test",
    priority: "high",
    stateName: "Backlog",
    stateGroup: "backlog",
    moduleIds: [],
    labelIds: [],
  };
}

function transitionIntent(): PlaneCeWorkItemStateTransitionIntent {
  return {
    workspaceSlug: "engineering",
    projectId,
    workItemId,
    workItemExternalId: "wi_chat_plane_provider",
    expectedStateId: backlogStateId,
    stateName: "In Progress",
    stateGroup: "started",
  };
}

function commentIntent(): PlaneCeAppendWorkItemCommentIntent {
  return {
    workspaceSlug: "engineering",
    projectId,
    workItemId,
    workItemExternalId: "wi_chat_plane_provider",
    kind: "progress",
    commentExternalId: "comment_progress_1",
    commentHtml: "<p>完成 Provider 单测。</p>",
  };
}

describe("Plane CE 1.4.1日常项目协作Provider", () => {
  it("完整读取project/states/modules/活跃work-items的cursor分页，并不返回Token", async () => {
    const counters = new Map<string, number>();
    const fetchFn = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(request.toString());
      const key = url.pathname;
      const count = counters.get(key) ?? 0;
      counters.set(key, count + 1);
      if (url.pathname.endsWith(`/projects/${projectId}/`)) return json(project());
      if (url.pathname.endsWith("/states/")) {
        return !url.searchParams.has("cursor")
          ? json(page([backlogState, startedState], true, "2:1:0"))
          : json(page([doneState], false, "2:2:0"));
      }
      if (url.pathname.endsWith("/modules/")) {
        return !url.searchParams.has("cursor")
          ? json(page([], true, "1:1:0"))
          : json(page([module()], false, "1:2:0"));
      }
      if (url.pathname.endsWith("/work-items/")) {
        return !url.searchParams.has("cursor")
          ? json(
              page(
                [
                  workItem(),
                  workItem({ id: otherWorkItemId, state: doneStateId, external_id: "wi_done" }),
                ],
                true,
                "2:1:0",
              ),
            )
          : json(page([], false, "2:2:0"));
      }
      return json({ error: "unexpected path" }, 500);
    });
    const adapter = provider(fetchFn);

    await expect(
      adapter.getProject({ workspaceSlug: "engineering", projectId }),
    ).resolves.toMatchObject({
      id: projectId,
      identifier: "CHAT",
    });
    await expect(
      adapter.listStates({ workspaceSlug: "engineering", projectId }),
    ).resolves.toHaveLength(3);
    await expect(adapter.listModules({ workspaceSlug: "engineering", projectId })).resolves.toEqual(
      [expect.objectContaining({ id: moduleId, totalWorkItems: 3 })],
    );
    await expect(
      adapter.listActiveWorkItems({ workspaceSlug: "engineering", projectId }),
    ).resolves.toEqual([
      expect.objectContaining({ id: workItemId, stateName: "Backlog", stateGroup: "backlog" }),
    ]);
    expect(counters.get(`/api/v1/workspaces/engineering/projects/${projectId}/states/`)).toBe(4);
    expect(counters.get(`/api/v1/workspaces/engineering/projects/${projectId}/work-items/`)).toBe(
      2,
    );
    expect(
      fetchFn.mock.calls.some(([request]) => request.toString().includes("cursor=2%3A1%3A0")),
    ).toBe(true);
    expect(JSON.stringify(adapter.describe())).not.toContain("private-test-token");
    expect("delete" in adapter).toBe(false);
    expect("request" in adapter).toBe(false);
  });

  it("只读已绑定Work Item的有界纯文本评论摘要，并标记人类与Agent来源", async () => {
    const humanActorId = "36b9ac12-fccc-4c86-8633-4ca784e310d5";
    const oldestCommentId = "0d50cf9c-0c77-4fb4-8372-a05f99092af4";
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      expect(method(init)).toBe("GET");
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) return json(workItem());
      if (url.pathname.endsWith("/work-items/")) return json(page([workItem()]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/comments/`)) {
        return json(
          page([
            comment({
              id: oldestCommentId,
              comment_html: "<p>旧评论</p>",
              created_at: "2026-08-23T15:00:00Z",
              updated_at: "2026-08-23T15:00:00Z",
              external_source: null,
              external_id: null,
            }),
            comment({
              id: otherCommentId,
              comment_html: "<p>Agent &lt;evidence&gt;</p>",
              created_at: "2026-08-23T16:00:00Z",
              updated_at: "2026-08-23T16:01:00Z",
            }),
            comment({
              comment_html: "<p>请补充反例 &amp; 来源。</p><script>ignored()</script>",
              created_at: "2026-08-23T16:02:00Z",
              updated_at: "2026-08-23T16:02:00Z",
              created_by: humanActorId,
              external_source: null,
              external_id: null,
            }),
          ]),
        );
      }
      return json({ error: "unexpected path" }, 500);
    });

    await expect(
      provider(fetchFn).readWorkItemComments({
        workspaceSlug: "engineering",
        projectId,
        workItemId,
        workItemExternalId: "wi_chat_plane_provider",
        limit: 2,
      }),
    ).resolves.toEqual({
      comments: [
        {
          id: commentId,
          workItemId,
          excerpt: "请补充反例 & 来源。",
          origin: "human_or_other",
          actorExternalId: humanActorId,
          createdAt: "2026-08-23T16:02:00Z",
          updatedAt: "2026-08-23T16:02:00Z",
        },
        {
          id: otherCommentId,
          workItemId,
          excerpt: "Agent <evidence>",
          origin: "later_agent",
          externalId: "comment_progress_1",
          createdAt: "2026-08-23T16:00:00Z",
          updatedAt: "2026-08-23T16:01:00Z",
        },
      ],
      totalCommentCount: 3,
      truncated: true,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("只按精确identifier完整分页采用唯一未归档Project", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(request.toString());
      return url.searchParams.has("cursor")
        ? json(page([project()], false, "1:2:0"))
        : json(page([{ ...project(), id: otherWorkItemId, identifier: "CHATX" }], true, "1:1:0"));
    });
    const adapter = provider(fetchFn);
    await expect(
      adapter.findProjectByIdentifier({
        workspaceSlug: "engineering",
        projectIdentifier: "CHAT",
      }),
    ).resolves.toMatchObject({ id: projectId, identifier: "CHAT" });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const archived = provider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(json(page([{ ...project(), archived_at: "2026-08-23T16:00:00Z" }]))),
    );
    await expect(
      archived.findProjectByIdentifier({ workspaceSlug: "engineering", identifier: "CHAT" }),
    ).rejects.toMatchObject({ code: "plane_project_archived" });

    const ambiguous = provider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(json(page([project(), { ...project(), id: otherWorkItemId }]))),
    );
    await expect(
      ambiguous.findProjectByIdentifier({ workspaceSlug: "engineering", identifier: "CHAT" }),
    ).rejects.toMatchObject({ code: "plane_project_identifier_ambiguous" });
  });

  it("按Application窄Port形状返回Project/Module/active work item snapshot", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith(`/projects/${projectId}/`)) return json(project());
      if (url.pathname.endsWith("/states/")) {
        return json(page([backlogState, doneState]));
      }
      if (url.pathname.endsWith("/modules/")) return json(page([module()]));
      if (url.pathname.endsWith("/labels/")) {
        return json(
          page([
            {
              id: "34343434-3434-4434-8434-343434343434",
              name: "kind:content",
              color: "#111111",
            },
          ]),
        );
      }
      if (url.pathname.endsWith("/work-items/")) {
        return json(
          page([
            workItem(),
            workItem({ id: otherWorkItemId, state: doneStateId, external_id: "wi_done" }),
          ]),
        );
      }
      return json({ error: "unexpected" }, 500);
    });
    await expect(
      provider(fetchFn).readProjectSnapshot({ workspaceSlug: "engineering", projectId }),
    ).resolves.toMatchObject({
      project: { id: projectId, identifier: "CHAT" },
      modules: [{ id: moduleId, totalWorkItems: 3, startedWorkItems: 1 }],
      labels: [{ name: "kind:content" }],
      workItems: [{ id: workItemId, updatedAt: "2026-08-23T16:00:00Z" }],
    });
  });

  it("ensure按later-agent external key幂等创建，重复调用不再POST", async () => {
    const labelId = "34343434-3434-4434-8434-343434343434";
    let created = false;
    let assigned = false;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState]));
      if (url.pathname.endsWith("/modules/")) return json(page([module()]));
      if (url.pathname.endsWith("/labels/")) {
        return json(page([{ id: labelId, name: "kind:content", color: "#111111" }]));
      }
      if (url.pathname.endsWith("/work-items/") && method(init) === "GET") {
        return json(
          page(
            created
              ? [workItem({ module_ids: assigned ? [moduleId] : [], label_ids: [labelId] })]
              : [],
          ),
        );
      }
      if (url.pathname.endsWith("/work-items/") && method(init) === "POST") {
        created = true;
        return json(workItem({ module_ids: [], label_ids: [labelId] }), 201);
      }
      if (url.pathname.endsWith(`/modules/${moduleId}/module-issues/`)) {
        assigned = true;
        return json([{ module: { id: moduleId } }]);
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);

    const firstIntent = { ...ensureIntent(), moduleIds: [moduleId], labelIds: [labelId] };
    await expect(
      adapter.ensureWorkItem({
        planeWorkspaceSlug: firstIntent.workspaceSlug,
        planeProjectId: firstIntent.projectId,
        externalId: firstIntent.externalId,
        name: firstIntent.name,
        description: firstIntent.description,
        priority: firstIntent.priority,
        stateName: firstIntent.stateName,
        stateGroup: firstIntent.stateGroup,
        moduleIds: firstIntent.moduleIds,
        labelIds: firstIntent.labelIds,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      workItem: { id: workItemId, updatedAt: "2026-08-23T16:00:00Z" },
    });
    await expect(adapter.ensureWorkItem(firstIntent)).resolves.toMatchObject({
      status: "completed",
      workItem: { id: workItemId },
    });
    const posts = fetchFn.mock.calls.filter(([, init]) => method(init) === "POST");
    expect(posts).toHaveLength(2);
    const workItemPost = posts.find(([request]) =>
      new URL(request.toString()).pathname.endsWith("/work-items/"),
    );
    expect(JSON.parse(String(workItemPost?.[1]?.body))).toEqual({
      name: "实现 Plane Provider",
      description_html: "<p>严格 &lt;contract&gt; &amp; test</p>",
      priority: "high",
      state: backlogStateId,
      labels: [labelId],
      external_source: PLANE_CE_AGENT_EXTERNAL_SOURCE,
      external_id: "wi_chat_plane_provider",
    });
    const modulePost = posts.find(([request]) =>
      new URL(request.toString()).pathname.endsWith(`/modules/${moduleId}/module-issues/`),
    );
    expect(JSON.parse(String(modulePost?.[1]?.body))).toEqual({ issues: [workItemId] });
  });

  it("同一Provider实例把同external key的并发ensure串行为一次POST", async () => {
    let created = false;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState]));
      if (url.pathname.endsWith("/work-items/") && method(init) === "GET") {
        return json(page(created ? [workItem()] : []));
      }
      if (url.pathname.endsWith("/work-items/") && method(init) === "POST") {
        await Promise.resolve();
        created = true;
        return json(workItem(), 201);
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);

    const [first, second] = await Promise.all([
      adapter.ensureWorkItem(ensureIntent()),
      adapter.ensureWorkItem(ensureIntent()),
    ]);
    expect(first).toMatchObject({ status: "completed", workItem: { id: workItemId } });
    expect(second).toMatchObject({ status: "completed", workItem: { id: workItemId } });
    expect(fetchFn.mock.calls.filter(([, init]) => method(init) === "POST")).toHaveLength(1);
  });

  it("POST 409后按external key读取；同Intent完成，人工改动则needs_attention", async () => {
    for (const [existing, expectedStatus] of [
      [workItem(), "completed"],
      [workItem({ name: "人工重命名" }), "needs_attention"],
    ] as const) {
      let exactReads = 0;
      const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
        const url = new URL(request.toString());
        if (url.pathname.endsWith("/states/")) return json(page([backlogState]));
        if (url.pathname.endsWith("/work-items/") && method(init) === "GET") {
          exactReads += 1;
          return json(page(exactReads === 1 ? [] : [existing]));
        }
        if (url.pathname.endsWith("/work-items/") && method(init) === "POST") {
          return json({ error: "duplicate", id: workItemId }, 409);
        }
        return json({ error: "unexpected" }, 500);
      });
      await expect(provider(fetchFn).ensureWorkItem(ensureIntent())).resolves.toMatchObject({
        status: expectedStatus,
      });
      expect(exactReads).toBe(2);
    }
  });

  it.each([
    ["断线", () => Promise.reject(new Error("connection reset"))],
    ["HTTP 408", () => Promise.resolve(json({ error: "request timeout" }, 408))],
    ["5xx", () => Promise.resolve(json({ error: "upstream" }, 503))],
    ["非法成功响应", () => Promise.resolve(json({ id: "not-a-uuid" }, 201))],
  ])("ensure写%s一律outcome_unknown，并允许同Intent只读对账", async (_label, writeResponse) => {
    let written = false;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState]));
      if (url.pathname.endsWith("/work-items/") && method(init) === "GET") {
        return json(page(written ? [workItem()] : []));
      }
      if (url.pathname.endsWith("/work-items/") && method(init) === "POST") {
        written = true;
        return writeResponse();
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);
    await expect(adapter.ensureWorkItem(ensureIntent())).resolves.toMatchObject({
      status: "outcome_unknown",
    });
    await expect(adapter.reconcileEnsureWorkItem(ensureIntent())).resolves.toMatchObject({
      status: "completed",
      workItem: { id: workItemId },
    });
    expect(fetchFn.mock.calls.filter(([, init]) => method(init) === "POST")).toHaveLength(1);
  });

  it("只读reconcile暂未看到external key时保持outcome_unknown且绝不POST", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState]));
      if (url.pathname.endsWith("/work-items/")) return json(page([]));
      return json({ error: "unexpected" }, 500);
    });
    await expect(provider(fetchFn).reconcileEnsureWorkItem(ensureIntent())).resolves.toEqual({
      status: "outcome_unknown",
      errorCode: "plane_work_item_reconcile_pending",
    });
    expect(fetchFn.mock.calls.some(([, init]) => method(init) === "POST")).toBe(false);
  });

  it("transition只PATCH state字段，并在写后人工竞争时needs_attention", async () => {
    let patched = false;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState, startedState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/`) && method(init) === "GET") {
        return json(workItem({ state: patched ? backlogStateId : backlogStateId }));
      }
      if (url.pathname.endsWith("/work-items/") && method(init) === "GET") {
        return json(page([workItem({ state: patched ? backlogStateId : backlogStateId })]));
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`) && method(init) === "PATCH") {
        patched = true;
        return json(workItem({ state: startedStateId }));
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);
    await expect(adapter.transitionWorkItemState(transitionIntent())).resolves.toMatchObject({
      status: "needs_attention",
      errorCode: "plane_work_item_state_competed",
    });
    const patchCall = fetchFn.mock.calls.find(([, init]) => method(init) === "PATCH");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ state: startedStateId });
    expect(Object.keys(JSON.parse(String(patchCall?.[1]?.body)))).toEqual(["state"]);
  });

  it("transition正常读回目标状态，且state name/group不一致时失败关闭", async () => {
    let patched = false;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/"))
        return json(page([backlogState, startedState, doneState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/`) && method(init) === "PATCH") {
        patched = true;
        return json(workItem({ state: startedStateId }));
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) {
        return json(workItem({ state: patched ? startedStateId : backlogStateId }));
      }
      if (url.pathname.endsWith("/work-items/")) {
        return json(page([workItem({ state: patched ? startedStateId : backlogStateId })]));
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);
    await expect(adapter.transitionWorkItemState(transitionIntent())).resolves.toMatchObject({
      status: "completed",
      workItem: { stateId: startedStateId },
    });
    await expect(
      adapter.transitionWorkItemState({ ...transitionIntent(), stateName: "Done" }),
    ).resolves.toEqual({ status: "failed", errorCode: "plane_state_group_mismatch" });
  });

  it("服务端来源矩阵拒绝把已看见的Needs Review主动回退到In Progress", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request, _init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) {
        return json(page([startedState, reviewState]));
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) {
        return json(workItem({ state: reviewStateId }));
      }
      if (url.pathname.endsWith("/work-items/")) {
        return json(page([workItem({ state: reviewStateId })]));
      }
      return json({ error: "unexpected" }, 500);
    });
    await expect(
      provider(fetchFn).transitionWorkItemState({
        ...transitionIntent(),
        expectedStateId: reviewStateId,
      }),
    ).resolves.toMatchObject({
      status: "needs_attention",
      errorCode: "plane_work_item_state_source_forbidden",
    });
    expect(fetchFn.mock.calls.some(([, init]) => method(init) === "PATCH")).toBe(false);
  });

  it("Binding驱动的Producing状态可推进，并原子替换受管executor标签而保留人工标签", async () => {
    const producingState = { ...startedState, name: "Producing" };
    const humanLabelId = "12121212-1212-4212-8212-121212121212";
    const kindLabelId = "23232323-2323-4232-8232-232323232323";
    const oldExecutorId = "34343434-3434-4434-8434-343434343434";
    const nextExecutorId = "45454545-4545-4454-8454-454545454545";
    let state = backlogStateId;
    let labels = [humanLabelId, oldExecutorId];
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState, producingState]));
      if (url.pathname.endsWith("/labels/")) {
        return json(
          page(
            [kindLabelId, oldExecutorId, nextExecutorId].map((id) => ({
              id,
              name: `managed:${id}`,
              color: "#111111",
            })),
          ),
        );
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`) && method(init) === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { state: string; labels: string[] };
        state = body.state;
        labels = body.labels;
        return json(workItem({ state, label_ids: labels }));
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) {
        return json(workItem({ state, label_ids: labels }));
      }
      if (url.pathname.endsWith("/work-items/")) {
        return json(page([workItem({ state, label_ids: labels })]));
      }
      return json({ error: "unexpected" }, 500);
    });
    await expect(
      provider(fetchFn).transitionWorkItemState({
        ...transitionIntent(),
        stateName: "Producing",
        labelIds: [kindLabelId, nextExecutorId],
        managedLabelIds: [kindLabelId, oldExecutorId, nextExecutorId],
      }),
    ).resolves.toMatchObject({
      status: "completed",
      workItem: {
        stateName: "Producing",
        labelIds: [humanLabelId, kindLabelId, nextExecutorId].sort(),
      },
    });
    const patchCall = fetchFn.mock.calls.find(([, init]) => method(init) === "PATCH");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      state: startedStateId,
      labels: [humanLabelId, kindLabelId, nextExecutorId].sort(),
    });
  });

  it("同一Work Item的并发transition只跨越一次PATCH边界", async () => {
    let state = backlogStateId;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState, startedState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/`) && method(init) === "PATCH") {
        state = startedStateId;
        return json(workItem({ state }));
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) {
        return json(workItem({ state }));
      }
      if (url.pathname.endsWith("/work-items/")) return json(page([workItem({ state })]));
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);
    const results = await Promise.all([
      adapter.transitionWorkItemState(transitionIntent()),
      adapter.transitionWorkItemState(transitionIntent()),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(fetchFn.mock.calls.filter(([, init]) => method(init) === "PATCH")).toHaveLength(1);
  });

  it("comment+transition以同一Work Item lease串行，竞争者不会留下孤儿评论", async () => {
    let state = backlogStateId;
    let commentPosted = false;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState, startedState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/comments/`)) {
        if (method(init) === "GET") return json(page(commentPosted ? [comment()] : []));
        if (method(init) === "POST") {
          commentPosted = true;
          return json(comment(), 201);
        }
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`) && method(init) === "PATCH") {
        state = startedStateId;
        return json(workItem({ state }));
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) return json(workItem({ state }));
      if (url.pathname.endsWith("/work-items/")) return json(page([workItem({ state })]));
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);
    const results = await Promise.all([
      adapter.applyCommentedWorkItemStateTransition({
        transition: transitionIntent(),
        comment: commentIntent(),
      }),
      adapter.applyCommentedWorkItemStateTransition({
        transition: transitionIntent(),
        comment: commentIntent(),
      }),
    ]);
    expect(results[0]).toMatchObject({
      phase: "transition",
      outcome: { status: "completed" },
    });
    expect(results[1]).toMatchObject({
      phase: "preflight",
      outcome: { status: "needs_attention", errorCode: "plane_work_item_state_competed" },
    });
    expect(fetchFn.mock.calls.filter(([, init]) => method(init) === "POST")).toHaveLength(1);
    expect(fetchFn.mock.calls.filter(([, init]) => method(init) === "PATCH")).toHaveLength(1);
  });

  it("composite preflight查询失败是确定failed，且不会越过评论或状态写边界", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState, startedState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) return json(workItem());
      if (url.pathname.endsWith("/work-items/")) return json({ error: "query failed" }, 503);
      return json({ error: "unexpected" }, 500);
    });
    const fetchMock = fetchFn;
    await expect(
      provider(fetchMock).applyCommentedWorkItemStateTransition({
        transition: transitionIntent(),
        comment: commentIntent(),
      }),
    ).resolves.toMatchObject({
      phase: "preflight",
      outcome: { status: "failed", errorCode: "plane_ce_http_503" },
    });
    expect(fetchMock.mock.calls.some(([, init]) => method(init) === "POST")).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => method(init) === "PATCH")).toBe(false);
  });

  it("重复later-agent external key失败关闭，UUID lookup不能掩盖歧义", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState, startedState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) return json(workItem());
      if (url.pathname.endsWith("/work-items/")) {
        return json(page([workItem(), workItem({ id: otherWorkItemId, sequence_id: 13 })]));
      }
      return json({ error: "unexpected" }, 500);
    });
    const fetchMock = fetchFn;
    await expect(provider(fetchMock).transitionWorkItemState(transitionIntent())).resolves.toEqual({
      status: "failed",
      errorCode: "plane_work_item_external_key_ambiguous",
    });
    expect(fetchMock.mock.calls.some(([, init]) => method(init) === "PATCH")).toBe(false);
  });

  it("transition写前比较Snapshot State，人工竞争与终态都拒绝PATCH", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) {
        return json(page([backlogState, startedState, doneState]));
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) {
        return json(workItem({ state: doneStateId }));
      }
      if (url.pathname.endsWith("/work-items/")) {
        return json(page([workItem({ state: doneStateId })]));
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);

    await expect(adapter.transitionWorkItemState(transitionIntent())).resolves.toMatchObject({
      status: "needs_attention",
      errorCode: "plane_work_item_state_competed",
    });
    await expect(
      adapter.preflightWorkItemStateTransition(transitionIntent()),
    ).resolves.toMatchObject({
      status: "needs_attention",
      errorCode: "plane_work_item_state_competed",
    });
    await expect(
      adapter.transitionWorkItemState({ ...transitionIntent(), expectedStateId: doneStateId }),
    ).resolves.toMatchObject({
      status: "needs_attention",
      errorCode: "plane_work_item_terminal_state_protected",
    });
    await expect(
      adapter.preflightWorkItemStateTransition({
        ...transitionIntent(),
        expectedStateId: doneStateId,
      }),
    ).resolves.toMatchObject({
      status: "needs_attention",
      errorCode: "plane_work_item_terminal_state_protected",
    });
    expect(fetchFn.mock.calls.some(([, init]) => method(init) === "PATCH")).toBe(false);
  });

  it("transition响应丢失后只用同Intent reconcile，绝不二次PATCH", async () => {
    let patched = false;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState, startedState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/`) && method(init) === "PATCH") {
        patched = true;
        throw new Error("response lost");
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) {
        return json(workItem({ state: patched ? startedStateId : backlogStateId }));
      }
      if (url.pathname.endsWith("/work-items/")) {
        return json(page([workItem({ state: patched ? startedStateId : backlogStateId })]));
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);
    await expect(adapter.transitionWorkItemState(transitionIntent())).resolves.toEqual({
      status: "outcome_unknown",
      errorCode: "plane_ce_write_outcome_unknown",
    });
    await expect(
      adapter.reconcileWorkItemStateTransition(transitionIntent()),
    ).resolves.toMatchObject({
      status: "completed",
      workItem: { id: workItemId, stateId: startedStateId },
    });
    expect(fetchFn.mock.calls.filter(([, init]) => method(init) === "PATCH")).toHaveLength(1);
  });

  it("State PATCH收到HTTP 408时归一outcome_unknown，reconcile只读且绝不二次PATCH", async () => {
    let patched = false;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState, startedState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/`) && method(init) === "PATCH") {
        patched = true;
        return json({ error: "request timeout" }, 408);
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) {
        return json(workItem({ state: patched ? startedStateId : backlogStateId }));
      }
      if (url.pathname.endsWith("/work-items/")) {
        return json(page([workItem({ state: patched ? startedStateId : backlogStateId })]));
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);

    await expect(adapter.transitionWorkItemState(transitionIntent())).resolves.toEqual({
      status: "outcome_unknown",
      errorCode: "plane_ce_write_outcome_unknown",
    });
    await expect(
      adapter.reconcileWorkItemStateTransition(transitionIntent()),
    ).resolves.toMatchObject({
      status: "completed",
      workItem: { id: workItemId, stateId: startedStateId },
    });
    expect(fetchFn.mock.calls.filter(([, init]) => method(init) === "PATCH")).toHaveLength(1);
  });

  it("comment按external key完整分页查重，append-only且不重复POST", async () => {
    let commentsPage = 0;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) {
        return json(workItem());
      }
      if (url.pathname.endsWith("/work-items/")) return json(page([workItem()]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/comments/`) && method(init) === "GET") {
        commentsPage += 1;
        return commentsPage === 1
          ? json(
              page([comment({ id: otherCommentId, external_id: "comment_other" })], true, "1:1:0"),
            )
          : json(page([comment()], false, "1:2:0"));
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);
    await expect(adapter.appendWorkItemComment(commentIntent())).resolves.toMatchObject({
      status: "completed",
      comment: { id: commentId },
    });
    expect(fetchFn.mock.calls.filter(([, init]) => method(init) === "POST")).toHaveLength(0);
    expect(
      fetchFn.mock.calls.some(([request]) => request.toString().includes("cursor=1%3A1%3A0")),
    ).toBe(true);
  });

  it("comment响应丢失保持outcome_unknown，同Intentreconcile只读收敛", async () => {
    let posted = false;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) {
        return json(workItem());
      }
      if (url.pathname.endsWith("/work-items/")) return json(page([workItem()]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/comments/`) && method(init) === "GET") {
        return json(page(posted ? [comment()] : []));
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/comments/`) && method(init) === "POST") {
        posted = true;
        throw new Error("response lost");
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);
    await expect(adapter.appendWorkItemComment(commentIntent())).resolves.toEqual({
      status: "outcome_unknown",
      errorCode: "plane_ce_write_outcome_unknown",
    });
    await expect(adapter.reconcileWorkItemComment(commentIntent())).resolves.toMatchObject({
      status: "completed",
      comment: { id: commentId },
    });
    expect(fetchFn.mock.calls.filter(([, init]) => method(init) === "POST")).toHaveLength(1);
  });

  it("Comment POST收到HTTP 408时归一outcome_unknown，reconcile只读且绝不二次POST", async () => {
    let posted = false;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) return json(workItem());
      if (url.pathname.endsWith("/work-items/")) return json(page([workItem()]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/comments/`) && method(init) === "GET") {
        return json(page(posted ? [comment()] : []));
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/comments/`) && method(init) === "POST") {
        posted = true;
        return json({ error: "request timeout" }, 408);
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);

    await expect(adapter.appendWorkItemComment(commentIntent())).resolves.toEqual({
      status: "outcome_unknown",
      errorCode: "plane_ce_write_outcome_unknown",
    });
    await expect(adapter.reconcileWorkItemComment(commentIntent())).resolves.toMatchObject({
      status: "completed",
      comment: { id: commentId },
    });
    expect(fetchFn.mock.calls.filter(([, init]) => method(init) === "POST")).toHaveLength(1);
  });

  it("comment reconcile受read replica延迟影响时保持outcome_unknown", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([backlogState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) {
        return json(workItem());
      }
      if (url.pathname.endsWith("/work-items/")) return json(page([workItem()]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/comments/`)) {
        return json(page([]));
      }
      return json({ error: "unexpected" }, 500);
    });
    await expect(provider(fetchFn).reconcileWorkItemComment(commentIntent())).resolves.toEqual({
      status: "outcome_unknown",
      errorCode: "plane_work_item_comment_reconcile_pending",
    });
    expect(fetchFn.mock.calls.some(([, init]) => method(init) === "POST")).toBe(false);
  });

  it("prepare后若人把Work Item改为终态，评论写边界和未命中对账都零写needs_attention", async () => {
    let existingComment = false;
    const fetchFn = vi.fn<typeof fetch>(async (request, init) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith("/states/")) return json(page([doneState]));
      if (url.pathname.endsWith(`/work-items/${workItemId}/comments/`)) {
        if (method(init) === "GET") return json(page(existingComment ? [comment()] : []));
        return json({ error: "comment write must not happen" }, 500);
      }
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) {
        return json(workItem({ state: doneStateId }));
      }
      if (url.pathname.endsWith("/work-items/")) {
        return json(page([workItem({ state: doneStateId })]));
      }
      return json({ error: "unexpected" }, 500);
    });
    const adapter = provider(fetchFn);
    await expect(adapter.appendWorkItemComment(commentIntent())).resolves.toEqual({
      status: "needs_attention",
      errorCode: "plane_work_item_terminal_state_protected",
    });
    await expect(adapter.reconcileWorkItemComment(commentIntent())).resolves.toEqual({
      status: "needs_attention",
      errorCode: "plane_work_item_terminal_state_protected",
    });
    existingComment = true;
    await expect(adapter.reconcileWorkItemComment(commentIntent())).resolves.toMatchObject({
      status: "completed",
      comment: { id: commentId },
    });
    expect(fetchFn.mock.calls.some(([, init]) => method(init) === "POST")).toBe(false);
  });

  it("UUID与external key不指向同一work item时拒绝写入", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) return json(workItem());
      if (url.pathname.endsWith("/work-items/")) {
        return json(page([workItem({ id: otherWorkItemId })]));
      }
      if (url.pathname.endsWith("/states/")) return json(page([startedState]));
      return json({ error: "unexpected" }, 500);
    });
    const fetchMock = fetchFn;
    await expect(provider(fetchMock).transitionWorkItemState(transitionIntent())).resolves.toEqual({
      status: "needs_attention",
      errorCode: "plane_work_item_binding_mismatch",
    });
    expect(fetchMock.mock.calls.some(([, init]) => method(init) === "PATCH")).toBe(false);
  });

  it("exact lookup即使返回同UUID也必须自证later-agent external key", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (request) => {
      const url = new URL(request.toString());
      if (url.pathname.endsWith(`/work-items/${workItemId}/`)) return json(workItem());
      if (url.pathname.endsWith("/work-items/")) {
        return json(page([workItem({ external_source: "human", external_id: "manual-item" })]));
      }
      if (url.pathname.endsWith("/states/")) return json(page([startedState]));
      return json({ error: "unexpected" }, 500);
    });
    const fetchMock = fetchFn;
    await expect(provider(fetchMock).transitionWorkItemState(transitionIntent())).resolves.toEqual({
      status: "failed",
      errorCode: "plane_work_item_external_key_mismatch",
    });
    expect(fetchMock.mock.calls.some(([, init]) => method(init) === "PATCH")).toBe(false);
  });

  it("Provider实例的JSON投影绝不枚举API Token", () => {
    const adapter = new PlaneCeProjectCoordination({
      baseUrl: new URL("http://127.0.0.1:8088"),
      apiToken: "plane-token-canary-do-not-leak",
      workspaces: [{ slug: "engineering", displayName: "Engineering" }],
      fetchFn: vi.fn<typeof fetch>(),
    });
    expect(JSON.stringify(adapter)).not.toContain("plane-token-canary-do-not-leak");
    expect(JSON.stringify(adapter)).not.toContain("apiToken");
  });

  it("非loopback HTTP、带凭据/路径URL和半配置失败关闭；loopback HTTP可用", () => {
    for (const baseUrl of [
      "http://plane.internal",
      "https://u:p@plane.example",
      "https://plane.example/api",
    ]) {
      expect(() =>
        createPlaneCeProjectCoordination({
          CHAT_PLANE_CE_BASE_URL: baseUrl,
          CHAT_PLANE_CE_API_TOKEN: "private-test-token",
          CHAT_PLANE_CE_WORKSPACES_JSON: '[{"slug":"engineering","displayName":"Engineering"}]',
        }),
      ).toThrowError(PlaneCeCoordinationError);
    }
    expect(() =>
      createPlaneCeProjectCoordination({ CHAT_PLANE_CE_API_TOKEN: "private-test-token" }),
    ).toThrowError(PlaneCeCoordinationError);
    expect(
      createPlaneCeProjectCoordination({
        CHAT_PLANE_CE_BASE_URL: "http://localhost:8088",
        CHAT_PLANE_CE_API_TOKEN: "private-test-token",
        CHAT_PLANE_CE_WORKSPACES_JSON: '[{"slug":"engineering","displayName":"Engineering"}]',
      }),
    ).toBeInstanceOf(PlaneCeProjectCoordination);
  });

  it("查询与分页响应严格校验，成功HTTP缺字段或非JSON不会被当作事实", async () => {
    const invalidProject = provider(
      vi.fn<typeof fetch>().mockResolvedValue(json({ id: projectId, name: "Chat" })),
    );
    await expect(
      invalidProject.getProject({ workspaceSlug: "engineering", projectId }),
    ).rejects.toMatchObject({ code: "plane_ce_query_response_invalid" });

    const invalidPage = provider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ results: [backlogState], next_page_results: true })),
    );
    await expect(
      invalidPage.listStates({ workspaceSlug: "engineering", projectId }),
    ).rejects.toMatchObject({ code: "plane_ce_query_response_invalid" });

    const nonJson = provider(
      vi.fn<typeof fetch>().mockResolvedValue(json(project(), 200, "text/html")),
    );
    await expect(
      nonJson.getProject({ workspaceSlug: "engineering", projectId }),
    ).rejects.toMatchObject({ code: "plane_ce_query_response_invalid" });
  });

  it("GET收到HTTP 408仍是确定的只读查询失败，不标记写结果未知", async () => {
    const adapter = provider(
      vi.fn<typeof fetch>().mockResolvedValue(json({ error: "request timeout" }, 408)),
    );

    await expect(
      adapter.getProject({ workspaceSlug: "engineering", projectId }),
    ).rejects.toMatchObject({ code: "plane_ce_http_408", outcomeUnknown: false, httpStatus: 408 });
  });
});
