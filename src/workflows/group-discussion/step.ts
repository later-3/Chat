import {
  runConversationConsultation,
  runConversationDiscussion,
  type ConversationDiscussionResult,
} from "../../long-agents/conversations/orchestrator.js";
import type { GroupDiscussionWorkflowInput } from "./types.js";

/**
 * One durable step per round/consultation. Execution still goes through the public Pi factory inside
 * `dispatchConversationAttempt`, and every attempt has a deterministic id, so a step retry after a
 * crash re-reads the stored attempt instead of calling the model twice.
 */
export async function runGroupDiscussionStep(payload: GroupDiscussionWorkflowInput): Promise<ConversationDiscussionResult> {
  "use step";
  return payload.kind === "consultation"
    ? await runConversationConsultation(payload.input)
    : await runConversationDiscussion(payload.input);
}

// A retry must never replay an unknown side effect; the orchestrator itself is the recovery path.
runGroupDiscussionStep.maxRetries = 0;
