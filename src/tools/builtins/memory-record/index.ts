import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import manifestJson from "./tool.json" with { type: "json" };
import type { MemoryKind } from "../../../memory/types.js";
import { defineChatSystemTool } from "../../framework.js";
import {
  bindMemoryToolRuntime,
  defaultProjectTarget,
  memoryToolSource,
} from "../memory/runtime.js";
import type { MemoryToolRuntimeContext } from "../memory/runtime.js";
import {
  memoryKindSchema,
  memoryResultText,
  memorySummary,
  memoryTargetSchema,
  normalizeMemoryTarget,
  throwIfMemoryToolAborted,
} from "../memory/shared.js";

export function createMemoryRecordTool(context: MemoryToolRuntimeContext) {
  return defineTool({
    name: manifestJson.name,
    label: manifestJson.label,
    description: manifestJson.description,
    executionMode: "sequential",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 50_000 }),
      kind: Type.Optional(memoryKindSchema),
      targets: Type.Optional(Type.Array(memoryTargetSchema, { minItems: 1, maxItems: 20 })),
    }),
    async execute(toolCallId, params, signal) {
      throwIfMemoryToolAborted(signal);
      const targets = params.targets?.map(normalizeMemoryTarget) ?? [defaultProjectTarget(context)];
      const details = await context.manager.createMany(targets, {
        text: params.text,
        ...(params.kind === undefined ? {} : { kind: params.kind as MemoryKind }),
        metadata: { managedBy: context.agentId },
        source: memoryToolSource(context, toolCallId),
      });
      const result = details.map((item) => ({
        target: item.target,
        ...(item.memory === undefined ? {} : { memory: memorySummary(item.memory) }),
        ...(item.error === undefined ? {} : { error: item.error }),
      }));
      return { content: [{ type: "text", text: memoryResultText(result) }], details: result };
    },
  });
}

export const MEMORY_RECORD_TOOL_PROVIDER = defineChatSystemTool(manifestJson, (baseContext, identity) => {
  const context = bindMemoryToolRuntime(
    baseContext,
    identity.address,
    identity.version,
  );
  return createMemoryRecordTool(context);
});
