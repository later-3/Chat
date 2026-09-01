import { randomUUID } from "node:crypto";
import { appendChatAuditEvent } from "../audit-log.js";
import { resolveChatHome } from "../chat-home.js";
import { resolveProjectContext } from "../projects/registry.js";
import { createMemoryServiceForTarget } from "./runtime.js";
import type { MemoryService } from "./service.js";
import type {
  CreateMemoryInput,
  DeleteMemoryResult,
  ListMemoriesInput,
  MemoryAddress,
  MemoryHealth,
  MemoryListPage,
  MemoryRebuildResult,
  MemoryRecord,
  MemorySearchHit,
  MemorySource,
  MemoryTarget,
  MemoryTargetWriteResult,
  SearchMemoryStoresInput,
  UpdateMemoryInput,
} from "./types.js";

function targetKey(target: MemoryTarget): string {
  return target.type === "personal" ? "personal" : `project:${target.projectId}`;
}

function targetFields(target: MemoryTarget) {
  return target.type === "personal"
    ? { scope: "personal" as const }
    : { scope: "project" as const, projectId: target.projectId };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Routes stable Memory Targets to independent Chat Catalog and Mem0 stores. */
export class MemoryStoreManager {
  readonly chatHome: string;
  private readonly stores = new Map<string, Promise<MemoryService>>();
  private readonly serviceFactory: (target: MemoryTarget, chatHome: string) => Promise<MemoryService>;

  constructor(
    chatHome = resolveChatHome(),
    serviceFactory = createMemoryServiceForTarget,
  ) {
    this.chatHome = chatHome;
    this.serviceFactory = serviceFactory;
  }

  async store(target: MemoryTarget): Promise<MemoryService> {
    if (target.type === "project") await resolveProjectContext(target.projectId, this.chatHome);
    const key = targetKey(target);
    const existing = this.stores.get(key);
    if (existing !== undefined) return existing;
    const created = this.serviceFactory(target, this.chatHome).catch((error: unknown) => {
      this.stores.delete(key);
      throw error;
    });
    this.stores.set(key, created);
    return created;
  }

  async get(address: MemoryAddress): Promise<MemoryRecord> {
    return (await this.store(address.target)).get(address.memoryId);
  }

  async list(target: MemoryTarget, input: Omit<ListMemoriesInput, "scope" | "projectId"> = {}): Promise<MemoryListPage> {
    return (await this.store(target)).list({ ...input, ...targetFields(target) });
  }

  async health(target: MemoryTarget): Promise<MemoryHealth> {
    return (await this.store(target)).health();
  }

  async createOne(target: MemoryTarget, input: Omit<CreateMemoryInput, "scope" | "projectId">): Promise<MemoryRecord> {
    const memory = await (await this.store(target)).create({ ...input, ...targetFields(target) });
    await appendChatAuditEvent({
      action: "memory.create",
      target,
      source: input.source === undefined ? {} : { ...input.source },
      details: { memoryId: memory.id, groupId: memory.groupId, kind: memory.kind },
    }, this.chatHome);
    return memory;
  }

  async createMany(
    targets: readonly MemoryTarget[],
    input: Omit<CreateMemoryInput, "scope" | "projectId" | "groupId">,
  ): Promise<readonly MemoryTargetWriteResult[]> {
    const unique = [...new Map(targets.map((target) => [targetKey(target), target])).values()];
    if (unique.length === 0) throw new Error("Memory写入至少需要一个Target");
    const groupId = randomUUID();
    return Promise.all(unique.map(async (target): Promise<MemoryTargetWriteResult> => {
      try {
        return { target, memory: await this.createOne(target, { ...input, groupId }) };
      } catch (error) {
        return { target, error: errorMessage(error) };
      }
    }));
  }

  async importOne(target: MemoryTarget, record: MemoryRecord): Promise<MemoryRecord> {
    const fields = targetFields(target);
    return (await this.store(target)).importRecord(
      record,
      fields.scope,
      target.type === "personal" ? null : target.projectId,
    );
  }

  async importCatalogRecord(target: MemoryTarget, record: MemoryRecord): Promise<MemoryRecord> {
    const fields = targetFields(target);
    return (await this.store(target)).repository.importRecord(
      record,
      fields.scope,
      target.type === "personal" ? null : target.projectId,
    );
  }

  async update(
    address: MemoryAddress,
    input: Omit<UpdateMemoryInput, "scope" | "projectId">,
    source?: MemorySource,
  ): Promise<MemoryRecord> {
    const memory = await (await this.store(address.target)).update(address.memoryId, input);
    await appendChatAuditEvent({
      action: "memory.update",
      target: { ...address.target, memoryId: address.memoryId },
      ...(source === undefined ? {} : { source: { ...source } }),
      details: { version: memory.version, fields: Object.keys(input).sort() },
    }, this.chatHome);
    return memory;
  }

  async delete(address: MemoryAddress, source?: MemorySource): Promise<DeleteMemoryResult> {
    const result = await (await this.store(address.target)).delete(address.memoryId);
    await appendChatAuditEvent({
      action: "memory.delete",
      target: { ...address.target, memoryId: address.memoryId },
      ...(source === undefined ? {} : { source: { ...source } }),
      details: { indexCleanup: result.indexCleanup },
    }, this.chatHome);
    return result;
  }

  async rebuild(target: MemoryTarget): Promise<MemoryRebuildResult> {
    const result = await (await this.store(target)).rebuild();
    await appendChatAuditEvent({
      action: "memory.rebuild",
      target,
      details: { total: result.total, indexed: result.indexed, failed: result.failed },
    }, this.chatHome);
    return result;
  }

  async search(input: SearchMemoryStoresInput): Promise<readonly MemorySearchHit[]> {
    const topK = Math.min(Math.max(input.topK ?? 5, 1), 50);
    const targets = [...new Map(input.targets.map((target) => [targetKey(target), target])).values()];
    if (targets.length === 0) throw new Error("Memory查询至少需要一个Target");
    const lists = await Promise.all(targets.map(async (target) => (
      (await this.store(target)).search({
        query: input.query,
        ...targetFields(target),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        topK: Math.min(topK * 3, 50),
        ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
      })
    )));

    const fused = new Map<string, { hit: MemorySearchHit; rrf: number }>();
    lists.forEach((hits) => hits.forEach((hit, rank) => {
      const key = `${hit.memory.scope}:${hit.memory.projectId ?? "personal"}:${hit.memory.id}`;
      const score = 1 / (60 + rank + 1);
      const existing = fused.get(key);
      fused.set(key, { hit, rrf: (existing?.rrf ?? 0) + score });
    }));
    const results = [...fused.values()]
      .sort((left, right) => right.rrf - left.rrf
        || right.hit.memory.updatedAt.localeCompare(left.hit.memory.updatedAt))
      .slice(0, topK)
      .map(({ hit, rrf }) => ({ ...hit, score: rrf }));
    await appendChatAuditEvent({
      action: "memory.search",
      target: { targets },
      ...(input.source === undefined ? {} : { source: { ...input.source } }),
      details: { queryCharacters: input.query.length, resultCount: results.length },
    }, this.chatHome);
    return results;
  }

  async close(): Promise<void> {
    await Promise.all([...this.stores.values()].map(async (service) => {
      (await service).close();
    }));
    this.stores.clear();
  }
}
