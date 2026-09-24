import {
  prepareWorkflowTurnContext,
  projectCurrentRoundContext,
} from "../../../session-conversation.js";
import type { WorkflowAgentSessionExtensions } from "../../../agent-definition.js";
import type { ChatWorkflowAgentSessionContext } from "../../../registry.js";
import { SESSION_MEMORY_WRITER_AGENT, SESSION_MEMORY_WRITER_AGENT_ID } from "./index.js";

/** Raised when a round cannot be projected, so the writer refuses instead of recording history. */
export class SessionMemoryRoundUnavailableError extends Error {
  readonly code = "SESSION_MEMORY_ROUND_UNAVAILABLE";
  constructor() {
    super("本会话没有可记录的本轮用户消息：会话记忆写入拒绝执行，本轮不写记忆");
    this.name = "SessionMemoryRoundUnavailableError";
  }
}

/**
 * The single runtime assembly path for the session-memory writer (execution and inspection).
 *
 * The writer must judge exactly ONE round: the round's own user entry plus the whole `work` stage. That
 * is why the context transform projects the current round FIRST and only then applies the invocation
 * control filter — `prepareWorkflowTurnContext` alone keeps the entire history. When the projection
 * cannot find a user entry it throws instead of handing over every previous round, so a round without a
 * user message fails visibly and writes nothing.
 */
export async function prepareSessionMemoryWriterSession(
  context: ChatWorkflowAgentSessionContext,
): Promise<WorkflowAgentSessionExtensions> {
  if (context.workflowId !== "session-memory" || context.agentId !== SESSION_MEMORY_WRITER_AGENT.id) {
    throw new Error(`Session Memory Workflow不能装配Agent: ${context.workflowId}/${context.agentId}`);
  }
  const turn = {
    workflowId: context.workflowId,
    invocationId: context.workflowInvocationId,
    // The Workflow manifest fixes this agent's stage id.
    stageId: "remember",
    agentId: SESSION_MEMORY_WRITER_AGENT_ID,
  };
  return {
    transformContext: (messages, signal) => {
      const round = projectCurrentRoundContext(messages);
      if (round === null) throw new SessionMemoryRoundUnavailableError();
      return prepareWorkflowTurnContext(round, turn);
    },
  };
}
