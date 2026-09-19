import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadChatAgentContextFiles } from "../../src/workflows/agent-context-files.ts";

// Native SDK feasibility gate for P1. This deliberately does NOT claim that
// Chat's production factory already separates storage from execution context.
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-pi-seams-"));
  const agentDir = path.join(root, "chat-home", "agent");
  const home = path.join(root, "friend", "workspace");
  const sessionDir = path.join(root, "friend", "sessions");
  const projects = ["a", "b"].map((name) => path.join(root, name));
  for (const dir of [agentDir, home, sessionDir, ...projects]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "PERSONAL_RULE");
  for (const [index, dir] of projects.entries()) {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), `PROJECT_${index}_RULE`);
  }
  const requests = [];
  let handler = () => ({ content: "ack" });
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const delta = handler(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (change, finish) => ({
        id: `p1-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "seam-model",
        choices: [{ index: 0, delta: change, finish_reason: finish }],
      });
      res.write(`data: ${JSON.stringify(frame({ role: "assistant", ...delta }, null))}\n\n`);
      res.write(`data: ${JSON.stringify({ ...frame({}, delta.tool_calls ? "tool_calls" : "stop"),
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    "p1-local": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions",
      apiKey: "local-fake-key", models: [{ id: "seam-model", name: "P1 local",
        reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
  } }));
  const modelRuntime = await ModelRuntime.create({
    modelsPath: path.join(agentDir, "models.json"), authPath: path.join(agentDir, "auth.json"),
  });
  const model = modelRuntime.getModel("p1-local", "seam-model");
  assert.ok(model);
  const manager = SessionManager.create(home, sessionDir);
  async function assemble(cwd, sessionManager = manager, options = {}) {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const files = await loadChatAgentContextFiles({ agentDir, projectRoot: cwd });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noContextFiles: true,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: files }),
      appendSystemPromptOverride: () => ["FRIEND_IDENTITY; own workspace=" + home],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd, agentDir, settingsManager, resourceLoader, sessionManager,
      modelRuntime, model, tools: ["read", "write"], ...options,
    });
    t.after(() => session.dispose());
    return session;
  }
  return { root, home, projects, manager, requests, assemble, setHandler: (next) => { handler = next; } };
}

test("native Pi reassembles project rules and real file tools without moving the Friend Session", async (t) => {
  const f = await fixture(t);
  const id = f.manager.getSessionId();
  const file = f.manager.getSessionFile();
  f.setHandler((body) => body.messages.at(-1).role === "tool" ? { content: "written" } : {
    tool_calls: [{ index: 0, id: `write-${f.requests.length}`, type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: "result.txt", content: `turn-${f.requests.length}` }) } }],
  });
  const first = await f.assemble(f.projects[0]);
  const events = [];
  first.subscribe((event) => events.push(event.type));
  await first.prompt("work in A");
  first.dispose();
  f.manager.flush();
  const reopened = SessionManager.open(file);
  const second = await f.assemble(f.projects[1], reopened);
  await second.prompt("work in B");
  second.dispose();
  reopened.flush();
  assert.equal(reopened.getSessionId(), id);
  assert.equal(reopened.getSessionFile(), file);
  assert.equal(reopened.getCwd(), f.home);
  assert.equal(fs.readFileSync(path.join(f.projects[0], "result.txt"), "utf8"), "turn-1");
  assert.equal(fs.readFileSync(path.join(f.projects[1], "result.txt"), "utf8"), "turn-3");
  assert.equal(fs.existsSync(path.join(f.home, "result.txt")), false);
  const firstSystem = JSON.stringify(f.requests[0].messages.filter((m) => ["system", "developer"].includes(m.role)));
  const secondSystem = JSON.stringify(f.requests[2].messages.filter((m) => ["system", "developer"].includes(m.role)));
  assert.match(firstSystem, /PROJECT_0_RULE/);
  assert.match(secondSystem, /PROJECT_1_RULE/);
  assert.doesNotMatch(secondSystem, /PROJECT_0_RULE/);
  assert.match(secondSystem, /PERSONAL_RULE/);
  assert.match(secondSystem, /FRIEND_IDENTITY/);
  assert.match(JSON.stringify(f.requests[2].messages), /work in A/);
  assert.ok(events.includes("message_update") && events.includes("tool_execution_end"));
  const entries = reopened.getEntries();
  assert.equal(entries.filter((e) => e.type === "message" && e.message.role === "user").length, 2);
  assert.equal(entries.filter((e) => e.type === "message" && e.message.role === "toolResult").length, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]).cwd, f.home);
});

test("CustomEntry requires explicit context projection and does not rewrite native user messages", async (t) => {
  const f = await fixture(t);
  f.manager.appendCustomEntry("chat.p1_context", { marker: "METADATA_ONLY", project: "a" });
  let session = await f.assemble(f.projects[0]);
  await session.prompt("original user words");
  session.dispose();
  assert.doesNotMatch(JSON.stringify(f.requests[0]), /METADATA_ONLY/);
  session = await f.assemble(f.projects[1], f.manager, {
    transformContext: async (messages) => [{ role: "user", content: [{ type: "text", text: "PROJECT_HISTORY_LABEL" }], timestamp: 0 }, ...messages],
  });
  await session.prompt("next user words");
  assert.match(JSON.stringify(f.requests[1]), /PROJECT_HISTORY_LABEL/);
  assert.equal(f.manager.getEntries().filter((e) => e.type === "message" && e.message.role === "user").length, 2);
  assert.doesNotMatch(JSON.stringify(f.manager.getEntries()), /PROJECT_HISTORY_LABEL/);
});

test("native compaction persists and restores without persisting dynamic system rules", async (t) => {
  const f = await fixture(t);
  f.manager.appendCustomMessageEntry("chat.p1_project_history", "Historical scope: PROJECT_A_LABEL; not current instructions.", false, { projectId: "a" });
  const session = await f.assemble(f.projects[0]);
  await session.prompt("A discussion " + "history ".repeat(400));
  await session.prompt("continue A " + "facts ".repeat(400));
  const beforeCompaction = f.requests.length;
  f.setHandler(() => ({ content: "P1_COMPACTED_HISTORY: earlier project A facts; not current instructions." }));
  const result = await session.compact("Keep historical project attribution.");
  assert.match(result.summary, /P1_COMPACTED_HISTORY/);
  assert.ok(f.requests.slice(beforeCompaction).some((request) => JSON.stringify(request.messages).includes("PROJECT_A_LABEL")));
  session.dispose();
  f.manager.flush();
  const reopened = SessionManager.open(f.manager.getSessionFile());
  assert.equal(reopened.getEntries().filter((e) => e.type === "compaction").length, 1);
  assert.equal(reopened.getEntries().filter((e) => e.type === "message" && e.message.role === "user").length, 2);
  f.setHandler(() => ({ content: "restored" }));
  const restored = await f.assemble(f.projects[1], reopened);
  await restored.prompt("now B");
  const last = f.requests.at(-1);
  assert.match(JSON.stringify(last.messages), /P1_COMPACTED_HISTORY/);
  const system = JSON.stringify(last.messages.filter((m) => ["system", "developer"].includes(m.role)));
  assert.match(system, /PROJECT_1_RULE/);
  assert.doesNotMatch(system, /PROJECT_0_RULE/);
  assert.doesNotMatch(JSON.stringify(reopened.getEntries()), /PROJECT_[01]_RULE/);
  assert.equal(reopened.getSessionId(), f.manager.getSessionId());
});

test("loaded context is stable during a turn and a fresh assembly sees changed or missing project rules", async (t) => {
  const f = await fixture(t);
  const current = await f.assemble(f.projects[0]);
  fs.writeFileSync(path.join(f.projects[0], "AGENTS.md"), "PROJECT_A_NEW_REVISION");
  await current.prompt("accepted before edit");
  current.dispose();
  assert.match(JSON.stringify(f.requests[0].messages), /PROJECT_0_RULE/);
  assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /PROJECT_A_NEW_REVISION/);
  const next = await f.assemble(f.projects[0]);
  await next.prompt("accepted after edit");
  next.dispose();
  assert.match(JSON.stringify(f.requests[1].messages), /PROJECT_A_NEW_REVISION/);
  fs.unlinkSync(path.join(f.projects[1], "AGENTS.md"));
  const withoutRules = await f.assemble(f.projects[1]);
  await withoutRules.prompt("project without rules");
  const system = JSON.stringify(f.requests[2].messages.filter((m) => ["system", "developer"].includes(m.role)));
  assert.match(system, /PERSONAL_RULE/);
  assert.doesNotMatch(system, /PROJECT_0_RULE|PROJECT_A_NEW_REVISION|PROJECT_1_RULE/);
});

test("native maintenance turn reuses the daily Session without inventing a user message or enabling tools", async (t) => {
  const f = await fixture(t);
  const userSession = await f.assemble(f.projects[0]);
  await userSession.prompt("today's work");
  userSession.dispose();
  const summary = await f.assemble(f.home, f.manager, { tools: [] });
  await summary.sendCustomMessage({
    customType: "chat.p1_daily_summary", content: "Summarize the recorded work. SYSTEM_MAINTENANCE",
    display: false, details: { source: "maintenance", cutoff: f.manager.getLeafId() },
  }, { triggerTurn: true });
  summary.dispose();
  f.manager.flush();
  const reopened = SessionManager.open(f.manager.getSessionFile());
  assert.equal(reopened.getSessionId(), f.manager.getSessionId());
  assert.equal(reopened.getEntries().filter((e) => e.type === "message" && e.message.role === "user").length, 1);
  assert.equal(reopened.getEntries().filter((e) => e.type === "message" && e.message.role === "assistant").length, 2);
  assert.equal(reopened.getEntries().filter((e) => e.type === "custom_message" && e.customType === "chat.p1_daily_summary").length, 1);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /SYSTEM_MAINTENANCE/);
  assert.equal(f.requests.at(-1).tools?.length ?? 0, 0);
});
