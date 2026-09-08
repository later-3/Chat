import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openProject } from "../src/projects/registry.ts";
import { listChatSessions, readChatSession } from "../src/session-read-model.ts";
import { SessionOwnerResolutionError } from "../src/session-owner.ts";

function writeState(chatHome, projectAgents) {
  const runtimeDir = path.join(chatHome, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "long-agent-state.json"), JSON.stringify({
    schemaVersion: 2,
    cursors: {},
    projectAgents,
    bindings: [],
  }));
}

test("Session list and detail project the same Project-scoped owner fact", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-owner-"));
  const chatHome = path.join(root, "home");
  const firstWorkspace = path.join(root, "first");
  const secondWorkspace = path.join(root, "second");
  fs.mkdirSync(firstWorkspace);
  fs.mkdirSync(secondWorkspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const firstProject = await openProject({
    path: firstWorkspace,
    chatHome,
    id: "owner-first",
    name: "Owner First",
  });
  const secondProject = await openProject({
    path: secondWorkspace,
    chatHome,
    id: "owner-second",
    name: "Owner Second",
  });
  const ordinary = SessionManager.create(firstWorkspace, firstProject.sessionDir);
  ordinary.appendMessage({ role: "user", content: "ordinary", timestamp: Date.now() });
  ordinary.flush();
  const longAgent = SessionManager.create(firstWorkspace, firstProject.sessionDir);
  longAgent.appendMessage({ role: "user", content: "long agent", timestamp: Date.now() });
  longAgent.flush();
  const now = "2026-09-06T00:00:00.000Z";
  writeState(chatHome, [{
    id: "project-long-agent:owner-first:nexus",
    projectId: firstProject.projectId,
    longAgentId: "nexus",
    primarySessionId: longAgent.getSessionId(),
    status: "active",
    createdAt: now,
    updatedAt: now,
  }]);

  const firstList = await listChatSessions(firstProject.projectId, chatHome);
  assert.deepEqual(firstList.find((session) => session.id === ordinary.getSessionId())?.owner, {
    type: "ordinary",
  });
  const listOwner = firstList.find((session) => session.id === longAgent.getSessionId())?.owner;
  assert.deepEqual(listOwner, {
    type: "long-agent",
    longAgentId: "nexus",
    projectLongAgentId: "project-long-agent:owner-first:nexus",
  });
  const firstDetail = await readChatSession(
    longAgent.getSessionId(),
    undefined,
    {},
    firstProject.projectId,
    chatHome,
  );
  assert.deepEqual(firstDetail.session.owner, listOwner);

  // A copied Session ID in another Project must not inherit the first Project's owner.
  fs.copyFileSync(
    longAgent.getSessionFile(),
    path.join(secondProject.sessionDir, path.basename(longAgent.getSessionFile())),
  );
  const secondList = await listChatSessions(secondProject.projectId, chatHome);
  assert.deepEqual(secondList.find((session) => session.id === longAgent.getSessionId())?.owner, {
    type: "ordinary",
  });
  const secondDetail = await readChatSession(
    longAgent.getSessionId(),
    undefined,
    {},
    secondProject.projectId,
    chatHome,
  );
  assert.deepEqual(secondDetail.session.owner, { type: "ordinary" });
});

test("invalid Long Agent state fails Session ownership closed with a safe error", { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-session-owner-invalid-"));
  const chatHome = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = await openProject({
    path: workspace,
    chatHome,
    id: "owner-invalid",
    name: "Owner Invalid",
  });
  const manager = SessionManager.create(workspace, project.sessionDir);
  manager.flush();
  fs.writeFileSync(path.join(chatHome, "runtime", "long-agent-state.json"), "not-json\n");

  for (const read of [
    () => listChatSessions(project.projectId, chatHome),
    () => readChatSession(manager.getSessionId(), undefined, {}, project.projectId, chatHome),
  ]) {
    await assert.rejects(read, (error) => {
      assert.equal(error instanceof SessionOwnerResolutionError, true);
      assert.equal(error.message, "无法读取Session归属状态");
      assert.equal(error.message.includes(root), false);
      return true;
    });
  }
});
