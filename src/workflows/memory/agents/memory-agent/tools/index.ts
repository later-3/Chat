import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { MemoryNotFoundError, type MemoryService } from "../../../../../memory/service.js";
import {
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchHit,
} from "../../../../../memory/types.js";

export const MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_list",
  "memory_get",
  "memory_add",
  "memory_update",
  "memory_delete",
] as const;

export interface MemoryToolContext {
  readonly service: Pick<MemoryService, "search" | "list" | "get" | "create" | "update" | "delete">;
  readonly projectId: string;
  readonly sessionId: string;
  readonly workflowInvocationId: string;
}

const kindSchema = Type.Union(MEMORY_KINDS.map((kind) => Type.Literal(kind)));
const scopeSchema = Type.Union([Type.Literal("global"), Type.Literal("project")]);

function projectFilter(scope: MemoryScope, context: MemoryToolContext) {
  return scope === "project"
    ? { scope, projectId: context.projectId } as const
    : { scope } as const;
}

function assertAccessible(record: MemoryRecord, context: MemoryToolContext): void {
  if (record.scope === "project" && record.projectId !== context.projectId) {
    throw new MemoryNotFoundError(record.id);
  }
}

function assertVersion(record: MemoryRecord, expectedVersion: number): void {
  if (record.version !== expectedVersion) {
    throw new Error(
      `Memory ${record.id} changed from version ${expectedVersion} to ${record.version}; query it again before mutating`,
    );
  }
}

function memorySummary(record: MemoryRecord): Record<string, unknown> {
  return {
    id: record.id,
    text: record.text,
    kind: record.kind,
    scope: record.scope,
    projectId: record.projectId,
    status: record.status,
    version: record.version,
    indexStatus: record.indexStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function resultText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Memory operation aborted");
  }
}

function mergeVisibleHits(
  globalHits: readonly MemorySearchHit[],
  projectHits: readonly MemorySearchHit[],
  topK: number,
): MemorySearchHit[] {
  const byId = new Map<string, MemorySearchHit>();
  for (const hit of [...globalHits, ...projectHits]) {
    const existing = byId.get(hit.memory.id);
    if (existing === undefined || (hit.score ?? -1) > (existing.score ?? -1)) {
      byId.set(hit.memory.id, hit);
    }
  }
  return [...byId.values()]
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1))
    .slice(0, topK);
}

/** Pi custom tools are the only execution surface exposed to Memory Agent. */
export function createMemoryTools(context: MemoryToolContext): ToolDefinition[] {
  const search = defineTool({
    name: "memory_search",
    label: "Search memory",
    description: "Semantically search active long-term memories visible to the current project.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Natural-language search query" }),
      scope: Type.Optional(scopeSchema),
      kind: Type.Optional(kindSchema),
      topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const topK = params.topK ?? 5;
      let hits: readonly MemorySearchHit[];
      if (params.scope !== undefined) {
        hits = await context.service.search({
          query: params.query,
          topK,
          ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
          ...projectFilter(params.scope, context),
        });
      } else {
        const [globalHits, projectHits] = await Promise.all([
          context.service.search({
            query: params.query,
            topK,
            scope: "global",
            ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
          }),
          context.service.search({
            query: params.query,
            topK,
            scope: "project",
            projectId: context.projectId,
            ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
          }),
        ]);
        hits = mergeVisibleHits(globalHits, projectHits, topK);
      }
      const details = hits.map((hit) => ({ ...memorySummary(hit.memory), score: hit.score }));
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  const list = defineTool({
    name: "memory_list",
    label: "List memories",
    description: "List active memories exactly, without semantic search or model loading.",
    parameters: Type.Object({
      scope: Type.Optional(scopeSchema),
      kind: Type.Optional(kindSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const scope = params.scope ?? "global";
      const page = context.service.list({
        ...projectFilter(scope, context),
        status: "active",
        ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.offset === undefined ? {} : { offset: params.offset }),
      });
      const details = { ...page, items: page.items.map(memorySummary) };
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  const get = defineTool({
    name: "memory_get",
    label: "Get memory",
    description: "Get one exact memory by Chat memory ID.",
    parameters: Type.Object({
      memoryId: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const memory = context.service.get(params.memoryId);
      assertAccessible(memory, context);
      const details = memorySummary(memory);
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  const add = defineTool({
    name: "memory_add",
    label: "Add memory",
    description: "Add one explicit, durable long-term memory to Chat and its Mem0 index.",
    executionMode: "sequential",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 50_000 }),
      kind: Type.Optional(kindSchema),
      scope: Type.Optional(scopeSchema),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const scope = params.scope ?? "global";
      const memory = await context.service.create({
        text: params.text,
        ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
        ...projectFilter(scope, context),
        metadata: { managedBy: "memory-agent" },
        source: {
          sessionId: context.sessionId,
          workflowInvocationId: context.workflowInvocationId,
        },
      });
      const details = memorySummary(memory);
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  const update = defineTool({
    name: "memory_update",
    label: "Update memory",
    description: "Update an exact visible memory after retrieving its current version.",
    executionMode: "sequential",
    parameters: Type.Object({
      memoryId: Type.String({ minLength: 1 }),
      expectedVersion: Type.Integer({ minimum: 1 }),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 50_000 })),
      kind: Type.Optional(kindSchema),
      scope: Type.Optional(scopeSchema),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const current = context.service.get(params.memoryId);
      assertAccessible(current, context);
      assertVersion(current, params.expectedVersion);
      const memory = await context.service.update(params.memoryId, {
        ...(params.text === undefined ? {} : { text: params.text }),
        ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
        ...(params.scope === undefined
          ? {}
          : params.scope === "global"
            ? { scope: "global", projectId: null }
            : { scope: "project", projectId: context.projectId }),
      });
      const details = memorySummary(memory);
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  const remove = defineTool({
    name: "memory_delete",
    label: "Delete memory",
    description: "Permanently delete one exact visible memory after retrieving its current version.",
    executionMode: "sequential",
    parameters: Type.Object({
      memoryId: Type.String({ minLength: 1 }),
      expectedVersion: Type.Integer({ minimum: 1 }),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const current = context.service.get(params.memoryId);
      assertAccessible(current, context);
      assertVersion(current, params.expectedVersion);
      const details = await context.service.delete(params.memoryId);
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  return [search, list, get, add, update, remove];
}
