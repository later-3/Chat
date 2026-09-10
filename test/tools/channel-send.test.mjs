import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { ensureDailyProject } from "../../src/projects/registry.ts";
import { listChatSystemTools, resolveChatSystemTools } from "../../src/tools/registry.ts";

const INSTANCE = (port) => ({
  id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
  gatewayBaseUrl: `http://127.0.0.1:${port}/webhook/chat-backend`,
});

const CHANNEL_TOKEN = "test-channel-token-that-is-at-least-32-characters";

function agentEntry(overrides = {}) {
  return {
    id: "nexus", name: "Nexus", description: "Daily coworker", enabled: true,
    instanceId: "local", nanoclawAgentGroupId: "ag-nexus", defaultProjectId: "daily",
    inbox: {
      messagingGroupId: "mg-private", channelType: "telegram", instance: "telegram",
      platformId: "telegram:user", threadId: null,
    },
    ...overrides,
  };
}

async function setup(t, agents) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-channel-send-"));
  const chatHome = path.join(base, "home");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = await ensureDailyProject(chatHome);
  const manager = SessionManager.inMemory(project.cwd);
  return { base, chatHome, project, manager };
}

function contextOf(base) {
  return {
    purpose: "execution", projectId: "daily", chatHome: base.chatHome, cwd: base.project.cwd,
    sessionManager: base.manager, sessionId: base.manager.getSessionId(), agentId: "nexus",
    longAgentId: "nexus", longAgentTurnId: "turn-1",
    authorizedToolAddresses: ["system:tool/channel_send"], authorizedToolNames: ["channel_send"],
  };
}

test("channel_send delivers through the bound destination and records the audit", async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      received.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ schemaVersion: 1, persisted: true, messageId: JSON.parse(body).messageId, nanoSessionId: "nano-1" }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const port = server.address().port;

  const base = await setup(t);
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = CHANNEL_TOKEN;
  t.after(() => { delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; });
  await writeLongAgentRegistry({
    schemaVersion: 1, instances: [INSTANCE(port)], agents: [agentEntry()],
  }, base.chatHome);

  const [tool] = resolveChatSystemTools(["system:tool/channel_send"], contextOf(base));
  const result = await tool.definition.execute("call-1", { text: "定时任务完成：报告已生成" });
  assert.equal(result.details.sent, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/webhook/chat-backend/v1/agent-messages");
  assert.equal(received[0].body.agentGroupId, "ag-nexus");
  assert.equal(received[0].body.messagingGroupId, "mg-private");
  assert.equal(received[0].body.text, "定时任务完成：报告已生成");
  assert.match(received[0].body.messageId, /^chat-pi:proactive:/);
  const audit = fs.readFileSync(path.join(base.chatHome, "logs", "audit.jsonl"), "utf8");
  assert.match(audit, /long-agent\.channel\.send/);
});

test("channel_send rejects non-Long-Agent contexts and unbound or archived Agents", async (t) => {
  const base = await setup(t);
  process.env.CHAT_CHANNEL_GATEWAY_TOKEN = CHANNEL_TOKEN;
  t.after(() => { delete process.env.CHAT_CHANNEL_GATEWAY_TOKEN; });
  await writeLongAgentRegistry({
    schemaVersion: 1, instances: [INSTANCE(1)],
    agents: [
      agentEntry({ id: "unbound", inbox: undefined, nanoclawAgentGroupId: "ag-unbound" }),
      agentEntry({ id: "archived", status: "archived", enabled: false, nanoclawAgentGroupId: "ag-archived" }),
    ],
  }, base.chatHome);

  const [tool] = resolveChatSystemTools(["system:tool/channel_send"], contextOf(base));
  // 非 Long Agent 上下文
  const { longAgentId, ...noAgent } = contextOf(base);
  const [plain] = resolveChatSystemTools(["system:tool/channel_send"], noAgent);
  await assert.rejects(plain.definition.execute("c1", { text: "hi" }), /只服务于Long Agent/);
  // 未绑定通道
  await assert.rejects(
    resolveChatSystemTools(["system:tool/channel_send"], { ...contextOf(base), longAgentId: "unbound" })[0]
      .definition.execute("c2", { text: "hi" }),
    /未绑定通道/,
  );
  // 已归档
  await assert.rejects(
    resolveChatSystemTools(["system:tool/channel_send"], { ...contextOf(base), longAgentId: "archived" })[0]
      .definition.execute("c3", { text: "hi" }),
    /已归档或停用/,
  );
  void tool;
});
