import { describe, expect, it } from "vitest";
import { PlaneCeProjectRolloutInspection } from "./plane-ce-rollout-inspection.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const stateId = "22222222-2222-4222-8222-222222222222";
const moduleId = "33333333-3333-4333-8333-333333333333";
const labelId = "44444444-4444-4444-8444-444444444444";
const viewId = "55555555-5555-4555-8555-555555555555";
const pageId = "66666666-6666-4666-8666-666666666666";
const intakeId = "77777777-7777-4777-8777-777777777777";
const workItemId = "88888888-8888-4888-8888-888888888888";

const page = (results: readonly unknown[]) => ({
  results,
  next_cursor: "1000:0:0",
  next_page_results: false,
});

describe("Plane CE 1.4.1项目Rollout只读预检", () => {
  it("只用GET读取Project配置、Views、Pages、Intake和全部Work身份", async () => {
    const requests: { method: string; pathname: string; token: string | null }[] = [];
    const project = {
      id: projectId,
      name: "Ziji Content Lab",
      identifier: "CONTENTLAB",
      description: "现有描述",
      network: 0,
      module_view: true,
      cycle_view: false,
      issue_views_view: false,
      page_view: true,
      intake_view: false,
      archived_at: null,
    };
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(init?.headers);
      requests.push({
        method: init?.method ?? "GET",
        pathname: url.pathname,
        token: headers.get("x-api-key"),
      });
      const body = url.pathname.endsWith(`/projects/${projectId}/`)
        ? project
        : url.pathname.endsWith("/projects/")
          ? page([project])
          : url.pathname.endsWith("/states/")
            ? page([
                { id: stateId, name: "Intake", group: "backlog", color: "#111111", sequence: 10 },
              ])
            : url.pathname.endsWith("/modules/")
              ? page([
                  {
                    id: moduleId,
                    name: "小红书内容交付",
                    description: "",
                    external_source: null,
                    external_id: null,
                  },
                ])
              : url.pathname.endsWith("/labels/")
                ? page([{ id: labelId, name: "kind:content", color: "#222222" }])
                : url.pathname.endsWith("/views/")
                  ? page([
                      {
                        id: viewId,
                        name: "01 当前执行",
                        description: "human",
                        filters: { state: ["x"] },
                        display_filters: { layout: "list" },
                        archived_at: null,
                      },
                    ])
                  : url.pathname.endsWith("/pages/")
                    ? page([
                        {
                          id: pageId,
                          name: "项目导航",
                          access: 1,
                          is_locked: false,
                          archived_at: null,
                          external_source: "later-agent",
                          external_id: "content-lab-plane-mapping.v1:page:navigation",
                        },
                      ])
                    : url.pathname.endsWith("/intakes/")
                      ? page([{ id: intakeId, name: "Inbox", description: "", is_default: true }])
                      : url.pathname.endsWith("/work-items/")
                        ? page([
                            {
                              id: workItemId,
                              name: "历史项",
                              external_source: "later-agent",
                              external_id: "chat-work:content-lab:history",
                            },
                          ])
                        : undefined;
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    };
    const provider = new PlaneCeProjectRolloutInspection({
      baseUrl: new URL("https://plane.example.test"),
      apiToken: "secret-token",
      workspaces: [{ slug: "later", displayName: "Later" }],
      fetchFn,
    });

    await expect(
      provider.inspectProject({ workspaceSlug: "later", projectIdentifier: "CONTENTLAB" }),
    ).resolves.toMatchObject({
      project: { id: projectId, issueViewsView: false, intakeView: false },
      surfaceAvailability: { views: "available", pages: "available", intakes: "available" },
      states: [{ id: stateId, name: "Intake" }],
      modules: [{ id: moduleId, name: "小红书内容交付" }],
      labels: [{ id: labelId, name: "kind:content" }],
      views: [{ id: viewId, filtersJson: '{"state":["x"]}' }],
      pages: [{ id: pageId, externalId: "content-lab-plane-mapping.v1:page:navigation" }],
      intakes: [{ id: intakeId, isDefault: true }],
      workItems: [{ id: workItemId, externalId: "chat-work:content-lab:history" }],
    });
    expect(requests).toHaveLength(9);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(JSON.stringify(provider)).not.toContain("secret-token");
    expect(requests.every((request) => request.token === "secret-token")).toBe(true);
  });

  it("Workspace越权在任何HTTP前失败关闭", async () => {
    let called = false;
    const provider = new PlaneCeProjectRolloutInspection({
      baseUrl: new URL("https://plane.example.test"),
      apiToken: "secret-token",
      workspaces: [{ slug: "later", displayName: "Later" }],
      fetchFn: async () => {
        called = true;
        return new Response("unexpected");
      },
    });
    await expect(
      provider.inspectProject({ workspaceSlug: "other", projectIdentifier: "CONTENTLAB" }),
    ).rejects.toMatchObject({ code: "plane_workspace_not_allowed", outcomeUnknown: false });
    expect(called).toBe(false);
  });

  it("可选Views/Pages/Intake的404被记录为不可用，不能伪装为空集合", async () => {
    const project = {
      id: projectId,
      name: "Content Lab",
      identifier: "CONTENTLAB",
      description: "",
      network: 2,
      module_view: true,
      cycle_view: false,
      issue_views_view: false,
      page_view: true,
      intake_view: false,
      archived_at: null,
    };
    const provider = new PlaneCeProjectRolloutInspection({
      baseUrl: new URL("https://plane.example.test"),
      apiToken: "secret-token",
      workspaces: [{ slug: "later", displayName: "Later" }],
      fetchFn: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (
          pathname.endsWith("/views/") ||
          pathname.endsWith("/pages/") ||
          pathname.endsWith("/intakes/")
        ) {
          return new Response("not found", { status: 404 });
        }
        const body = pathname.endsWith(`/projects/${projectId}/`)
          ? project
          : pathname.endsWith("/projects/")
            ? page([project])
            : page([]);
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await provider.inspectProject({
      workspaceSlug: "later",
      projectIdentifier: "CONTENTLAB",
    });
    expect(result.surfaceAvailability).toEqual({
      views: "unavailable",
      pages: "unavailable",
      intakes: "unavailable",
    });
    expect(result.views).toEqual([]);
    expect(result.pages).toEqual([]);
    expect(result.intakes).toEqual([]);
  });
});
