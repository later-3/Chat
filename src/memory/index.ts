import type {
  MemoryIndexSearchHit,
  MemoryRecord,
  SearchMemoriesInput,
} from "./types.js";

export interface MemoryIndex {
  add(record: MemoryRecord): Promise<string>;
  exists(mem0Id: string): Promise<boolean>;
  update(mem0Id: string, record: MemoryRecord): Promise<void>;
  delete(mem0Id: string): Promise<void>;
  search(input: SearchMemoriesInput & { readonly candidateLimit: number }): Promise<readonly MemoryIndexSearchHit[]>;
  reset(): Promise<void>;
}

export type MemoryIndexFactory = () => Promise<MemoryIndex>;
