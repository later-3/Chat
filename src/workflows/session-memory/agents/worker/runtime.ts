import type { WorkflowAgentSessionExtensions } from "../../../agent-definition.js";
import type { ChatWorkflowAgentSessionContext } from "../../../registry.js";
import { sessionMemorySkillPath } from "../skill-path.js";
import { SESSION_MEMORY_WORKER_AGENT } from "./index.js";

/**
 * The single runtime assembly path for the session-memory worker. The worker keeps the ordinary
 * continuous conversation (no round projection) and reads memory ON DEMAND through the Skill + tool.
 */
export async function prepareSessionMemoryWorkerSession(
  context: ChatWorkflowAgentSessionContext,
  options: { readonly memoryEnabled?: boolean } = {},
): Promise<WorkflowAgentSessionExtensions> {
  if (context.workflowId !== "session-memory" || context.agentId !== SESSION_MEMORY_WORKER_AGENT.id) {
    throw new Error(`Session Memory Workflow不能装配Agent: ${context.workflowId}/${context.agentId}`);
  }
  // Memory off: the worker does the same work without the read Skill and without the memory tool.
  return options.memoryEnabled === false ? {} : { additionalSkillPaths: [sessionMemorySkillPath()] };
}
