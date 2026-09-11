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
      const task = {
        id: "evening-summary-1234", seriesId: "evening-summary-1234", status: "pending",
        processAfter: "2026-09-10T15:30:00.000Z", recurrence: payload.recurrence ?? "30 23 * * *",
        prompt: payload.prompt ?? "", script: null, originSessionId: null,
        sessionId: "sess-task-1", agentGroupId: payload.agentGroupId, createdAt: new Date().toISOString(), tries: 0,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        schemaVersion: 1,
        ...(payload.operation === "list" ? { tasks: [] } : {}),
        ...(payload.operation === "list" ? {} : { task }),
        ...(payload.operation === "run" ? { firedTaskId: "evening-summary-1234-run-abcd" } : {}),
      }));
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

test("task_manage proxies the narrow task contract for the agent's own group", async (t) => {
  const base = await setup(t);
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = CHANNEL_TOKEN;
  t.after(() => { delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; });
  const [tool] = resolveChatSystemTools(["system:tool/task_manage"], contextOf(base));

  const created = await tool.definition.execute("c1", {
    operation: "create", name: "evening-summary", prompt: "做今天的每日总结", recurrence: "30 23 * * *", reason: "用户要求每天总结",
  });
  assert.equal(created.details.task.id, "evening-summary-1234");
  assert.equal(base.received[0].url, "/webhook/chat-backend/v1/agent-groups/tasks");
  assert.equal(base.received[0].body.agentGroupId, "ag-nexus");
  assert.equal(base.received[0].body.operation, "create");
  assert.equal(base.received[0].body.recurrence, "30 23 * * *");

  await tool.definition.execute("c2", { operation: "run", taskId: "evening-summary-1234" });
  assert.equal(base.received[1].body.operation, "run");
  assert.equal(base.received[1].body.taskId, "evening-summary-1234");

  const audit = fs.readFileSync(path.join(base.chatHome, "logs", "audit.jsonl"), "utf8");
  assert.match(audit, /long-agent\.task\.create/);
  assert.match(audit, /long-agent\.task\.run/);
  assert.match(audit, /用户要求每天总结/);
});

test("task_manage rejects non-Long-Agent contexts, archived agents and missing parameters", async (t) => {
  const base = await setup(t);
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = CHANNEL_TOKEN;
  t.after(() => { delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; });

  const { longAgentId, ...noAgent } = contextOf(base);
  const [plain] = resolveChatSystemTools(["system:tool/task_manage"], noAgent);
  await assert.rejects(plain.definition.execute("c1", { operation: "list" }), /只服务于Long Agent/);

  const [tool] = resolveChatSystemTools(["system:tool/task_manage"], contextOf(base));
  await assert.rejects(tool.definition.execute("c2", { operation: "create" }), /create需要prompt/);
  await assert.rejects(tool.definition.execute("c3", { operation: "pause" }), /pause需要taskId/);

  // 归档 Agent 不能管理任务
  await writeLongAgentRegistry({
    schemaVersion: 1,
    instances: [{ id: "local", name: "Local NanoClaw", executionMode: "chat-pi", gatewayBaseUrl: "http://127.0.0.1:1/webhook/chat-backend" }],
    agents: [{
      id: "nexus", name: "Nexus", description: "Daily coworker", enabled: false, status: "archived",
      instanceId: "local", nanoclawAgentGroupId: "ag-nexus", defaultProjectId: "nexus",
    }],
  }, base.chatHome);
  const [archivedTool] = resolveChatSystemTools(["system:tool/task_manage"], contextOf(base));
  await assert.rejects(archivedTool.definition.execute("c4", { operation: "list" }), /已归档或停用/);
});
