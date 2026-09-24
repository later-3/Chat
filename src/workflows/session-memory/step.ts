import { openChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import { createWorkflowAgentSession } from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import {
  appendChatUserMessage,
  triggerChatWorkflowAgentHandoff,
} from "../session-conversation.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflow-configuration.js";
import { appendChatWorkflowAgentInput, appendChatWorkflowStage } from "../workflow-stage.js";
import { SESSION_MEMORY_WORKER_AGENT } from "./agents/worker/index.js";
import { prepareSessionMemoryWorkerSession } from "./agents/worker/runtime.js";
import { SESSION_MEMORY_WRITER_AGENT } from "./agents/writer/index.js";
import { prepareSessionMemoryWriterSession } from "./agents/writer/runtime.js";

const WORKFLOW_ID = "session-memory";

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (typeof block === "object" && block !== null
    && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"
    ? [(block as { text: string }).text] : [])).join("\n");
}

/** Last assistant text from the live Agent state (handed-off turns are not started by this step). */
function lastAssistantTextOf(session: { agent?: { state?: { messages?: readonly unknown[] } } }): string {
  const messages = session.agent?.state?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    return textOfContent(message.content);
  }
  return "";
}

/**
 * The 「会话记忆」workflow runs TWO stages in the SAME node Session: `work` (an ordinary round) and then
 * `remember` (the session-memory writer). Only the writer's context is projected to the current round.
 * Both stages share one invocation id, so a round is settled only when both stages finished.
 */
async function runSessionMemoryStage(
  input: ChatWorkflowInput,
  stage: "work" | "remember",
): Promise<ChatWorkflowResult> {
  const stepStartedAt = Date.now();
  const chatSession = await openChatSession(input);
  const prepared = await prepareChatWorkflowTurnConfiguration(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: WORKFLOW_ID,
    agents: [SESSION_MEMORY_WORKER_AGENT, SESSION_MEMORY_WRITER_AGENT],
    cwd: chatSession.cwd,
    ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
    ...(chatSession.projectContext === undefined ? {} : { projectDataDir: chatSession.projectContext.projectDataDir }),
    ...(input.defaultAgentConfigs === undefined ? {} : { defaults: input.defaultAgentConfigs }),
    ...(input.agentConfigs === undefined ? {} : { adjustments: input.agentConfigs }),
    ...(input.delegatedByAgentId === undefined ? {} : { actor: "agent" as const, actorAgentId: input.delegatedByAgentId }),
  });
  const agentId = stage === "work" ? SESSION_MEMORY_WORKER_AGENT.id : SESSION_MEMORY_WRITER_AGENT.id;
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: WORKFLOW_ID,
    stageId: stage,
    agentId,
  });
  const inputEntryIds = stage === "work" ? [appendChatUserMessage(chatSession.manager, input.prompt)] : [];
  if (stage === "work") {
    appendChatWorkflowAgentInput(chatSession.manager, {
      invocationId: input.workflowInvocationId, workflowId: WORKFLOW_ID, stageId: stage, agentId, inputEntryIds,
    });
  }
  const agent = prepared.agents[agentId];
  if (agent === undefined) throw new Error(`本轮配置缺少Agent: ${agentId}`);
  const sessionContext = {
    purpose: "execution" as const,
    ...(chatSession.projectId === undefined ? {} : { projectId: chatSession.projectId }),
    ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
    cwd: chatSession.cwd,
    workflowId: WORKFLOW_ID,
    agentId,
    stageId: stage,
    sessionManager: chatSession.manager,
    sessionId: chatSession.manager.getSessionId(),
    workflowInvocationId: input.workflowInvocationId,
    userPrompt: input.prompt,
    ...(input.delegatedByAgentId === undefined
      ? {}
      : { capabilitySource: "workflow_call" as const, capabilitySelection: prepared.agentConfigs[agentId] ?? {} }),
  };
  const sessionExtensions = stage === "work"
    ? await prepareSessionMemoryWorkerSession(sessionContext)
    : await prepareSessionMemoryWriterSession(sessionContext);
  const { session, toolResources, modelFallbackMessage } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: chatSession.manager,
    agent,
    ...sessionExtensions,
    toolContext: {
      purpose: "execution", workflowId: WORKFLOW_ID, workflowInvocationId: input.workflowInvocationId,
      stageId: stage, agentId,
      // The Session's OWN storage project. A stamped durable binding still wins; this only lets the
      // resolver recognise an agent-home node session, and it still refuses an ordinary project session.
      ...(input.projectId === undefined ? {} : { longAgentId: input.projectId }),
      ...(input.sessionMemoryTarget === undefined ? {} : { sessionMemoryTarget: input.sessionMemoryTarget }),
    },
  });
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined) {
    session.dispose();
    throw new Error("会话记忆 Agent没有创建持久Session文件");
  }
  if (modelFallbackMessage !== undefined) console.log(`${localTimestamp()} [${WORKFLOW_ID}] modelFallback=${modelFallbackMessage}`);
  const observer = subscribeAgentSessionLog(session, WORKFLOW_ID, {
    workflowId: WORKFLOW_ID, stageId: stage, nodeKind: "agent", agentId,
  }, {
    sessionManager: chatSession.manager,
    ...(chatSession.projectId === undefined ? {} : { projectId: chatSession.projectId }),
    workflowInvocationId: input.workflowInvocationId,
    toolResources,
  });
  try {
    if (stage === "remember") {
      // The handoff writes the internal control message AND triggers this writer turn itself. It only
      // runs the turn when the session is idle; a streaming session would queue the message as a steer
      // and return, leaving the writer without a reply, so wait for idle first.
      await session.waitForIdle();
      await triggerChatWorkflowAgentHandoff(session, {
        workflowId: WORKFLOW_ID, invocationId: input.workflowInvocationId, stageId: stage, agentId, inputEntryIds: [],
        content: "本轮工作阶段已完成。请只依据本轮（本轮用户消息与工作阶段产物）维护本会话的会话记忆；需要更早的上下文或既有条目时用 session_memory 工具按需读取。",
      });
    } else {
      await session.resumePendingTurn();
    }
    const observed = observer.getLastAssistantText();
    const fallback = lastAssistantTextOf(session);
    const text = observed !== "" ? observed : fallback;
    if (text === "") {
      const messages = (session.agent?.state?.messages ?? []) as readonly { role?: string; content?: unknown }[];
      throw new Error(`会话记忆 ${stage} 阶段没有返回Assistant文本`);
    }
    console.log(`${localTimestamp()} [${WORKFLOW_ID}] step=${stage} completed elapsedMs=${Date.now() - stepStartedAt}`);
    return {
      text,
      sessionId: session.sessionId,
      sessionFile,
      model: session.model === undefined ? null : { provider: session.model.provider, modelId: session.model.id },
    };
  } catch (error) {
    console.error(`${localTimestamp()} [${WORKFLOW_ID}] step=${stage} failed error=${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    await observer.finish(true);
    session.dispose();
  }
}

/** Stage 1: an ordinary round in the node session (opens the round with its user entry). */
export async function runSessionMemoryWorkStep(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  "use step";
  return runSessionMemoryStage(input, "work");
}
runSessionMemoryWorkStep.maxRetries = 0;

/** Stage 2: the session-memory writer, whose context is projected to the current round only. */
export async function runSessionMemoryRememberStep(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  "use step";
  return runSessionMemoryStage(input, "remember");
}
runSessionMemoryRememberStep.maxRetries = 0;
