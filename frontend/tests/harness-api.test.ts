import assert from "node:assert/strict";
import test from "node:test";

import {
  createProject,
  createWorkItem,
  latestContextPackage,
  listIntentSets,
  reviseContextPackage,
} from "../src/harness-api.js";
import { type DurableDecisionRequest, resolveDurableDecisionRequest } from "../src/hitl-api.js";

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

test("本轮信息面板从Product API读取版本化Intent Set而不是解析聊天文本", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return jsonResponse([]);
  }) as typeof fetch;
  try {
    assert.deepEqual(await listIntentSets("session / one"), []);
    assert.match(requestedUrl, /\/api\/harness\/intents\?session_id=session%20%2F%20one&limit=20$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Context修改提交不可变revision、CAS Hash与用户选择而不是覆盖旧包", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let captured: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    captured = init;
    return jsonResponse({
      id: "context-v2",
      revision: 2,
      previous_package_id: "context-v1",
      package_hash: "hash-v2",
      execution_invalidation: {
        invalidated: true,
        draft_ids: ["draft-1"],
        decision_request_ids: ["decision-1"],
        requires_recompile: true,
      },
    });
  }) as typeof fetch;
  try {
    await reviseContextPackage("context / v1", {
      expected_package_hash: "hash-v1",
      reason: "只保留当前Project并锁定目标",
      item_changes: [
        { ordinal: 0, locked: true },
        {
          ordinal: 1,
          adopted: true,
          reason: "用户明确选择仓库规则",
          materialize: true,
        },
      ],
      added_source_refs: [
        {
          source_kind: "note",
          source_id: "note-2",
          adopted: true,
          reason: "用户从信息面板明确选择",
        },
      ],
      token_budget: 2400,
    });

    assert.match(requestedUrl, /\/api\/harness\/context-packages\/context%20%2F%20v1\/revisions$/);
    assert.equal(captured?.method, "POST");
    const body = JSON.parse(String(captured?.body));
    assert.match(body.command_id, /^web:revise-context:/);
    assert.equal(body.expected_package_hash, "hash-v1");
    assert.equal(body.reason, "只保留当前Project并锁定目标");
    assert.deepEqual(body.item_changes, [
      { ordinal: 0, locked: true },
      {
        ordinal: 1,
        adopted: true,
        reason: "用户明确选择仓库规则",
        materialize: true,
      },
    ]);
    assert.deepEqual(body.added_source_refs, [
      {
        source_kind: "note",
        source_id: "note-2",
        adopted: true,
        reason: "用户从信息面板明确选择",
      },
    ]);
    assert.equal(body.token_budget, 2400);
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
    await resolveDurableDecisionRequest(request, [{ item_key: "context", decision: "revise" }], {
      changes: { selected_project_id: "project-2" },
    });
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
