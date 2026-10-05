import { openChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import { createWorkflowAgentSession } from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflow-configuration.js";
import { appendChatUserMessage } from "../session-conversation.js";
import { appendChatWorkflowAgentInput, appendChatWorkflowStage } from "../workflow-stage.js";
import { SESSION_MEMORY_WRITER_AGENT } from "./agents/writer/index.js";
import { recordSessionMemoryNotice } from "./writer-notice.js";
import { prepareSessionMemoryWriterSession } from "./agents/writer/runtime.js";

const WORKFLOW_ID = "session-memory";

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (typeof block === "object" && block !== null
    && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"
    ? [(block as { text: string }).text] : [])).join("\n");
}

/** Last assistant text from the live Agent state (the round is started by this step's user entry). */
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
 * The 「会话记忆」round: the user's message opens the round as a normal user entry, and the writer
 * agent — projected to the WHOLE session — maintains the session memory in reply. The writer's report
 * (entryId/revision receipts, or 无需写入) is the round's answer.
 */
async function runSessionMemoryRound(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  const stepStartedAt = Date.now();
  if (input.projectId === undefined) throw new Error("会话记忆整理需要Project身份");
  const chatSession = await openChatSession(input);
  try {
    const prepared = await prepareChatWorkflowTurnConfiguration(chatSession.manager, {
      invocationId: input.workflowInvocationId,
      workflowId: WORKFLOW_ID,
      agents: [SESSION_MEMORY_WRITER_AGENT],
      cwd: chatSession.cwd,
      ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
      ...(chatSession.projectContext === undefined ? {} : { projectDataDir: chatSession.projectContext.projectDataDir }),
      ...(input.defaultAgentConfigs === undefined ? {} : { defaults: input.defaultAgentConfigs }),
      ...(input.agentConfigs === undefined ? {} : { adjustments: input.agentConfigs }),
      ...(input.delegatedByAgentId === undefined ? {} : { actor: "agent" as const, actorAgentId: input.delegatedByAgentId }),
    });
    const agentId = SESSION_MEMORY_WRITER_AGENT.id;
    appendChatWorkflowStage(chatSession.manager, {
      invocationId: input.workflowInvocationId, workflowId: WORKFLOW_ID, stageId: "remember", agentId,
    });
    const inputEntryIds = [appendChatUserMessage(chatSession.manager, input.prompt)];
    appendChatWorkflowAgentInput(chatSession.manager, {
      invocationId: input.workflowInvocationId, workflowId: WORKFLOW_ID, stageId: "remember", agentId, inputEntryIds,
    });
    const agent = prepared.agents[agentId];
    if (agent === undefined) throw new Error(`本轮配置缺少Agent: ${agentId}`);
    const sessionExtensions = await prepareSessionMemoryWriterSession({
      purpose: "execution",
      ...(chatSession.projectId === undefined ? {} : { projectId: chatSession.projectId }),
      ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
      cwd: chatSession.cwd,
      workflowId: WORKFLOW_ID,
      agentId,
      sessionManager: chatSession.manager,
      sessionId: chatSession.manager.getSessionId(),
      workflowInvocationId: input.workflowInvocationId,
      userPrompt: input.prompt,
      ...(input.delegatedByAgentId === undefined
        ? {}
        : { capabilitySource: "workflow_call" as const, capabilitySelection: prepared.agentConfigs[agentId] ?? {} }),
    });
    const { session, toolResources } = await createWorkflowAgentSession({
      ...(input.promptCaptureEnabled === undefined ? {} : { promptCaptureEnabled: input.promptCaptureEnabled }),
      chatSession,
      sessionManager: chatSession.manager,
      agent,
      ...sessionExtensions,
      toolContext: {
        purpose: "execution", workflowId: WORKFLOW_ID, workflowInvocationId: input.workflowInvocationId,
        stageId: "remember", agentId,
        ...(chatSession.projectId === undefined ? {} : { longAgentId: chatSession.projectId }),
        ...(input.sessionMemoryTarget === undefined ? {} : { sessionMemoryTarget: input.sessionMemoryTarget }),
      },
    });
    const sessionFile = session.sessionFile;
    if (sessionFile === undefined) {
      session.dispose();
      throw new Error("会话记忆 Agent没有创建持久Session文件");
    }
    const observer = subscribeAgentSessionLog(session, WORKFLOW_ID, {
      workflowId: WORKFLOW_ID, stageId: "remember", nodeKind: "agent", agentId,
    }, {
      sessionManager: chatSession.manager,
      ...(chatSession.projectId === undefined ? {} : { projectId: chatSession.projectId }),
      workflowInvocationId: input.workflowInvocationId,
      toolResources,
    });
    try {
      await session.resumePendingTurn();
      const observed = observer.getLastAssistantText();
      const fallback = lastAssistantTextOf(session);
      const text = observed !== "" ? observed : fallback;
      if (text === "") {
        throw new Error("会话记忆 remember 阶段没有返回Assistant文本");
      }
      console.log(`${localTimestamp()} [${WORKFLOW_ID}] step=remember completed elapsedMs=${Date.now() - stepStartedAt}`);
      return {
        text,
        sessionId: session.sessionId,
        sessionFile,
        model: session.model === undefined ? null : { provider: session.model.provider, modelId: session.model.id },
      };
    } finally {
      // The round has ONE stage: it always owns closing the event stream.
      await observer.finish(true);
      session.dispose();
    }
  } catch (error) {
    // The round FAILED — the failure is the round's outcome, never rewritten as success. A durable,
    // viewable record is written in the session (this runs inside a Step, the only place allowed to
    // touch the filesystem) and the error is then rethrown.
    await recordSessionMemoryNotice({
      ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }),
      projectId: chatSession.projectId ?? input.projectId, sessionId: chatSession.manager.getSessionId(),
      ownerWorkflowId: WORKFLOW_ID, workflowInvocationId: input.workflowInvocationId, error,
    });
    throw error;
  }
}

/** The single stage of the manually-triggered session-memory round. */
export async function runSessionMemoryRoundStep(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  "use step";
  return runSessionMemoryRound(input);
}
runSessionMemoryRoundStep.maxRetries = 0;
