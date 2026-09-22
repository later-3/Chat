import { start } from "workflow/api";
import type { ConversationConsultationInput, ConversationDiscussionInput } from "../../long-agents/conversations/orchestrator.js";
import { groupDiscussionWorkflow } from "./workflow.js";

/**
 * Start one durable group discussion round (or A→B→A consultation). This is the only entry the
 * HTTP/Tool layer uses; it deliberately does not go through `startChatWorkflow`, whose input/Agent
 * model is the static Chat Workflow contract rather than the group's dynamic Friends.
 */
export async function startGroupDiscussion(input: ConversationDiscussionInput): Promise<{ runId: string }> {
  const run = await start(groupDiscussionWorkflow, [{ kind: "discussion", input }]);
  return { runId: run.runId };
}

export async function startConversationConsultation(input: ConversationConsultationInput): Promise<{ runId: string }> {
  const run = await start(groupDiscussionWorkflow, [{ kind: "consultation", input }]);
  return { runId: run.runId };
}
