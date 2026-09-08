import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CHAT_PLANNER_OUTPUT_REPAIR_CUSTOM_TYPE, injectInstructionBeforeLatestUser } from "../session-conversation.js";

export const LEGACY_PLANNING_HANDOFF_CUSTOM_TYPE = "planning-execution-handoff";

/** Exact, versioned task brief supplied to Pi Coding Agent for this execution. */
export function buildPlanningExecutionTaskBrief(input: {
  readonly userRequest: string;
  readonly approvedPlan: string;
  readonly approvedPlanRevision: number;
}): string {
  return [
    "<workflow_execution_task_brief>",
    JSON.stringify({
      schemaVersion: 1,
      kind: "planning_execution_task_brief",
      task: {
        userRequest: input.userRequest,
        approvedPlanRevision: input.approvedPlanRevision,
        approvedPlan: input.approvedPlan,
      },
      executionContract: {
        objective: "完成用户真实请求，并交付已批准计划定义的本轮结果。",
        startRule: "计划已完成前置澄清；先执行可推进的工作，不重复向用户收集任务书中已有信息。",
        discoveryRule: "可通过工具验证或调查的事实由Executor主动完成。",
        authorityRule: "只在任务书授权边界内行动；另行授权点必须在动作前停止。",
        completionReport: ["已完成交付物", "关键结果", "验证证据", "剩余风险或阻塞"],
      },
    }, null, 2),
    "</workflow_execution_task_brief>",
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
    readonly previousPlan?: string;
    readonly workflowId?: string;
  },
): AgentMessage[] {
  const history = stripLegacyPlanningHandoffs(messages).filter((message) => {
    if (message.role !== "custom" || message.customType !== CHAT_PLANNER_OUTPUT_REPAIR_CUSTOM_TYPE) return true;
    const details = message.details;
    return typeof details === "object" && details !== null
      && "planRevision" in details && details.planRevision === input.planRevision;
  });
  return injectInstructionBeforeLatestUser(history, {
    customType: "chat.planning_revision_context",
    details: {
      workflow: input.workflowId ?? "planning-execution",
      invocationId: input.invocationId,
      planRevision: input.planRevision,
    },
    content: [
      input.previousPlan === undefined
        ? "你现在进入新一轮的Planner阶段。最新一条原生user消息是本轮任务，历史Executor回答仅供参考。"
        : `你正在修订第${String(input.planRevision)}版计划。最新一条原生user消息是审核人对上一版计划的修改意见。`,
      "请逐条响应用户信息，重新完成任务理解和就绪判定，并输出可独立审核的完整任务澄清稿或执行计划；不要执行任务，也不要只输出差异。",
      "即使任务是编写或修订方案，也应先生成交给下游Agent的计划，不能直接代替它交付。第一行必须遵守System Prompt中的chat-planner-output协议。",
      ...(input.previousPlan === undefined ? [] : ["<previous_plan>", input.previousPlan, "</previous_plan>"]),
    ].join("\n"),
  });
}
