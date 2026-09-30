import { collectChatWorkflowStageMarkers } from "../../../workflow-stage.js";
import { prepareWorkflowTurnContext } from "../../../session-conversation.js";
import { buildContextEntries, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
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
 * The writer must judge ONE round: the round's user/work entries that remain in Pi context, including
 * a summary generated during the round if compaction replaced earlier text. The transform projects
 * that scope before the invocation control filter — `prepareWorkflowTurnContext` alone keeps history. When the projection
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
    contextFilesPolicy: "none",
    additionalSkillPaths: [sessionMemorySkillPath()],
    transformContext: () => {
      // Resolve the round from durable stage identities, then respect Pi's active compaction boundary.
      // Re-injecting the raw branch here would undo compaction on every provider request.
      const round = currentRoundMessagesOf(context.sessionManager, context.workflowInvocationId);
      if (round === null) throw new SessionMemoryRoundUnavailableError();
      return prepareWorkflowTurnContext(round, turn);
    },
  };
}

/**
 * The durable branch determines ownership; Pi determines which entries remain in context. A summary
 * created during this round replaces its compacted messages. Earlier round summaries are not injected.
 * Original messages stay on disk, including when the round's first user entry was compacted away.
 */
function currentRoundMessagesOf(sessionManager: {
  getContextBranch?: () => readonly unknown[];
  getBranch: () => readonly unknown[];
}, invocationId: string): AgentMessage[] | null {
  // Keep the complete parent chain for native tree traversal. Filtering before buildContextEntries
  // would leave missing parent IDs at hidden handoffs and cut off the preceding conversation.
  const branch = sessionManager.getBranch() as readonly SessionEntry[];
  const allowedIds = new Set(((sessionManager.getContextBranch ?? sessionManager.getBranch)
    .call(sessionManager) as readonly SessionEntry[]).map(entry => entry.id));
  const start = collectChatWorkflowStageMarkers(branch).find(stage => stage.invocationId === invocationId && stage.stageId !== "remember");
  const startIndex = start === undefined ? -1 : branch.findIndex(entry => typeof entry === "object" && entry !== null && "id" in entry && entry.id === start.entryId);
  // Review/revision adds native user messages within ONE invocation. Keep the whole current workflow
  // round, not just the final approval. Legacy queue rounds lack a work-stage marker and keep the fallback.
  const firstUser = startIndex < 0
    ? branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "user")
    : branch.findIndex((entry, index) => index > startIndex && entry.type === "message" && entry.message.role === "user");
  if (firstUser < 0) return null;
  const roundIds = new Set(branch.slice(firstUser).map(entry => entry.id));
  return buildContextEntries([...branch])
    .filter(entry => roundIds.has(entry.id) && allowedIds.has(entry.id))
    .flatMap(sessionEntryToContextMessages);
}
