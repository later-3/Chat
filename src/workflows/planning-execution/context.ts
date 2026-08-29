import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const LEGACY_PLANNING_HANDOFF_CUSTOM_TYPE = "planning-execution-handoff";

/** Exact Workflow input supplied to Pi Coding Agent for this execution. */
export function buildPlanningExecutionInput(userPrompt: string, plan: string): string {
  return [
    "<workflow_execution_input>",
    JSON.stringify({ userRequest: userPrompt, plannerOutput: plan }, null, 2),
    "</workflow_execution_input>",
  ].join("\n");
}

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
