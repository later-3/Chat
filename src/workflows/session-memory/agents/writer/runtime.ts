import {
  prepareWorkflowTurnContext,
  projectCurrentRoundContext,
} from "../../../session-conversation.js";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { WorkflowAgentSessionExtensions } from "../../../agent-definition.js";
import type { ChatWorkflowAgentSessionContext } from "../../../registry.js";
import { sessionMemorySkillPath } from "../skill-path.js";
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
  // The writer is declared as the `remember` node of EVERY interactive Workflow, so it assembles for any
  // of them (its own turn always runs under the session-memory Workflow, which owns the stage contract).
  if (context.agentId !== SESSION_MEMORY_WRITER_AGENT.id) {
    throw new Error(`Session Memory Writer不能装配Agent: ${context.workflowId}/${context.agentId}`);
  }
  const turn = {
    workflowId: context.workflowId,
    invocationId: context.workflowInvocationId,
    // The Workflow manifest fixes this agent's stage id.
    stageId: "remember",
    agentId: SESSION_MEMORY_WRITER_AGENT_ID,
  };
  return {
    additionalSkillPaths: [sessionMemorySkillPath()],
    transformContext: () => {
      // The round is read from the DURABLE Session branch, never from the messages handed to this
      // transform: a Workflow agent session is assembled with its own assembly/control entries and does
      // not carry the conversation, so projecting that list would always find "no round" and refuse.
      const round = currentRoundMessagesOf(context.sessionManager);
      if (round === null) throw new SessionMemoryRoundUnavailableError();
      return prepareWorkflowTurnContext(round, turn);
    },
  };
}

/**
 * The current round read from the durable Session: the round's own user entry plus the whole work stage.
 * `getContextBranch()` applies the same entry filter the model context uses (internal control messages of
 * other invocations stay out), and each entry is converted exactly as Pi builds context messages.
 */
function currentRoundMessagesOf(sessionManager: {
  getContextBranch?: () => readonly unknown[];
  getBranch: () => readonly unknown[];
}): AgentMessage[] | null {
  const branch = (sessionManager.getContextBranch ?? sessionManager.getBranch).call(sessionManager);
  const messages = (branch as readonly Parameters<typeof sessionEntryToContextMessages>[0][])
    .flatMap((entry) => sessionEntryToContextMessages(entry)) as AgentMessage[];
  return projectCurrentRoundContext(messages);
}
