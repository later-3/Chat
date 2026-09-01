import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { injectInstructionBeforeLatestUser } from "../session-conversation.js";

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

/** Keeps review feedback as a native user message while giving Planner explicit revision context. */
export function injectPlanningRevisionContext(
  messages: AgentMessage[],
  input: {
    readonly invocationId: string;
    readonly planRevision: number;
    readonly previousPlan: string;
  },
): AgentMessage[] {
  return injectInstructionBeforeLatestUser(stripLegacyPlanningHandoffs(messages), {
    customType: "chat.planning_revision_context",
    details: {
      workflow: "planning-execution",
      invocationId: input.invocationId,
      planRevision: input.planRevision,
    },
    content: [
      `你正在修订第${String(input.planRevision)}版计划。`,
      "最新一条原生user消息是审核人对上一版计划的修改意见。",
      "请逐条响应意见并输出可独立审核的完整计划；不要执行任务，也不要只输出差异。",
      "<previous_plan>",
      input.previousPlan,
      "</previous_plan>",
    ].join("\n"),
  });
}
