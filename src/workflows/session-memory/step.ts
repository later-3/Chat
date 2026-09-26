import { openChatSession } from "../../chat-session.js";
import { resolveChatHome } from "../../chat-home.js";
import { runSessionMemoryWriterTurn } from "./writer-run.js";
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
import { recordSessionMemoryNotice } from "./writer-notice.js";
import { prepareSessionMemoryWriterSession } from "./agents/writer/runtime.js";
import { stageFinishClosesStream } from "./tail-policy.js";

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
  if (stage === "remember") {
    // ONE writer implementation shared with the Long Agent queue worker (which runs it as the second
    // half of a node round), so this stage never grows a second copy of the writer turn.
    if (input.projectId === undefined) throw new Error("会话记忆写入需要Project身份");
    const ownerWorkflowId = input.sessionMemoryOwnerWorkflowId ?? WORKFLOW_ID;
    try {
      return await runSessionMemoryWriterTurn({
        chatHome: resolveChatHome(input.chatHome),
        projectId: input.projectId,
        cwd: input.cwd,
        sessionId: input.sessionId ?? "",
        workflowInvocationId: input.workflowInvocationId,
        stageId: "remember",
        // The owner keeps its own provenance: a `remember` node inside another Workflow is recorded there.
        workflowId: ownerWorkflowId,
      });
    } catch (error) {
      // The work answer stays; the failure does NOT. A durable, viewable record is written in the session
      // (this runs inside a Step, the only place allowed to touch the filesystem) and the error is then
      // rethrown so the round can never be reported as a success it was not.
      await recordSessionMemoryNotice({
        ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }),
        projectId: input.projectId ?? "", sessionId: input.sessionId ?? "",
        ownerWorkflowId, workflowInvocationId: input.workflowInvocationId, error,
      });
      throw error;
    }
  }
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
  const agentId = SESSION_MEMORY_WORKER_AGENT.id;
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId, workflowId: WORKFLOW_ID, stageId: "work", agentId,
  });
  const inputEntryIds = [appendChatUserMessage(chatSession.manager, input.prompt)];
  appendChatWorkflowAgentInput(chatSession.manager, {
    invocationId: input.workflowInvocationId, workflowId: WORKFLOW_ID, stageId: "work", agentId, inputEntryIds,
  });
  const agent = prepared.agents[agentId];
  if (agent === undefined) throw new Error(`本轮配置缺少Agent: ${agentId}`);
  const memoryEnabled = input.sessionMemoryEnabled !== false;
  // With memory off the worker must not even be OFFERED the memory tool: capability removal happens at
  // assembly, not by asking the model to ignore it.
  const agentDefinition = memoryEnabled ? agent : withoutSessionMemoryTool(agent);
  const sessionExtensions = await prepareSessionMemoryWorkerSession({
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
  }, { memoryEnabled });
  const { session, toolResources } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: chatSession.manager,
    agent: agentDefinition,
    ...sessionExtensions,
    toolContext: {
      purpose: "execution", workflowId: WORKFLOW_ID, workflowInvocationId: input.workflowInvocationId,
      stageId: "work", agentId,
      ...(input.projectId === undefined ? {} : { longAgentId: input.projectId }),
      ...(input.sessionMemoryTarget === undefined ? {} : { sessionMemoryTarget: input.sessionMemoryTarget }),
    },
  });
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined) {
    session.dispose();
    throw new Error("会话记忆 Agent没有创建持久Session文件");
  }
  const observer = subscribeAgentSessionLog(session, WORKFLOW_ID, {
    workflowId: WORKFLOW_ID, stageId: "work", nodeKind: "agent", agentId,
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
    // The `remember` stage returns through the writer turn (which closes its own stream), so only the
    // WORK stage lands here: it must step back when the memory node still has to run.
    await observer.finish(stageFinishClosesStream(input));
    session.dispose();
  }
}

/** Drops the memory tool from an Agent whose policy lists addresses (memory-off rounds). */
function withoutSessionMemoryTool<T extends { readonly tools: unknown }>(agent: T): T {
  const tools = agent.tools as { readonly addresses?: readonly string[] };
  // Both `explicit` and `pi-default` policies honour the address list, so the memory tool is removed
  // from either shape.
  if (!Array.isArray(tools.addresses)) return agent;
  return { ...agent, tools: { ...tools, addresses: tools.addresses.filter((address) => address !== "system:tool/session_memory") } } as T;
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
