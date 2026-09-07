import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import manifestJson from "./tool.json" with { type: "json" };
import { searchNanoClawAgentMemory } from "../../../long-agents/nanoclaw-client.js";
import { defineChatSystemTool } from "../../framework.js";
import {
  bindAgentMemoryToolRuntime,
  resolveAgentMemoryToolTarget,
  throwIfAgentMemoryToolAborted,
} from "../agent-memory/runtime.js";

export const AGENT_MEMORY_SEARCH_TOOL_PROVIDER = defineChatSystemTool(manifestJson, (baseContext) => {
  const context = bindAgentMemoryToolRuntime(baseContext);
  return defineTool({
    name: manifestJson.name,
    label: manifestJson.label,
    description: manifestJson.description,
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 512, description: "At most 32 whitespace-delimited tokens." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAgentMemoryToolAborted(signal);
      const target = await resolveAgentMemoryToolTarget(context);
      const results = await searchNanoClawAgentMemory({
        instance: target.instance,
        agentGroupId: target.agent.nanoclawAgentGroupId,
        query: params.query,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      });
      return {
        content: [{ type: "text", text: results.length === 0 ? "No agent memory matches." : JSON.stringify(results, null, 2) }],
        details: { results },
      };
    },
  });
});
