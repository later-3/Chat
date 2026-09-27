import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureAgentHomeProject, openProject, resolveProjectContext } from "../../src/projects/registry.ts";
import { createRouter } from "nitro/h3";
import listHandler from "../../src/routes/api/memories/index.get.ts";
import healthHandler from "../../src/routes/api/memories/health.get.ts";
import { MemoryStoreManager } from "../../src/memory/manager.ts";
import { MemoryRepository } from "../../src/memory/repository.ts";
import { MemoryService } from "../../src/memory/service.ts";

class TestIndex {
  records = new Map();

  async add(record) {
    const id = `index:${record.id}`;
    this.records.set(id, record);
    return id;
  }
  async exists(id) { return this.records.has(id); }
  async update(id, record) { this.records.set(id, record); }
  async delete(id) { this.records.delete(id); }
  async reset() { this.records.clear(); }
  async search(input) {
    return [...this.records.entries()]
      .filter(([, record]) => record.text.includes(input.query)
        && (input.scope === undefined || record.scope === input.scope)
        && (input.projectId === undefined || record.projectId === input.projectId))
      .map(([id, record]) => ({ mem0Id: id, chatMemoryId: record.id, score: 1 }));
  }
}

test("Agent home memory targets return actionable 400 for list and health, not HTTP 500", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-memory-home-"));
  const prior = process.env.CHAT_HOME;
  process.env.CHAT_HOME = root;
  t.after(() => { if (prior === undefined) delete process.env.CHAT_HOME; else process.env.CHAT_HOME = prior; fs.rmSync(root, { recursive: true, force: true }); });
  await ensureAgentHomeProject("nexus", "Nexus", root);
  const router = createRouter(); router.get("/api/memories", listHandler); router.get("/api/memories/health", healthHandler);
  for (const path of ["/api/memories", "/api/memories/health"]) {
    const response = await router.fetch(new Request(`http://chat.test${path}?scope=project&projectId=nexus`));
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /Agent Memory/);
  }
});

test("Personal and every Project use independent catalogs while explicit cross-Project search works", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-memory-manager-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");
  for (const projectId of ["chat", "content-lab"]) {
    const projectRoot = path.join(root, projectId);
    fs.mkdirSync(projectRoot, { recursive: true });
    await openProject({
      path: projectRoot,
      chatHome,
      id: projectId,
      name: projectId,
    });
  }

  const factory = async (target) => {
    const memoryDir = target.type === "personal"
      ? path.join(chatHome, "memory", "personal")
      : (await resolveProjectContext(target.projectId, chatHome)).memoryDir;
    const repository = new MemoryRepository(path.join(memoryDir, "catalog.db"));
    const index = new TestIndex();
    return new MemoryService(repository, async () => index, target);
  };
  const manager = new MemoryStoreManager(chatHome, factory);
  const write = await manager.createMany([
    { type: "personal" },
    { type: "project", projectId: "chat" },
    { type: "project", projectId: "content-lab" },
  ], {
    text: "共享架构原则 TARGET_ALPHA",
    kind: "decision",
    source: { projectId: "chat", sessionId: "session-1" },
  });
  assert.equal(write.every((item) => item.memory !== undefined), true);
  assert.equal(new Set(write.map((item) => item.memory.groupId)).size, 1);
  assert.equal(fs.existsSync(path.join(chatHome, "memory", "personal", "catalog.db")), true);
  assert.equal(fs.existsSync(path.join(chatHome, "projects", "chat", "memory", "catalog.db")), true);
  assert.equal(fs.existsSync(path.join(chatHome, "projects", "content-lab", "memory", "catalog.db")), true);

  const visibleFromChat = await manager.search({
    query: "TARGET_ALPHA",
    targets: [{ type: "personal" }, { type: "project", projectId: "chat" }],
    topK: 10,
  });
  assert.deepEqual(visibleFromChat.map((hit) => hit.memory.scope).sort(), ["personal", "project"]);
  assert.equal(visibleFromChat.some((hit) => hit.memory.projectId === "content-lab"), false);

  const explicitOtherProject = await manager.search({
    query: "TARGET_ALPHA",
    targets: [{ type: "project", projectId: "content-lab" }],
  });
  assert.equal(explicitOtherProject.length, 1);
  assert.equal(explicitOtherProject[0].memory.projectId, "content-lab");
  assert.equal(explicitOtherProject[0].memory.sourceProjectId, "chat");
});
