import type { ConversationConsultationInput, ConversationDiscussionInput } from "../../long-agents/conversations/orchestrator.js";

/** Serializable input for the durable group orchestration workflow. */
export type GroupDiscussionWorkflowInput =
  | { readonly kind: "discussion"; readonly input: ConversationDiscussionInput }
  | { readonly kind: "consultation"; readonly input: ConversationConsultationInput };
