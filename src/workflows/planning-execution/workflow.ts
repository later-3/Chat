import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import {
  beginSessionExecution,
  endSessionExecution,
} from "../execution-registry.js";
import {
  publishPlanReviewStep,
  recordPlanReviewDecisionStep,
  runPlanningExecutionStep,
  runPlanningRevisionStep,
  runPlanningStep,
} from "./steps.js";
import {
  assertPlanReviewDecisionMatches,
  planReviewDecisionHook,
  planReviewHookToken,
} from "./review.js";

/** Runs planning, durable human review, revisions, and execution in one Chat Session. */
export async function planningExecutionWorkflow(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use workflow";
  // 登记覆盖整个 Run 生命周期（执行中、step 间隙、挂起等待审核）；
  // 进程崩溃则随进程消失，由 session 活跃守卫对账。
  if (input.sessionId !== undefined) {
    beginSessionExecution(input.sessionId, "planning-execution", input.workflowInvocationId);
  }
  try {
    const common = {
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }),
      cwd: input.cwd,
      workflowInvocationId: input.workflowInvocationId,
      prompt: input.prompt,
    };
    const initial = await runPlanningStep(input);
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
          workflowId: "planning-execution",
          workflowInvocationId: input.workflowInvocationId,
          planRevision,
        },
      });
      try {
        const conflict = await decisionHook.getConflict();
        if (conflict !== null) {
          throw new Error(`计划审核Hook已被Workflow Run ${conflict.runId}占用`);
        }

        const review = await publishPlanReviewStep({
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
        const recordedDecision = await recordPlanReviewDecisionStep({
          ...common,
          sessionId: initial.sessionId,
          decision,
        });

        if (decision.kind === "approve") {
          return await runPlanningExecutionStep({
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
            agent: initial.executionAgent,
          });
        }

        if (recordedDecision.feedbackEntryId === undefined) {
          throw new Error("计划修改意见没有写入原生用户消息");
        }
        feedbackEntryIds.push(recordedDecision.feedbackEntryId);

        planRevision += 1;
        const revised = await runPlanningRevisionStep({
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
    if (input.sessionId !== undefined) {
      endSessionExecution(input.sessionId, input.workflowInvocationId);
    }
  }
}
