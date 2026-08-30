import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Mem0MemoryIndex } from "./mem0-index.ts";
import { MemoryRepository } from "./repository.ts";
import { MemoryService } from "./service.ts";

const EMBEDDING_DIMENSION = 64;

function textEmbedding(text) {
  const vector = Array.from({ length: EMBEDDING_DIMENSION }, () => 0);
  const symbols = Array.from(text.toLowerCase());
  for (let index = 0; index < symbols.length; index += 1) {
    const current = symbols[index]?.codePointAt(0) ?? 0;
    const next = symbols[index + 1]?.codePointAt(0) ?? 0;
    vector[(current * 31 + next * 17 + index) % vector.length] += 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startEmbeddingServer(t) {
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/embeddings") {
      response.writeHead(404).end();
      return;
    }
    const body = await readJson(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      model: body.model,
      data: inputs.map((input, index) => ({
        object: "embedding",
        index,
        embedding: textEmbedding(String(input)),
      })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  return `http://127.0.0.1:${address.port}/v1`;
}

async function createHarness(projectRoot, embeddingBaseUrl) {
  const memoryDir = path.join(projectRoot, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const repository = new MemoryRepository(path.join(memoryDir, "catalog.db"));
  const index = await Mem0MemoryIndex.create({
    vectorDbPath: path.join(memoryDir, "vector-store.db"),
    dimension: EMBEDDING_DIMENSION,
    embedder: {
      provider: "openai",
      config: {
        apiKey: "test",
        baseURL: embeddingBaseUrl,
        model: "deterministic-test-embedding",
      },
    },
  });
  return { index, service: new MemoryService(repository, async () => index) };
}

test("Chat catalog and Mem0 survive restart, support CRUD, and rebuild the index", async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-memory-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const embeddingBaseUrl = await startEmbeddingServer(t);

  const first = await createHarness(projectRoot, embeddingBaseUrl);
  const globalMemory = await first.service.create({
    text: "Later 选择 MEMORY_ALPHA 作为长期记忆架构。",
    kind: "decision",
    metadata: { source: "test" },
  });
  const projectMemory = await first.service.create({
    text: "Chat 项目要求 MEMORY_BETA 可以从事实源重建。",
    kind: "constraint",
    scope: "project",
    projectId: "chat",
  });
  assert.equal(globalMemory.indexStatus, "indexed");
  assert.ok(globalMemory.mem0Id);
  assert.equal(first.service.list().total, 2);
  assert.deepEqual(
    (await first.service.search({ query: "MEMORY_ALPHA", topK: 1 })).map((hit) => hit.memory.id),
    [globalMemory.id],
  );
  first.service.close();

  // A new repository and Mem0 instance over the same two SQLite files simulate
  // a process restart; no in-memory object from the first service is reused.
  const restarted = await createHarness(projectRoot, embeddingBaseUrl);
  assert.equal(restarted.service.list().total, 2);
  assert.deepEqual(
    (await restarted.service.search({ query: "MEMORY_BETA", scope: "project", projectId: "chat" }))
      .map((hit) => hit.memory.id),
    [projectMemory.id],
  );
  await assert.rejects(
    restarted.service.update(projectMemory.id, { projectId: null }),
    /project scope requires projectId/,
  );
  assert.equal(restarted.service.get(projectMemory.id).version, 1);

  const updated = await restarted.service.update(globalMemory.id, {
    text: "Later 选择 MEMORY_GAMMA 作为长期记忆架构。",
  });
  assert.equal(updated.version, 2);
  assert.deepEqual(
    (await restarted.service.search({ query: "MEMORY_GAMMA", topK: 1 })).map((hit) => hit.memory.text),
    [updated.text],
  );

  // Destroy only Mem0's projection, then rebuild it entirely from catalog.db.
  await restarted.index.reset();
  assert.equal(
    (await restarted.service.search({ query: "MEMORY_GAMMA" }))
      .some((hit) => hit.memory.id === globalMemory.id),
    false,
  );
  const rebuilt = await restarted.service.rebuild();
  assert.deepEqual(rebuilt, { total: 2, indexed: 2, failed: 0, failures: [] });
  assert.deepEqual(
    (await restarted.service.search({ query: "MEMORY_GAMMA", topK: 1 })).map((hit) => hit.memory.id),
    [globalMemory.id],
  );

  const deleted = await restarted.service.delete(globalMemory.id);
  assert.deepEqual(deleted, { id: globalMemory.id, deleted: true, indexCleanup: "completed" });
  assert.equal(restarted.service.list().total, 1);
  assert.equal(
    (await restarted.service.search({ query: "MEMORY_GAMMA" }))
      .some((hit) => hit.memory.id === globalMemory.id),
    false,
  );
  assert.throws(() => restarted.service.get(globalMemory.id), /does not exist/);
  assert.deepEqual(restarted.service.health(), {
    records: 1,
    indexed: 1,
    pending: 0,
    failed: 0,
    pendingDeletions: 0,
  });
  restarted.service.close();
});

test("a later operation retries failed indexing and pending index deletion", async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-memory-repair-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const repository = new MemoryRepository(path.join(projectRoot, "catalog.db"));
  const indexed = new Map();
  let addAttempts = 0;
  let deleteAttempts = 0;
  const index = {
    async add(record) {
      addAttempts += 1;
      if (addAttempts <= 2) throw new Error("temporary add failure");
      const mem0Id = `mem0-${record.id}`;
      indexed.set(mem0Id, record.id);
      return mem0Id;
    },
    async exists(mem0Id) {
      return indexed.has(mem0Id);
    },
    async update(mem0Id, record) {
      indexed.set(mem0Id, record.id);
    },
    async delete(mem0Id) {
      deleteAttempts += 1;
      if (deleteAttempts === 1) throw new Error("temporary delete failure");
      indexed.delete(mem0Id);
    },
    async search() {
      return [...indexed].map(([mem0Id, chatMemoryId]) => ({
        mem0Id,
        chatMemoryId,
        score: 1,
      }));
    },
    async reset() {
      indexed.clear();
    },
  };
  const service = new MemoryService(repository, async () => index);
  t.after(() => service.close());

  let memoryId;
  await assert.rejects(
    service.create({ text: "这条记录第一次索引失败，但事实源必须保留。" }),
    (error) => {
      memoryId = error.memoryId;
      return error.name === "MemoryIndexError";
    },
  );
  assert.equal(service.health().failed, 1);

  const repaired = await service.search({ query: "事实源" });
  assert.deepEqual(repaired.map((hit) => hit.memory.id), [memoryId]);
  assert.equal(addAttempts, 3);
  assert.deepEqual(service.health(), {
    records: 1,
    indexed: 1,
    pending: 0,
    failed: 0,
    pendingDeletions: 0,
  });

  const deleted = await service.delete(memoryId);
  assert.equal(deleted.indexCleanup, "pending");
  assert.equal(service.health().pendingDeletions, 1);

  await service.search({ query: "触发下一次自动修复" });
  assert.equal(service.health().pendingDeletions, 0);
  assert.equal(deleteAttempts, 2);
});
