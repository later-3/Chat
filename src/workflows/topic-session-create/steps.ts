import { openChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import { createWorkflowAgentSession, type ResolvedWorkflowAgentDefinition } from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import { triggerChatWorkflowAgentHandoff } from "../session-conversation.js";
import { appendChatWorkflowAgentInput, appendChatWorkflowStage } from "../workflow-stage.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflow-configuration.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import type { ChatPlanReview } from "../planning-execution/review-state.js";
import type {
  PlanningRevisionStepInput,
  PlanningRevisionStepResult,
  PublishPlanReviewStepInput,
  RecordPlanReviewDecisionStepInput,
  RecordPlanReviewDecisionStepResult,
} from "../planning-execution/steps.js";
import { TOPIC_COLLECTOR_AGENT } from "./agents/collector/index.js";
import { TOPIC_CREATOR_AGENT } from "./agents/creator/index.js";
import {
  appendTopicCreationDraft,
  canonicalTopicDraftJson,
  parseTopicCreationDraft,
  planSha256Hex,
  renderTopicCreationPreview,
  type TopicCreationDraft,
} from "./creation-draft.js";

import { stageFinishClosesStream } from "../session-memory/tail-policy.js";
export const TOPIC_SESSION_CREATE_WORKFLOW_ID = "topic-session-create";

export interface TopicCollectStepResult {
  readonly sessionId: string;
  readonly userEntryId: string;
  readonly plan: string;
  readonly planEntryId: string;
  readonly readiness: ChatPlanReview["readiness"];
  readonly blockingQuestions: readonly string[];
  readonly plannerAgent: ResolvedWorkflowAgentDefinition;
  readonly agents: Readonly<Record<string, ResolvedWorkflowAgentDefinition>>;
  readonly planSha256: string;
}

export interface TopicCreateStepInput {
  readonly projectId?: string;
  readonly chatHome?: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly workflowInvocationId: string;
  readonly prompt: string;
  readonly planRevision: number;
  readonly planSha256: string;
  readonly inputEntryIds: readonly string[];
  readonly topicCreation: NonNullable<ChatWorkflowInput["topicCreation"]>;
  /** The round's memory switch: the work stage only releases the stream when no memory node follows. */
  readonly sessionMemoryEnabled?: boolean;
  readonly sessionMemoryOwnerWorkflowId?: string;
}

export async function runTopicCollectStep(input: ChatWorkflowInput): Promise<TopicCollectStepResult> {
  "use step";
  const { runReviewedPlanningStep } = await import("../planning-execution/reviewed-planning-runtime.js");
  const result = await runReviewedPlanningStep(input, {
    workflowId: TOPIC_SESSION_CREATE_WORKFLOW_ID,
    plannerAgent: TOPIC_COLLECTOR_AGENT,
    agents: [TOPIC_COLLECTOR_AGENT, TOPIC_CREATOR_AGENT],
    ...(input.topicCreation === undefined ? {} : { longAgentId: input.topicCreation.longAgentId }),
    topicReadOnly: true,
  });
  const { draft } = parseTopicCreationDraft(result.plan);
  // The DRAFT is the source of truth: the hash binds its canonical JSON, and the review shows the
  // deterministic render of the same draft.
  const planSha256 = planSha256Hex(canonicalTopicDraftJson(draft));
  const chatSession = await openChatSession(input);
  appendTopicCreationDraft(chatSession.manager, { planRevision: 1, planSha256, draft });
  chatSession.manager.flush();
  return { ...result, plan: renderTopicCreationPreview(draft), planSha256 };
}

export async function runTopicCollectRevisionStep(input: PlanningRevisionStepInput): Promise<PlanningRevisionStepResult & { readonly planSha256: string }> {
  "use step";
  const { runReviewedPlanningRevisionStep } = await import("../planning-execution/reviewed-planning-runtime.js");
  const result = await runReviewedPlanningRevisionStep(input, {
    workflowId: TOPIC_SESSION_CREATE_WORKFLOW_ID,
    plannerAgent: TOPIC_COLLECTOR_AGENT,
    ...(input.longAgentId === undefined ? {} : { longAgentId: input.longAgentId }),
    topicReadOnly: true,
  });
  const { draft } = parseTopicCreationDraft(result.plan);
  const planSha256 = planSha256Hex(canonicalTopicDraftJson(draft));
  const chatSession = await openChatSession(input);
  appendTopicCreationDraft(chatSession.manager, { planRevision: input.planRevision, planSha256, draft });
  chatSession.manager.flush();
  return { ...result, plan: renderTopicCreationPreview(draft), planSha256 };
}

export async function publishTopicReviewStep(input: PublishPlanReviewStepInput): Promise<ChatPlanReview> {
  "use step";
  const { publishReviewedPlan } = await import("../planning-execution/reviewed-planning-runtime.js");
  // The explicit hash binds the STRUCTURED draft; the plan text is only its deterministic render.
  return publishReviewedPlan(input, TOPIC_SESSION_CREATE_WORKFLOW_ID);
}

export async function recordTopicReviewDecisionStep(input: RecordPlanReviewDecisionStepInput): Promise<RecordPlanReviewDecisionStepResult> {
  "use step";
  const { recordReviewedPlanDecision } = await import("../planning-execution/reviewed-planning-runtime.js");
  return recordReviewedPlanDecision(input, TOPIC_SESSION_CREATE_WORKFLOW_ID);
}

/**
 * The create step runs the creator agent — which must call the controlled `commit_creation` tool — and
 * then verifies the REAL产物 landed. A model claiming success is not enough.
 */
export async function runTopicCreateStep(input: TopicCreateStepInput): Promise<ChatWorkflowResult> {
  "use step";
  const chatSession = await openChatSession(input);
  const project = chatSession.projectContext;
  const prepared = await prepareChatWorkflowTurnConfiguration(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: TOPIC_SESSION_CREATE_WORKFLOW_ID,
    agents: [TOPIC_CREATOR_AGENT],
    cwd: chatSession.cwd,
    ...(project === undefined ? {} : { chatHome: project.chatHome, projectDataDir: project.projectDataDir }),
  });
  const creator = prepared.agents[TOPIC_CREATOR_AGENT.id];
  if (creator === undefined) throw new Error(`本轮配置缺少创建 Agent: ${TOPIC_CREATOR_AGENT.id}`);
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId, workflowId: TOPIC_SESSION_CREATE_WORKFLOW_ID, stageId: "create", agentId: TOPIC_CREATOR_AGENT.id,
  });
  appendChatWorkflowAgentInput(chatSession.manager, {
    invocationId: input.workflowInvocationId, workflowId: TOPIC_SESSION_CREATE_WORKFLOW_ID, stageId: "create", agentId: TOPIC_CREATOR_AGENT.id, inputEntryIds: input.inputEntryIds,
  });
  const { session, toolResources } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: chatSession.manager,
    agent: creator,
    toolContext: {
      purpose: "execution",
      workflowId: TOPIC_SESSION_CREATE_WORKFLOW_ID,
      workflowInvocationId: input.workflowInvocationId,
      stageId: "create",
      agentId: TOPIC_CREATOR_AGENT.id,
      longAgentId: input.topicCreation.longAgentId,
      topicCreation: input.topicCreation,
      topicCreationApproval: { planRevision: input.planRevision, planSha256: input.planSha256 },
    },
  });
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined) { session.dispose(); throw new Error("主题创建没有打开持久Session文件"); }
  const observer = subscribeAgentSessionLog(session, TOPIC_SESSION_CREATE_WORKFLOW_ID, {
    workflowId: TOPIC_SESSION_CREATE_WORKFLOW_ID, stageId: "create", nodeKind: "agent", agentId: TOPIC_CREATOR_AGENT.id,
  }, {
    sessionManager: chatSession.manager,
    projectId: project?.projectId ?? input.topicCreation.longAgentId,
    workflowInvocationId: input.workflowInvocationId,
    toolResources,
  });
  try {
    await triggerChatWorkflowAgentHandoff(session, {
      workflowId: TOPIC_SESSION_CREATE_WORKFLOW_ID,
      invocationId: input.workflowInvocationId,
      stageId: "create",
      agentId: TOPIC_CREATOR_AGENT.id,
      inputEntryIds: input.inputEntryIds,
      content: [
        "用户已批准当前版本（revision=" + String(input.planRevision) + "）。",
        "请调用 topic_manage 的 commit_creation（无参数）把它创建为真实主题节点会话；服务端会读取已批准版本，你不需要提供 title/summary/project/source。",
        "完成后用一句话说明结果。",
      ].join("\n"),
    });
    const text = observer.getLastAssistantText();
    if (text === "") throw new Error("主题创建 Agent 没有返回Assistant文本");
    // Verify the REAL product exists; a model sentence is not proof.
    const [{ readTopicGraph }, { resolveChatHome }] = await Promise.all([
      import("../../long-agents/topics.js"), import("../../chat-home.js"),
    ]);
    const graph = await readTopicGraph(resolveChatHome(input.chatHome), input.topicCreation.longAgentId);
    const node = graph.nodes.find((candidate) => candidate.createdByRequestId === input.topicCreation.requestId);
    if (node === undefined) throw new Error(`创建 Agent 结束后没有找到真实主题节点产物；Agent 回复：${text.slice(0, 400)}`);
    console.log(`${localTimestamp()} [topic-session-create] created node=${node.nodeId} session=${node.sessionId}`);
    return { text, sessionId: session.sessionId, sessionFile, model: session.model === undefined ? null : { provider: session.model.provider, modelId: session.model.id } };
  } finally {
    await observer.finish(stageFinishClosesStream(input));
    session.dispose();
  }
}

runTopicCollectStep.maxRetries = 0;
runTopicCollectRevisionStep.maxRetries = 0;
publishTopicReviewStep.maxRetries = 0;
recordTopicReviewDecisionStep.maxRetries = 0;
runTopicCreateStep.maxRetries = 0;
