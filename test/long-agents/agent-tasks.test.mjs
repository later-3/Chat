import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ensureDefaultLongAgentTasks, DEFAULT_LONG_AGENT_TASKS } from "../../src/long-agents/agent-tasks.ts";

async function gateway(t, tasks = []) {
  const created = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      if (payload.operation === "list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ schemaVersion: 1, tasks }));
        return;
      }
      created.push(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        schemaVersion: 1,
        task: {
          id: `${payload.name}-abcd`, seriesId: `${payload.name}-abcd`, status: "pending",
          processAfter: "2026-09-11T00:00:00.000Z", recurrence: payload.recurrence, prompt: payload.prompt,
          script: null, originSessionId: null, sessionId: "s1", agentGroupId: payload.agentGroupId,
          createdAt: new Date().toISOString(), tries: 0,
        },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { instance: { id: "local", name: "Local", executionMode: "chat-pi", gatewayBaseUrl: `http://127.0.0.1:${server.address().port}/webhook/chat-backend` }, created };
}

test("default tasks are created once with the daily-summary and morning-outreach schedules", async (t) => {
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = "test-channel-token-that-is-at-least-32-characters";
  t.after(() => { delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; });
  const { instance, created } = await gateway(t);
  const result = await ensureDefaultLongAgentTasks({ instance, agentGroupId: "ag-nexus" });
  assert.deepEqual([...result].sort(), ["daily-summary", "morning-outreach"]);
  assert.equal(created.length, 2);
  assert.deepEqual(created.map((task) => [task.name, task.recurrence]).sort(), [
    ["daily-summary", "30 23 * * *"],
    ["morning-outreach", "0 8 * * *"],
  ]);
  // 晨间任务必须明确要求经 channel_send 主动联系，且允许"保持安静"。
  const outreach = created.find((task) => task.name === "morning-outreach");
  assert.match(outreach.prompt, /channel_send/);
  assert.match(outreach.prompt, /不要问候语/);
  assert.match(outreach.prompt, /保持安静/);
  // 日终总结必须包含反思与记忆维护。
  const summary = created.find((task) => task.name === "daily-summary");
  assert.match(summary.prompt, /memory_record/);
  assert.match(summary.prompt, /下次怎么改/);
});

test("default task provisioning is idempotent when the series already exists", async (t) => {
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = "test-channel-token-that-is-at-least-32-characters";
  t.after(() => { delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; });
  const existing = DEFAULT_LONG_AGENT_TASKS.map((task) => ({
    id: `${task.name}-1234`, seriesId: `${task.name}-1234`, status: "pending", processAfter: null,
    recurrence: task.recurrence, prompt: task.prompt, script: null, originSessionId: null,
    sessionId: "s1", agentGroupId: "ag-nexus", createdAt: new Date().toISOString(), tries: 0,
  }));
  const { instance, created } = await gateway(t, existing);
  const result = await ensureDefaultLongAgentTasks({ instance, agentGroupId: "ag-nexus" });
  assert.deepEqual(result, []);
  assert.equal(created.length, 0);
});
