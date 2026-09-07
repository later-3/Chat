import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import manifestJson from "./tool.json" with { type: "json" };
import { appendChatAuditEvent } from "../../../audit-log.js";
import { parseAgentMemoryPath } from "../../../long-agents/agent-group-service.js";
import { writeNanoClawAgentMemory } from "../../../long-agents/nanoclaw-client.js";
import { defineChatSystemTool } from "../../framework.js";
import {
  bindAgentMemoryToolRuntime,
  resolveAgentMemoryToolTarget,
  throwIfAgentMemoryToolAborted,
} from "../agent-memory/runtime.js";

export const AGENT_MEMORY_WRITE_TOOL_PROVIDER = defineChatSystemTool(manifestJson, (baseContext) => {
  const context = bindAgentMemoryToolRuntime(baseContext);
  return defineTool({
    name: manifestJson.name,
    label: manifestJson.label,
    description: manifestJson.description,
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "OKF Markdown path relative to this Agent Group's memory root." }),
      content: Type.String({ maxLength: 921_600 }),
      expectedRevision: Type.Union([
        Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
        Type.Null(),
      ], { description: "Current file revision, or null only when the file must not exist." }),
    }),
    async execute(toolCallId, params, signal) {
      throwIfAgentMemoryToolAborted(signal);
      const target = await resolveAgentMemoryToolTarget(context);
      const file = await writeNanoClawAgentMemory({
        instance: target.instance,
        agentGroupId: target.agent.nanoclawAgentGroupId,
        path: parseAgentMemoryPath(params.path),
        content: params.content,
        expectedRevision: params.expectedRevision,
      });
      await appendChatAuditEvent({
        action: "long-agent.agent-memory.write",
        target: {
          longAgentId: target.agent.id,
          agentGroupId: target.agent.nanoclawAgentGroupId,
        },
        source: {
          type: "pi-tool",
          projectId: context.projectId,
          sessionId: context.sessionId,
          turnId: context.longAgentTurnId ?? null,
          toolCallId,
        },
        details: { resourcePath: file.path, revision: file.revision, result: "written" },
      }, context.chatHome);
      return {
        content: [{ type: "text", text: `Agent memory saved: ${file.path} (${file.revision})` }],
        details: { file },
      };
    },
  });
});
