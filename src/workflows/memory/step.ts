import { openChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import {
  createWorkflowAgentSession,
} from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import { appendChatUserMessage } from "../session-conversation.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflow-configuration.js";
import { appendChatWorkflowAgentInput, appendChatWorkflowStage } from "../workflow-stage.js";
import { MEMORY_AGENT } from "./agents/memory-agent/index.js";
import { prepareMemoryAgentSession } from "./agents/memory-agent/runtime.js";

export async function runMemoryAgentStep(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use step";

  const stepStartedAt = Date.now();
  const chatSession = await openChatSession(input);
  const prepared = await prepareChatWorkflowTurnConfiguration(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "memory",
    agents: [MEMORY_AGENT],
    cwd: chatSession.cwd,
    ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
    ...(chatSession.projectContext === undefined ? {} : { projectDataDir: chatSession.projectContext.projectDataDir }),
    ...(input.defaultAgentConfigs === undefined ? {} : { defaults: input.defaultAgentConfigs }),
    ...(input.agentConfigs === undefined ? {} : { adjustments: input.agentConfigs }),
  });
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "memory",
    stageId: "manage",
    agentId: MEMORY_AGENT.id,
  });
  const userEntryId = appendChatUserMessage(chatSession.manager, input.prompt);
  appendChatWorkflowAgentInput(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "memory",
    stageId: "manage",
    agentId: MEMORY_AGENT.id,
    inputEntryIds: [userEntryId],
  });
  console.log(`${localTimestamp()} [memory] step starting cwd=${chatSession.cwd}`);
  console.log(`${localTimestamp()} [memory] creating AgentSession`);

  const agent = prepared.agents[MEMORY_AGENT.id];
  if (agent === undefined) throw new Error(`本轮配置缺少Agent: ${MEMORY_AGENT.id}`);
  const sessionExtensions = await prepareMemoryAgentSession({
    purpose: "execution",
    ...(chatSession.projectId === undefined ? {} : { projectId: chatSession.projectId }),
    ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
    cwd: chatSession.cwd,
    workflowId: "memory",
    agentId: MEMORY_AGENT.id,
    sessionManager: chatSession.manager,
    sessionId: chatSession.manager.getSessionId(),
    workflowInvocationId: input.workflowInvocationId,
    userPrompt: input.prompt,
  });
  const { session, modelFallbackMessage } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: chatSession.manager,
    agent,
    ...sessionExtensions,
  });
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined) {
    session.dispose();
    throw new Error("Memory Agent没有创建持久Session文件");
  }
  if (modelFallbackMessage !== undefined) {
    console.log(`${localTimestamp()} [memory] modelFallback=${modelFallbackMessage}`);
  }
  console.log(
    `${localTimestamp()} [memory] model=${session.model?.provider ?? "none"}/${session.model?.id ?? "none"}`,
  );

  const observer = subscribeAgentSessionLog(session, "memory", {
    workflowId: "memory",
    stageId: "manage",
    nodeKind: "agent",
    agentId: MEMORY_AGENT.id,
  });
  try {
    await session.resumePendingTurn();
    const text = observer.getLastAssistantText();
    if (text === "") throw new Error("Memory Agent没有返回Assistant文本");
    console.log(
      `${localTimestamp()} [memory] completed elapsedMs=${Date.now() - stepStartedAt}`,
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
      `${localTimestamp()} [memory] failed elapsedMs=${Date.now() - stepStartedAt} error=${message}`,
    );
    throw error;
  } finally {
    await observer.finish(true);
    session.dispose();
    console.log(`${localTimestamp()} [memory] session disposed`);
  }
}

// The Agent may already have changed memory and Session state before a failure.
runMemoryAgentStep.maxRetries = 0;
