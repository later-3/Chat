import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import manifestJson from "./tool.json" with { type: "json" };
import { parseAgentMemoryPath } from "../../../long-agents/agent-group-service.js";
import { listNanoClawAgentMemory, readNanoClawAgentMemory, type NanoClawMemoryFile, type NanoClawMemoryFileSummary } from "../../../long-agents/nanoclaw-client.js";
import { defineChatSystemTool } from "../../framework.js";
import {
  bindAgentMemoryToolRuntime,
  resolveAgentMemoryToolTarget,
  throwIfAgentMemoryToolAborted,
} from "../agent-memory/runtime.js";

const promptGuidelines = [
  "Agent Memory is your private NanoClaw OKF Markdown store, separate from Chat Personal/Project memory and Session history. Use agent_memory_read without path to list files; use a returned relative path to read one file. Do not look for this store using filesystem tools or native container paths.",
  "The read result includes content and revision. To update with agent_memory_write, preserve the file's Markdown/frontmatter and pass that exact revision as expectedRevision; null is only for creating a missing file. On conflict, read again before merging.",
];

function memoryResult(details: { file: NanoClawMemoryFile } | { files: readonly NanoClawMemoryFileSummary[] }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export const AGENT_MEMORY_READ_TOOL_PROVIDER = defineChatSystemTool(manifestJson, (baseContext) => {
  const context = bindAgentMemoryToolRuntime(baseContext);
  return defineTool({
    name: manifestJson.name,
    label: manifestJson.label,
    description: [manifestJson.description, ...promptGuidelines].join("\n"),
    promptGuidelines,
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1, description: "OKF Markdown path relative to this Agent Group's memory root. Omit to list files." })),
    }),
    async execute(_toolCallId, params, signal) {
      throwIfAgentMemoryToolAborted(signal);
      const target = await resolveAgentMemoryToolTarget(context);
      if (params.path === undefined) {
        const files = await listNanoClawAgentMemory(target.instance, target.agent.nanoclawAgentGroupId);
        return memoryResult({ files });
      }
      const file = await readNanoClawAgentMemory({
        instance: target.instance,
        agentGroupId: target.agent.nanoclawAgentGroupId,
        path: parseAgentMemoryPath(params.path),
      });
      // Pi sends content to the model; details are UI metadata and cannot carry the only CAS token.
      return memoryResult({ file });
    },
  });
});
