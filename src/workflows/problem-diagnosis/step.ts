import { openChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import { createWorkflowAgentSession } from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import { appendChatUserMessage } from "../session-conversation.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflow-configuration.js";
import { appendChatWorkflowAgentInput, appendChatWorkflowStage } from "../workflow-stage.js";
import { PROBLEM_DIAGNOSER_AGENT } from "./agents/diagnoser/index.js";
import { stageFinishClosesStream } from "../session-memory/tail-policy.js";

export const PROBLEM_DIAGNOSIS_WORKFLOW_ID = "problem-diagnosis";
export const PROBLEM_DIAGNOSIS_STAGE_ID = "diagnose";

/**
 * One structured problem-diagnosis turn in the (child) Session the Workflow runtime reserved for it.
 * It uses the same Chat assembly path as every other Workflow Agent: no second execution path, no
 * private model loop.
 */
export async function runProblemDiagnosisStep(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  "use step";
  const chatSession = await openChatSession(input);
  const prepared = await prepareChatWorkflowTurnConfiguration(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: PROBLEM_DIAGNOSIS_WORKFLOW_ID,
    agents: [PROBLEM_DIAGNOSER_AGENT],
    cwd: chatSession.cwd,
    ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
    ...(chatSession.projectContext === undefined ? {} : { projectDataDir: chatSession.projectContext.projectDataDir }),
    ...(input.defaultAgentConfigs === undefined ? {} : { defaults: input.defaultAgentConfigs }),
    ...(input.agentConfigs === undefined ? {} : { adjustments: input.agentConfigs }),
    ...(input.delegatedByAgentId === undefined ? {} : { actor: "agent" as const, actorAgentId: input.delegatedByAgentId }),
  });
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId, workflowId: PROBLEM_DIAGNOSIS_WORKFLOW_ID,
    stageId: PROBLEM_DIAGNOSIS_STAGE_ID, agentId: PROBLEM_DIAGNOSER_AGENT.id,
  });
  const userEntryId = appendChatUserMessage(chatSession.manager, input.prompt);
  appendChatWorkflowAgentInput(chatSession.manager, {
    invocationId: input.workflowInvocationId, workflowId: PROBLEM_DIAGNOSIS_WORKFLOW_ID,
    stageId: PROBLEM_DIAGNOSIS_STAGE_ID, agentId: PROBLEM_DIAGNOSER_AGENT.id, inputEntryIds: [userEntryId],
  });
  const agent = prepared.agents[PROBLEM_DIAGNOSER_AGENT.id];
  if (agent === undefined) throw new Error(`本轮配置缺少Agent: ${PROBLEM_DIAGNOSER_AGENT.id}`);
  const { session, toolResources } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: chatSession.manager,
    agent,
    toolContext: {
      purpose: "execution", workflowId: PROBLEM_DIAGNOSIS_WORKFLOW_ID,
      workflowInvocationId: input.workflowInvocationId, stageId: PROBLEM_DIAGNOSIS_STAGE_ID,
      agentId: PROBLEM_DIAGNOSER_AGENT.id,
      ...(chatSession.projectId === undefined ? {} : { longAgentId: chatSession.projectId }),
      ...(input.sessionMemoryTarget === undefined ? {} : { sessionMemoryTarget: input.sessionMemoryTarget }),
    },
  });
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined) {
    session.dispose();
    throw new Error("问题定位没有创建持久Session文件");
  }
  const observer = subscribeAgentSessionLog(session, PROBLEM_DIAGNOSIS_WORKFLOW_ID, {
    workflowId: PROBLEM_DIAGNOSIS_WORKFLOW_ID, stageId: PROBLEM_DIAGNOSIS_STAGE_ID,
    nodeKind: "agent", agentId: PROBLEM_DIAGNOSER_AGENT.id,
  }, {
    sessionManager: chatSession.manager,
    ...(chatSession.projectId === undefined ? {} : { projectId: chatSession.projectId }),
    workflowInvocationId: input.workflowInvocationId,
    toolResources,
  });
  try {
    await session.resumePendingTurn();
    const text = observer.getLastAssistantText();
    if (text === "") throw new Error("问题定位没有返回Assistant文本");
    console.log(`${localTimestamp()} [${PROBLEM_DIAGNOSIS_WORKFLOW_ID}] completed`);
    return {
      text,
      sessionId: session.sessionId,
      sessionFile,
      model: session.model === undefined ? null : { provider: session.model.provider, modelId: session.model.id },
    };
  } finally {
    await observer.finish(stageFinishClosesStream(input));
    session.dispose();
  }
}

runProblemDiagnosisStep.maxRetries = 0;
