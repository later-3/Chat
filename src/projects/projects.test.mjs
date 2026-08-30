import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createProjectManifest,
  listProjects,
  openProject,
  resolveProjectContext,
} from "./registry.ts";
import { createChatExecutionContext } from "./context.ts";

test("Project Manifest, Registry and data paths use stable projectId", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-projects-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");
  const project = path.join(root, "repos", "content-lab");
  fs.mkdirSync(path.join(project, "nested"), { recursive: true });

  await createProjectManifest({
    root: project,
    id: "content-lab",
    name: "Content Lab",
    description: "内容项目",
  });
  const opened = await openProject({ path: path.join(project, "nested"), chatHome });

  assert.equal(opened.projectId, "content-lab");
  assert.equal(opened.projectRoot, fs.realpathSync(project));
  assert.equal(opened.sessionDir, path.join(chatHome, "projects", "content-lab", "sessions"));
  assert.equal(opened.memoryDir, path.join(chatHome, "projects", "content-lab", "memory"));
  assert.equal(opened.projectConfigPath, path.join(fs.realpathSync(project), ".chat", "config.json"));
  assert.equal((await listProjects(chatHome))[0]?.available, true);

  const context = await createChatExecutionContext({
    projectId: "content-lab",
    chatHome,
    sessionId: "session-1",
    workflowId: "memory",
  });
  assert.equal(context.personalId, "later");
  assert.equal(context.sessionId, "session-1");
  assert.equal((await resolveProjectContext("content-lab", chatHome)).projectRoot, opened.projectRoot);
});

test("opening an uninitialized directory requires an explicit create decision", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-project-create-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "new-project");
  fs.mkdirSync(project, { recursive: true });

  await assert.rejects(
    openProject({ path: project, chatHome: path.join(root, "home") }),
    /尚未初始化/,
  );
  const opened = await openProject({
    path: project,
    chatHome: path.join(root, "home"),
    createIfMissing: true,
    id: "new-project",
    name: "New Project",
  });
  assert.equal(opened.projectId, "new-project");
});

test("the same registered project survives a local path move", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-project-move-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  fs.mkdirSync(first, { recursive: true });
  await openProject({
    path: first,
    chatHome,
    createIfMissing: true,
    id: "moving-project",
    name: "Moving Project",
  });
  fs.renameSync(first, second);
  await openProject({ path: second, chatHome });
  const resolved = await resolveProjectContext("moving-project", chatHome);
  assert.equal(resolved.projectRoot, fs.realpathSync(second));
  assert.equal(resolved.memoryDir, path.join(chatHome, "projects", "moving-project", "memory"));
});
