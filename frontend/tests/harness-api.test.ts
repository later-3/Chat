import assert from "node:assert/strict";
import test from "node:test";

import {
  createProject,
  createWorkItem,
  latestContextPackage,
} from "../src/harness-api.js";
import {
  resolveDurableDecisionRequest,
  type DurableDecisionRequest,
} from "../src/hitl-api.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Product Harness写命令带独立command_id且不让前端直接修改权威版本", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    const body = JSON.parse(String(init?.body));
    return jsonResponse({ id: body.command_id, ...body, row_version: 1 });
  }) as typeof fetch;
  try {
    await createProject({
      kind: "delivery",
      title: "贪吃蛇",
      goal: "完成可验证交付",
      status: "active",
      session_id: "session-1",
    });
    await createWorkItem({
      project_id: "project-1",
      kind: "task",
      title: "碰撞检测",
      objective: "通过边界与自身碰撞测试",
      priority: "high",
      status: "draft",
    });
    assert.equal(requests.length, 2);
    const project = JSON.parse(String(requests[0].init?.body));
    const work = JSON.parse(String(requests[1].init?.body));
    assert.match(project.command_id, /^web:create-project:/);
    assert.match(work.command_id, /^web:create-work:/);
    assert.notEqual(project.command_id, work.command_id);
    assert.equal(project.row_version, undefined);
    assert.equal(work.row_version, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Context Inspector只读取服务端版本化ContextPackage", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return jsonResponse({ context_package: null });
  }) as typeof fetch;
  try {
    assert.equal(await latestContextPackage("session / one"), null);
    assert.match(requestedUrl, /\/api\/harness\/sessions\/session%20%2F%20one\/context\/latest$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("跨进程HITL修改把changes与请求版本一并提交给Outbox恢复入口", async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = (async (_input, init) => {
    captured = init;
    return jsonResponse({ decision_request_id: "decision-1", status: "resolved" });
  }) as typeof fetch;
  const request: DurableDecisionRequest = {
    id: "decision-1",
    decision_point_key: "context_adoption",
    session_id: "session-1",
    interaction_id: "interaction-1",
    run_id: "run-1",
    request_hash: "request-hash",
    title: "确认Context",
    reason_summary: "跨Project采用需要确认",
    visible_evidence: {},
    consequence: {},
    status: "pending",
    row_version: 3,
    created_at: null,
    expires_at: null,
    runtime_recovery: null,
    items: [],
  };
  try {
    await resolveDurableDecisionRequest(
      request,
      [{ item_key: "context", decision: "revise" }],
      { changes: { selected_project_id: "project-2" } },
    );
    const body = JSON.parse(String(captured?.body));
    assert.equal(body.expected_request_hash, "request-hash");
    assert.equal(body.expected_row_version, 3);
    assert.deepEqual(body.response_payload, {
      changes: { selected_project_id: "project-2" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
