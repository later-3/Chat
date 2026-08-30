import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemoryStoreManager } from "../../../../../memory/manager.js";
import {
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryRecord,
  type MemoryTarget,
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
  readonly manager: Pick<MemoryStoreManager, "search" | "list" | "get" | "createMany" | "update" | "delete">;
  readonly projectId: string;
  readonly sessionId: string;
  readonly workflowInvocationId: string;
  readonly agentId: string;
}

const kindSchema = Type.Union(MEMORY_KINDS.map((kind) => Type.Literal(kind)));
const targetSchema = Type.Union([
  Type.Object({ type: Type.Literal("personal") }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("project"),
    projectId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);

function defaultProjectTarget(context: MemoryToolContext): MemoryTarget {
  return { type: "project", projectId: context.projectId };
}

function visibleTargets(context: MemoryToolContext): readonly MemoryTarget[] {
  return [{ type: "personal" }, defaultProjectTarget(context)];
}

function normalizeTarget(value: { type: "personal" } | { type: "project"; projectId: string }): MemoryTarget {
  return value.type === "personal"
    ? { type: "personal" }
    : { type: "project", projectId: value.projectId };
}

function targetForRecord(record: MemoryRecord): MemoryTarget {
  return record.scope === "personal"
    ? { type: "personal" }
    : { type: "project", projectId: record.projectId as string };
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
    target: targetForRecord(record),
    groupId: record.groupId,
    text: record.text,
    kind: record.kind,
    scope: record.scope,
    projectId: record.projectId,
    sourceProjectId: record.sourceProjectId,
    sourceSessionId: record.sourceSessionId,
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
  if (signal?.aborted) throw signal.reason ?? new Error("Memory operation aborted");
}

/** Pi custom tools expose explicit Targets while Chat resolves paths and Project access. */
export function createMemoryTools(context: MemoryToolContext): ToolDefinition[] {
  const search = defineTool({
    name: "memory_search",
    label: "Search memory",
    description: "Search Personal, current-Project, or explicitly selected registered Project memories.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Natural-language search query" }),
      targets: Type.Optional(Type.Array(targetSchema, { minItems: 1, maxItems: 20 })),
      kind: Type.Optional(kindSchema),
      topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const targets = params.targets?.map(normalizeTarget) ?? visibleTargets(context);
      const hits = await context.manager.search({
        query: params.query,
        targets,
        ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
        ...(params.topK === undefined ? {} : { topK: params.topK }),
      });
      const details = hits.map((hit) => ({ ...memorySummary(hit.memory), score: hit.score }));
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  const list = defineTool({
    name: "memory_list",
    label: "List memories",
    description: "List one exact Memory namespace without semantic search.",
    parameters: Type.Object({
      target: Type.Optional(targetSchema),
      kind: Type.Optional(kindSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const target = params.target === undefined ? defaultProjectTarget(context) : normalizeTarget(params.target);
      const page = await context.manager.list(target, {
        status: "active",
        ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.offset === undefined ? {} : { offset: params.offset }),
      });
      const details = { target, ...page, items: page.items.map(memorySummary) };
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  const get = defineTool({
    name: "memory_get",
    label: "Get memory",
    description: "Get one exact memory by Target and Chat memory ID.",
    parameters: Type.Object({ target: targetSchema, memoryId: Type.String({ minLength: 1 }) }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const memory = await context.manager.get({ target: normalizeTarget(params.target), memoryId: params.memoryId });
      const details = memorySummary(memory);
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  const add = defineTool({
    name: "memory_add",
    label: "Add memory",
    description: "Add one durable memory to one or more explicit Personal or Project Targets.",
    executionMode: "sequential",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 50_000 }),
      kind: Type.Optional(kindSchema),
      targets: Type.Optional(Type.Array(targetSchema, { minItems: 1, maxItems: 20 })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const targets = params.targets?.map(normalizeTarget) ?? [defaultProjectTarget(context)];
      const details = await context.manager.createMany(targets, {
        text: params.text,
        ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
        metadata: { managedBy: "memory-agent" },
        source: {
          projectId: context.projectId,
          sessionId: context.sessionId,
          workflowInvocationId: context.workflowInvocationId,
          agentId: context.agentId,
        },
      });
      const result = details.map((item) => ({
        target: item.target,
        ...(item.memory === undefined ? {} : { memory: memorySummary(item.memory) }),
        ...(item.error === undefined ? {} : { error: item.error }),
      }));
      return { content: [{ type: "text", text: resultText(result) }], details: result };
    },
  });

  const update = defineTool({
    name: "memory_update",
    label: "Update memory",
    description: "Update an exact memory in its owning namespace after retrieving its version.",
    executionMode: "sequential",
    parameters: Type.Object({
      target: targetSchema,
      memoryId: Type.String({ minLength: 1 }),
      expectedVersion: Type.Integer({ minimum: 1 }),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 50_000 })),
      kind: Type.Optional(kindSchema),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const target = normalizeTarget(params.target);
      const current = await context.manager.get({ target, memoryId: params.memoryId });
      assertVersion(current, params.expectedVersion);
      const memory = await context.manager.update({ target, memoryId: params.memoryId }, {
        ...(params.text === undefined ? {} : { text: params.text }),
        ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
      });
      const details = memorySummary(memory);
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  const remove = defineTool({
    name: "memory_delete",
    label: "Delete memory",
    description: "Delete one exact memory from its owning namespace after retrieving its version.",
    executionMode: "sequential",
    parameters: Type.Object({
      target: targetSchema,
      memoryId: Type.String({ minLength: 1 }),
      expectedVersion: Type.Integer({ minimum: 1 }),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAborted(signal);
      const target = normalizeTarget(params.target);
      const current = await context.manager.get({ target, memoryId: params.memoryId });
      assertVersion(current, params.expectedVersion);
      const details = await context.manager.delete({ target, memoryId: params.memoryId });
      return { content: [{ type: "text", text: resultText(details) }], details };
    },
  });

  return [search, list, get, add, update, remove];
}
