import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openProject } from "../src/projects/registry.ts";
import {
  listActiveSessionFiles,
  removedSessionDirectory,
  requireActiveSessionFile,
} from "../src/session-files.ts";

test("active Session lookup uses Pi and ignores the nested removed directory", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-files-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const project = await openProject({
    path: workspace,
    chatHome: path.join(base, "chat-home"),
    id: "session-files",
    name: "Session Files",
  });

  const active = SessionManager.create(workspace, project.sessionDir);
  active.appendMessage({ role: "user", content: "active", timestamp: Date.now() });
  active.flush();

  const removedDir = removedSessionDirectory(project);
  fs.mkdirSync(removedDir, { recursive: true });
  const removed = SessionManager.create(workspace, removedDir);
  removed.appendMessage({ role: "user", content: "removed", timestamp: Date.now() });
  removed.flush();

  const listed = await listActiveSessionFiles(project);
  assert.deepEqual(listed.map((session) => session.id), [active.getSessionId()]);
  assert.equal((await requireActiveSessionFile(project, active.getSessionId())).path, active.getSessionFile());
  await assert.rejects(
    requireActiveSessionFile(project, removed.getSessionId()),
    new RegExp(`找不到Session: ${removed.getSessionId()}`),
  );
});

test("summary revalidation reads changed native files only and observes rename/removal/external append", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-summary-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = { sessionDir: path.join(base, "sessions") };
  const a = SessionManager.create(base, project.sessionDir);
  const b = SessionManager.create(base, project.sessionDir);
  a.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: Date.now() }); a.flush();
  b.appendMessage({ role: "user", content: "other".repeat(200) + "search tail", timestamp: Date.now() }); b.flush();
  const original = SessionManager.open;
  let opens = 0;
  SessionManager.open = (...args) => { opens++; return original.apply(SessionManager, args); };
  t.after(() => { SessionManager.open = original; });
  let list = await listActiveSessionFiles(project);
  assert.equal(opens, 2);
  assert.match(list.find(item => item.id === b.getSessionId()).firstMessage, /search tail$/, "sidebar search must retain long first messages");
  assert.equal(list.find(item => item.id === a.getSessionId()).firstMessage, "first answer");
  await listActiveSessionFiles(project);
  assert.equal(opens, 2, "unchanged files need no JSONL parsing");
  a.appendMessage({ role: "user", content: "external append", timestamp: Date.now() }); a.appendSessionInfo("renamed"); a.flush();
  list = await listActiveSessionFiles(project);
  assert.equal(opens, 3, "only changed Session parsed");
  assert.equal(list.find(item => item.id === a.getSessionId()).name, "renamed");
  assert.equal(list.find(item => item.id === a.getSessionId()).messageCount, 2);
  fs.unlinkSync(b.getSessionFile());
  assert.deepEqual((await listActiveSessionFiles(project)).map(item => item.id), [a.getSessionId()]);
});
