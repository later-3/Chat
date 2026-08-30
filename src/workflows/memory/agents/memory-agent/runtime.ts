import { ensureChatDataLayout } from "../../../../chat-data.js";
import { getChatMemoryService } from "../../../../memory/runtime.js";
import type { WorkflowAgentSessionExtensions } from "../../../agent-definition.js";
import type { ChatWorkflowAgentSessionContext } from "../../../registry.js";
import { stripLegacyPlanningHandoffs } from "../../../planning-execution/context.js";
import { MEMORY_AGENT } from "./index.js";
import { ensureMemorySkill } from "./skill.js";
import { createMemoryTools } from "./tools/index.js";

const inspectionMemoryService = {
  search(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
  list(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
  get(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
  create(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
  update(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
  delete(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
};

/** The single runtime assembly path used by Memory execution and inspection. */
export async function prepareMemoryAgentSession(
  context: ChatWorkflowAgentSessionContext,
): Promise<WorkflowAgentSessionExtensions> {
  if (context.workflowId !== "memory" || context.agentId !== MEMORY_AGENT.id) {
    throw new Error(`Memory Workflow不能装配Agent: ${context.workflowId}/${context.agentId}`);
  }
  const paths = await ensureChatDataLayout();
  const skillPath = await ensureMemorySkill(paths.memoryDir);
  return {
    additionalSkillPaths: [skillPath],
    customTools: createMemoryTools({
      service: context.purpose === "execution"
        ? await getChatMemoryService()
        : inspectionMemoryService,
      projectId: context.cwd,
      sessionId: context.sessionId,
      workflowInvocationId: context.workflowInvocationId,
    }),
    transformContext: stripLegacyPlanningHandoffs,
  };
}
