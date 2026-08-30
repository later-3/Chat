import type { Memory } from "mem0ai/oss";
import type { MemoryIndex } from "./index.js";
import type {
  MemoryIndexSearchHit,
  MemoryRecord,
  SearchMemoriesInput,
} from "./types.js";

export interface Mem0EmbedderOptions {
  readonly provider: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface Mem0MemoryIndexOptions {
  readonly vectorDbPath: string;
  readonly collectionName?: string;
  readonly dimension?: number;
  readonly embedder?: Mem0EmbedderOptions;
}

const MEM0_USER_ID = "later";

function indexMetadata(record: MemoryRecord): Record<string, unknown> {
  return {
    ...record.metadata,
    chat_memory_id: record.id,
    kind: record.kind,
    scope: record.scope,
    ...(record.projectId === null ? {} : { project_id: record.projectId }),
    version: record.version,
  };
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Mem0 is a rebuildable semantic index; Chat's catalog remains the source of truth. */
export class Mem0MemoryIndex implements MemoryIndex {
  private readonly memory: Memory;

  private constructor(memory: Memory) {
    this.memory = memory;
  }

  static async create(options: Mem0MemoryIndexOptions): Promise<Mem0MemoryIndex> {
    // Local private memory must not emit anonymous product telemetry. Set this
    // before the lazy Mem0 import because the SDK reads it at module load time.
    process.env.MEM0_TELEMETRY = "false";
    const { Memory: Mem0Memory } = await import("mem0ai/oss");
    const vectorConfig: Record<string, unknown> = {
      collectionName: options.collectionName ?? "later_chat_memories",
      dbPath: options.vectorDbPath,
    };
    if (options.dimension !== undefined) vectorConfig.dimension = options.dimension;

    const embedder = options.embedder ?? {
      provider: "fastembed",
      config: {
        model: process.env.CHAT_MEMORY_EMBEDDING_MODEL ?? "fast-bge-small-zh-v1.5",
      },
    };

    const memory = new Mem0Memory({
      embedder: {
        provider: embedder.provider,
        config: { ...embedder.config },
      },
      vectorStore: {
        provider: "memory",
        config: vectorConfig,
      },
      // Chat performs memory curation with Pi and always writes with infer:false.
      // Mem0 currently constructs an LLM eagerly, so provide a non-secret local
      // placeholder that is never sent over the network by this adapter.
      llm: {
        provider: "openai",
        config: {
          apiKey: "chat-mem0-index-only",
          model: "gpt-5-mini",
        },
      },
      disableHistory: true,
    });
    return new Mem0MemoryIndex(memory);
  }

  async add(record: MemoryRecord): Promise<string> {
    const result = await this.memory.add(record.text, {
      userId: MEM0_USER_ID,
      infer: false,
      metadata: indexMetadata(record),
    });
    const added = result.results[0];
    if (added === undefined) throw new Error(`Mem0 did not return an ID for memory ${record.id}`);
    return added.id;
  }

  async exists(mem0Id: string): Promise<boolean> {
    return await this.memory.get(mem0Id) !== null;
  }

  async update(mem0Id: string, record: MemoryRecord): Promise<void> {
    await this.memory.update(mem0Id, {
      text: record.text,
      metadata: indexMetadata(record),
    });
  }

  async delete(mem0Id: string): Promise<void> {
    if (!await this.exists(mem0Id)) return;
    await this.memory.delete(mem0Id);
  }

  async search(
    input: SearchMemoriesInput & { readonly candidateLimit: number },
  ): Promise<readonly MemoryIndexSearchHit[]> {
    const filters: Record<string, unknown> = { user_id: MEM0_USER_ID };
    if (input.scope !== undefined) filters.scope = input.scope;
    if (input.projectId !== undefined) filters.project_id = input.projectId;
    if (input.kind !== undefined) filters.kind = input.kind;

    const result = await this.memory.search(input.query, {
      filters,
      topK: input.candidateLimit,
      ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
    });

    return result.results.map((item) => ({
      mem0Id: item.id,
      chatMemoryId: stringMetadata(item.metadata?.chat_memory_id),
      score: typeof item.score === "number" ? item.score : null,
    }));
  }

  async reset(): Promise<void> {
    await this.memory.reset();
  }
}
