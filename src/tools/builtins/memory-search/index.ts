import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import manifestJson from "./tool.json" with { type: "json" };
import type { MemoryKind } from "../../../memory/types.js";
import { defineChatSystemTool } from "../../framework.js";
import type { MemoryToolRuntimeContext } from "../memory/runtime.js";
import {
  bindMemoryToolRuntime,
  memoryToolSource,
  visibleTargets,
} from "../memory/runtime.js";
import {
  memoryKindSchema,
  memoryResultText,
  memorySummary,
  memoryTargetSchema,
  normalizeMemoryTarget,
  throwIfMemoryToolAborted,
} from "../memory/shared.js";

export function createMemorySearchTool(context: MemoryToolRuntimeContext) {
  return defineTool({
    name: manifestJson.name,
    label: manifestJson.label,
    description: manifestJson.description,
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        description: "Task-specific natural-language query for stable background, preferences, decisions, or project facts.",
      }),
      targets: Type.Optional(Type.Array(memoryTargetSchema, {
        minItems: 1,
        maxItems: 20,
        description: "Memory scopes to search. Omit to search Personal and the current Project.",
      })),
      kind: Type.Optional(memoryKindSchema),
      topK: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 20,
        description: "Maximum number of ranked matches. Omit to use the Memory service default.",
      })),
    }),
    async execute(toolCallId, params, signal) {
      throwIfMemoryToolAborted(signal);
      const targets = params.targets?.map(normalizeMemoryTarget) ?? visibleTargets(context);
      const hits = await context.manager.search({
        query: params.query,
        targets,
        source: memoryToolSource(context, toolCallId),
        ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
        ...(params.topK === undefined ? {} : { topK: params.topK }),
      });
      const details = hits.map((hit) => ({ ...memorySummary(hit.memory), score: hit.score }));
      return { content: [{ type: "text", text: memoryResultText(details) }], details };
    },
  });
}

export const MEMORY_SEARCH_TOOL_PROVIDER = defineChatSystemTool(manifestJson, (baseContext, identity) => {
  const context = bindMemoryToolRuntime(
    baseContext,
    identity.address,
    identity.version,
  );
  return createMemorySearchTool(context);
});
