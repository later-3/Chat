import { openChatSession } from "../chat-session.js";
import { resolveChatHome } from "../chat-home.js";
import { readLongAgentState } from "../long-agents/storage.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "./types.js";
import { appendChatWorkflowStage } from "./workflow-stage.js";

/** Revalidate the serialized reference against the receipt; a client/model cannot supply authority. */
export async function requireAcceptedWorkflowTurn(input: Pick<ChatWorkflowInput,
  "acceptedLongAgentTurn" | "chatHome" | "projectId" | "sessionId" | "workflowInvocationId">, inspection = false) {
  const ref = input.acceptedLongAgentTurn;
  if (ref === undefined) throw new Error("缺少受理的Friend轮次");
  const home = resolveChatHome(input.chatHome);
  const turn = (await readLongAgentState(home)).turns.find(candidate => candidate.turnId === ref.turnId);
  if (turn === undefined || turn.longAgentId !== ref.longAgentId || turn.longAgentId !== input.projectId
    || turn.sessionId !== input.sessionId || turn.workflow?.invocationId !== input.workflowInvocationId)
    throw new Error("Workflow与耐久接受记录不匹配");
  if (!inspection && (turn.cancelRequested || turn.status === "cancelled")) throw new Error("请求已取消");
  return turn;
}

/** The default Workflow uses Friend's existing frozen work segment, inside the SAME SDK Step contract. */
export async function executeLongAgentWorkflowStep(input: ChatWorkflowInput): Promise<ChatWorkflowResult> {
  const turn = await requireAcceptedWorkflowTurn(input);
  const chatSession = await openChatSession(input);
  appendChatWorkflowStage(chatSession.manager, { invocationId: input.workflowInvocationId,
    workflowId: "minimal-pi-coding-agent", stageId: "execute", agentId: "pi-coding-agent" });
  chatSession.manager.flush();
  const { executeAcceptedLongAgentTurn } = await import("../long-agents/runtime.js");
  const result = await executeAcceptedLongAgentTurn({
    ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }), projectId: turn.longAgentId, longAgentId: turn.longAgentId,
    sessionId: turn.sessionId, text: turn.text, ...(turn.images === undefined ? {} : { images: turn.images }), turnId: turn.turnId,
    source: turn.source, channelType: turn.channelType, contextProjectId: turn.contextProjectId,
    ...(turn.inboundEventId === null ? {} : { inboundEventId: turn.inboundEventId }), summaryDraft: turn.summaryDraft,
    workflowExecution: { invocationId: input.workflowInvocationId, workflowId: "minimal-pi-coding-agent", memoryEnabled: input.sessionMemoryEnabled !== false },
  }, turn);
  const sessionFile = chatSession.manager.getSessionFile();
  if (sessionFile === undefined) throw new Error("受理Session缺少原生文件");
  return { text: result.text, sessionId: result.sessionId, sessionFile, model: result.model };
}
