import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openProject } from "../../src/projects/registry.ts";
import { readChatSession } from "../../src/session-read-model.ts";
import { ensureProjectLongAgent } from "../../src/long-agents/project-agent.ts";
import { readLongAgentRegistry, writeLongAgentRegistry, readLongAgentState } from "../../src/long-agents/storage.ts";
import { fixture } from "./daily-fixture.mjs";
import { getChatHomePaths } from "../../src/chat-home.ts";

/** A CHAT_HOME with one Friend (the daily fixture) — the same shape the browser opens. */
async function chatHomeFixture(t) {
  const f = await fixture(t);
  return f.home;
}

/** Counts Pi's full-directory scans: `listAll` reads EVERY session body, so the open path must not use it. */
function countingListAll() {
  const original = SessionManager.listAll;
  const calls = [];
  SessionManager.listAll = async (...args) => {
    calls.push(args);
    return original.apply(SessionManager, args);
  };
  return {
    calls,
    restore: () => { SessionManager.listAll = original; },
  };
}

/** One small target Session plus several unrelated sessions with large histories. */
async function projectWithNoisyNeighbours(home) {
  const base = fs.mkdtempSync(path.join(home, "noise-"));
  fs.writeFileSync(path.join(base, "AGENTS.md"), "noise");
  const project = await openProject({ path: base, chatHome: home, id: "noise", name: "Noise" });
  const big = "x".repeat(4_000);
  for (let index = 0; index < 6; index += 1) {
    const manager = SessionManager.create(project.cwd, project.sessionDir);
    for (let turn = 0; turn < 40; turn += 1) manager.appendMessage({ role: "user", content: [{ type: "text", text: `${big} noise ${String(index)}-${String(turn)}` }] });
    manager.flush();
  }
  const target = SessionManager.create(project.cwd, project.sessionDir);
  target.appendMessage({ role: "user", content: [{ type: "text", text: "只读这一条" }] });
  target.flush();
  return { project, targetSessionId: target.getSessionId() };
}

test("opening one Session never scans (or reads) unrelated Session bodies", async (t) => {
  const home = await chatHomeFixture(t);
  const { project, targetSessionId } = await projectWithNoisyNeighbours(home);
  const counter = countingListAll();
  t.after(counter.restore);
  counter.calls.length = 0;

  const session = await readChatSession(targetSessionId, undefined, {}, project.projectId, home, { kind: "owner" });

  assert.equal(session.sessionId, targetSessionId);
  assert.equal(session.context.messages.length, 1);
  assert.deepEqual(counter.calls, [], "the open path must resolve the exact Session, not listAll every body");
});

test("reopening today's Friend does not rewrite the Long Agent state", async (t) => {
  const home = await chatHomeFixture(t);
  const registry = await readLongAgentRegistry(home);
  const agent = registry.agents[0];
  const input = { chatHome: home, projectId: agent.id, agent, requestedSessionId: undefined };

  const first = await ensureProjectLongAgent(input);
  const statePath = getChatHomePaths(home).longAgentStatePath;
  const afterFirst = fs.readFileSync(statePath, "utf8");
  const before = fs.statSync(statePath).mtimeMs;

  const second = await ensureProjectLongAgent(input);

  assert.equal(second.projectAgent.primarySessionId, first.projectAgent.primarySessionId);
  assert.equal(second.isNewSession, false);
  assert.equal(fs.readFileSync(statePath, "utf8"), afterFirst, "an unchanged day must not rewrite the state file");
  assert.equal(fs.statSync(statePath).mtimeMs, before, "an unchanged day must not bump the state file mtime");
  // The binding is still the same one the first call recorded.
  const state = await readLongAgentState(home);
  assert.equal(state.projectAgents.find((entry) => entry.longAgentId === agent.id)?.primarySessionId, first.projectAgent.primarySessionId);
});

test("workflow-call statistics skip the Session scan when the root has no child calls", async (t) => {
  const home = await chatHomeFixture(t);
  const { project, targetSessionId } = await projectWithNoisyNeighbours(home);
  const counter = countingListAll();
  t.after(counter.restore);
  counter.calls.length = 0;

  await readChatSession(targetSessionId, undefined, {}, project.projectId, home, { kind: "owner" });

  assert.deepEqual(counter.calls, [], "a root without delegated calls must short-circuit before listAll");
});

// keep the registry import used: the fixture guarantees exactly one Friend to open
void writeLongAgentRegistry;

test("a Session with a finished child call still opens without scanning the directory", async (t) => {
  const home = await chatHomeFixture(t);
  const { project, targetSessionId } = await projectWithNoisyNeighbours(home);
  // A finished delegated call: its child Session exists and is reachable by the recorded identity.
  const child = SessionManager.create(project.cwd, project.sessionDir);
  child.appendMessage({ role: "user", content: [{ type: "text", text: "子会话的一轮" }] });
  child.flush();
  const rootPath = path.join(project.sessionDir, fs.readdirSync(project.sessionDir).find((name) => name.endsWith(`_${targetSessionId}.jsonl`)));
  const root = SessionManager.open(rootPath, project.sessionDir);
  root.appendCustomEntry("chat.workflow_call", {
    schemaVersion: 1, callId: "call-done", toolCallId: "tool-call-done",
    parent: { sessionId: targetSessionId, workflowId: "minimal-pi-coding-agent", workflowInvocationId: "parent-inv", stageId: "execute", agentId: "pi-coding-agent" },
    child: { sessionId: child.getSessionId(), workflowId: "minimal-pi-coding-agent", workflowInvocationId: "child-inv", runId: "run-child" },
    status: "completed", startedAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:01.000Z",
    finishedAt: "2026-09-26T00:00:01.000Z", durationMs: 1_000,
  });
  root.flush();

  const counter = countingListAll();
  t.after(counter.restore);
  counter.calls.length = 0;

  const session = await readChatSession(targetSessionId, undefined, {}, project.projectId, home, { kind: "owner" });

  assert.deepEqual(counter.calls, [], "a call-bearing Session must not trigger a full-directory scan");
  assert.equal(session.workflowCallStatistics.direct.total, 1);
  assert.equal(session.workflowCallStatistics.direct.completed, 1);
  assert.equal(session.workflowCallTree.length, 1, "the reachable child stays in the tree");
  assert.equal(session.workflowCallTree[0].call.status, "completed");
  assert.equal(session.workflowCallTree[0].call.child.sessionId, child.getSessionId());
});
