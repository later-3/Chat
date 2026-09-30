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

const promptGuidelines = ["agent_memory_search searches your private NanoClaw Markdown memory. memory_search searches shared Chat Personal/Project facts; the two stores are independent. No matches does not mean there are no files: use agent_memory_read without path to inspect the file index when available."];

export const AGENT_MEMORY_SEARCH_TOOL_PROVIDER = defineChatSystemTool(manifestJson, (baseContext) => {
  const context = bindAgentMemoryToolRuntime(baseContext);
  return defineTool({
    name: manifestJson.name,
    label: manifestJson.label,
    description: [manifestJson.description, ...promptGuidelines].join("\n"),
    promptGuidelines,
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
