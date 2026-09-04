import { openChatSession, type ChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import {
  createWorkflowAgentSession,
  type ResolvedWorkflowAgentDefinition,
} from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { triggerChatWorkflowAgentHandoff } from "../session-conversation.js";
import { appendChatWorkflowAgentInput, appendChatWorkflowStage } from "../workflow-stage.js";
import {
  type PlanningRevisionStepInput,
  type PublishPlanReviewStepInput,
  type RecordPlanReviewDecisionStepInput,
} from "../planning-execution/steps.js";
import {
  publishReviewedPlan,
  recordReviewedPlanDecision,
  runReviewedPlanningRevisionStep,
  runReviewedPlanningStep,
} from "../planning-execution/reviewed-planning-runtime.js";
import {
  setPlanningExecutionPhase,
  type ChatPlanReview,
} from "../planning-execution/review-state.js";
import { ORCHESTRATION_PLANNER_AGENT } from "./agents/planner/index.js";
import { WORKFLOW_COORDINATOR_AGENT } from "./agents/coordinator/index.js";
import { prepareWorkflowCoordinatorSession } from "./agents/coordinator/runtime.js";

const WORKFLOW_ID = "planner-orchestrator";

export interface OrchestrationExecutionStepInput {
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
  if (chatSession.projectContext === undefined) throw new Error("Planner Orchestrator缺少Project上下文");
  return chatSession.projectContext;
}

async function markOrchestrationPhase(
  chatSession: ChatSession,
  workflowInvocationId: string,
  phase: "completed" | "failed",
): Promise<void> {
  const project = requireProjectContext(chatSession);
  await setPlanningExecutionPhase({
    projectDataDir: project.projectDataDir,
    projectId: project.projectId,
    workflowId: WORKFLOW_ID,
    workflowInvocationId,
    sessionId: chatSession.manager.getSessionId(),
    phase,
  });
}

function buildDelegationTaskBrief(input: OrchestrationExecutionStepInput): string {
  return [
    '<workflow_delegation_task_brief schemaVersion="1">',
    JSON.stringify({
      task: {
        userRequest: input.prompt,
        approvedPlanRevision: input.planRevision,
        approvedPlan: input.plan,
      },
      coordinationContract: {
        startRule: "Only delegate work packages present in the approved plan.",
        concurrencyRule: "Issue up to 8 independent workflow_call operations in the same turn; start later batches only after capacity is released, and serialize dependency groups.",
        authorizationRule: "Plan approval does not expand external or irreversible action authority.",
        completionRule: "Wait or explicitly cancel every started call before reporting each child Workflow status and Session ID, then summarize combined outcomes.",
      },
    }),
    "</workflow_delegation_task_brief>",
  ].join("\n");
}

export async function runOrchestrationPlanningStep(input: ChatWorkflowInput) {
  "use step";

  return runReviewedPlanningStep(input, {
    workflowId: WORKFLOW_ID,
    plannerAgent: ORCHESTRATION_PLANNER_AGENT,
    agents: [ORCHESTRATION_PLANNER_AGENT, WORKFLOW_COORDINATOR_AGENT],
  });
}

export async function runOrchestrationPlanningRevisionStep(input: PlanningRevisionStepInput) {
  "use step";

  return runReviewedPlanningRevisionStep(input, {
    workflowId: WORKFLOW_ID,
    plannerAgent: ORCHESTRATION_PLANNER_AGENT,
  });
}

export async function publishOrchestrationPlanReviewStep(
  input: PublishPlanReviewStepInput,
): Promise<ChatPlanReview> {
  "use step";

  return publishReviewedPlan(input, WORKFLOW_ID);
}

export async function recordOrchestrationPlanReviewDecisionStep(
  input: RecordPlanReviewDecisionStepInput,
) {
  "use step";

  return recordReviewedPlanDecision(input, WORKFLOW_ID);
}

export async function runWorkflowDelegationStep(
  input: OrchestrationExecutionStepInput,
): Promise<ChatWorkflowResult> {
  "use step";

  const stepStartedAt = Date.now();
  const chatSession = await openChatSession(input);
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: WORKFLOW_ID,
    stageId: "delegate",
    agentId: WORKFLOW_COORDINATOR_AGENT.id,
  });
  appendChatWorkflowAgentInput(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: WORKFLOW_ID,
    stageId: "delegate",
    agentId: WORKFLOW_COORDINATOR_AGENT.id,
    inputEntryIds: input.inputEntryIds,
  });

  const toolContext = {
    purpose: "execution",
    workflowId: WORKFLOW_ID,
    workflowInvocationId: input.workflowInvocationId,
    stageId: "delegate",
    agentId: WORKFLOW_COORDINATOR_AGENT.id,
  } as const;
  const extensions = await prepareWorkflowCoordinatorSession({
    ...toolContext,
    ...(chatSession.projectId === undefined ? {} : { projectId: chatSession.projectId }),
    ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
    cwd: chatSession.cwd,
    sessionManager: chatSession.manager,
    sessionId: chatSession.manager.getSessionId(),
    userPrompt: input.prompt,
  });
  const { session, toolResources, modelFallbackMessage } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: chatSession.manager,
    agent: input.agent,
    toolContext,
    ...extensions,
  });
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined) {
    session.dispose();
    throw new Error("Workflow Coordinator没有打开持久Session文件");
  }
  if (modelFallbackMessage !== undefined) {
    console.log(`${localTimestamp()} [workflow-coordinator] modelFallback=${modelFallbackMessage}`);
  }
  const observer = subscribeAgentSessionLog(session, "workflow-coordinator", {
    workflowId: WORKFLOW_ID,
    stageId: "delegate",
    nodeKind: "agent",
    agentId: WORKFLOW_COORDINATOR_AGENT.id,
  }, {
    sessionManager: chatSession.manager,
    projectId: requireProjectContext(chatSession).projectId,
    workflowInvocationId: input.workflowInvocationId,
    toolResources,
  });
  try {
    await triggerChatWorkflowAgentHandoff(session, {
      workflowId: WORKFLOW_ID,
      invocationId: input.workflowInvocationId,
      stageId: "delegate",
      agentId: WORKFLOW_COORDINATOR_AGENT.id,
      inputEntryIds: input.inputEntryIds,
      content: buildDelegationTaskBrief(input),
    });
    const text = observer.getLastAssistantText();
    if (text === "") throw new Error("Workflow Coordinator没有返回汇总文本");
    await markOrchestrationPhase(chatSession, input.workflowInvocationId, "completed");
    console.log(
      `${localTimestamp()} [workflow-coordinator] completed elapsedMs=${Date.now() - stepStartedAt}`,
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
    await markOrchestrationPhase(chatSession, input.workflowInvocationId, "failed");
    throw error;
  } finally {
    await observer.finish(true);
    session.dispose();
  }
}

runOrchestrationPlanningStep.maxRetries = 0;
runOrchestrationPlanningRevisionStep.maxRetries = 0;
publishOrchestrationPlanReviewStep.maxRetries = 0;
recordOrchestrationPlanReviewDecisionStep.maxRetries = 0;
runWorkflowDelegationStep.maxRetries = 0;
