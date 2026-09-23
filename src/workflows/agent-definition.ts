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
import { inheritSessionMemoryTarget } from "./session-memory-target.js";
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
 * in createChatPiAgentSession so individual Workflows do not recreate Pi's ResourceLoader setup.
 * 本包装只增加 Workflow 本轮上下文投影；检查路径同样调用公共装配，
 * 不要在此新增与 Long Agent 不一致的模型、Skill 或 Tool 加载分支。
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
  // Inherit the dispatching session's session-memory target from the durable run binding, so a
  // workflow's internal agents write memory to the originating session (never the child session).
  const inheritedTarget = await inheritSessionMemoryTarget({
    toolContextTarget: context.sessionMemoryTarget,
    projectDataDir: options.chatSession.projectContext?.projectDataDir,
    workflowInvocationId: context.workflowInvocationId,
  });
  const withTarget = inheritedTarget === undefined
    ? options
    : { ...options, toolContext: { ...context, sessionMemoryTarget: inheritedTarget } };
  return createChatPiAgentSession({
    ...withTarget,
    transformContext: async (messages, signal) => {
      const current = prepareWorkflowTurnContext(messages, turn);
      return withTarget.transformContext === undefined ? current : withTarget.transformContext(current, signal);
    },
  });
}
