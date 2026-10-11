import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInteractionRecorder, interactionWriteFailureCount, readInteractionPage, readInteractionRequest } from "../src/session-interactions.ts";

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-interactions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const directTurn = (extra = {}) => ({
  source: "direct", stage: { id: "direct", nodeKind: "system" }, ...extra,
});
const bigPayload = (tag) => ({
  messages: [
    { role: "system", content: `<chat_identity source="chat">\n${"身份正文 ".repeat(400)}\n</chat_identity>\n${tag}` },
    { role: "user", content: "hi" },
  ],
  tools: Array.from({ length: 26 }, (_unused, index) => ({ function: { name: `tool_${index}` } })),
});
const model = { provider: "p", modelId: "m", api: "openai-completions" };

test("区域行无条件写；gz 仅开关开（D4 条件表）", async (t) => {
  const dir = tmp(t);
  const off = createInteractionRecorder({ sessionDir: dir, storageProjectId: "p", sessionId: "s1", turn: directTurn(), agent: { agentId: "a" }, enabled: false });
  await off.record(bigPayload("off"), model);
  const pageOff = await readInteractionPage(dir, "s1");
  assert.equal(pageOff.rows.length, 1);
  assert.equal(pageOff.rows[0].payload.file, undefined);
  assert.equal(fs.existsSync(path.join(dir, "interactions", "s1", "requests")), false);

  const on = createInteractionRecorder({ sessionDir: dir, storageProjectId: "p", sessionId: "s1", turn: directTurn(), agent: { agentId: "a" }, enabled: true });
  await on.record(bigPayload("on"), model);
  const pageOn = await readInteractionPage(dir, "s1");
  const withFile = pageOn.rows.find((row) => row.payload.file !== undefined);
  assert.ok(withFile);
  assert.ok(fs.existsSync(path.join(dir, "interactions", "s1", "requests", withFile.payload.file)));
});

test("单行 ≤4096 字节（regions 只存摘要，大 payload 不进索引）", async (t) => {
  const dir = tmp(t);
  const recorder = createInteractionRecorder({ sessionDir: dir, storageProjectId: "p", sessionId: "s1", turn: directTurn(), agent: { agentId: "a" }, enabled: true });
  await recorder.record(bigPayload("x"), model);
  const indexPath = path.join(dir, "interactions", "s1", "index.jsonl");
  for (const line of fs.readFileSync(indexPath, "utf8").split("\n")) {
    if (line.trim() !== "") assert.ok(Buffer.byteLength(line, "utf8") <= 4096, `行 ${Buffer.byteLength(line, "utf8")}B 超限`);
  }
});

test("direct 轮 stage 归 {direct, system}（D5）；agent 字段入行", async (t) => {
  const dir = tmp(t);
  const recorder = createInteractionRecorder({
    sessionDir: dir, storageProjectId: "p", sessionId: "s1", turn: directTurn(), agent: { agentId: "pi-coding-agent", agentName: "X", longAgentId: "coder-muse" }, enabled: false,
  });
  await recorder.record(bigPayload("d"), model);
  const row = (await readInteractionPage(dir, "s1")).rows[0];
  assert.deepEqual(row.turn.stage, { id: "direct", nodeKind: "system" });
  assert.equal(row.agent.agentId, "pi-coding-agent");
  assert.equal(row.longAgentId, "coder-muse");
});

test("attempt：同实例同 sha 归并 + auto_retry_start 事件为主（D2）", async (t) => {
  const dir = tmp(t);
  const recorder = createInteractionRecorder({ sessionDir: dir, storageProjectId: "p", sessionId: "s1", turn: directTurn(), agent: { agentId: "a" }, enabled: false });
  await recorder.record(bigPayload("same"), model);
  await recorder.record(bigPayload("same"), model);                 // 同 sha → attempt 2
  recorder.handleSessionEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "e" });
  await recorder.record(bigPayload("different"), model);            // 事件置位 → lastAttempt+1=3（即使 sha 不同）
  const rows = (await readInteractionPage(dir, "s1")).rows;
  assert.deepEqual(rows.map((row) => row.attempt), [1, 2, 3]);
  assert.equal(rows[1].retryOf, rows[0].requestId);
});

test("message_end 配对 outcome 并合并读出；无待决则忽略（D1）", async (t) => {
  const dir = tmp(t);
  const recorder = createInteractionRecorder({ sessionDir: dir, storageProjectId: "p", sessionId: "s1", turn: directTurn(), agent: { agentId: "a" }, enabled: false });
  recorder.handleSessionEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }); // 无待决 → 忽略
  await recorder.record(bigPayload("o"), model);
  recorder.handleSessionEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "boom", responseId: "r-1", timestamp: Date.now() + 42 } });
  const rows = (await readInteractionPage(dir, "s1")).rows;
  assert.equal(rows[0].outcome.status, "error");
  assert.equal(rows[0].outcome.errorMessage, "boom");
  assert.equal(rows[0].outcome.responseId, "r-1");
  assert.equal(typeof rows[0].outcome.durationMs, "number");
  const outcomes = fs.readFileSync(path.join(dir, "interactions", "s1", "outcomes.jsonl"), "utf8").trim().split("\n");
  assert.equal(outcomes.length, 1);
});

test("写盘失败不静默：进运行日志并计数，不阻断会话（U3）", async (t) => {
  const dir = tmp(t);
  const sessionDir = path.join(dir, "interactions", "s1");
  fs.mkdirSync(path.join(sessionDir, "index.jsonl"), { recursive: true }); // 同名目录占位 → appendFile EISDIR
  const before = interactionWriteFailureCount();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(" ")); };
  try {
    const recorder = createInteractionRecorder({ sessionDir: dir, storageProjectId: "p", sessionId: "s1", turn: directTurn(), agent: { agentId: "a" }, enabled: false });
    await recorder.record(bigPayload("fail"), model);
    await new Promise(resolve => setTimeout(resolve, 100)); // 等后台写失败落日志
  } finally {
    console.error = originalError;
  }
  assert.equal(interactionWriteFailureCount(), before + 1, "失败计数递增");
  assert.ok(errors.some(line => line.includes("[interactions] 写盘失败")), `运行日志含失败: ${JSON.stringify(errors)}`);
});

test("payload=1 附带 messageRegions 标注且不含重复 text（D2）", async (t) => {
  const dir = tmp(t);
  const recorder = createInteractionRecorder({ sessionDir: dir, storageProjectId: "p", sessionId: "s1", turn: directTurn(), agent: { agentId: "a" }, enabled: true });
  await recorder.record({
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ],
  }, model);
  const row = (await readInteractionPage(dir, "s1")).rows[0];
  const result = await readInteractionRequest(dir, "s1", row.requestId, true);
  assert.ok(result.messageRegions, "payload=1 返回 messageRegions");
  assert.ok(result.messageRegions.length >= 3);
  const userMarks = result.messageRegions.filter(mark => mark.role === "user");
  assert.equal(userMarks.at(-1)?.region, "current-user-message", "末条 user 定位本轮输入");
  assert.ok(userMarks.slice(0, -1).every(mark => mark.region === "history-user"));
  assert.ok(result.messageRegions.every(mark => !("text" in mark) && !("chars" in mark)), "不携带重复原文");
  const plain = await readInteractionRequest(dir, "s1", row.requestId, false);
  assert.equal(plain.messageRegions, undefined, "payload=0 不带标注");
});

test("workflow 轮携带 turn/stage 标识", async (t) => {
  const dir = tmp(t);
  const turn = { source: "workflow", workflowId: "minimal-pi-coding-agent", workflowInvocationId: "inv", stageId: "execute", turnKey: "turn-1", stage: { id: "execute", nodeKind: "agent" } };
  const recorder = createInteractionRecorder({ sessionDir: dir, storageProjectId: "p", sessionId: "s1", turn, agent: { agentId: "pi-coding-agent", longAgentId: "coder-muse" }, enabled: false });
  await recorder.record(bigPayload("w"), model);
  const row = (await readInteractionPage(dir, "s1")).rows[0];
  assert.equal(row.turn.workflowId, "minimal-pi-coding-agent");
  assert.equal(row.turn.turnKey, "turn-1");
  assert.equal(row.turn.stage.id, "execute");
});
