import type {
  AgentContextTransform,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ChatSession } from "../chat-session.js";
import type { ChatToolRuntimeContext } from "../tools/framework.js";
import {
  buildChatAgentCustomInstructions,
  createChatPiAgentSession,
  type CreatedChatPiAgentSession,
} from "../agents/pi-agent-session.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgentDefinition } from "./agent-config.js";
import { prepareWorkflowTurnContext } from "./session-conversation.js";

export {
  parseWorkflowAgentDefinition,
  parseAgentConfigSelection,
  type AgentConfigSelection,
  type AgentPromptResourceSelection,
  type ResolvedWorkflowAgentDefinition,
  type WorkflowAgentDefinition,
  type WorkflowAgentResources,
} from "./agent-config.js";
export { resolveWorkflowAgentDefinition } from "./agent-config-loader.js";

export interface CreateWorkflowAgentSessionOptions {
  readonly chatSession: ChatSession;
  readonly sessionManager: SessionManager;
  readonly agent: WorkflowAgentDefinition;
  readonly additionalSkillPaths?: readonly string[];
  readonly customTools?: readonly ToolDefinition[];
  readonly transformContext?: AgentContextTransform;
  readonly toolContext?: Omit<
    ChatToolRuntimeContext,
    "projectId" | "chatHome" | "cwd" | "sessionManager" | "sessionId"
  >;
}

/** Workflow-owned additions applied identically during execution and inspection. */
export interface WorkflowAgentSessionExtensions {
  readonly additionalSkillPaths?: readonly string[];
  readonly customTools?: readonly ToolDefinition[];
  readonly transformContext?: AgentContextTransform;
}

export type CreatedWorkflowAgentSession = CreatedChatPiAgentSession;
export { buildChatAgentCustomInstructions };

/**
 * Creates one Pi AgentSession from the Agent definition owned by a Workflow.
 * Session selection stays with Chat; Agent capability assembly is centralized
 * here so individual Workflows do not recreate Pi's ResourceLoader setup.
 */
export async function createWorkflowAgentSession(
  options: CreateWorkflowAgentSessionOptions,
): Promise<CreatedWorkflowAgentSession> {
  const context = options.toolContext;
  if (context?.purpose !== "execution" || context.workflowId === undefined
    || context.workflowInvocationId === undefined || context.stageId === undefined
    || context.agentId === undefined) return createChatPiAgentSession(options);
  const turn = {
    workflowId: context.workflowId,
    invocationId: context.workflowInvocationId,
    stageId: context.stageId,
    agentId: context.agentId,
  };
  return createChatPiAgentSession({
    ...options,
    transformContext: async (messages, signal) => {
      const current = prepareWorkflowTurnContext(messages, turn);
      return options.transformContext === undefined ? current : options.transformContext(current, signal);
    },
  });
}
