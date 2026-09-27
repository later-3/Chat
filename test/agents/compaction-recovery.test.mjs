import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createChatPiAgentSession } from "../../src/agents/pi-agent-session.ts";
import { openChatSession } from "../../src/chat-session.ts";
import { fixture } from "../long-agents/daily-fixture.mjs";

const agent = { schemaVersion: 1, id: "test", name: "Test", description: "Compaction transport regression",
  systemPrompt: { mode: "replace", text: "Answer the user." }, customInstructions: [], tools: { mode: "none" },
  resources: { mode: "explicit", skillPaths: [], extensionPaths: [], pluginSources: [] } };

async function setup(t, retry = { enabled: false }) {
  const f = await fixture(t);
  const settingsPath = path.join(f.home, "agent/settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, retry: { ...retry, provider: { maxRetries: 0 } } }));
  const chatSession = await openChatSession({ chatHome: f.home, projectId: f.projects[0].projectId });
  let allowed = true;
  const admissions = [];
  async function assemble(manager = chatSession.manager) {
    const { session } = await createChatPiAgentSession({ chatSession, sessionManager: manager, agent,
      providerRequestGate: payload => {
        admissions.push(payload);
        if (!allowed) throw new Error("Budget admission denied");
        return payload;
      } });
    t.after(() => session.dispose());
    return session;
  }
  const session = await assemble();
  await session.prompt("ORIGINAL_HISTORY " + "history ".repeat(200));
  await session.prompt("LATEST_TASK");
  const reopen = () => SessionManager.open(chatSession.manager.getSessionFile());
  return { ...f, session, manager: chatSession.manager, admissions, assemble, reopen, deny: () => { allowed = false; } };
}

test("public assembly admits ordinary, split compaction and branch-summary HTTP requests exactly once", async t => {
  const f = await setup(t);
  assert.equal(f.admissions.length, 2);
  f.setHandler(() => ({ content: "SAFE_SUMMARY" }));
  const before = f.requests.length;
  await f.session.compact();
  assert.ok(f.requests.length > before);
  assert.equal(f.admissions.length, f.requests.length);
  assert.equal(f.reopen().getEntries().filter(e => e.type === "compaction").length, 1);
  await f.session.prompt("AFTER_COMPACTION");
  const target = f.manager.getEntries().find(e => e.type === "message" && e.message.role === "assistant");
  await f.session.navigateTree(target.id, { summarize: true });
  assert.equal(f.admissions.length, f.requests.length);
  assert.equal(f.reopen().getEntries().filter(e => e.type === "branch_summary").length, 1);
});

for (const action of ["compaction", "branch-summary"]) test(`budget denial blocks ${action} before HTTP and keeps the native leaf`, async t => {
  const f = await setup(t);
  const leaf = f.manager.getLeafId(), requests = f.requests.length;
  f.deny();
  const target = f.manager.getEntries().find(e => e.type === "message" && e.message.role === "assistant");
  await assert.rejects(action === "compaction" ? f.session.compact() : f.session.navigateTree(target.id, { summarize: true }), /Budget admission denied/);
  assert.equal(f.requests.length, requests);
  assert.equal(f.manager.getLeafId(), leaf);
  assert.equal(f.reopen().getEntries().some(e => ["compaction", "branch_summary"].includes(e.type)), false);
});

for (const failure of ["length", "quota"]) test(`${failure} summary is not saved; reassembly retains history and can compact again`, async t => {
  const f = await setup(t, { enabled: true, maxRetries: 2, baseDelayMs: 5 });
  const events = []; f.session.subscribe(event => events.push(event));
  f.setHandler(() => failure === "length" ? { content: "UNSAFE_PARTIAL_SUMMARY", finishReason: "length" } : { error: "insufficient_quota" });
  await assert.rejects(f.session.compact(), failure === "length" ? /token cap/ : /quota/);
  assert.equal(events.filter(e => e.type === "summarization_retry_scheduled").length, 0);
  assert.equal(f.reopen().getEntries().some(e => e.type === "compaction"), false);
  assert.match(JSON.stringify(f.reopen().buildSessionContext().messages), /ORIGINAL_HISTORY/);
  f.session.dispose();
  const resumed = await f.assemble(f.reopen());
  f.setHandler(() => ({ content: "RECOVERED_SUMMARY" }));
  await resumed.compact();
  assert.match(JSON.stringify(f.reopen().buildSessionContext().messages), /RECOVERED_SUMMARY/);
  assert.doesNotMatch(JSON.stringify(f.reopen().buildSessionContext().messages), /UNSAFE_PARTIAL_SUMMARY/);
  await resumed.prompt("CONTINUE_SAME_SESSION");
  assert.equal(resumed.sessionManager.getSessionId(), f.manager.getSessionId());
  assert.match(JSON.stringify(f.requests.at(-1)), /RECOVERED_SUMMARY/);
});

for (const cancel of [false, true]) test(`summary transport failure ${cancel ? "cancels during backoff" : "retries with admission"} and settles`, async t => {
  const f = await setup(t, { enabled: true, maxRetries: 2, baseDelayMs: cancel ? 60_000 : 5 });
  let attempts = 0;
  f.setHandler((_body, res) => {
    if (++attempts === 1) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"id":"drop","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n');
      setImmediate(() => res.destroy());
      return undefined;
    }
    return { content: "RETRY_SUMMARY" };
  });
  const events = [];
  f.session.subscribe(event => {
    events.push(event);
    if (cancel && event.type === "summarization_retry_scheduled") f.session.abortCompaction();
  });
  const work = f.session.compact();
  if (cancel) await assert.rejects(work, /cancel|abort/i); else await work;
  assert.equal(events.filter(e => e.type === "summarization_retry_scheduled").length, 1);
  assert.equal(events.filter(e => e.type === "summarization_retry_finished").length, 1);
  assert.equal(f.session.isCompacting, false);
  assert.equal(f.admissions.length, f.requests.length);
  assert.equal(f.reopen().getEntries().some(e => e.type === "compaction"), !cancel);
  if (cancel) assert.equal(attempts, 1, "cancel must not wait for or dispatch the delayed retry");
});
