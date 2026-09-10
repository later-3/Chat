import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRouter } from "nitro/h3";
import { MemoryRepository } from "../../src/memory/repository.ts";
import { ensureLongAgentShareProject, openProject, resolveProjectContext } from "../../src/projects/registry.ts";
import treeHandler from "../../src/routes/api/memories/tree.get.ts";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-memory-tree-"));
  const chatHome = path.join(base, ".chat");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, chatHome };
}

test("memory tree lists Chat system, Project, and Long Agent scopes with counts", async (t) => {
  const { base, chatHome } = fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = chatHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  const daily = await ensureLongAgentShareProject(chatHome);
  fs.mkdirSync(path.join(base, "workspace"));
  const project = await openProject({
    path: path.join(base, "workspace"), chatHome, id: "tree-project", name: "Tree Project",
  });

  // 个人 2 条（1 条归档不计入），项目 1 条。
  const personal = new MemoryRepository(path.join(daily.chatHome, "memory", "personal", "catalog.db"));
  personal.create({ text: "personal fact a", kind: "fact", scope: "personal" });
  const archived = personal.create({ text: "personal archived", kind: "fact", scope: "personal" });
  personal.delete(archived.id);
  const projectRepository = new MemoryRepository(path.join(project.memoryDir, "catalog.db"));
  projectRepository.create({ text: "project fact", kind: "fact", scope: "project", projectId: "tree-project" });

  const router = createRouter();
  router.get("/api/memories/tree", treeHandler);
  const response = await router.fetch(new Request("http://chat.test/api/memories/tree"));
  assert.equal(response.status, 200);
  const tree = await response.json();

  assert.equal(tree.schemaVersion, 1);
  assert.equal(tree.personal.total, 1);
  const own = tree.projects.find((entry) => entry.projectId === "tree-project");
  assert.ok(own);
  assert.equal(own.total, 1);
  // 记忆只有三类：共享 daily 与 Long Agent 日常项目不得以“项目”形式出现。
  assert.equal(tree.projects.some((entry) => entry.projectId === "longagentshare"), false,
    "the shared Long Agent space must not appear as a user Project");
  assert.equal(tree.projects.some((entry) => entry.projectId.startsWith("daily-")), false,
    "Long Agent daily Projects must not appear as user Projects");
  assert.ok(Array.isArray(tree.longAgents));
});

test("memory tree counts only the requested Project scope", async (t) => {
  const { base, chatHome } = fixture(t);
  const previousHome = process.env.CHAT_HOME;
  process.env.CHAT_HOME = chatHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousHome;
  });
  const daily = await ensureLongAgentShareProject(chatHome);
  const dailyRepository = new MemoryRepository(path.join(daily.chatHome, "memory", "personal", "catalog.db"));
  dailyRepository.create({ text: "shared personal", kind: "fact", scope: "personal" });

  const router = createRouter();
  router.get("/api/memories/tree", treeHandler);
  const tree = await (await router.fetch(new Request("http://chat.test/api/memories/tree"))).json();
  assert.equal(tree.personal.total, 1);
  // project 计数不包含个人记忆。
  for (const entry of tree.projects) {
    assert.equal(entry.total, 0);
  }
  void resolveProjectContext;
});

test("system Long Agent containers are recognized consistently", async () => {
  const { isSystemLongAgentProjectId } = await import("../../src/projects/system-projects.ts");
  const agents = new Set(["nexus", "coder-muse"]);
  assert.equal(isSystemLongAgentProjectId("longagentshare", agents), true);
  assert.equal(isSystemLongAgentProjectId("longagentshare", agents), true);
  assert.equal(isSystemLongAgentProjectId("daily-nexus", agents), true);
  assert.equal(isSystemLongAgentProjectId("daily-coder-muse", agents), true);
  // 普通项目与“看起来像但不属于任何已登记 Agent”的 id 不算系统容器。
  assert.equal(isSystemLongAgentProjectId("chat", agents), false);
  assert.equal(isSystemLongAgentProjectId("ziji-content-lab", agents), false);
  assert.equal(isSystemLongAgentProjectId("daily-unknown-agent", agents), false);
});
