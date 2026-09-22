import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createChatPiAgentSession } from "../../src/agents/pi-agent-session.ts";
import { openChatSession } from "../../src/chat-session.ts";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../../src/session-operation-lock.ts";
import { prepareLongAgentAssembly } from "../../src/long-agents/assembly.ts";
import { readLongAgentRegistry, longAgentConfigRoot } from "../../src/long-agents/storage.ts";
import { writeLongAgentSummary } from "../../src/long-agents/summaries.ts";
import { acceptLongAgentTurn } from "../../src/long-agents/turn-queue.ts";
import { fixture } from "./daily-fixture.mjs";

// LA0 feasibility probes, NOT a production group/task implementation. The public
// factory and native persistence are real; only the HTTP model is deterministic.
// la0.probe.* entries intentionally have no production reader or API contract.
async function assemble(t, f, chatSession, turnId, projectId = null) {
  const agent = (await readLongAgentRegistry(f.home)).agents[0];
  const created = await createChatPiAgentSession({
    chatSession, sessionManager: chatSession.manager, agent: agent.definition,
    invocation: { turnId, projectId, ownWorkspace: chatSession.cwd,
      ownResourceRoot: longAgentConfigRoot(f.home, agent.id) },
    toolContext: { purpose: "execution", agentId: agent.id, longAgentId: agent.id, longAgentTurnId: turnId },
  });
  t.after(() => created.session.dispose());
  return created.session;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function user(manager, text) {
  return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

test("LA0: public assembly can run the same Friend in two independent Sessions concurrently", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const chats = await Promise.all([0, 1].map(() => openChatSession({ chatHome: f.home, projectId: "friend" })));
  assert.notEqual(chats[0].manager.getSessionId(), chats[1].manager.getSessionId());
  const sessions = await Promise.all(chats.map((chat, i) => assemble(t, f, chat, `independent-${i}`, i ? "b" : "a")));
  const arrived = deferred();
  let active = 0;
  f.setHandler(async () => {
    if (++active === 2) arrived.resolve();
    await arrived.promise; // Cannot finish if an identity-wide lock serializes these requests.
    return { content: "isolated reply" };
  });
  await Promise.all(sessions.map((session, i) => session.prompt(`ONLY_SESSION_${i}`)));
  assert.equal(active, 2);
  for (const [i, chat] of chats.entries()) {
    chat.manager.flush();
    const reopened = SessionManager.open(chat.manager.getSessionFile());
    assert.match(JSON.stringify(reopened.getBranch()), new RegExp(`ONLY_SESSION_${i}`));
    assert.doesNotMatch(JSON.stringify(reopened.getBranch()), new RegExp(`ONLY_SESSION_${1 - i}`));
    const request = f.requests.find((body) => JSON.stringify(body.messages).includes(`ONLY_SESSION_${i}`));
    assert.match(JSON.stringify(request), new RegExp(i ? "RULE_b" : "RULE_a"));
    assert.doesNotMatch(JSON.stringify(request), new RegExp(i ? "RULE_a" : "RULE_b"));
  }
});

test("LA0: current Friend acceptance rejects arbitrary task Sessions before model execution", async (t) => {
  const f = await fixture(t);
  await assert.rejects(acceptLongAgentTurn({ ...f.input("not-a-daily-session"), sessionId: "independent-task" }));
  assert.equal(f.requests.length, 0);
});

test("LA0: current daily assembly includes private handoff and must not be reused blindly for group input", async (t) => {
  const f = await fixture(t);
  await writeLongAgentSummary({ chatHome: f.home, longAgentId: "friend", date: "2026-09-19",
    did: ["PRIVATE_DAILY_FACT"], handoff: "PRIVATE_NEXT_STEP" });
  const agent = (await readLongAgentRegistry(f.home)).agents[0];
  const prepared = await prepareLongAgentAssembly({ agent, chatHome: f.home, projectId: null,
    turnId: "private-handoff-probe", today: "2026-09-20" });
  assert.match(JSON.stringify(prepared.agent.customInstructions), /PRIVATE_DAILY_FACT/);
  assert.match(JSON.stringify(prepared.agent.customInstructions), /PRIVATE_NEXT_STEP/);
});

test("LA0: retaining an old native writer creates a branch that omits newer user input", async (t) => {
  const f = await fixture(t);
  const chat = await openChatSession({ chatHome: f.home, projectId: "friend" });
  user(chat.manager, "original"); chat.manager.flush();
  const file = chat.manager.getSessionFile();
  const stale = SessionManager.open(file);
  const fresh = SessionManager.open(file);
  const newerId = user(fresh, "NEWER_USER_INPUT"); fresh.flush();
  stale.appendCustomEntry("la0.probe.completion", { taskId: "task" }); stale.flush();
  const reopened = SessionManager.open(file);
  assert.ok(reopened.getEntry(newerId), "raw entry survives");
  assert.equal(reopened.getBranch().some((entry) => entry.id === newerId), false,
    "this is the known stale-writer hazard, not an acceptable production result");
});

test("LA0: reload under the shared Session lock preserves new input and deduplicates a durable completion", async (t) => {
  const f = await fixture(t);
  const chat = await openChatSession({ chatHome: f.home, projectId: "friend" });
  user(chat.manager, "original"); chat.manager.flush();
  const file = chat.manager.getSessionFile();
  const key = chatSessionOperationKey("friend", chat.manager.getSessionId());
  const release = deferred(); const entered = deferred();
  const input = withChatSessionOperationLock(key, async () => {
    const manager = SessionManager.open(file);
    entered.resolve(); await release.promise;
    const id = user(manager, "NEWER_USER_INPUT"); manager.flush(); return id;
  });
  await entered.promise;
  // Test-only receipt prototype: LA1 must integrate this discipline in all real writers.
  const complete = (simulateCrash = false) => withChatSessionOperationLock(key, async () => {
    const manager = SessionManager.open(file);
    const prior = manager.getEntries().find((entry) => entry.type === "custom"
      && entry.customType === "la0.probe.completion" && entry.data.eventId === "task:attempt:destination");
    if (prior) return prior.id;
    const id = manager.appendCustomEntry("la0.probe.completion", { eventId: "task:attempt:destination" });
    manager.flush();
    if (simulateCrash) throw new Error("lost acknowledgement after durable append");
    return id;
  });
  const crash = assert.rejects(complete(true), /lost acknowledgement/);
  release.resolve();
  const newerId = await input;
  await crash;
  const ids = await Promise.all([complete(), complete()]);
  assert.equal(ids[0], ids[1]);
  const reopened = SessionManager.open(file);
  assert.ok(reopened.getBranch().some((entry) => entry.id === newerId));
  assert.equal(reopened.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "la0.probe.completion").length, 1);
});

test("LA0: public references survive native tool execution, compaction and reopen without copying private history", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const participant = await openChatSession({ chatHome: f.home, projectId: "friend" });
  const session = await assemble(t, f, participant, "publication", "a");
  fs.writeFileSync(path.join(f.projects[0].cwd, "source.txt"), "PRIVATE_TOOL_MATERIAL");
  f.setHandler((body) => body.messages.at(-1).role === "tool" ? { content: "PUBLIC_CONCLUSION" } : {
    tool_calls: [{ index: 0, id: "read-source", type: "function", function: {
      name: "read", arguments: JSON.stringify({ path: "source.txt" }),
    } }],
  });
  await session.prompt("PRIVATE_DRAFT_REQUEST " + "background ".repeat(300));
  const entries = participant.manager.getEntries();
  const answer = entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(answer);
  assert.ok(entries.some((entry) => entry.type === "message" && entry.message.role === "toolResult"));
  participant.manager.flush();
  const root = await openChatSession({ chatHome: f.home, projectId: "a" });
  const publicationId = root.manager.appendCustomEntry("la0.probe.publication", {
    participantId: "friend", sourceSessionId: participant.manager.getSessionId(), sourceEntryId: answer.id,
  });
  root.manager.flush();
  f.setHandler(() => ({ content: "COMPACTED_PARTICIPANT_CONTEXT" }));
  await session.compact("Summarize the discussion.");
  session.dispose(); participant.manager.flush();
  const reopened = SessionManager.open(participant.manager.getSessionFile());
  assert.ok(reopened.getEntries().some((entry) => entry.type === "compaction"));
  const publication = SessionManager.open(root.manager.getSessionFile()).getEntry(publicationId);
  const referenced = reopened.getEntry(publication.data.sourceEntryId);
  assert.equal(referenced.message.role, "assistant");
  const publicText = referenced.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  assert.equal(publicText, "PUBLIC_CONCLUSION");
  assert.doesNotMatch(fs.readFileSync(root.manager.getSessionFile(), "utf8"), /PRIVATE_DRAFT_REQUEST|PRIVATE_TOOL_MATERIAL|PUBLIC_CONCLUSION/);
  assert.ok(reopened.getEntries().some((entry) => entry.type === "message" && entry.message.role === "toolResult"));
  // Foreign references are metadata only; production needs an authorized projection.
  assert.doesNotMatch(JSON.stringify(SessionManager.open(root.manager.getSessionFile()).buildSessionContext()), /PUBLIC_CONCLUSION/);
});
