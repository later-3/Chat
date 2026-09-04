import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { beginSessionExecution, endSessionExecution } from "../execution-registry.js";
import {
  assertPlanReviewDecisionMatches,
  planReviewDecisionHook,
  planReviewHookToken,
} from "../planning-execution/review.js";
import {
  publishOrchestrationPlanReviewStep,
  recordOrchestrationPlanReviewDecisionStep,
  runOrchestrationPlanningRevisionStep,
  runOrchestrationPlanningStep,
  runWorkflowDelegationStep,
} from "./steps.js";

const WORKFLOW_ID = "planner-orchestrator";
const COORDINATOR_AGENT_ID = "coordinator";

/** Plans, waits for human approval, then delegates work packages to child Workflows. */
export async function plannerOrchestratorWorkflow(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use workflow";
  if (input.sessionId !== undefined) {
    beginSessionExecution(input.sessionId, WORKFLOW_ID, input.workflowInvocationId);
  }
  try {
    const common = {
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }),
      cwd: input.cwd,
      workflowInvocationId: input.workflowInvocationId,
      prompt: input.prompt,
    };
    const initial = await runOrchestrationPlanningStep(input);
    const coordinatorAgent = initial.agents[COORDINATOR_AGENT_ID];
    if (coordinatorAgent === undefined) throw new Error("本轮配置缺少Workflow Coordinator Agent");
    let planRevision = 1;
    let plan = initial.plan;
    let planEntryId = initial.planEntryId;
    let readiness = initial.readiness;
    let blockingQuestions = initial.blockingQuestions;
    const feedbackEntryIds: string[] = [];

    for (;;) {
      const decisionHook = planReviewDecisionHook.create({
        token: planReviewHookToken(input.workflowInvocationId, planRevision),
        metadata: {
          workflowId: WORKFLOW_ID,
          workflowInvocationId: input.workflowInvocationId,
          planRevision,
        },
      });
      try {
        const conflict = await decisionHook.getConflict();
        if (conflict !== null) throw new Error(`计划审核Hook已被Workflow Run ${conflict.runId}占用`);

        const review = await publishOrchestrationPlanReviewStep({
          ...common,
          sessionId: initial.sessionId,
          planRevision,
          plan,
          planEntryId,
          readiness,
          blockingQuestions,
        });
        const decision = await decisionHook;
        assertPlanReviewDecisionMatches(decision, review);
        const recordedDecision = await recordOrchestrationPlanReviewDecisionStep({
          ...common,
          sessionId: initial.sessionId,
          decision,
        });

        if (decision.kind === "approve") {
          return await runWorkflowDelegationStep({
            ...common,
            sessionId: initial.sessionId,
            plan,
            planRevision,
            inputEntryIds: [
              initial.userEntryId,
              ...feedbackEntryIds,
              planEntryId,
              recordedDecision.messageEntryId,
            ],
            agent: coordinatorAgent,
          });
        }
        if (recordedDecision.feedbackEntryId === undefined) {
          throw new Error("计划修改意见没有写入原生用户消息");
        }
        feedbackEntryIds.push(recordedDecision.feedbackEntryId);
        planRevision += 1;
        const revised = await runOrchestrationPlanningRevisionStep({
          ...common,
          sessionId: initial.sessionId,
          planRevision,
          previousPlan: plan,
          feedback: decision.feedback,
          inputEntryIds: [initial.userEntryId, planEntryId, recordedDecision.feedbackEntryId],
          agent: initial.plannerAgent,
        });
        plan = revised.plan;
        planEntryId = revised.planEntryId;
        readiness = revised.readiness;
        blockingQuestions = revised.blockingQuestions;
      } finally {
        decisionHook.dispose();
      }
    }
  } finally {
    if (input.sessionId !== undefined) endSessionExecution(input.sessionId, input.workflowInvocationId);
  }
}
