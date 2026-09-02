import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openProject } from "./projects/registry.ts";
import { renameChatSession } from "./session-name.ts";

test("Session rename reuses Pi session_info in the Project active directory", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-name-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const chatHome = path.join(base, "chat-home");
  const project = await openProject({ path: workspace, chatHome, id: "session-name", name: "Session Name" });
  const manager = SessionManager.create(workspace, project.sessionDir);
  manager.appendMessage({ role: "user", content: "rename me", timestamp: Date.now() });
  manager.flush();

  assert.deepEqual(await renameChatSession(project.projectId, manager.getSessionId(), "Renamed\nSession", chatHome), {
    sessionId: manager.getSessionId(),
    name: "Renamed Session",
  });
  const reopened = SessionManager.open(manager.getSessionFile(), project.sessionDir);
  assert.equal(reopened.getSessionName(), "Renamed Session");
});
