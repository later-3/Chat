import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openProject, resolveProjectContext } from "../projects/registry.ts";
import { MemoryStoreManager } from "./manager.ts";
import { MemoryRepository } from "./repository.ts";
import { MemoryService } from "./service.ts";

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
      createIfMissing: true,
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
