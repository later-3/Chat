import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { ensureAgentHomeProject, ensureLongAgentShareProject } from "../../src/projects/registry.ts";
import { resolveChatSystemTools } from "../../src/tools/registry.ts";

const CHANNEL_TOKEN = "test-channel-token-that-is-at-least-32-characters";

async function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-task-manage-"));
  const chatHome = path.join(base, "home");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ url: req.url, body: JSON.parse(body) });
      const payload = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      const projection = payload.projection;
      res.end(JSON.stringify(payload.operation === "claim" ? { schemaVersion: 1, timeZone: "Asia/Shanghai", tasks: [] }
        : payload.operation === "list" ? { schemaVersion: 1, projections: [] }
        : payload.operation === "preview" ? { schemaVersion: 1, nextAt: null }
        : { schemaVersion: 1, taskId: projection.taskId, revision: projection.revision, nextAt: null }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistry({
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local NanoClaw", executionMode: "chat-pi", gatewayBaseUrl: `http://127.0.0.1:${port}/webhook/chat-backend` }],
    agents: [{
      id: "nexus", name: "Nexus", description: "Daily coworker", enabled: true,
      instanceId: "local", nanoclawAgentGroupId: "ag-nexus", defaultProjectId: "nexus",
      inbox: { messagingGroupId: "mg-1", channelType: "telegram", instance: "telegram", platformId: "telegram:user", threadId: null },
    }],
  }, chatHome);
  await ensureAgentHomeProject("nexus", "Nexus", chatHome);
  const manager = SessionManager.inMemory(chatHome);
  return { chatHome, manager, received };
}

function contextOf(base) {
  return {
    purpose: "execution", projectId: "nexus", chatHome: base.chatHome, cwd: base.chatHome,
    sessionManager: base.manager, sessionId: base.manager.getSessionId(), agentId: "nexus",
    longAgentId: "nexus", longAgentTurnId: "turn-1",
    authorizedToolAddresses: ["system:tool/task_manage"], authorizedToolNames: ["task_manage"],
  };
}

test("task_manage uses Chat definitions and trusted context, sending only projections to Nano", async (t) => {
  const base = await setup(t);
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = CHANNEL_TOKEN;
  t.after(() => { delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; });
  const [tool] = resolveChatSystemTools(["system:tool/task_manage"], contextOf(base));
  const command = { operation: "create", definition: { name: "evening-summary", prompt: "做今天的每日总结", schedule: { kind: "cron", expression: "30 23 * * *" }, timeZone: "Asia/Shanghai", missed: "skip", overlap: "queue-one" } };
  const created = await tool.definition.execute("c1", command);
  const retried = await tool.definition.execute("c1", command);
  assert.equal(created.details.tasks.length, 1); assert.equal(retried.details.tasks.length, 1);
  assert.equal(created.details.tasks[0].contextProjectId, null);
  assert.ok(base.received.every(r => r.url === "/webhook/chat-backend/v1/task-projections"));
  assert.ok(base.received.filter(r => r.body.projection).every(r => r.body.projection.agentGroupId === "ag-nexus" && !Object.hasOwn(r.body.projection, "prompt")));
  await tool.definition.execute("c2", { operation: "pause", taskId: created.details.tasks[0].id, expectedRevision: 1 });
  const audit = fs.readFileSync(path.join(base.chatHome, "logs", "audit.jsonl"), "utf8");
  assert.match(audit, /long-agent\.task\.create/); assert.match(audit, /long-agent\.task\.pause/);
});
test("task_manage rejects non-Friend contexts and missing or forged input", async (t) => {
  const base = await setup(t); process.env.CHAT_CHANNEL_GATEWAY_TOKEN = CHANNEL_TOKEN;
  t.after(() => { delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; });
  const { longAgentId, ...noAgent } = contextOf(base);
  const [plain] = resolveChatSystemTools(["system:tool/task_manage"], noAgent);
  await assert.rejects(plain.definition.execute("c1", { operation: "list" }), /只服务于当前Friend/);
  const [tool] = resolveChatSystemTools(["system:tool/task_manage"], contextOf(base));
  await assert.rejects(tool.definition.execute("c2", { operation: "create" }), /任务数据必须是对象/);
  await assert.rejects(tool.definition.execute("c3", { operation: "pause" }), /任务文字为空/);
  await assert.rejects(tool.definition.execute("c4", { operation: "list", longAgentId: "foreign" }), /未知字段/);
});
