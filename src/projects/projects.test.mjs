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
  fs.mkdirSync(project, { recursive: true });

  await createProjectManifest({
    root: project,
    id: "content-lab",
    name: "Content Lab",
    description: "内容项目",
  });
  const opened = await openProject({ path: project, chatHome });

  assert.equal(opened.projectId, "content-lab");
  assert.equal(opened.projectRoot, fs.realpathSync(project));
  assert.equal(opened.sessionDir, path.join(chatHome, "projects", "content-lab", "sessions"));
  assert.equal(opened.memoryDir, path.join(chatHome, "projects", "content-lab", "memory"));
  assert.equal("workflowDataDir" in opened, false);
  assert.equal(opened.workflowsDir, path.join(chatHome, "projects", "content-lab", "workflows"));
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

test("the directory selected by the user is the exact Project root even below another Project", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-project-create-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");
  const parent = path.join(root, "parent");
  const child = path.join(parent, "nested", "child");
  fs.mkdirSync(child, { recursive: true });

  const openedParent = await openProject({ path: parent, chatHome, id: "parent", name: "Parent" });
  const openedChild = await openProject({ path: child, chatHome });

  assert.equal(openedParent.projectRoot, fs.realpathSync(parent));
  assert.equal(openedChild.projectRoot, fs.realpathSync(child));
  assert.notEqual(openedChild.projectId, openedParent.projectId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(child, ".chat", "project.json"), "utf8")).id, openedChild.projectId);
  assert.deepEqual((await listProjects(chatHome)).map((project) => project.path).sort(), [
    fs.realpathSync(child),
    fs.realpathSync(parent),
  ].sort());
});

test("first open initializes the selected directory with a unique stable Project id", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-project-unique-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");
  const first = path.join(root, "one", "app");
  const second = path.join(root, "two", "app");
  const concurrent = path.join(root, "concurrent", "app");
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  fs.mkdirSync(concurrent, { recursive: true });

  const openedFirst = await openProject({ path: first, chatHome });
  const openedSecond = await openProject({ path: second, chatHome });
  const reopenedFirst = await openProject({ path: first, chatHome });
  const [concurrentFirst, concurrentSecond] = await Promise.all([
    openProject({ path: concurrent, chatHome }),
    openProject({ path: concurrent, chatHome }),
  ]);

  assert.match(openedFirst.projectId, /^app-[a-f0-9]{8}$/);
  assert.match(openedSecond.projectId, /^app-[a-f0-9]{8}$/);
  assert.notEqual(openedFirst.projectId, openedSecond.projectId);
  assert.equal(reopenedFirst.projectId, openedFirst.projectId);
  assert.equal(concurrentFirst.projectId, concurrentSecond.projectId);
  assert.equal((await listProjects(chatHome)).length, 3);
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
    id: "moving-project",
    name: "Moving Project",
  });
  fs.renameSync(first, second);
  await openProject({ path: second, chatHome });
  const resolved = await resolveProjectContext("moving-project", chatHome);
  assert.equal(resolved.projectRoot, fs.realpathSync(second));
  assert.equal(resolved.memoryDir, path.join(chatHome, "projects", "moving-project", "memory"));
});

test("opening a legacy project data directory backfills the workflows directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-project-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");
  const project = path.join(root, "repos", "legacy");
  fs.mkdirSync(project, { recursive: true });
  const opened = await openProject({ path: project, chatHome });

  fs.rmSync(path.join(chatHome, "projects", opened.projectId, "workflows"), { recursive: true, force: true });
  const resolved = await resolveProjectContext(opened.projectId, chatHome);
  assert.equal(
    fs.statSync(path.join(chatHome, "projects", opened.projectId, "workflows")).isDirectory(),
    true,
  );
  assert.equal(resolved.workflowsDir, path.join(chatHome, "projects", opened.projectId, "workflows"));
});
