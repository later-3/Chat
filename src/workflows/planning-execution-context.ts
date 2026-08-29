import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildPlanningExecutionInput } from "./planning-execution-prompts.js";

export const LEGACY_PLANNING_HANDOFF_CUSTOM_TYPE = "planning-execution-handoff";

/** Removes handoff messages written by older Chat builds before they reach the model. */
export function stripLegacyPlanningHandoffs(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => (
    message.role !== "custom"
    || message.customType !== LEGACY_PLANNING_HANDOFF_CUSTOM_TYPE
  ));
}

/** Adds this Workflow's structured input to the current model request. */
export function injectPlanningExecutionContext(
  messages: AgentMessage[],
  userPrompt: string,
  plan: string,
  invocationId: string,
): AgentMessage[] {
  const cleanMessages = stripLegacyPlanningHandoffs(messages);
  const latestUserIndex = cleanMessages.findLastIndex((message) => message.role === "user");
  const insertionIndex = latestUserIndex === -1 ? cleanMessages.length : latestUserIndex;
  const plannerContext = {
    role: "custom" as const,
    customType: "chat.planning_execution_context",
    content: buildPlanningExecutionInput(userPrompt, plan),
    display: false,
    details: { workflow: "planning-execution", invocationId },
    timestamp: Date.now(),
  } satisfies AgentMessage;

  return [
    ...cleanMessages.slice(0, insertionIndex),
    plannerContext,
    ...cleanMessages.slice(insertionIndex),
  ];
}
