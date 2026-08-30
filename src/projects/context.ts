import { resolveProjectContext } from "./registry.js";
import type { ChatExecutionContext } from "./types.js";

export async function createChatExecutionContext(input: {
  readonly projectId: string;
  readonly chatHome?: string;
  readonly sessionId?: string;
  readonly workflowId?: string;
  readonly workflowInvocationId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
}): Promise<ChatExecutionContext> {
  const project = await resolveProjectContext(input.projectId, input.chatHome);
  return {
    ...project,
    personalId: "later",
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
    ...(input.workflowInvocationId === undefined ? {} : { workflowInvocationId: input.workflowInvocationId }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
  };
}
