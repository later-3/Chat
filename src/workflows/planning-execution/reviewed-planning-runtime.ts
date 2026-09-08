import { openChatSession, type ChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import {
  createWorkflowAgentSession,
  type ResolvedWorkflowAgentDefinition,
} from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import { createChatRunEventPublisher } from "../chat-run-events.js";
import {
  appendChatUserMessage,
  requireNativeAssistantLeafId,
  CHAT_PLANNER_OUTPUT_REPAIR_CUSTOM_TYPE,
} from "../session-conversation.js";
import {
  appendChatWorkflowAgentInput,
  appendChatWorkflowStage,
} from "../workflow-stage.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflow-configuration.js";
import { MAX_PLANNING_RESULT_CHARS } from "./agents/planner/index.js";
import { injectPlanningRevisionContext } from "./context.js";
import { parsePlannerOutput, type ParsedPlannerOutput } from "./planner-output.js";
import {
  appendPlanReview,
  appendPlanReviewDecision,
  collectPlanReviewDecisions,
  hasPlanReview,
  hasPlanReviewDecision,
  planReviewDecisionMessage,
  planSha256,
  publishPlanReviewState,
  setPlanningExecutionPhase,
  type ChatPlanReview,
} from "./review-state.js";
import type {
  PlanningRevisionStepInput,
  PlanningRevisionStepResult,
  PublishPlanReviewStepInput,
  RecordPlanReviewDecisionStepInput,
  RecordPlanReviewDecisionStepResult,
  ReviewedPlanningProfile,
  ReviewedPlanningStepResult,
} from "./steps.js";
import type { ChatWorkflowInput } from "../types.js";

function requireProjectContext(chatSession: ChatSession) {
  if (chatSession.projectContext === undefined) throw new Error("Planning Workflow缺少Project上下文");
  return chatSession.projectContext;
}

async function markReviewedPlanningFailed(
  chatSession: ChatSession,
  workflowInvocationId: string,
  workflowId: string,
): Promise<void> {
  try {
    const project = requireProjectContext(chatSession);
    await setPlanningExecutionPhase({
      projectDataDir: project.projectDataDir,
      projectId: project.projectId,
      workflowId,
      workflowInvocationId,
      sessionId: chatSession.manager.getSessionId(),
      phase: "failed",
    });
  } catch (error) {
    console.error(
      `${localTimestamp()} [reviewed-planning] failed to persist terminal state error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runPlannerIteration(input: {
  readonly chatSession: ChatSession;
  readonly workflowId: string;
  readonly plannerAgentId: string;
  readonly workflowInvocationId: string;
  readonly userMessage?: string;
  readonly inputEntryIds: readonly string[];
  readonly planRevision: number;
  readonly previousPlan?: string;
  readonly agent: ResolvedWorkflowAgentDefinition;
}): Promise<PlanningRevisionStepResult> {
  const stepStartedAt = Date.now();
  const project = requireProjectContext(input.chatSession);
  await setPlanningExecutionPhase({
    projectDataDir: project.projectDataDir,
    projectId: project.projectId,
    workflowId: input.workflowId,
    workflowInvocationId: input.workflowInvocationId,
    sessionId: input.chatSession.manager.getSessionId(),
    phase: "planning",
  });
  appendChatWorkflowStage(input.chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: input.workflowId,
    stageId: "plan",
    agentId: input.plannerAgentId,
  });
  const userEntryId = input.userMessage === undefined
    ? undefined
    : appendChatUserMessage(input.chatSession.manager, input.userMessage);
  const inputEntryIds = [
    ...input.inputEntryIds,
    ...(userEntryId === undefined ? [] : [userEntryId]),
  ];
  appendChatWorkflowAgentInput(input.chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: input.workflowId,
    stageId: "plan",
    agentId: input.plannerAgentId,
    inputEntryIds,
  });

  console.log(`${localTimestamp()} [planner] revision=${input.planRevision} step starting cwd=${input.chatSession.cwd}`);
  const { session, toolResources, modelFallbackMessage } = await createWorkflowAgentSession({
    chatSession: input.chatSession,
    sessionManager: input.chatSession.manager,
    agent: input.agent,
    toolContext: {
      purpose: "execution",
      workflowId: input.workflowId,
      workflowInvocationId: input.workflowInvocationId,
      stageId: "plan",
      agentId: input.plannerAgentId,
    },
    transformContext: (messages) => injectPlanningRevisionContext(messages, {
      workflowId: input.workflowId,
      invocationId: input.workflowInvocationId,
      planRevision: input.planRevision,
      ...(input.previousPlan === undefined ? {} : { previousPlan: input.previousPlan }),
    }),
  });
  if (modelFallbackMessage !== undefined) {
    console.log(`${localTimestamp()} [planner] modelFallback=${modelFallbackMessage}`);
  }
  console.log(
    `${localTimestamp()} [planner] model=${session.model?.provider ?? "none"}/${session.model?.id ?? "none"}`,
  );

  const observer = subscribeAgentSessionLog(session, "planner", {
    workflowId: input.workflowId,
    stageId: "plan",
    nodeKind: "agent",
    agentId: input.plannerAgentId,
  }, {
    sessionManager: input.chatSession.manager,
    projectId: project.projectId,
    workflowInvocationId: input.workflowInvocationId,
    toolResources,
  });
  let completed = false;
  try {
    await session.resumePendingTurn();
    const readOutput = () => {
      const message = observer.getLastAssistantMessage();
      if (message === undefined) throw new Error("Planner Agent没有返回Assistant消息");
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error("Planner模型调用失败或已取消，不能作为输出格式修正");
      }
      return observer.getLastAssistantText();
    };
    const validateOutput = (text: string) => {
      if (text.length > MAX_PLANNING_RESULT_CHARS) {
        throw new Error(`规划结果不能超过${MAX_PLANNING_RESULT_CHARS}个字符`);
      }
      return parsePlannerOutput(text);
    };
    const plannerOutput = readOutput();
    let parsed: ParsedPlannerOutput;
    try {
      parsed = validateOutput(plannerOutput);
    } catch (error) {
      const validationError = error instanceof Error ? error.message : String(error);
      const activeTools = session.getActiveToolNames();
      console.warn(`${localTimestamp()} [planner] revision=${input.planRevision} output repair attempt=1 reason=${validationError}`);
      // One protocol repair, not a Step retry: preserve the failed answer and never rerun tools.
      session.setActiveToolsByName([]);
      try {
        await session.sendCustomMessage({
          customType: CHAT_PLANNER_OUTPUT_REPAIR_CUSTOM_TYPE,
          display: false,
          details: {
            schemaVersion: 1,
            workflowId: input.workflowId,
            invocationId: input.workflowInvocationId,
            stageId: "plan",
            agentId: input.plannerAgentId,
            planRevision: input.planRevision,
            attempt: 1,
            validationError,
          },
          content: [
            `Planner输出校验失败：${validationError}。这是唯一一次格式修正机会。`,
            "保留已有信息，重新输出符合当前Planner协议的完整待审核计划或澄清稿。不要执行用户任务，不重新调查，不调用工具。",
            '第一行必须是<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->，或将readiness设为needs_clarification并填写真实阻塞问题。',
            "不得为了通过校验而猜测就绪状态。第一行之后是完整Markdown计划正文。",
          ].join("\n"),
        }, { triggerTurn: true });
        const repairedOutput = readOutput();
        try {
          parsed = validateOutput(repairedOutput);
        } catch (repairError) {
          const failure = `Planner输出格式修正后仍不符合协议：${repairError instanceof Error ? repairError.message : String(repairError)}`;
          await session.sendCustomMessage({
            customType: "chat.planner_output_failure",
            display: true,
            details: { invocationId: input.workflowInvocationId, workflowId: input.workflowId },
            content: `${failure}。本轮未进入审核或执行；原始请求和两次回答均已保留，可以继续对话重新规划。`,
          });
          throw new Error(failure);
        }
      } finally {
        session.setActiveToolsByName(activeTools);
      }
    }

    const planEntryId = requireNativeAssistantLeafId(input.chatSession.manager);
    input.chatSession.manager.flush();
    console.log(
      `${localTimestamp()} [planner] revision=${input.planRevision} readiness=${parsed.readiness} chars=${parsed.document.length} elapsedMs=${Date.now() - stepStartedAt}`,
    );
    completed = true;
    return {
      plan: parsed.document,
      planEntryId,
      readiness: parsed.readiness,
      blockingQuestions: parsed.blockingQuestions,
      ...(userEntryId === undefined ? {} : { userEntryId }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${localTimestamp()} [planner] revision=${input.planRevision} failed elapsedMs=${Date.now() - stepStartedAt} error=${message}`,
    );
    await markReviewedPlanningFailed(input.chatSession, input.workflowInvocationId, input.workflowId);
    throw error;
  } finally {
    await observer.finish(!completed);
    session.dispose();
  }
}

export async function runReviewedPlanningStep(
  input: ChatWorkflowInput,
  profile: ReviewedPlanningProfile,
): Promise<ReviewedPlanningStepResult> {
  const chatSession = await openChatSession(input);
  try {
    const prepared = await prepareChatWorkflowTurnConfiguration(chatSession.manager, {
      invocationId: input.workflowInvocationId,
      workflowId: profile.workflowId,
      agents: profile.agents,
      cwd: chatSession.cwd,
      ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
      ...(chatSession.projectContext === undefined ? {} : { projectDataDir: chatSession.projectContext.projectDataDir }),
      ...(input.defaultAgentConfigs === undefined ? {} : { defaults: input.defaultAgentConfigs }),
      ...(input.agentConfigs === undefined ? {} : { adjustments: input.agentConfigs }),
    });
    const plannerAgent = prepared.agents[profile.plannerAgent.id];
    if (plannerAgent === undefined) throw new Error(`本轮配置缺少Planner Agent: ${profile.plannerAgent.id}`);
    const result = await runPlannerIteration({
      chatSession,
      workflowId: profile.workflowId,
      plannerAgentId: profile.plannerAgent.id,
      workflowInvocationId: input.workflowInvocationId,
      userMessage: input.prompt,
      inputEntryIds: [],
      planRevision: 1,
      agent: plannerAgent,
    });
    if (result.userEntryId === undefined) throw new Error("Planning Workflow没有写入原生用户消息");
    return {
      sessionId: chatSession.manager.getSessionId(),
      plan: result.plan,
      planEntryId: result.planEntryId,
      readiness: result.readiness,
      blockingQuestions: result.blockingQuestions,
      userEntryId: result.userEntryId,
      plannerAgent,
      agents: prepared.agents,
    };
  } catch (error) {
    await markReviewedPlanningFailed(chatSession, input.workflowInvocationId, profile.workflowId);
    throw error;
  }
}

export async function runReviewedPlanningRevisionStep(
  input: PlanningRevisionStepInput,
  profile: Pick<ReviewedPlanningProfile, "workflowId" | "plannerAgent">,
): Promise<PlanningRevisionStepResult> {
  const chatSession = await openChatSession(input);
  return runPlannerIteration({
    chatSession,
    workflowId: profile.workflowId,
    plannerAgentId: profile.plannerAgent.id,
    workflowInvocationId: input.workflowInvocationId,
    inputEntryIds: input.inputEntryIds,
    planRevision: input.planRevision,
    previousPlan: input.previousPlan,
    agent: input.agent,
  });
}

export async function publishReviewedPlan(
  input: PublishPlanReviewStepInput,
  workflowId: string,
): Promise<ChatPlanReview> {
  const chatSession = await openChatSession(input);
  try {
    const project = requireProjectContext(chatSession);
    const sha256 = planSha256(input.plan);
    const review: ChatPlanReview = {
      schemaVersion: 1,
      workflowId,
      stageId: "review",
      reviewId: `${input.workflowInvocationId}:${String(input.planRevision)}:${sha256.slice(0, 12)}`,
      workflowInvocationId: input.workflowInvocationId,
      sessionId: chatSession.manager.getSessionId(),
      planRevision: input.planRevision,
      planSha256: sha256,
      planEntryId: input.planEntryId,
      plan: input.plan,
      readiness: input.readiness,
      blockingQuestions: [...input.blockingQuestions],
      createdAt: new Date().toISOString(),
    };
    if (!hasPlanReview(chatSession.manager.getEntries(), review.reviewId)) {
      appendChatWorkflowStage(chatSession.manager, {
        invocationId: input.workflowInvocationId,
        workflowId,
        stageId: "review",
        nodeKind: "human",
      });
      appendPlanReview(chatSession.manager, review);
      chatSession.manager.flush();
    }
    await publishPlanReviewState({
      projectDataDir: project.projectDataDir,
      projectId: project.projectId,
      review,
    });
    const publisher = createChatRunEventPublisher({
      workflowId,
      stageId: "review",
      nodeKind: "task",
    });
    publisher.publishPlanReview(review);
    await publisher.finish(false);
    return review;
  } catch (error) {
    await markReviewedPlanningFailed(chatSession, input.workflowInvocationId, workflowId);
    throw error;
  }
}

export async function recordReviewedPlanDecision(
  input: RecordPlanReviewDecisionStepInput,
  workflowId: string,
): Promise<RecordPlanReviewDecisionStepResult> {
  const chatSession = await openChatSession(input);
  try {
    const project = requireProjectContext(chatSession);
    const existing = collectPlanReviewDecisions(chatSession.manager.getEntries())
      .findLast((decision) => decision.reviewId === input.decision.reviewId);
    let messageEntryId = existing?.messageEntryId ?? existing?.feedbackEntryId;
    let feedbackEntryId = existing?.feedbackEntryId;
    const needsNativeMessageUpgrade = existing !== undefined && messageEntryId === undefined;
    if (!hasPlanReviewDecision(chatSession.manager.getEntries(), input.decision.reviewId)
      || needsNativeMessageUpgrade) {
      const decidedAt = existing?.decidedAt ?? new Date().toISOString();
      messageEntryId ??= appendChatUserMessage(
        chatSession.manager,
        planReviewDecisionMessage(input.decision),
        Date.parse(decidedAt),
      );
      feedbackEntryId = input.decision.kind === "request_revision" ? messageEntryId : undefined;
      appendPlanReviewDecision(chatSession.manager, {
        schemaVersion: 3,
        workflowId,
        stageId: "review",
        ...input.decision,
        messageEntryId,
        ...(feedbackEntryId === undefined ? {} : { feedbackEntryId }),
        decidedAt,
      });
      chatSession.manager.flush();
    }
    if (messageEntryId === undefined) throw new Error("审核决定没有写入原生用户消息");
    await setPlanningExecutionPhase({
      projectDataDir: project.projectDataDir,
      projectId: project.projectId,
      workflowId,
      workflowInvocationId: input.workflowInvocationId,
      sessionId: chatSession.manager.getSessionId(),
      phase: input.decision.kind === "approve" ? "executing" : "planning",
    });
    return {
      messageEntryId,
      ...(feedbackEntryId === undefined ? {} : { feedbackEntryId }),
    };
  } catch (error) {
    await markReviewedPlanningFailed(chatSession, input.workflowInvocationId, workflowId);
    throw error;
  }
}
