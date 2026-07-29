import assert from "node:assert/strict";
import test from "node:test";

import {
  activateHitlPolicy,
  listDurableDecisionRequests,
  loadHitlConfiguration,
  previewHitlPolicy,
} from "../src/features/governance/hitl-api.js";
import {
  captureNote,
  getProjectContext,
  listMemory,
  listNotes,
  listProjects,
  listWorkItems,
  proposeMemory,
  resolveMemoryCandidate,
} from "../src/features/harness/harness-api.js";
import { getHomeOverview, searchHomeResources } from "../src/features/home/home-api.js";
import {
  loadProtocolConfiguration,
  saveProtocolBinding,
} from "../src/features/protocols/protocol-api.js";
import {
  cancelSessionRun,
  getRuntimeEvents,
  getSessionMessages,
  getSessionRuns,
  listSessions,
  updateSession,
} from "../src/features/session/session-api.js";
import {
  getLatestWorkflowTrace,
  getRunGovernance,
  getRunStepInputs,
  getRunToolExecutions,
  getRunTrace,
  getRunTraceReports,
  listWorkflows,
  workflowEndpointUrl,
} from "../src/features/workflow/workflow-api.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Home Feature API按本地日期读取真实投影并复用Harness搜索", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/api/home/overview")) {
      return jsonResponse({ year: 2026, today: "2026-07-28", calendar_days: [] });
    }
    return jsonResponse({
      resources: [
        {
          kind: "project",
          id: "project-1",
          title: "Chat",
          summary: "持续协作",
          status: "active",
          revision: 1,
        },
      ],
    });
  }) as typeof fetch;
  try {
    const overview = await getHomeOverview(2026, 480);
    const results = await searchHomeResources("Chat / 主页");
    assert.equal(overview.today, "2026-07-28");
    assert.equal(results[0].id, "project-1");
    assert.match(requests[0], /year=2026&utc_offset_minutes=480$/);
    assert.match(requests[1], /q=Chat(?:\+|%20)%2F(?:\+|%20)%E4%B8%BB%E9%A1%B5&limit=8$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Session Feature API固定编码资源ID、控制方法和事件游标", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("/runtime/jobs/")) {
      return jsonResponse({ job: { id: "job-1" }, events: [], next_cursor: "next" });
    }
    if (url.endsWith("/messages")) return jsonResponse({ messages: [] });
    if (url.endsWith("/runs")) return jsonResponse({ runs: [] });
    if (url.includes("/agui-runs/")) return jsonResponse({ id: "run-1", status: "cancelled" });
    if (init?.method === "PATCH") return jsonResponse({ id: "session-1", title: "新标题" });
    return jsonResponse({ sessions: [] });
  }) as typeof fetch;
  try {
    assert.deepEqual(await listSessions(true), []);
    assert.deepEqual(await getSessionMessages("session / one"), []);
    assert.deepEqual(await getSessionRuns("session / one"), []);
    await cancelSessionRun("session / one", "run / one");
    await getRuntimeEvents("job / one", "cursor / one");
    await updateSession("session / one", { title: "新标题" });

    assert.match(requests[0].url, /include_archived=true$/);
    assert.match(requests[1].url, /session%20%2F%20one\/messages$/);
    assert.match(requests[3].url, /agui-runs\/run%20%2F%20one\/cancel$/);
    assert.equal(requests[3].init?.method, "POST");
    assert.match(requests[4].url, /job%20%2F%20one\/events\?cursor=cursor%20%2F%20one$/);
    assert.equal(requests[5].init?.method, "PATCH");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Workflow Feature API读取目录、治理和稳定Trace路径", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/api/workflows")) return jsonResponse({ workflows: [] });
    if (url.endsWith("/governance")) return jsonResponse({ run_id: "run-1" });
    if (url.endsWith("/step-inputs")) return jsonResponse({ step_inputs: [] });
    if (url.endsWith("/tool-executions")) return jsonResponse({ tool_executions: [] });
    if (url.endsWith("/trace-reports")) return jsonResponse({ reports: [] });
    return jsonResponse({ trace: [] });
  }) as typeof fetch;
  try {
    assert.deepEqual(await listWorkflows(), []);
    assert.deepEqual(await getRunTrace("session / one", "run / one"), []);
    assert.deepEqual(await getRunTraceReports("session / one", "run / one"), []);
    assert.equal((await getRunGovernance("run / one")).run_id, "run-1");
    assert.deepEqual(await getRunStepInputs("run / one"), []);
    assert.deepEqual(await getRunToolExecutions("run / one"), []);
    assert.deepEqual(await getLatestWorkflowTrace("session / one", "workflow / one"), []);

    assert.match(requests[1], /session%20%2F%20one\/runs\/run%20%2F%20one\/trace$/);
    assert.match(requests[2], /session%20%2F%20one\/runs\/run%20%2F%20one\/trace-reports$/);
    assert.match(requests[3], /runs\/run%20%2F%20one\/governance$/);
    assert.match(requests[4], /runs\/run%20%2F%20one\/step-inputs$/);
    assert.match(requests[5], /runs\/run%20%2F%20one\/tool-executions$/);
    assert.match(
      requests[6],
      /session%20%2F%20one\/workflows\/workflow%20%2F%20one\/latest-trace$/,
    );
    assert.equal(workflowEndpointUrl("/api/custom"), "http://127.0.0.1:8030/api/custom");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("协作方法配置使用服务端Principal、CAS版本和不可变Definition引用", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    if (!init?.method) {
      return jsonResponse({
        scope_id: "local",
        principal_id: "local-user",
        scenario_kinds: ["learning"],
        protocols: [],
        bindings: [],
      });
    }
    return jsonResponse({ id: "binding-1", row_version: 3 });
  }) as typeof fetch;
  try {
    const configuration = await loadProtocolConfiguration();
    assert.equal(configuration.principal_id, "local-user");
    await saveProtocolBinding({
      scope_kind: "user",
      scope_ref_id: configuration.principal_id,
      scenario_kind: "learning",
      protocol_definition_id: "definition-1",
      disabled_rule_keys: ["optional-review"],
      status: "active",
      expected_row_version: 2,
    });

    assert.match(requests[0].url, /\/api\/harness\/protocols\/configuration$/);
    assert.equal(requests[1].init?.method, "PUT");
    const body = JSON.parse(String(requests[1].init?.body));
    assert.match(body.command_id, /^web:save-protocol-binding:/);
    assert.equal(body.scope_ref_id, "local-user");
    assert.equal(body.expected_row_version, 2);
    assert.equal(body.protocol_definition_id, "definition-1");
    assert.deepEqual(body.disabled_rule_keys, ["optional-review"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HITL Feature API区分配置、预览和待处理决定请求", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/decision-points")) return jsonResponse({ decision_points: [] });
    if (url.endsWith("/policy-sets")) return jsonResponse({ policy_sets: [] });
    if (url.includes("/decision-requests?")) return jsonResponse({ decision_requests: [] });
    if (url.endsWith("/policy-preview")) return jsonResponse({ final_action: "require_human" });
    return jsonResponse({ id: "policy-1" });
  }) as typeof fetch;
  try {
    assert.deepEqual(await loadHitlConfiguration(), { decisionPoints: [], policySets: [] });
    await activateHitlPolicy({
      scope_kind: "session",
      scope_ref_id: "session-1",
      expected_active_revision_id: null,
      change_summary: "测试策略",
      rules: [],
    });
    const preview = await previewHitlPolicy({
      decision_point_key: "model_call_authorization",
      scopes: [{ kind: "session", ref_id: "session-1" }],
      facts: {},
    });
    assert.equal(preview.final_action, "require_human");
    assert.deepEqual(await listDurableDecisionRequests("session / one"), []);

    assert.equal(requests[2].init?.method, "POST");
    assert.equal(requests[3].init?.method, "POST");
    assert.match(requests[4].url, /status=pending&session_id=session(?:\+|%20)%2F(?:\+|%20)one$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Harness Feature API通过权威资源合同查询和维护知识", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/projects")) return jsonResponse({ projects: [] });
    if (url.includes("/work-items")) return jsonResponse({ work_items: [] });
    if (url.includes("/notes") && !init?.method) return jsonResponse({ notes: [] });
    if (url.endsWith("/memory")) return jsonResponse({ accepted: [], candidates: [] });
    if (url.includes("/resolve"))
      return jsonResponse({ candidate_id: "memory-1", status: "accepted" });
    if (url.endsWith("/memory-candidates")) return jsonResponse({ id: "memory-1" });
    if (url.endsWith("/notes")) return jsonResponse({ id: "note-1" });
    return jsonResponse({ project: { id: "project-1" } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await listProjects(), []);
    assert.equal((await getProjectContext("project-1")).project.id, "project-1");
    assert.deepEqual(await listWorkItems("project / one"), []);
    assert.deepEqual(await listNotes("project / one"), []);
    assert.deepEqual(await listMemory(), { accepted: [], candidates: [] });
    await captureNote({
      kind: "learning_note",
      title: "FastAPI",
      content: "依赖注入",
      project_id: "project-1",
    });
    await proposeMemory({
      scope_kind: "project",
      scope_ref_id: "project-1",
      memory_kind: "decision",
      content: "使用FastAPI",
    });
    await resolveMemoryCandidate("memory-1", "accept");

    assert.match(requests[2].url, /work-items\?project_id=project%20%2F%20one$/);
    assert.match(requests[3].url, /notes\?project_id=project%20%2F%20one$/);
    assert.equal(requests[5].init?.method, "POST");
    assert.match(String(requests[5].init?.body), /web:capture-note:/);
    assert.match(String(requests[6].init?.body), /web:propose-memory:/);
    assert.match(String(requests[7].init?.body), /web:memory-accept:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
