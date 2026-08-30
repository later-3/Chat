import type { MemoryIndex, MemoryIndexFactory } from "./index.js";
import { MemoryRepository } from "./repository.js";
import type {
  CreateMemoryInput,
  DeleteMemoryResult,
  ListMemoriesInput,
  MemoryHealth,
  MemoryListPage,
  MemoryRecord,
  MemoryRebuildResult,
  MemorySearchHit,
  SearchMemoriesInput,
  UpdateMemoryInput,
} from "./types.js";

export class MemoryNotFoundError extends Error {
  readonly memoryId: string;

  constructor(memoryId: string) {
    super(`Memory ${memoryId} does not exist`);
    this.memoryId = memoryId;
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

export class MemoryIndexError extends Error {
  readonly memoryId: string;

  constructor(memoryId: string, cause: unknown) {
    super(`Memory ${memoryId} was saved in Chat but could not be indexed: ${errorMessage(cause)}`);
    this.memoryId = memoryId;
    this.name = "MemoryIndexError";
    this.cause = cause;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === "" ? undefined : normalized;
}

function validateProjectScope(scope: string | undefined, projectId: string | null | undefined): void {
  if (scope === "project" && nonEmpty(projectId ?? undefined) === undefined) {
    throw new MemoryValidationError("project scope requires projectId");
  }
}

function recordMatchesSearch(record: MemoryRecord, input: SearchMemoriesInput): boolean {
  return record.status === "active"
    && (input.scope === undefined || record.scope === input.scope)
    && (input.projectId === undefined || record.projectId === input.projectId)
    && (input.kind === undefined || record.kind === input.kind);
}

export class MemoryService {
  private indexPromise: Promise<MemoryIndex> | undefined;
  private repairPromise: Promise<void> | undefined;
  readonly repository: MemoryRepository;
  private readonly indexFactory: MemoryIndexFactory;

  constructor(
    repository: MemoryRepository,
    indexFactory: MemoryIndexFactory,
  ) {
    this.repository = repository;
    this.indexFactory = indexFactory;
  }

  get(id: string): MemoryRecord {
    const record = this.repository.get(id);
    if (record === null) throw new MemoryNotFoundError(id);
    return record;
  }

  list(input: ListMemoriesInput = {}): MemoryListPage {
    return this.repository.list(input);
  }

  health(): MemoryHealth {
    return this.repository.health();
  }

  async create(input: CreateMemoryInput): Promise<MemoryRecord> {
    const text = input.text.trim();
    if (text === "") throw new MemoryValidationError("memory text cannot be empty");
    if (text.length > 50_000) throw new MemoryValidationError("memory text cannot exceed 50000 characters");
    validateProjectScope(input.scope, input.projectId);

    const record = this.repository.create({ ...input, text });
    try {
      const index = await this.readyIndex();
      const current = this.repository.require(record.id);
      return current.indexStatus === "indexed"
        ? current
        : await this.syncRecord(index, current);
    } catch (error) {
      this.repository.markIndexFailed(record.id, errorMessage(error));
      this.repairPromise = undefined;
      throw new MemoryIndexError(record.id, error);
    }
  }

  async update(id: string, input: UpdateMemoryInput): Promise<MemoryRecord> {
    const current = this.repository.get(id);
    if (current === null) throw new MemoryNotFoundError(id);
    if (Object.keys(input).length === 0) {
      throw new MemoryValidationError("at least one memory field must be updated");
    }
    if (input.text !== undefined && input.text.trim() === "") {
      throw new MemoryValidationError("memory text cannot be empty");
    }
    if (input.text !== undefined && input.text.trim().length > 50_000) {
      throw new MemoryValidationError("memory text cannot exceed 50000 characters");
    }
    const nextScope = input.scope ?? current.scope;
    const nextProjectId = input.projectId === undefined ? current.projectId : input.projectId;
    validateProjectScope(nextScope, nextProjectId);

    const normalized: UpdateMemoryInput = {
      ...input,
      ...(input.text === undefined ? {} : { text: input.text.trim() }),
      ...(input.projectId === undefined
        ? {}
        : { projectId: input.projectId === null ? null : input.projectId.trim() }),
    };
    const record = this.repository.update(id, normalized);
    try {
      const index = await this.readyIndex();
      const currentRecord = this.repository.require(record.id);
      return currentRecord.indexStatus === "indexed"
        ? currentRecord
        : await this.syncRecord(index, currentRecord);
    } catch (error) {
      this.repository.markIndexFailed(record.id, errorMessage(error));
      this.repairPromise = undefined;
      throw new MemoryIndexError(record.id, error);
    }
  }

  async delete(id: string): Promise<DeleteMemoryResult> {
    const current = this.repository.get(id);
    if (current === null) throw new MemoryNotFoundError(id);
    this.repository.delete(id);
    if (current.mem0Id === null) {
      return { id, deleted: true, indexCleanup: "completed" };
    }

    try {
      const index = await this.getIndex();
      await index.delete(current.mem0Id);
      this.repository.completePendingDeletion(current.mem0Id);
      return { id, deleted: true, indexCleanup: "completed" };
    } catch (error) {
      this.repository.failPendingDeletion(current.mem0Id, errorMessage(error));
      this.repairPromise = undefined;
      // Chat no longer exposes the deleted record, and search hydrates every hit
      // through the catalog, so a stale index entry cannot become visible.
      return { id, deleted: true, indexCleanup: "pending" };
    }
  }

  async search(input: SearchMemoriesInput): Promise<readonly MemorySearchHit[]> {
    const query = input.query.trim();
    if (query === "") throw new MemoryValidationError("memory search query cannot be empty");
    const topK = Math.min(Math.max(input.topK ?? 5, 1), 50);
    if (input.threshold !== undefined && (input.threshold < 0 || input.threshold > 1)) {
      throw new MemoryValidationError("memory search threshold must be between 0 and 1");
    }

    const index = await this.readyIndex();
    const rawHits = await index.search({
      ...input,
      query,
      topK,
      candidateLimit: Math.min(Math.max(topK * 5, 20), 200),
    });
    const ids = rawHits.flatMap((hit) => hit.chatMemoryId === null ? [] : [hit.chatMemoryId]);
    const records = new Map(this.repository.getMany(ids).map((record) => [record.id, record]));
    const hydrated: MemorySearchHit[] = [];
    const seen = new Set<string>();

    for (const hit of rawHits) {
      const record = hit.chatMemoryId === null
        ? this.repository.getByMem0Id(hit.mem0Id)
        : records.get(hit.chatMemoryId) ?? null;
      if (record === null || seen.has(record.id) || !recordMatchesSearch(record, input)) continue;
      seen.add(record.id);
      hydrated.push({ memory: record, score: hit.score });
      if (hydrated.length === topK) break;
    }
    return hydrated;
  }

  async rebuild(): Promise<MemoryRebuildResult> {
    const index = await this.getIndex();
    await index.reset();
    this.repository.prepareRebuild();
    const records = this.repository.listAllActive();
    const failures: Array<{ memoryId: string; error: string }> = [];
    let indexed = 0;

    for (const record of records) {
      try {
        await this.syncRecord(index, record);
        indexed += 1;
      } catch (error) {
        const message = errorMessage(error);
        this.repository.markIndexFailed(record.id, message);
        failures.push({ memoryId: record.id, error: message });
      }
    }

    this.repairPromise = failures.length === 0 ? Promise.resolve() : undefined;
    return {
      total: records.length,
      indexed,
      failed: failures.length,
      failures,
    };
  }

  close(): void {
    this.repository.close();
  }

  private getIndex(): Promise<MemoryIndex> {
    this.indexPromise ??= this.indexFactory().catch((error: unknown) => {
      // A transient model/download/storage failure must not poison this service
      // forever. The next workflow/API invocation gets a clean retry.
      this.indexPromise = undefined;
      throw error;
    });
    return this.indexPromise;
  }

  private readyIndex(): Promise<MemoryIndex> {
    this.repairPromise ??= this.repairIndex().catch((error: unknown) => {
      this.repairPromise = undefined;
      throw error;
    });
    return this.repairPromise.then(() => this.getIndex());
  }

  private async repairIndex(): Promise<void> {
    const index = await this.getIndex();
    let incomplete = false;
    for (const deletion of this.repository.listPendingDeletions()) {
      try {
        await index.delete(deletion.mem0Id);
        this.repository.completePendingDeletion(deletion.mem0Id);
      } catch (error) {
        incomplete = true;
        this.repository.failPendingDeletion(deletion.mem0Id, errorMessage(error));
      }
    }
    for (const record of this.repository.listPendingIndexRecords()) {
      try {
        await this.syncRecord(index, record);
      } catch (error) {
        incomplete = true;
        this.repository.markIndexFailed(record.id, errorMessage(error));
      }
    }
    if (incomplete) this.repairPromise = undefined;
  }

  private async syncRecord(index: MemoryIndex, record: MemoryRecord): Promise<MemoryRecord> {
    if (record.mem0Id !== null && await index.exists(record.mem0Id)) {
      await index.update(record.mem0Id, record);
      return this.repository.markIndexed(record.id, record.mem0Id);
    }
    const mem0Id = await index.add(record);
    return this.repository.markIndexed(record.id, mem0Id);
  }
}
