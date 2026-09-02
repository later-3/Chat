import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openProject } from "./projects/registry.ts";
import {
  listActiveSessionFiles,
  removedSessionDirectory,
  requireActiveSessionFile,
} from "./session-files.ts";

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
