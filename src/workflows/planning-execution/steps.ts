import { openChatSession, type ChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import {
  createWorkflowAgentSession,
  type ResolvedWorkflowAgentDefinition,
} from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import { createChatRunEventPublisher } from "../chat-run-events.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import {
  appendChatUserMessage,
  requireNativeAssistantLeafId,
  triggerChatWorkflowAgentHandoff,
} from "../session-conversation.js";
import {
  appendChatWorkflowAgentInput,
  appendChatWorkflowStage,
} from "../workflow-stage.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflow-configuration.js";
import { MAX_PLANNING_RESULT_CHARS, PLANNER_AGENT } from "./agents/planner/index.js";
import { PLANNING_EXECUTION_AGENT } from "./agents/pi-coding-agent/index.js";
import { buildPlanningExecutionTaskBrief, injectPlanningRevisionContext, stripLegacyPlanningHandoffs } from "./context.js";
import { parsePlannerOutput } from "./planner-output.js";
import type { PlanReviewDecision } from "./review.js";
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

interface PlanningStepResult {
  readonly sessionId: string;
  readonly userEntryId: string;
  readonly plan: string;
  readonly planEntryId: string;
  readonly readiness: ChatPlanReview["readiness"];
  readonly blockingQuestions: readonly string[];
  readonly plannerAgent: ResolvedWorkflowAgentDefinition;
  readonly executionAgent: ResolvedWorkflowAgentDefinition;
}

export interface PlanningRevisionStepInput {
  readonly projectId?: string;
  readonly chatHome?: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly workflowInvocationId: string;
  readonly prompt: string;
  readonly planRevision: number;
  readonly previousPlan: string;
  readonly feedback: string;
  readonly inputEntryIds: readonly string[];
  readonly agent: ResolvedWorkflowAgentDefinition;
}

interface PlanningRevisionStepResult {
  readonly plan: string;
  readonly planEntryId: string;
  readonly readiness: ChatPlanReview["readiness"];
  readonly blockingQuestions: readonly string[];
  readonly userEntryId?: string;
}

export interface PublishPlanReviewStepInput {
  readonly projectId?: string;
  readonly chatHome?: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly workflowInvocationId: string;
  readonly planRevision: number;
  readonly plan: string;
  readonly planEntryId: string;
  readonly readiness: ChatPlanReview["readiness"];
  readonly blockingQuestions: readonly string[];
}

export interface RecordPlanReviewDecisionStepInput {
  readonly projectId?: string;
  readonly chatHome?: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly workflowInvocationId: string;
  readonly decision: PlanReviewDecision;
}

export interface RecordPlanReviewDecisionStepResult {
  readonly messageEntryId: string;
  readonly feedbackEntryId?: string;
}

export interface PlanningExecutionStepInput {
  readonly projectId?: string;
  readonly chatHome?: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly workflowInvocationId: string;
  readonly prompt: string;
  readonly plan: string;
  readonly planRevision: number;
  readonly inputEntryIds: readonly string[];
  readonly agent: ResolvedWorkflowAgentDefinition;
}

function requireProjectContext(chatSession: ChatSession) {
  if (chatSession.projectContext === undefined) throw new Error("Planning Workflow缺少Project上下文");
  return chatSession.projectContext;
}

async function markPlanningExecutionFailed(
  chatSession: ChatSession,
  workflowInvocationId: string,
): Promise<void> {
  try {
    const project = requireProjectContext(chatSession);
    await setPlanningExecutionPhase({
      projectDataDir: project.projectDataDir,
      projectId: project.projectId,
      workflowInvocationId,
      sessionId: chatSession.manager.getSessionId(),
      phase: "failed",
    });
  } catch (error) {
    console.error(
      `${localTimestamp()} [planning-execution] failed to persist terminal state error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runPlannerIteration(input: {
  readonly chatSession: ChatSession;
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
    workflowInvocationId: input.workflowInvocationId,
    sessionId: input.chatSession.manager.getSessionId(),
    phase: "planning",
  });
  appendChatWorkflowStage(input.chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: PLANNER_AGENT.id,
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
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: PLANNER_AGENT.id,
    inputEntryIds,
  });

  console.log(`${localTimestamp()} [planner] revision=${input.planRevision} step starting cwd=${input.chatSession.cwd}`);
  const { session, toolResources, modelFallbackMessage } = await createWorkflowAgentSession({
    chatSession: input.chatSession,
    sessionManager: input.chatSession.manager,
    agent: input.agent,
    toolContext: {
      purpose: "execution",
      workflowId: "planning-execution",
      workflowInvocationId: input.workflowInvocationId,
      stageId: "plan",
      agentId: PLANNER_AGENT.id,
    },
    transformContext: input.previousPlan === undefined
      ? stripLegacyPlanningHandoffs
      : (messages) => injectPlanningRevisionContext(messages, {
          invocationId: input.workflowInvocationId,
          planRevision: input.planRevision,
          previousPlan: input.previousPlan as string,
        }),
  });
  if (modelFallbackMessage !== undefined) {
    console.log(`${localTimestamp()} [planner] modelFallback=${modelFallbackMessage}`);
  }
  console.log(
    `${localTimestamp()} [planner] model=${session.model?.provider ?? "none"}/${session.model?.id ?? "none"}`,
  );

  const observer = subscribeAgentSessionLog(session, "planner", {
    workflowId: "planning-execution",
    stageId: "plan",
    nodeKind: "agent",
    agentId: PLANNER_AGENT.id,
  }, {
    sessionManager: input.chatSession.manager,
    projectId: project.projectId,
    workflowInvocationId: input.workflowInvocationId,
    toolResources,
  });
  let completed = false;
  try {
    await session.resumePendingTurn();
    const plannerOutput = observer.getLastAssistantText();
    const plannerMessage = observer.getLastAssistantMessage();
    if (plannerOutput === "") throw new Error("Planner Agent没有返回计划文本");
    if (plannerMessage === undefined) throw new Error("Planner Agent没有返回Assistant消息");
    if (plannerOutput.length > MAX_PLANNING_RESULT_CHARS) {
      throw new Error(`规划结果不能超过${MAX_PLANNING_RESULT_CHARS}个字符`);
    }
    const parsed = parsePlannerOutput(plannerOutput);

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
    await markPlanningExecutionFailed(input.chatSession, input.workflowInvocationId);
    throw error;
  } finally {
    await observer.finish(!completed);
    session.dispose();
  }
}

export async function runPlanningStep(input: ChatWorkflowInput): Promise<PlanningStepResult> {
  "use step";

  const chatSession = await openChatSession(input);
  try {
    const prepared = await prepareChatWorkflowTurnConfiguration(chatSession.manager, {
      invocationId: input.workflowInvocationId,
      workflowId: "planning-execution",
      agents: [PLANNER_AGENT, PLANNING_EXECUTION_AGENT],
      cwd: chatSession.cwd,
      ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
      ...(chatSession.projectContext === undefined ? {} : { projectDataDir: chatSession.projectContext.projectDataDir }),
      ...(input.defaultAgentConfigs === undefined ? {} : { defaults: input.defaultAgentConfigs }),
      ...(input.agentConfigs === undefined ? {} : { adjustments: input.agentConfigs }),
    });
    const plannerAgent = prepared.agents[PLANNER_AGENT.id];
    const executionAgent = prepared.agents[PLANNING_EXECUTION_AGENT.id];
    if (plannerAgent === undefined || executionAgent === undefined) {
      throw new Error("本轮配置缺少Planning Workflow Agent");
    }
    const result = await runPlannerIteration({
      chatSession,
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
      executionAgent,
    };
  } catch (error) {
    await markPlanningExecutionFailed(chatSession, input.workflowInvocationId);
    throw error;
  }
}

export async function runPlanningRevisionStep(
  input: PlanningRevisionStepInput,
): Promise<PlanningRevisionStepResult> {
  "use step";

  const chatSession = await openChatSession(input);
  return runPlannerIteration({
    chatSession,
    workflowInvocationId: input.workflowInvocationId,
    inputEntryIds: input.inputEntryIds,
    planRevision: input.planRevision,
    previousPlan: input.previousPlan,
    agent: input.agent,
  });
}

export async function publishPlanReviewStep(
  input: PublishPlanReviewStepInput,
): Promise<ChatPlanReview> {
  "use step";

  const chatSession = await openChatSession(input);
  try {
    const project = requireProjectContext(chatSession);
    const sha256 = planSha256(input.plan);
    const review: ChatPlanReview = {
      schemaVersion: 1,
      workflowId: "planning-execution",
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
        workflowId: "planning-execution",
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
      workflowId: "planning-execution",
      stageId: "review",
      nodeKind: "task",
    });
    publisher.publishPlanReview(review);
    await publisher.finish(false);
    return review;
  } catch (error) {
    await markPlanningExecutionFailed(chatSession, input.workflowInvocationId);
    throw error;
  }
}

export async function recordPlanReviewDecisionStep(
  input: RecordPlanReviewDecisionStepInput,
): Promise<RecordPlanReviewDecisionStepResult> {
  "use step";

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
        workflowId: "planning-execution",
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
      workflowInvocationId: input.workflowInvocationId,
      sessionId: chatSession.manager.getSessionId(),
      phase: input.decision.kind === "approve" ? "executing" : "planning",
    });
    return {
      messageEntryId,
      ...(feedbackEntryId === undefined ? {} : { feedbackEntryId }),
    };
  } catch (error) {
    await markPlanningExecutionFailed(chatSession, input.workflowInvocationId);
    throw error;
  }
}

export async function runPlanningExecutionStep(
  input: PlanningExecutionStepInput,
): Promise<ChatWorkflowResult> {
  "use step";

  const stepStartedAt = Date.now();
  const chatSession = await openChatSession(input);
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: PLANNING_EXECUTION_AGENT.id,
  });
  appendChatWorkflowAgentInput(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: PLANNING_EXECUTION_AGENT.id,
    inputEntryIds: input.inputEntryIds,
  });
  console.log(`${localTimestamp()} [pi] planning execution step starting cwd=${chatSession.cwd}`);

  const { session, toolResources, modelFallbackMessage } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: chatSession.manager,
    agent: input.agent,
    toolContext: {
      purpose: "execution",
      workflowId: "planning-execution",
      workflowInvocationId: input.workflowInvocationId,
      stageId: "execute",
      agentId: PLANNING_EXECUTION_AGENT.id,
    },
    transformContext: stripLegacyPlanningHandoffs,
  });
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined) {
    session.dispose();
    throw new Error("Pi Coding Agent没有打开持久Session文件");
  }
  if (modelFallbackMessage !== undefined) {
    console.log(`${localTimestamp()} [pi] modelFallback=${modelFallbackMessage}`);
  }
  console.log(
    `${localTimestamp()} [pi] model=${session.model?.provider ?? "none"}/${session.model?.id ?? "none"}`,
  );

  const observer = subscribeAgentSessionLog(session, "pi", {
    workflowId: "planning-execution",
    stageId: "execute",
    nodeKind: "agent",
    agentId: PLANNING_EXECUTION_AGENT.id,
  }, {
    sessionManager: chatSession.manager,
    projectId: requireProjectContext(chatSession).projectId,
    workflowInvocationId: input.workflowInvocationId,
    toolResources,
  });
  try {
    await triggerChatWorkflowAgentHandoff(session, {
      workflowId: "planning-execution",
      invocationId: input.workflowInvocationId,
      stageId: "execute",
      agentId: PLANNING_EXECUTION_AGENT.id,
      inputEntryIds: input.inputEntryIds,
      content: buildPlanningExecutionTaskBrief({
        userRequest: input.prompt,
        approvedPlan: input.plan,
        approvedPlanRevision: input.planRevision,
      }),
    });
    const text = observer.getLastAssistantText();
    if (text === "") throw new Error("Pi Coding Agent没有返回Assistant文本");
    const project = requireProjectContext(chatSession);
    await setPlanningExecutionPhase({
      projectDataDir: project.projectDataDir,
      projectId: project.projectId,
      workflowInvocationId: input.workflowInvocationId,
      sessionId: session.sessionId,
      phase: "completed",
    });
    console.log(
      `${localTimestamp()} [pi] planning execution completed elapsedMs=${Date.now() - stepStartedAt}`,
    );
    return {
      text,
      sessionId: session.sessionId,
      sessionFile,
      model: session.model === undefined
        ? null
        : { provider: session.model.provider, modelId: session.model.id },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${localTimestamp()} [pi] planning execution failed elapsedMs=${Date.now() - stepStartedAt} error=${message}`,
    );
    await markPlanningExecutionFailed(chatSession, input.workflowInvocationId);
    throw error;
  } finally {
    await observer.finish(true);
    session.dispose();
    console.log(`${localTimestamp()} [pi] session disposed`);
  }
}

// Model calls must not be retried automatically after they may have changed files or incurred cost.
runPlanningStep.maxRetries = 0;
runPlanningRevisionStep.maxRetries = 0;
publishPlanReviewStep.maxRetries = 0;
recordPlanReviewDecisionStep.maxRetries = 0;
runPlanningExecutionStep.maxRetries = 0;
