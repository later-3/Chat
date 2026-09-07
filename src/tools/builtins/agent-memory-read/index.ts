import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import manifestJson from "./tool.json" with { type: "json" };
import { parseAgentMemoryPath } from "../../../long-agents/agent-group-service.js";
import { readNanoClawAgentMemory } from "../../../long-agents/nanoclaw-client.js";
import { defineChatSystemTool } from "../../framework.js";
import {
  bindAgentMemoryToolRuntime,
  resolveAgentMemoryToolTarget,
  throwIfAgentMemoryToolAborted,
} from "../agent-memory/runtime.js";

export const AGENT_MEMORY_READ_TOOL_PROVIDER = defineChatSystemTool(manifestJson, (baseContext) => {
  const context = bindAgentMemoryToolRuntime(baseContext);
  return defineTool({
    name: manifestJson.name,
    label: manifestJson.label,
    description: manifestJson.description,
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "OKF Markdown path relative to this Agent Group's memory root." }),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAgentMemoryToolAborted(signal);
      const target = await resolveAgentMemoryToolTarget(context);
      const file = await readNanoClawAgentMemory({
        instance: target.instance,
        agentGroupId: target.agent.nanoclawAgentGroupId,
        path: parseAgentMemoryPath(params.path),
      });
      return { content: [{ type: "text", text: file.content }], details: { file } };
    },
  });
});
