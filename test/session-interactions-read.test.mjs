import assert from "node:assert/strict";
import test from "node:test";
import { adaptLegacyPromptCaptures, aggregateInteractionRows, resolvePromptCapture, toLegacyDetail, toLegacyListResponse } from "../src/session-interactions.ts";

test("轮内请求级聚合：retryOf 链归组 + tokenOut/failures 后端汇总（D-1/02 T9）", () => {
  const row = (id, retryOf, outcome) => ({
    seq: 1, requestId: id, timestamp: "t", storageProjectId: "p", sessionId: "s", schemaVersion: 2,
    kind: "agent", payloadSha256: "x", agent: { agentId: "pi-coding-agent" },
    model: { provider: "p", modelId: "m" }, payloadChars: 10,
    turn: { source: "workflow", stage: { id: "execute", nodeKind: "agent" }, turnKey: "t1" },
    regions: [{ id: "chat_identity", chars: 5 }], messageCount: 3, toolCount: 1,
    attempt: 1, excluded: { count: 0 }, payload: { sha256: "x", chars: 10 },
    ...(retryOf === undefined ? {} : { retryOf }),
    ...(outcome === undefined ? {} : { outcome }),
  });
  const e = (status, totalTokens) => ({ status, usage: { totalTokens } });
  const { requests, summary } = aggregateInteractionRows([
    row("r1", undefined, e("error", 100)),
    row("r2", "r1", e("error", 200)),
    row("r3", "r2", e("success", 300)),
    row("r4", undefined, e("success", 50)),
    row("r5", undefined, undefined), // 未配对 outcome：不计失败也不算成功
  ]);
  assert.equal(requests.length, 3);
  assert.deepEqual([requests[0].attempts, requests[1].attempts, requests[2].attempts], [3, 1, 1]);
  assert.deepEqual([requests[0].failures, requests[1].failures], [2, 0]);
  assert.deepEqual(summary, { requestCount: 3, attempts: 5, failures: 2, tokenOut: 650,
    promptChars: 50, model: "p/m", hasOutcome: true });
  assert.equal(requests[0].requestId, "r1");
  assert.equal(requests[0].lastOutcome.status, "success");
});

test("v1 兼容详情形状锁：FE 解析契约（G1 §3）", () => {
  const row = adaptLegacyPromptCaptures([{
    seq: 1, timestamp: "t", storageProjectId: "p", sessionId: "s-legacy", kind: "agent", requestId: "r1",
    payloadSha256: "x", agent: { agentId: "pi-coding-agent", longAgentId: "coder-muse" },
    model: { provider: "p", modelId: "m" }, payloadChars: 10,
    turn: { source: "workflow", stageId: "execute", turnKey: "t1" },
    regions: { parsed: true, systemPrompt: { chars: 3, text: "abc", sections: [{ kind: "chat-identity", label: "身份与职责", chars: 3, text: "abc" }] }, tools: [], messages: [] },
  }]).rows[0];
  const detail = toLegacyDetail(row, { messages: [{ role: "system", content: "abc" }] });
  assert.equal(detail.schemaVersion, 1);
  assert.equal(detail.record.sessionId, "s-legacy");
  assert.equal(detail.record.agent.agentId, "pi-coding-agent");
  assert.equal(detail.record.regions.systemSections[0].kind, "chat-identity");
  assert.ok(Array.isArray(detail.payload.messages));
});

test("开关解析链：请求体 > 会话条目 > LA 默认（DP-3 缺省关）", () => {
  const entry = { type: "custom", customType: "chat.interaction-recording", data: { enabled: true } };
  assert.equal(resolvePromptCapture({ body: "on", entries: [], agentDefault: "off" }).promptCapture, "on");
  assert.equal(resolvePromptCapture({ body: "off", entries: [entry], agentDefault: "on" }).promptCapture, undefined); // body 最高优先
  assert.equal(resolvePromptCapture({ entries: [entry], agentDefault: undefined }).promptCapture, "on");
  assert.equal(resolvePromptCapture({ entries: [{ type: "custom", customType: "other", data: {} }], agentDefault: undefined }).promptCapture, undefined);
  assert.equal(resolvePromptCapture({ entries: [], agentDefault: "on" }).promptCapture, "on");
});

test("旧捕获纯读适配：direct→系统调用组、同 sha 归并 attempt、legacy 标记", () => {
  const base = { seq: 1, timestamp: "t", storageProjectId: "p", sessionId: "s", kind: "agent",
    agent: { agentId: "pi-coding-agent" }, model: { provider: "p", modelId: "m" }, payloadChars: 10,
    regions: { parsed: true, systemPrompt: { chars: 5, text: "x", sections: [] }, tools: [], messages: [] } };
  const record = (rid, sha, turn) => ({ ...base, requestId: rid, payloadSha256: sha, turn });
  const { rows, groupKeys } = adaptLegacyPromptCaptures([
    record("r1", "sha-a", { source: "workflow", stageId: "execute", turnKey: "t1" }),
    record("r2", "sha-a", { source: "workflow", stageId: "execute", turnKey: "t1" }),
    record("r3", "sha-b", { source: "direct", turnKey: undefined }),
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].attempt, 1);
  assert.equal(rows[1].attempt, 2);
  assert.equal(rows[1].retryOf, "r1");
  assert.equal(rows[2].turn.stage.id, "direct");
  assert.equal(rows[2].turn.stage.nodeKind, "system");
  assert.equal(rows[0].legacy, true);
  assert.deepEqual([...groupKeys].sort(), ["t1", "系统调用"]);
});

test("兼容视图：v1 形状含 agent.agentId 与区域标签（FE 解析契约）", () => {
  const row = adaptLegacyPromptCaptures([{
    seq: 1, timestamp: "t", storageProjectId: "p", sessionId: "s", kind: "agent", requestId: "r1",
    payloadSha256: "x", agent: { agentId: "pi-coding-agent", longAgentId: "coder-muse" },
    model: { provider: "p", modelId: "m" }, payloadChars: 10,
    turn: { source: "workflow", stageId: "execute", turnKey: "t1" },
    regions: { parsed: true, systemPrompt: { chars: 3, text: "abc", sections: [{ kind: "chat_identity", label: "身份与职责", chars: 3, text: "abc" }] }, tools: [], messages: [] },
  }]).rows;
  const response = toLegacyListResponse(row, "s");
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.count, 1);
  const summary = response.records[0];
  assert.equal(summary.agent.agentId, "pi-coding-agent");
  assert.equal(summary.regions.systemPromptChars, 3);
  assert.equal(summary.regions.systemSections[0].kind, "chat-identity");
  assert.equal(summary.regions.systemSections[0].label, "身份与职责");
  assert.equal(summary.regions.systemSections[0].chars, 3);
});

test("B5 读侧补齐区域元数据：旧记录（无 tag）反查 registry 补 tag，pi-base 不补", async () => {
  const { enrichRegionMetadata } = await import("../src/session-interactions.ts");
  const regions = enrichRegionMetadata([
    { id: "chat-identity", chars: 920 },
    { id: "pi-base", chars: 100 },
    { id: "chat-interaction-harness", chars: 81262, preview: "以下是用户与该项目的交互 harness…" },
    { id: "chat-unknown-region", chars: 5 },
  ]);
  assert.equal(regions[0].tag, "chat_identity", "旧记录按 kind 反查出 XML 标签名");
  assert.ok(regions[0].label.length > 0 && regions[0].label !== "chat-identity", "补出人话名");
  assert.equal(regions[1].tag, undefined, "pi-base 无标签 → 不补（界面不可勾）");
  assert.equal(regions[2].tag, "chat_interaction_harness", "写入侧已带 tag 的记录保持不变");
  assert.equal(regions[2].preview, "以下是用户与该项目的交互 harness…", "preview 原样保留");
  assert.equal(regions[3].tag, undefined, "未登记区域不猜标签");
});
