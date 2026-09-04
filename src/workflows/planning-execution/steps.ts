import { openChatSession, type ChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import {
  createWorkflowAgentSession,
  type ResolvedWorkflowAgentDefinition,
  type WorkflowAgentDefinition,
} from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import {
  triggerChatWorkflowAgentHandoff,
} from "../session-conversation.js";
import {
  appendChatWorkflowAgentInput,
  appendChatWorkflowStage,
} from "../workflow-stage.js";
import { PLANNER_AGENT } from "./agents/planner/index.js";
import { PLANNING_EXECUTION_AGENT } from "./agents/pi-coding-agent/index.js";
import { buildPlanningExecutionTaskBrief, stripLegacyPlanningHandoffs } from "./context.js";
import type { PlanReviewDecision } from "./review.js";
import {
  setPlanningExecutionPhase,
  type ChatPlanReview,
} from "./review-state.js";
import {
  publishReviewedPlan,
  recordReviewedPlanDecision,
  runReviewedPlanningRevisionStep,
  runReviewedPlanningStep,
} from "./reviewed-planning-runtime.js";

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

export interface ReviewedPlanningProfile {
  readonly workflowId: string;
  readonly plannerAgent: WorkflowAgentDefinition;
  readonly agents: readonly WorkflowAgentDefinition[];
}

export interface ReviewedPlanningStepResult {
  readonly sessionId: string;
  readonly userEntryId: string;
  readonly plan: string;
  readonly planEntryId: string;
  readonly readiness: ChatPlanReview["readiness"];
  readonly blockingQuestions: readonly string[];
  readonly plannerAgent: ResolvedWorkflowAgentDefinition;
  readonly agents: Readonly<Record<string, ResolvedWorkflowAgentDefinition>>;
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

export interface PlanningRevisionStepResult {
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
  workflowId = "planning-execution",
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
      `${localTimestamp()} [planning-execution] failed to persist terminal state error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function runPlanningStep(input: ChatWorkflowInput): Promise<PlanningStepResult> {
  "use step";

  const result = await runReviewedPlanningStep(input, {
    workflowId: "planning-execution",
    plannerAgent: PLANNER_AGENT,
    agents: [PLANNER_AGENT, PLANNING_EXECUTION_AGENT],
  });
  const executionAgent = result.agents[PLANNING_EXECUTION_AGENT.id];
  if (executionAgent === undefined) throw new Error("本轮配置缺少Planning Execution Agent");
  return { ...result, executionAgent };
}

export async function runPlanningRevisionStep(
  input: PlanningRevisionStepInput,
): Promise<PlanningRevisionStepResult> {
  "use step";

  return runReviewedPlanningRevisionStep(input, {
    workflowId: "planning-execution",
    plannerAgent: PLANNER_AGENT,
  });
}

export async function publishPlanReviewStep(
  input: PublishPlanReviewStepInput,
): Promise<ChatPlanReview> {
  "use step";

  return publishReviewedPlan(input, "planning-execution");
}

export async function recordPlanReviewDecisionStep(
  input: RecordPlanReviewDecisionStepInput,
): Promise<RecordPlanReviewDecisionStepResult> {
  "use step";

  return recordReviewedPlanDecision(input, "planning-execution");
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
