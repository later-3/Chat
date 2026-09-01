import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemoryStoreManager } from "../../../../../memory/manager.js";
import type { MemoryKind, MemoryRecord, MemorySource } from "../../../../../memory/types.js";
import {
  memoryKindSchema,
  memoryResultText,
  memorySummary,
  memoryTargetSchema,
  normalizeMemoryTarget,
  throwIfMemoryToolAborted,
} from "../../../../../tools/builtins/memory/shared.js";

export const MEMORY_MANAGEMENT_TOOL_NAMES = [
  "memory_list",
  "memory_get",
  "memory_update",
  "memory_delete",
] as const;

export interface MemoryManagementToolContext {
  readonly manager: Pick<MemoryStoreManager, "list" | "get" | "update" | "delete">;
  readonly projectId: string;
  readonly sessionId: string;
  readonly workflowId: string;
  readonly workflowInvocationId: string;
  readonly stageId: string;
  readonly agentId: string;
}

function defaultProjectTarget(context: MemoryManagementToolContext) {
  return { type: "project" as const, projectId: context.projectId };
}

function assertVersion(record: MemoryRecord, expectedVersion: number): void {
  if (record.version !== expectedVersion) {
    throw new Error(
      `Memory ${record.id} changed from version ${expectedVersion} to ${record.version}; query it again before mutating`,
    );
  }
}

function operationSource(
  context: MemoryManagementToolContext,
  toolCallId: string,
  toolName: string,
): MemorySource {
  return {
    projectId: context.projectId,
    sessionId: context.sessionId,
    workflowId: context.workflowId,
    workflowInvocationId: context.workflowInvocationId,
    stageId: context.stageId,
    agentId: context.agentId,
    toolCallId,
    toolAddress: `workflow/${context.workflowId}/${context.agentId}:tool/${toolName}`,
    toolVersion: "workflow:memory-management@1",
  };
}

/** Workflow-private mutation management tools; public search/record tools come from Chat's system registry. */
export function createMemoryManagementTools(context: MemoryManagementToolContext): ToolDefinition[] {
  const list = defineTool({
    name: "memory_list",
    label: "List memories",
    description: "List one exact Memory namespace without semantic search.",
    parameters: Type.Object({
      target: Type.Optional(memoryTargetSchema),
      kind: Type.Optional(memoryKindSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfMemoryToolAborted(signal);
      const target = params.target === undefined ? defaultProjectTarget(context) : normalizeMemoryTarget(params.target);
      const page = await context.manager.list(target, {
        status: "active",
        ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.offset === undefined ? {} : { offset: params.offset }),
      });
      const details = { target, ...page, items: page.items.map(memorySummary) };
      return { content: [{ type: "text", text: memoryResultText(details) }], details };
    },
  });

  const get = defineTool({
    name: "memory_get",
    label: "Get memory",
    description: "Get one exact memory by Target and Chat memory ID.",
    parameters: Type.Object({ target: memoryTargetSchema, memoryId: Type.String({ minLength: 1 }) }),
    async execute(_toolCallId, params, signal) {
      throwIfMemoryToolAborted(signal);
      const memory = await context.manager.get({ target: normalizeMemoryTarget(params.target), memoryId: params.memoryId });
      const details = memorySummary(memory);
      return { content: [{ type: "text", text: memoryResultText(details) }], details };
    },
  });

  const update = defineTool({
    name: "memory_update",
    label: "Update memory",
    description: "Update an exact memory in its owning namespace after retrieving its version.",
    executionMode: "sequential",
    parameters: Type.Object({
      target: memoryTargetSchema,
      memoryId: Type.String({ minLength: 1 }),
      expectedVersion: Type.Integer({ minimum: 1 }),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 50_000 })),
      kind: Type.Optional(memoryKindSchema),
    }),
    async execute(toolCallId, params, signal) {
      throwIfMemoryToolAborted(signal);
      const target = normalizeMemoryTarget(params.target);
      const current = await context.manager.get({ target, memoryId: params.memoryId });
      assertVersion(current, params.expectedVersion);
      const memory = await context.manager.update(
        { target, memoryId: params.memoryId },
        {
          ...(params.text === undefined ? {} : { text: params.text }),
          ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
        },
        operationSource(context, toolCallId, "memory_update"),
      );
      const details = memorySummary(memory);
      return { content: [{ type: "text", text: memoryResultText(details) }], details };
    },
  });

  const remove = defineTool({
    name: "memory_delete",
    label: "Delete memory",
    description: "Delete one exact memory from its owning namespace after retrieving its version.",
    executionMode: "sequential",
    parameters: Type.Object({
      target: memoryTargetSchema,
      memoryId: Type.String({ minLength: 1 }),
      expectedVersion: Type.Integer({ minimum: 1 }),
    }),
    async execute(toolCallId, params, signal) {
      throwIfMemoryToolAborted(signal);
      const target = normalizeMemoryTarget(params.target);
      const current = await context.manager.get({ target, memoryId: params.memoryId });
      assertVersion(current, params.expectedVersion);
      const details = await context.manager.delete(
        { target, memoryId: params.memoryId },
        operationSource(context, toolCallId, "memory_delete"),
      );
      return { content: [{ type: "text", text: memoryResultText(details) }], details };
    },
  });

  return [list, get, update, remove];
}
