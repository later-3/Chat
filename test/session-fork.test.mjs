import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openProject } from "../src/projects/registry.ts";
import { forkChatSession, parseForkSessionInput } from "../src/session-fork.ts";
import { readSessionTranscript } from "../src/session-transcript.ts";
import { listChatSessions, readChatSession } from "../src/session-read-model.ts";
import { beginSessionExecution, endSessionExecution } from "../src/workflows/execution-registry.ts";
import { collectPendingPlanReview, appendPlanReview } from "../src/workflows/planning-execution/review-state.ts";
import { collectChatSubsessionRelation, collectChatWorkflowCalls } from "../src/workflows/workflow-call-state.ts";
import { removeChatSession, purgeRemovedChatSession } from "../src/session-removal.ts";

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-fork-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace"); fs.mkdirSync(workspace);
  const chatHome = path.join(base, "home");
  const project = await openProject({ path: workspace, chatHome, id: "fork-project", name: "Fork" });
  const manager = SessionManager.create(workspace, project.sessionDir);
  const first = manager.appendMessage({ role: "user", content: "first question", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }], model: "faux", provider: "faux", api: "openai-completions", timestamp: 2, stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  appendPlanReview(manager, { workflowId: "planning-execution", workflowInvocationId: "source-invocation", plan: "old pending plan", readiness: "ready_for_review", blockingQuestions: [] });
  const second = manager.appendMessage({ role: "user", content: "second question", timestamp: 3 });
  manager.flush();
  return { base, workspace, chatHome, project, manager, first, second };
}

test("Fork publishes a new Web-visible Pi Session, preserves source and replays the same request", async (t) => {
  const { project, chatHome, manager, second } = await fixture(t);
  const before = fs.readFileSync(manager.getSessionFile(), "utf8");
  const input = { projectId: project.projectId, entryId: second, requestId: randomUUID() };
  const [fork, replay] = await Promise.all([forkChatSession(manager.getSessionId(), input, chatHome), forkChatSession(manager.getSessionId(), input, chatHome)]);
  assert.deepEqual(fork, replay);
  assert.equal(fork.selectedText, "second question");
  assert.notEqual(fork.sessionId, manager.getSessionId());
  const list = await listChatSessions(project.projectId, chatHome);
  assert.equal(list.length, 2);
  const childInfo = list.find((session) => session.id === fork.sessionId);
  assert.equal(childInfo.parentSessionId, manager.getSessionId());
  const child = SessionManager.open(childInfo.path, project.sessionDir);
  assert.equal(child.getHeader().parentSession, manager.getSessionFile());
  assert.equal(collectPendingPlanReview(child.getEntries()), undefined);
  assert.equal(child.getEntries().some((e) => e.type === "custom" && e.customType === "chat.plan_review"), true, "inherited review is still readable history");
  assert.deepEqual(collectChatWorkflowCalls(child.getEntries()), []);
  assert.equal(collectChatSubsessionRelation(child.getEntries()), undefined);
  const web = await readChatSession(fork.sessionId, undefined, {}, project.projectId, chatHome);
  assert.equal(web.context.messages.some((m) => m.role === "assistant"), true);
  assert.equal(web.activeWorkflowRun, undefined);
  assert.equal(fs.readFileSync(manager.getSessionFile(), "utf8"), before);
  await assert.rejects(forkChatSession(manager.getSessionId(), { ...input, entryId: "different" }, chatHome), /requestId/);
});

test("Fork before the first user input creates a durable empty child and honors busy/project boundaries", async (t) => {
  const { project, chatHome, manager, first, second, base } = await fixture(t);
  const input = { projectId: project.projectId, entryId: first, requestId: randomUUID() };
  beginSessionExecution(manager.getSessionId(), "minimal-pi-coding-agent", "busy");
  await assert.rejects(forkChatSession(manager.getSessionId(), input, chatHome), /正在运行/);
  endSessionExecution(manager.getSessionId(), "busy");
  const fork = await forkChatSession(manager.getSessionId(), input, chatHome);
  const transcript = await readSessionTranscript({ projectId: project.projectId, sessionId: fork.sessionId }, chatHome);
  assert.equal(transcript.entries.filter((e) => e.type === "message").length, 0);
  const otherRoot = path.join(base, "other"); fs.mkdirSync(otherRoot);
  const other = await openProject({ path: otherRoot, chatHome, id: "other", name: "Other" });
  await assert.rejects(forkChatSession(manager.getSessionId(), { ...input, projectId: other.projectId, entryId: second }, chatHome));
  const assistantId = manager.getEntries().find((e) => e.type === "message" && e.message.role === "assistant").id;
  await assert.rejects(forkChatSession(manager.getSessionId(), { ...input, entryId: assistantId, requestId: randomUUID() }, chatHome), /用户消息/);
});

test("Transcript pages include pre-compaction originals and branches without changing execution context", async (t) => {
  const { project, chatHome, manager, first, second } = await fixture(t);
  manager.appendCompaction("summary only", second, 100);
  manager.appendMessage({ role: "user", content: "after compaction", timestamp: 4 }); manager.flush();
  const input = { projectId: project.projectId, sessionId: manager.getSessionId(), limit: 2 };
  const messages = []; let cursor;
  do {
    const page = await readSessionTranscript({ ...input, ...(cursor ? { cursor } : {}) }, chatHome);
    messages.push(...page.entries); cursor = page.nextCursor;
  } while (cursor);
  assert.ok(messages.find((e) => e.id === first && e.message.content === "first question"));
  assert.ok(messages.find((e) => e.label?.includes("summary only")));
  const leaf = manager.getLeafId();
  const branch = await readSessionTranscript({ ...input, leafId: first }, chatHome);
  assert.equal(branch.entries.length, 1);
  assert.equal(SessionManager.open(manager.getSessionFile(), project.sessionDir).getLeafId(), leaf);
  await assert.rejects(readSessionTranscript({ ...input, cursor: "missing" }, chatHome), /游标/);
  await assert.rejects(readSessionTranscript({ ...input, limit: 501 }, chatHome), /limit/);
});

test("Fork request rejects extra fields and filesystem-like identifiers", () => {
  const valid = { projectId: "p", entryId: "abcd", requestId: randomUUID() };
  assert.deepEqual(parseForkSessionInput(valid), valid);
  for (const value of [{ ...valid, sessionFile: "/private" }, { ...valid, entryId: "../../x" }, { ...valid, requestId: "../x" }, null]) assert.throws(() => parseForkSessionInput(value));
});

test("Fork resumes prepared publication and late retries cannot resurrect removed or purged children", async (t) => {
  const { project, chatHome, manager, second } = await fixture(t);
  const input = { projectId: project.projectId, entryId: second, requestId: randomUUID() };
  const child = await forkChatSession(manager.getSessionId(), input, chatHome);
  const root = path.join(project.projectDataDir, "session-operations");
  const operation = JSON.parse(fs.readFileSync(path.join(root, `fork-${input.requestId}.json`), "utf8"));
  const destination = path.join(project.sessionDir, `fork-${input.requestId}.jsonl`);
  fs.mkdirSync(path.join(root, operation.directory));
  fs.renameSync(destination, path.join(root, operation.directory, operation.file));
  assert.deepEqual(await forkChatSession(manager.getSessionId(), input, chatHome), child);
  assert.equal(fs.existsSync(path.join(root, operation.directory)), false);
  await removeChatSession(project.projectId, child.sessionId, chatHome);
  await assert.rejects(forkChatSession(manager.getSessionId(), input, chatHome), (error) => error.code === "SESSION_REMOVED");
  await purgeRemovedChatSession(project.projectId, child.sessionId, chatHome);
  await assert.rejects(forkChatSession(manager.getSessionId(), input, chatHome), (error) => error.code === "SESSION_PURGED");
  assert.equal((await listChatSessions(project.projectId, chatHome)).length, 1);
});
