import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FlagEmbedding } from "fastembed";
import { Mem0MemoryIndex } from "./mem0-index.ts";
import { resolveMem0IndexOptions } from "./runtime.ts";

test("the local Mem0 embedder uses Chat Home instead of the process cwd for its cache", (t) => {
  const previousProvider = process.env.CHAT_MEMORY_EMBEDDER_PROVIDER;
  const previousModel = process.env.CHAT_MEMORY_EMBEDDING_MODEL;
  const previousDimension = process.env.CHAT_MEMORY_EMBEDDING_DIMENSION;
  t.after(() => {
    if (previousProvider === undefined) delete process.env.CHAT_MEMORY_EMBEDDER_PROVIDER;
    else process.env.CHAT_MEMORY_EMBEDDER_PROVIDER = previousProvider;
    if (previousModel === undefined) delete process.env.CHAT_MEMORY_EMBEDDING_MODEL;
    else process.env.CHAT_MEMORY_EMBEDDING_MODEL = previousModel;
    if (previousDimension === undefined) delete process.env.CHAT_MEMORY_EMBEDDING_DIMENSION;
    else process.env.CHAT_MEMORY_EMBEDDING_DIMENSION = previousDimension;
  });
  delete process.env.CHAT_MEMORY_EMBEDDER_PROVIDER;
  delete process.env.CHAT_MEMORY_EMBEDDING_MODEL;
  delete process.env.CHAT_MEMORY_EMBEDDING_DIMENSION;

  const memoryDir = path.join("/tmp", "chat-home", "memory", "personal");
  const cacheDir = path.join("/tmp", "chat-home", "cache", "fastembed");
  const options = resolveMem0IndexOptions(memoryDir, cacheDir);

  assert.equal(options.vectorDbPath, path.join(memoryDir, "vector-store.db"));
  assert.deepEqual(options.embedder, {
    provider: "fastembed",
    config: {
      model: "fast-bge-small-zh-v1.5",
      cacheDir,
    },
  });
});

test("the Mem0 FastEmbed adapter preserves cacheDir through schema validation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-mem0-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalInit = FlagEmbedding.init;
  let received;
  FlagEmbedding.init = async (options) => {
    received = options;
    throw new Error("captured-fastembed-options");
  };
  t.after(() => {
    FlagEmbedding.init = originalInit;
  });

  const cacheDir = path.join(root, "cache", "fastembed");
  const index = await Mem0MemoryIndex.create({
    vectorDbPath: path.join(root, "vector-store.db"),
    dimension: 512,
    embedder: {
      provider: "fastembed",
      config: { model: "fast-bge-small-zh-v1.5", cacheDir },
    },
  });
  await assert.rejects(
    index.search({ query: "cache probe", candidateLimit: 1 }),
    /captured-fastembed-options/,
  );
  assert.deepEqual(received, { model: "fast-bge-small-zh-v1.5", cacheDir });
});
