import { resolve } from "node:path";
import { ensureChatHome, resolveChatHome } from "../chat-home.js";
import { resolveProjectContext } from "../projects/registry.js";
import { MemoryRepository } from "./repository.js";
import { MemoryService } from "./service.js";
import type { Mem0MemoryIndexOptions } from "./mem0-index.js";
import type { MemoryTarget } from "./types.js";

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function mem0IndexOptions(memoryDir: string): Mem0MemoryIndexOptions {
  const vectorDbPath = resolve(memoryDir, "vector-store.db");
  const provider = process.env.CHAT_MEMORY_EMBEDDER_PROVIDER?.trim() || "fastembed";
  const dimension = positiveInteger(
    process.env.CHAT_MEMORY_EMBEDDING_DIMENSION,
    "CHAT_MEMORY_EMBEDDING_DIMENSION",
  );

  if (provider === "fastembed") {
    return {
      vectorDbPath,
      ...(dimension === undefined ? {} : { dimension }),
      embedder: {
        provider,
        config: {
          model: process.env.CHAT_MEMORY_EMBEDDING_MODEL ?? "fast-bge-small-zh-v1.5",
        },
      },
    };
  }

  if (provider === "openai") {
    const apiKey = process.env.CHAT_MEMORY_EMBEDDER_API_KEY?.trim();
    if (apiKey === undefined || apiKey === "") {
      throw new Error("CHAT_MEMORY_EMBEDDER_API_KEY is required for the openai memory embedder");
    }
    const baseURL = process.env.CHAT_MEMORY_EMBEDDER_BASE_URL?.trim();
    return {
      vectorDbPath,
      ...(dimension === undefined ? {} : { dimension }),
      embedder: {
        provider,
        config: {
          apiKey,
          model: process.env.CHAT_MEMORY_EMBEDDING_MODEL ?? "text-embedding-3-small",
          ...(baseURL === undefined || baseURL === "" ? {} : { baseURL }),
        },
      },
    };
  }

  throw new Error(`Unsupported CHAT_MEMORY_EMBEDDER_PROVIDER: ${provider}`);
}

export async function createMemoryServiceForTarget(
  target: MemoryTarget,
  chatHome = resolveChatHome(),
): Promise<MemoryService> {
  const memoryDir = target.type === "personal"
    ? (await ensureChatHome(chatHome)).personalMemoryDir
    : (await resolveProjectContext(target.projectId, chatHome)).memoryDir;
  const repository = new MemoryRepository(resolve(memoryDir, "catalog.db"));
  return new MemoryService(repository, async () => {
    const { Mem0MemoryIndex } = await import("./mem0-index.js");
    return Mem0MemoryIndex.create(mem0IndexOptions(memoryDir));
  }, target);
}
