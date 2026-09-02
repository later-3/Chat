import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeProjectChatConfig } from "./chat-config.ts";
import { openProject } from "./projects/registry.ts";
import {
  listRemovedChatSessions,
  purgeRemovedChatSession,
  removeChatSession,
  restoreRemovedChatSession,
} from "./session-removal.ts";
import { SessionLifecycleError } from "./session-errors.ts";
import { listActiveSessionFiles, removedSessionDirectory } from "./session-files.ts";
import { readChatSession } from "./session-read-model.ts";
import { requireActiveChatSessionFile } from "./session-state.ts";
import { bindPlanningExecutionRun } from "./workflows/planning-execution/review-state.ts";

async function fixture(t, id = "session-removal") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-removal-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const chatHome = path.join(base, "chat-home");
  const project = await openProject({ path: workspace, chatHome, id, name: "Session Removal" });
  const manager = SessionManager.create(workspace, project.sessionDir);
  manager.appendMessage({ role: "user", content: "remove this session", timestamp: Date.now() });
  manager.flush();
  return { base, workspace, chatHome, project, manager };
}

test("Session removal moves the Pi JSONL below sessions/removed and restore reverses it", async (t) => {
  const { chatHome, project, manager } = await fixture(t);
  const sessionId = manager.getSessionId();
  const originalFile = manager.getSessionFile();
  const removedAt = new Date("2026-09-02T00:00:00.000Z");

  const removed = await removeChatSession(project.projectId, sessionId, chatHome, removedAt);
  assert.equal(removed.id, sessionId);
  assert.equal(removed.projectId, project.projectId);
  assert.equal(removed.removedAt, removedAt.toISOString());
  assert.equal(removed.purgeAt, "2026-10-02T00:00:00.000Z");
  assert.equal(fs.existsSync(originalFile), false);
  assert.equal(fs.existsSync(path.join(removedSessionDirectory(project), path.basename(originalFile))), true);
  assert.deepEqual(await listActiveSessionFiles(project), []);

  const listing = await listRemovedChatSessions(project.projectId, chatHome, removedAt);
  assert.equal(listing.retentionDays, 30);
  assert.deepEqual(listing.sessions.map((session) => session.id), [sessionId]);

  assert.deepEqual(
    await restoreRemovedChatSession(project.projectId, sessionId, chatHome, removedAt),
    { sessionId, state: "active" },
  );
  assert.equal(fs.existsSync(originalFile), true);
  assert.deepEqual((await listActiveSessionFiles(project)).map((session) => session.id), [sessionId]);
  assert.deepEqual((await listRemovedChatSessions(project.projectId, chatHome, removedAt)).sessions, []);
});

test("per-Project retention lazily purges expired removed Sessions and keeps a tombstone", async (t) => {
  const { chatHome, project, manager } = await fixture(t, "session-retention");
  await writeProjectChatConfig(project.projectId, {
    schemaVersion: 1,
    sessions: { removedRetentionDays: 1 },
  }, chatHome);
  const sessionId = manager.getSessionId();
  await removeChatSession(project.projectId, sessionId, chatHome, new Date("2026-09-01T00:00:00.000Z"));

  const listing = await listRemovedChatSessions(
    project.projectId,
    chatHome,
    new Date("2026-09-02T00:00:00.001Z"),
  );
  assert.deepEqual(listing.sessions, []);
  assert.equal(listing.retentionDays, 1);
  await assert.rejects(
    restoreRemovedChatSession(project.projectId, sessionId, chatHome),
    (error) => error instanceof SessionLifecycleError && error.code === "SESSION_PURGED",
  );
});

test("permanent purge is idempotent and removes only the Session JSONL", async (t) => {
  const { chatHome, project, manager } = await fixture(t, "session-purge");
  const sessionId = manager.getSessionId();
  await removeChatSession(project.projectId, sessionId, chatHome);
  const first = await purgeRemovedChatSession(project.projectId, sessionId, chatHome, new Date("2026-09-02T01:00:00.000Z"));
  const second = await purgeRemovedChatSession(project.projectId, sessionId, chatHome, new Date("2026-09-03T01:00:00.000Z"));
  assert.deepEqual(second, first);
  assert.equal(fs.existsSync(path.join(removedSessionDirectory(project), path.basename(manager.getSessionFile()))), false);
  assert.equal(fs.existsSync(path.join(removedSessionDirectory(project), "index.json")), true);
});

test("Session content access distinguishes a removed Session from a permanently deleted one", async (t) => {
  const { chatHome, project, manager } = await fixture(t, "session-content-state");
  const sessionId = manager.getSessionId();
  await removeChatSession(project.projectId, sessionId, chatHome);

  await assert.rejects(
    readChatSession(sessionId, undefined, {}, project.projectId, chatHome),
    (error) => error instanceof SessionLifecycleError && error.code === "SESSION_REMOVED",
  );

  await purgeRemovedChatSession(project.projectId, sessionId, chatHome);
  await assert.rejects(
    readChatSession(sessionId, undefined, {}, project.projectId, chatHome),
    (error) => error instanceof SessionLifecycleError && error.code === "SESSION_PURGED",
  );
});

test("a non-terminal Planning Run blocks Session removal without moving the file", async (t) => {
  const { chatHome, project, manager } = await fixture(t, "session-busy");
  const sessionId = manager.getSessionId();
  await bindPlanningExecutionRun({
    projectDataDir: project.projectDataDir,
    projectId: project.projectId,
    workflowInvocationId: "busy-invocation",
    runId: "busy-run",
    sessionId,
  });
  await assert.rejects(
    removeChatSession(project.projectId, sessionId, chatHome),
    (error) => error instanceof SessionLifecycleError && error.code === "SESSION_BUSY",
  );
  assert.equal(fs.existsSync(manager.getSessionFile()), true);
});

test("an interrupted prepared move is completed from index.json on the next read", async (t) => {
  const { chatHome, project, manager } = await fixture(t, "session-recovery");
  const sessionId = manager.getSessionId();
  await removeChatSession(project.projectId, sessionId, chatHome, new Date("2026-09-02T00:00:00.000Z"));
  const removedDir = removedSessionDirectory(project);
  const indexPath = path.join(removedDir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const record = index.sessions[sessionId];
  fs.renameSync(path.join(removedDir, record.fileName), path.join(project.sessionDir, record.fileName));
  index.revision += 1;
  index.sessions = {};
  index.pendingOperation = {
    operationId: "interrupted-remove",
    type: "remove",
    record,
    startedAt: "2026-09-02T00:00:01.000Z",
  };
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  const recovered = await listRemovedChatSessions(project.projectId, chatHome, new Date("2026-09-02T00:00:02.000Z"));
  assert.deepEqual(recovered.sessions.map((session) => session.id), [sessionId]);
  assert.equal(fs.existsSync(path.join(project.sessionDir, record.fileName)), false);
  assert.equal(fs.existsSync(path.join(removedDir, record.fileName)), true);
});

test("an interrupted restore is visible to the same request that recovers it", async (t) => {
  const { chatHome, project, manager } = await fixture(t, "session-restore-recovery");
  const sessionId = manager.getSessionId();
  await removeChatSession(project.projectId, sessionId, chatHome);
  const removedDir = removedSessionDirectory(project);
  const indexPath = path.join(removedDir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const record = index.sessions[sessionId];
  index.revision += 1;
  index.sessions = {};
  index.pendingOperation = {
    operationId: "interrupted-restore",
    type: "restore",
    record,
    startedAt: "2026-09-02T00:00:01.000Z",
  };
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  const recovered = await requireActiveChatSessionFile(project, sessionId);
  assert.equal(recovered.id, sessionId);
  assert.equal(fs.existsSync(manager.getSessionFile()), true);
  assert.equal(fs.existsSync(path.join(removedDir, record.fileName)), false);
});
