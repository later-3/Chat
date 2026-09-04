import { openChatSession } from "../../chat-session.js";
import { getStoredAgentConfigs, resolveChatConfig } from "../../chat-config.js";
import { localTimestamp } from "../../runtime-log.js";
import {
  createWorkflowAgentSession,
} from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import { appendChatUserMessage } from "../session-conversation.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { appendChatWorkflowAgentInput, appendChatWorkflowStage } from "../workflow-stage.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflow-configuration.js";
import { getChatWorkflowDefinition } from "../registry.js";
import { RULE_CURATOR_AGENT } from "./agents/rule-curator-agent/index.js";
import { prepareRuleCuratorAgentSession } from "./agents/rule-curator-agent/runtime.js";

export async function runRuleManagementStep(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  "use step";

  const startedAt = Date.now();
  const chatSession = await openChatSession(input);
  const prepared = await prepareChatWorkflowTurnConfiguration(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "rule-management",
    agents: [RULE_CURATOR_AGENT],
    cwd: chatSession.cwd,
    ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
    ...(chatSession.projectContext === undefined ? {} : { projectDataDir: chatSession.projectContext.projectDataDir }),
    ...(input.defaultAgentConfigs === undefined ? {} : { defaults: input.defaultAgentConfigs }),
    ...(input.agentConfigs === undefined ? {} : { adjustments: input.agentConfigs }),
  });
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "rule-management",
    stageId: "manage",
    agentId: RULE_CURATOR_AGENT.id,
  });
  const userEntryId = appendChatUserMessage(chatSession.manager, input.prompt);
  appendChatWorkflowAgentInput(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "rule-management",
    stageId: "manage",
    agentId: RULE_CURATOR_AGENT.id,
    inputEntryIds: [userEntryId],
  });

  const agent = prepared.agents[RULE_CURATOR_AGENT.id];
  if (agent === undefined) throw new Error(`本轮配置缺少Agent: ${RULE_CURATOR_AGENT.id}`);
  const sessionExtensions = await prepareRuleCuratorAgentSession({
    purpose: "execution",
    ...(chatSession.projectId === undefined ? {} : { projectId: chatSession.projectId }),
    ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
    cwd: chatSession.cwd,
    workflowId: "rule-management",
    agentId: RULE_CURATOR_AGENT.id,
    sessionManager: chatSession.manager,
    sessionId: chatSession.manager.getSessionId(),
    workflowInvocationId: input.workflowInvocationId,
    userPrompt: input.prompt,
  }, {
    workflowAgentExists: (workflowId, agentId) => getChatWorkflowDefinition(workflowId)
      ?.agents.some((candidate) => candidate.id === agentId) === true,
    loadStoredAgentConfigs: async (workflowId) => {
      if (chatSession.projectContext === undefined) return undefined;
      const config = (await resolveChatConfig(
        chatSession.projectContext.projectId,
        chatSession.projectContext.chatHome,
      )).effective;
      return getStoredAgentConfigs(config, workflowId);
    },
  });
  const { session, toolResources, modelFallbackMessage } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: chatSession.manager,
    agent,
    ...sessionExtensions,
    toolContext: {
      purpose: "execution",
      workflowId: "rule-management",
      workflowInvocationId: input.workflowInvocationId,
      stageId: "manage",
      agentId: RULE_CURATOR_AGENT.id,
    },
  });
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined) {
    session.dispose();
    throw new Error("Rule Curator Agent没有打开持久Session文件");
  }
  if (modelFallbackMessage !== undefined) {
    console.log(`${localTimestamp()} [rule-curator] modelFallback=${modelFallbackMessage}`);
  }
  console.log(
    `${localTimestamp()} [rule-curator] started model=${session.model?.provider ?? "none"}/${session.model?.id ?? "none"}`,
  );

  const observer = subscribeAgentSessionLog(session, "rule-curator", {
    workflowId: "rule-management",
    stageId: "manage",
    nodeKind: "agent",
    agentId: RULE_CURATOR_AGENT.id,
  }, {
    sessionManager: chatSession.manager,
    ...(chatSession.projectId === undefined ? {} : { projectId: chatSession.projectId }),
    workflowInvocationId: input.workflowInvocationId,
    toolResources,
  });
  try {
    await session.resumePendingTurn();
    const text = observer.getLastAssistantText();
    if (text === "") throw new Error("Rule Curator Agent没有返回Assistant文本");
    console.log(`${localTimestamp()} [rule-curator] completed elapsedMs=${Date.now() - startedAt}`);
    return {
      text,
      sessionId: session.sessionId,
      sessionFile,
      model: session.model === undefined
        ? null
        : { provider: session.model.provider, modelId: session.model.id },
    };
  } finally {
    await observer.finish(true);
    session.dispose();
    console.log(`${localTimestamp()} [rule-curator] session disposed`);
  }
}

runRuleManagementStep.maxRetries = 0;
