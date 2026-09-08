import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

export const CHAT_WORKFLOW_AGENT_HANDOFF_CUSTOM_TYPE = "chat.workflow_agent_handoff";
export const CHAT_PLANNER_OUTPUT_REPAIR_CUSTOM_TYPE = "chat.planner_output_repair";

/** Old control messages remain on disk; only this invocation's controls reach the model. */
export function prepareWorkflowTurnContext(
  messages: AgentMessage[],
  input: { readonly workflowId: string; readonly invocationId: string; readonly stageId: string; readonly agentId: string },
): AgentMessage[] {
  const history = messages.filter((message) => {
    if (message.role !== "custom" || ![
      CHAT_WORKFLOW_AGENT_HANDOFF_CUSTOM_TYPE,
      CHAT_PLANNER_OUTPUT_REPAIR_CUSTOM_TYPE,
    ].includes(message.customType)) return true;
    const details = message.details;
    return typeof details === "object" && details !== null
      && "invocationId" in details && details.invocationId === input.invocationId
      && "stageId" in details && details.stageId === input.stageId
      && "agentId" in details && details.agentId === input.agentId;
  });
  return injectInstructionBeforeLatestUser(history, {
    customType: "chat.workflow_turn_context",
    details: input,
    content: [
      `当前Workflow=${input.workflowId}，本轮Invocation=${input.invocationId}，Stage=${input.stageId}，Agent=${input.agentId}。`,
      "历史用户消息、回答和工具结果是上下文，不代表本轮继续执行历史阶段或沿用历史批准。",
      "按当前Agent定义、本轮用户消息和本轮阶段交接完成任务；只使用本次实际提供的工具。",
    ].join("\n"),
  });
}

/** Writes a human utterance exactly once through Pi's native message contract. */
export function appendChatUserMessage(
  sessionManager: SessionManager,
  text: string,
  timestamp = Date.now(),
): string {
  return sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  });
}

/** Resolves the native AssistantMessage just persisted by a completed Agent turn. */
export function requireNativeAssistantLeafId(sessionManager: SessionManager): string {
  const leaf = sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") {
    throw new Error("Agent执行完成后没有原生Assistant MessageEntry");
  }
  return leaf.id;
}

/**
 * Adds ephemeral model-facing instructions without changing the persisted role
 * of the human utterance that triggered the turn.
 */
export function injectInstructionBeforeLatestUser(
  messages: AgentMessage[],
  input: { readonly customType: string; readonly content: string; readonly details?: unknown },
): AgentMessage[] {
  const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
  const insertionIndex = latestUserIndex === -1 ? messages.length : latestUserIndex;
  const instruction = {
    role: "custom" as const,
    customType: input.customType,
    content: input.content,
    display: false,
    ...(input.details === undefined ? {} : { details: input.details }),
    timestamp: Date.now(),
  } satisfies AgentMessage;
  return [
    ...messages.slice(0, insertionIndex),
    instruction,
    ...messages.slice(insertionIndex),
  ];
}

/**
 * Triggers a downstream Agent when no human authored a new utterance (for
 * example after an approval click). The hidden CustomMessage is an internal
 * handoff, participates in model context, and never impersonates a user.
 */
export async function triggerChatWorkflowAgentHandoff(
  session: AgentSession,
  input: {
    readonly workflowId: string;
    readonly invocationId: string;
    readonly stageId: string;
    readonly agentId: string;
    readonly inputEntryIds: readonly string[];
    readonly content: string;
  },
): Promise<void> {
  await session.sendCustomMessage({
    customType: CHAT_WORKFLOW_AGENT_HANDOFF_CUSTOM_TYPE,
    content: input.content,
    display: false,
    details: {
      schemaVersion: 1,
      workflowId: input.workflowId,
      invocationId: input.invocationId,
      stageId: input.stageId,
      agentId: input.agentId,
      inputEntryIds: [...input.inputEntryIds],
    },
  }, { triggerTurn: true });
}
