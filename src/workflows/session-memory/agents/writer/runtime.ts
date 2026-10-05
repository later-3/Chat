import { buildContextEntries, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { WorkflowAgentSessionExtensions } from "../../../agent-definition.js";
import type { ChatWorkflowAgentSessionContext } from "../../../registry.js";
import { sessionMemorySkillPath } from "../skill-path.js";
import { SESSION_MEMORY_WRITER_AGENT } from "./index.js";

/**
 * The single runtime assembly path for the session-memory writer (execution and inspection).
 *
 * The writer judges the WHOLE session: every entry that remains in Pi context, respecting the active
 * compaction boundary. The round is manually triggered by the user; their message is the round's
 * instruction and — being part of the session — part of the projection.
 */
export async function prepareSessionMemoryWriterSession(
  context: ChatWorkflowAgentSessionContext,
): Promise<WorkflowAgentSessionExtensions> {
  // The writer is the single `remember` node of the session-memory Workflow, which owns the stage contract.
  if (context.workflowId !== "session-memory" || context.agentId !== SESSION_MEMORY_WRITER_AGENT.id) {
    throw new Error(`Session Memory Writer不能装配Agent: ${context.workflowId}/${context.agentId}`);
  }
  return {
    contextFilesPolicy: "none",
    additionalSkillPaths: [sessionMemorySkillPath()],
    transformContext: () => wholeSessionMessagesOf(context.sessionManager),
  };
}

/**
 * The durable branch determines ownership; Pi determines which entries remain in context. A summary
 * created by compaction replaces the messages it covers; earlier history stays on disk. Original
 * messages are never re-injected, so the projection never undoes compaction.
 */
function wholeSessionMessagesOf(sessionManager: {
  getContextBranch?: () => readonly unknown[];
  getBranch: () => readonly unknown[];
}): AgentMessage[] {
  // Keep the complete parent chain for native tree traversal. Filtering before buildContextEntries
  // would leave missing parent IDs at hidden handoffs and cut off the preceding conversation.
  const branch = sessionManager.getBranch() as readonly SessionEntry[];
  const allowedIds = new Set(((sessionManager.getContextBranch ?? sessionManager.getBranch)
    .call(sessionManager) as readonly SessionEntry[]).map(entry => entry.id));
  return buildContextEntries([...branch])
    .filter(entry => allowedIds.has(entry.id))
    .flatMap(sessionEntryToContextMessages);
}
