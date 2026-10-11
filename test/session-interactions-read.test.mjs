import assert from "node:assert/strict";
import test from "node:test";
import { adaptLegacyPromptCaptures, resolvePromptCapture, toLegacyListResponse } from "../src/session-interactions.ts";

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
