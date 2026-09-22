import type { ConversationDiscussionResult } from "../../long-agents/conversations/orchestrator.js";
import { runGroupDiscussionStep } from "./step.js";
import type { GroupDiscussionWorkflowInput } from "./types.js";

/**
 * Durable orchestration entry for group work.
 *
 * Strategies, budget and stop reasons all live in the single orchestrator; this Workflow only gives
 * it a durable run so a crash can recover queued work instead of losing it. It is not a
 * user-selectable Chat Workflow: its Agents are the group's dynamic Friends, not static Workflow
 * agent definitions, so it is started directly by the conversation service.
 */
export async function groupDiscussionWorkflow(payload: GroupDiscussionWorkflowInput): Promise<ConversationDiscussionResult> {
  "use workflow";
  return await runGroupDiscussionStep(payload);
}
