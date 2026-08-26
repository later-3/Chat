import { describe, expect, it } from "vitest";
import {
  PlaneCeProjectRolloutExecution,
  type PlaneCeProjectRolloutExecution as ExecutionProvider,
} from "./plane-ce-rollout-execution.js";
import type { PlaneProjectRolloutExecutionIntent } from "@chat/application";

const PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const WORKSPACE = "ai";
const HASH = "f".repeat(64);

describe("PlaneCeProjectRolloutExecution", () => {
  it("只执行获批的29个非破坏性写，逐项回读且重复调用零写", async () => {
    const fixture = providerFixture();
    const first = await fixture.provider.executeApprovedRollout(intent());
    expect(first.writes).toBe(34);
    expect(first.objects).toHaveLength(31);
    expect(first.objects.filter((item) => item.outcome === "created")).toHaveLength(28);
    expect(first.objects.filter((item) => item.outcome === "updated")).toHaveLength(1);
    expect(first.objects.filter((item) => item.outcome === "reused")).toHaveLength(2);
    expect(fixture.writeMethods.filter((method) => method === "PATCH")).toHaveLength(1);
    expect(fixture.writeMethods.filter((method) => method === "POST")).toHaveLength(33);
    expect(fixture.paths.some((path) => /views|pages|intakes|archive|delete/iu.test(path))).toBe(
      false,
    );

    const writesBeforeReplay = fixture.writeMethods.length;
    const replay = await fixture.provider.executeApprovedRollout(intent());
    expect(replay.writes).toBe(0);
    expect(replay.objects.every((item) => item.outcome === "reused")).toBe(true);
    expect(fixture.writeMethods).toHaveLength(writesBeforeReplay);
    expect(JSON.stringify(fixture.provider)).not.toContain("secret-token");
  });
});

function intent(): PlaneProjectRolloutExecutionIntent {
  const states = [
    ["Intake", "backlog", "#60646C", 10],
    ["Proposed", "backlog", "#8B5CF6", 20],
    ["Selected", "unstarted", "#3B82F6", 30],
    ["Producing", "started", "#0EA5E9", 40],
    ["Experimenting", "started", "#8B5CF6", 50],
    ["Needs Review", "started", "#F59E0B", 60],
    ["Ready", "started", "#14B8A6", 70],
    ["Blocked", "started", "#EF4444", 80],
    ["Published", "completed", "#22C55E", 90],
    ["Adopted", "completed", "#16A34A", 100],
    ["Dropped", "cancelled", "#6B7280", 110],
    ["Rejected", "cancelled", "#9F1239", 120],
  ] as const;
  const modules = [
    ["xiaohongshu-delivery", "小红书内容交付"],
    ["bilibili-delivery", "B站内容交付"],
    ["workflow-improvement", "工作流持续改进"],
  ] as const;
  const labels = [
    "kind:content",
    "kind:practice",
    "platform:xiaohongshu",
    "platform:bilibili",
    "executor:codex",
    "executor:pi",
    "executor:chat",
    "series:crash_course_botany",
    "series:gardening_how_tos",
    "series:monstrofarm",
  ];
  const samples = [
    ["history_work", "xiaohongshu_independent", "内容一", "Ready", "小红书内容交付"],
    ["history_work", "series_content", "内容二", "Ready", "小红书内容交付"],
    ["history_work", "bilibili_content", "内容三", "Ready", "B站内容交付"],
    ["history_work", "blocked_content", "内容四", "Blocked", "小红书内容交付"],
    ["workflow_improvement", "workflow_improvement", "方法一", "Proposed", "工作流持续改进"],
  ] as const;
  return {
    workspaceSlug: WORKSPACE,
    projectId: PROJECT_ID,
    approvedDryRunSha256: HASH,
    project: {
      stableKey: "project:content-lab",
      displayName: "Content Lab",
      description: "批准后的Content Lab描述",
      network: 0,
      moduleView: true,
      cycleView: false,
      issueViewsView: false,
      pageView: true,
      intakeView: false,
    },
    states: states.map(([name, group, color, sequence]) => ({
      stableKey: `state:${name.toLowerCase().replaceAll(" ", "-")}`,
      name,
      group,
      color,
      sequence,
    })),
    modules: modules.map(([key, name]) => ({
      stableKey: `module:${key}`,
      name,
      description: `Content Lab · ${name}`,
      externalId: `content-lab-plane-mapping.v1:module:${key}`,
    })),
    labels: labels.map((name) => ({
      stableKey: `label:${name.replaceAll(":", "-")}`,
      name,
      color: "#123456",
      externalId: `content-lab-plane-mapping.v1:label:${name}`,
    })),
    workItems: samples.map(([targetKind, key, name, stateName, moduleName]) => ({
      targetKind,
      stableKey: `sample:${key}`,
      name,
      description: `Authority: candidate_only\nSource: ${key}`,
      externalId: `chat-work:content-lab:${key}`,
      stateName,
      stateGroup: stateName === "Proposed" ? ("backlog" as const) : ("started" as const),
      moduleName,
      labelNames: [targetKind === "workflow_improvement" ? "kind:practice" : "kind:content"],
      priority: "medium",
    })),
  };
}

function providerFixture(): {
  provider: ExecutionProvider;
  paths: string[];
  writeMethods: string[];
} {
  let nextId = 100;
  let sequenceId = 0;
  const id = () => `${String(nextId++).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const project = {
    id: PROJECT_ID,
    name: "Content Lab",
    identifier: "CONTENTLAB",
    description: "旧描述",
    network: 2,
    module_view: true,
    cycle_view: false,
    issue_views_view: false,
    page_view: true,
    intake_view: false,
    archived_at: null,
    external_source: "chat",
    external_id: "bootstrap",
  };
  const states: Array<Record<string, unknown>> = [
    {
      id: id(),
      name: "Blocked",
      group: "started",
      color: "#D92D20",
      sequence: 70_000,
      external_source: "chat",
      external_id: "bootstrap:blocked",
    },
    {
      id: id(),
      name: "Needs Review",
      group: "started",
      color: "#7F56D9",
      sequence: 85_000,
      external_source: "chat",
      external_id: "bootstrap:review",
    },
  ];
  const modules: Array<Record<string, unknown>> = [];
  const labels: Array<Record<string, unknown>> = [];
  const workItems: Array<Record<string, unknown>> = [];
  const paths: string[] = [];
  const writeMethods: string[] = [];
  const base = `/api/v1/workspaces/${WORKSPACE}/projects/${PROJECT_ID}/`;
  const fetchFn: typeof fetch = async (request, init) => {
    const url = new URL(
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
    );
    const method = init?.method ?? "GET";
    paths.push(url.pathname);
    if (method !== "GET") writeMethods.push(method);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));

    if (url.pathname === base && method === "GET") return json(project);
    if (url.pathname === base && method === "PATCH") {
      Object.assign(project, body);
      return json(project);
    }
    if (url.pathname === `${base}states/` && method === "GET") return json(page(states));
    if (url.pathname === `${base}states/` && method === "POST") {
      const created = { id: id(), ...body };
      states.push(created);
      return json(created, 201);
    }
    if (url.pathname === `${base}modules/` && method === "GET") return json(page(modules));
    if (url.pathname === `${base}modules/` && method === "POST") {
      const created = module({ id: id(), ...body });
      modules.push(created);
      return json(created, 201);
    }
    if (url.pathname === `${base}labels/` && method === "GET") return json(page(labels));
    if (url.pathname === `${base}labels/` && method === "POST") {
      const created = { id: id(), ...body };
      labels.push(created);
      return json(created, 201);
    }
    if (url.pathname === `${base}work-items/` && method === "GET") {
      return json(page(workItems.map(apiWorkItem)));
    }
    if (url.pathname === `${base}work-items/` && method === "POST") {
      const created = {
        id: id(),
        sequence_id: ++sequenceId,
        name: body.name,
        description_html: body.description_html,
        priority: body.priority,
        module_ids: [],
        label_ids: body.labels,
        state: body.state,
        updated_at: "2026-08-24T10:00:00.000Z",
        updated_by: null,
        external_source: body.external_source,
        external_id: body.external_id,
      };
      workItems.push(created);
      return json(apiWorkItem(created), 201);
    }
    const moduleIssueMatch = new RegExp(
      `^${base.replaceAll("/", "\\/")}modules/([^/]+)/module-issues/$`,
    ).exec(url.pathname);
    if (moduleIssueMatch?.[1] !== undefined && method === "GET") {
      return json(
        page(
          workItems
            .filter((item) => (item.module_ids as string[]).includes(moduleIssueMatch[1]!))
            .map(apiWorkItem),
        ),
      );
    }
    if (moduleIssueMatch?.[1] !== undefined && method === "POST") {
      const target = workItems.find((item) => item.id === body.issues[0]);
      if (target === undefined) return json({ error: "missing" }, 404);
      target.module_ids = [moduleIssueMatch[1]];
      return json({ results: [apiWorkItem(target)] });
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  };
  return {
    provider: new PlaneCeProjectRolloutExecution({
      baseUrl: new URL("https://plane.example.test"),
      apiToken: "secret-token",
      workspaces: [{ slug: WORKSPACE, displayName: "AI" }],
      fetchFn,
    }),
    paths,
    writeMethods,
  };
}

function module(input: Record<string, unknown>) {
  return {
    status: "backlog",
    total_issues: 0,
    completed_issues: 0,
    cancelled_issues: 0,
    started_issues: 0,
    unstarted_issues: 0,
    backlog_issues: 0,
    ...input,
  };
}

function apiWorkItem(input: Record<string, unknown>) {
  const copy = { ...input };
  const labelIds = copy.label_ids;
  delete copy.module_ids;
  delete copy.label_ids;
  return { ...copy, labels: labelIds };
}

function page(results: readonly unknown[]) {
  return { results, next_cursor: "0", next_page_results: false };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
