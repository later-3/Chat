import { openChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import { createWorkflowAgentSession } from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import { triggerChatWorkflowAgentHandoff } from "../session-conversation.js";
import type { ChatWorkflowResult } from "../types.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflow-configuration.js";
import { appendChatWorkflowStage } from "../workflow-stage.js";
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

/** Last assistant text from the live Agent state (the handoff runs the turn itself). */
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
 * The 「会话记忆」writer turn — ONE reusable implementation called from two places: the Workflow's
 * `remember` step and the Long Agent queue worker (which runs it as the second half of a topic node
 * round). Both must run the same thing, so this is a plain function rather than a `"use step"` entry:
 * the worker is not inside a Workflow run and must not depend on the Step bundle.
 *
 * The writer's context is projected to the current round by its own runtime; this function only creates
 * the turn (handoff control message + trigger) and returns the visible reply.
 */
export async function runSessionMemoryWriterTurn(input: {
  readonly chatHome: string;
  readonly projectId: string;
  readonly cwd?: string;
  readonly sessionId: string;
  readonly workflowInvocationId: string;
  readonly stageId?: string;
}): Promise<Pick<ChatWorkflowResult, "text" | "sessionId" | "sessionFile" | "model">> {
  const stageId = input.stageId ?? "remember";
  const chatSession = await openChatSession({ projectId: input.projectId, chatHome: input.chatHome,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }), sessionId: input.sessionId });
  const prepared = await prepareChatWorkflowTurnConfiguration(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: WORKFLOW_ID,
    agents: [SESSION_MEMORY_WRITER_AGENT],
    cwd: chatSession.cwd,
    ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
    ...(chatSession.projectContext === undefined ? {} : { projectDataDir: chatSession.projectContext.projectDataDir }),
  });
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId, workflowId: WORKFLOW_ID, stageId, agentId: SESSION_MEMORY_WRITER_AGENT.id,
  });
  const agent = prepared.agents[SESSION_MEMORY_WRITER_AGENT.id];
  if (agent === undefined) throw new Error(`本轮配置缺少Agent: ${SESSION_MEMORY_WRITER_AGENT.id}`);
  const sessionExtensions = await prepareSessionMemoryWriterSession({
    purpose: "execution",
    ...(chatSession.projectId === undefined ? {} : { projectId: chatSession.projectId }),
    ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
    cwd: chatSession.cwd,
    workflowId: WORKFLOW_ID,
    agentId: SESSION_MEMORY_WRITER_AGENT.id,
    sessionManager: chatSession.manager,
    sessionId: chatSession.manager.getSessionId(),
    workflowInvocationId: input.workflowInvocationId,
    userPrompt: "",
  });
  const { session, toolResources } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: chatSession.manager,
    agent,
    ...sessionExtensions,
    toolContext: {
      purpose: "execution", workflowId: WORKFLOW_ID, workflowInvocationId: input.workflowInvocationId, stageId,
      agentId: SESSION_MEMORY_WRITER_AGENT.id,
      ...(chatSession.projectId === undefined ? {} : { longAgentId: chatSession.projectId }),
    },
  });
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined) {
    session.dispose();
    throw new Error("会话记忆写入没有创建持久Session文件");
  }
  const observer = subscribeAgentSessionLog(session, WORKFLOW_ID, {
    workflowId: WORKFLOW_ID, stageId, nodeKind: "agent", agentId: SESSION_MEMORY_WRITER_AGENT.id,
  }, {
    sessionManager: chatSession.manager,
    ...(chatSession.projectId === undefined ? {} : { projectId: chatSession.projectId }),
    workflowInvocationId: input.workflowInvocationId,
    toolResources,
  });
  try {
    // The handoff writes the internal control message AND triggers this writer turn itself.
    await triggerChatWorkflowAgentHandoff(session, {
      workflowId: WORKFLOW_ID, invocationId: input.workflowInvocationId, stageId, agentId: SESSION_MEMORY_WRITER_AGENT.id,
      inputEntryIds: [],
      content: "本轮工作阶段已完成。请只依据本轮（本轮用户消息与工作阶段产物）维护本会话的会话记忆；需要更早的上下文或既有条目时用 session_memory 工具按需读取。",
    });
    const text = observer.getLastAssistantText() || lastAssistantTextOf(session);
    if (text === "") throw new Error(`会话记忆 ${stageId} 阶段没有返回Assistant文本`);
    console.log(`${localTimestamp()} [${WORKFLOW_ID}] writer completed sessionId=${session.sessionId}`);
    return {
      text,
      sessionId: session.sessionId,
      sessionFile,
      model: session.model === undefined ? null : { provider: session.model.provider, modelId: session.model.id },
    };
  } finally {
    await observer.finish(true);
    session.dispose();
  }
}
