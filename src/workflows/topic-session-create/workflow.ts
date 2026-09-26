import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { runSessionMemoryTail } from "../session-memory/tail.js";
import { beginSessionExecution, endSessionExecution } from "../execution-registry.js";
import { assertPlanReviewDecisionMatches, planReviewDecisionHook, planReviewHookToken } from "../planning-execution/review.js";
import {
  TOPIC_SESSION_CREATE_WORKFLOW_ID,
  publishTopicReviewStep,
  recordTopicReviewDecisionStep,
  runTopicCollectRevisionStep,
  runTopicCollectStep,
  runTopicCreateStep,
} from "./steps.js";

/**
 * Review-gated topic session creation: `collect → review → create` in ONE real Workflow Run.
 *
 * The trusted creation binding (`input.topicCreation`) comes from the dispatching Backend service, never
 * from an HTTP client or model argument. The visible document is bound by revision+hash; the create step
 * reads the approved draft and the controlled tool performs the real creation.
 */
export async function topicSessionCreateWorkflow(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  "use workflow";
  const topicCreation = input.topicCreation;
  if (topicCreation === undefined) throw new Error("主题会话创建缺少可信绑定；请通过受控入口发起");
  if (input.sessionId !== undefined) beginSessionExecution(input.sessionId, TOPIC_SESSION_CREATE_WORKFLOW_ID, input.workflowInvocationId);
  try {
    // The collector MUST receive the TRUSTED source (and fork anchors) so it reads the real material;
    // they come from the backend binding, never from model arguments.
    const collectionBrief = [
      input.prompt,
      `来源会话（只读）：${topicCreation.sourceSessionId}`,
      ...(topicCreation.sourceTurnId === null ? [] : [`来源轮次：${topicCreation.sourceTurnId}`]),
      ...(topicCreation.parents.length === 0 ? [] : [`分叉父边（不要更改）：${JSON.stringify(topicCreation.parents)}`]),
      "请先只读读取来源会话记忆/全文，再只输出规定的两行（planner 元数据 + chat-topic-draft 草稿）。",
    ].join("\n");
    const common = {
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }),
      cwd: input.cwd,
      workflowInvocationId: input.workflowInvocationId,
      prompt: input.prompt,
      ...(input.sessionMemoryEnabled === undefined ? {} : { sessionMemoryEnabled: input.sessionMemoryEnabled }),
      ...(input.sessionMemoryOwnerWorkflowId === undefined ? {} : { sessionMemoryOwnerWorkflowId: input.sessionMemoryOwnerWorkflowId }),
    };
    const initial = await runTopicCollectStep({ ...input, prompt: collectionBrief });
    let planRevision = 1;
    let plan = initial.plan;
    let planEntryId = initial.planEntryId;
    let planSha256 = initial.planSha256;
    let readiness = initial.readiness;
    let blockingQuestions = initial.blockingQuestions;
    const feedbackEntryIds: string[] = [];
    for (;;) {
      const decisionHook = planReviewDecisionHook.create({
        token: planReviewHookToken(input.workflowInvocationId, planRevision),
        metadata: { workflowId: TOPIC_SESSION_CREATE_WORKFLOW_ID, workflowInvocationId: input.workflowInvocationId, planRevision },
      });
      try {
        const conflict = await decisionHook.getConflict();
        if (conflict !== null) throw new Error(`主题审核Hook已被Workflow Run ${conflict.runId}占用`);
        const review = await publishTopicReviewStep({
          ...common, sessionId: initial.sessionId, planRevision, plan, planEntryId, readiness, blockingQuestions, planSha256,
        });
        const decision = await decisionHook;
        assertPlanReviewDecisionMatches(decision, review);
        const recorded = await recordTopicReviewDecisionStep({ ...common, sessionId: initial.sessionId, decision });
        if (decision.kind === "approve") {
          const tailResult = await runTopicCreateStep({
            ...common, sessionId: initial.sessionId, planRevision, planSha256,
            inputEntryIds: [initial.userEntryId, ...feedbackEntryIds, planEntryId, recorded.messageEntryId],
            topicCreation,
          });
          return await runSessionMemoryTail(input, tailResult, "topic-session-create");
        }
        if (recorded.feedbackEntryId === undefined) throw new Error("主题修改意见没有写入原生用户消息");
        feedbackEntryIds.push(recorded.feedbackEntryId);
        planRevision += 1;
        const revised = await runTopicCollectRevisionStep({
          ...common, sessionId: initial.sessionId, planRevision, previousPlan: plan, feedback: decision.feedback,
          inputEntryIds: [initial.userEntryId, planEntryId, recorded.feedbackEntryId],
          agent: initial.plannerAgent, longAgentId: topicCreation.longAgentId,
        });
        plan = revised.plan;
        planEntryId = revised.planEntryId;
        planSha256 = revised.planSha256;
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
