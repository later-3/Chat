import { createHash } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openChatSession, reserveChatSession } from "../chat-session.js";
import { withFileLock } from "../persistence/versioned-file.js";
import { resolveProjectContext } from "../projects/registry.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../session-operation-lock.js";
import { readLongAgentRegistry, readLongAgentState, updateLongAgentState } from "./storage.js";
import { acceptLongAgentTurn, drainLongAgentTurns } from "./turn-queue.js";
import { friendExecution } from "./turn-feedback.js";
import { parseFriendWork, type FriendWork } from "./work-state.js";
import { latestChatLongAgentTurn } from "./session-turn.js";
import { cancelFriendTurn } from "./turn-controls.js";

const WORK_BINDING = "chat.friend-work.v1";
export const WORK_RETURN = "chat.friend-work-return.v1";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const MAX_FRIEND_BACKGROUND_WORK = 4;
export class FriendWorkCapacityError extends Error {}

export async function startFriendWork(input: {
  chatHome: string; longAgentId: string; requestId: string; originSessionId: string;
  contextProjectId: string | null; text: string; title: string;
}) {
  if (!input.requestId.trim() || input.requestId.length > 256 || !input.text.trim() || input.text.length > 100_000
    || !input.title.trim() || input.title.length > 120) throw new Error("后台工作需要有效请求ID、名称（最多120字）与任务说明（最多100000字）");
  const agent = (await readLongAgentRegistry(input.chatHome)).agents.find(a => a.id === input.longAgentId && a.enabled && a.status !== "archived");
  if (!agent) throw new Error("Friend已停用或不存在");
  if (input.contextProjectId !== null) await resolveProjectContext(input.contextProjectId, input.chatHome);
  const id = `work-${digest([agent.id, input.requestId]).slice(0, 32)}`;
  const payloadHash = digest([input.originSessionId, input.contextProjectId, input.text, input.title]);
  const work = await withFileLock(`${input.chatHome}/runtime/friend-work-create`, async () => {
    const state = await readLongAgentState(input.chatHome);
    const existing = state.works.find(w => w.id === id);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new Error("同一后台工作请求包含不同输入，不能重复创建");
      return existing;
    }
    if (!state.dailySessions.some(day => day.longAgentId === agent.id && day.sessionId === input.originSessionId))
      throw new Error("后台工作必须从此Friend的日常会话发起，不能递归创建或伪造来源");
    if (state.works.filter(w => w.longAgentId === agent.id && state.turns.some(turn => turn.workId === w.id && ["queued", "running"].includes(turn.status))).length >= MAX_FRIEND_BACKGROUND_WORK)
      throw new FriendWorkCapacityError("此Friend已有4项后台工作，请等待完成或取消后重试");
    const origin = await openChatSession({ chatHome: input.chatHome, projectId: agent.id, sessionId: input.originSessionId });
    // Recover a binding flushed before an interrupted index update.
    const candidates: FriendWork[] = [];
    for (const info of await SessionManager.listAll(origin.sessionDir)) {
      for (const entry of SessionManager.open(info.path, origin.sessionDir).getEntries()) {
        if (entry.type !== "custom" || entry.customType !== WORK_BINDING) continue;
        const binding = parseFriendWork(entry.data);
        if (binding.id === id) {
          if (binding.sessionId !== info.id || binding.payloadHash !== payloadHash) throw new Error("后台工作原生绑定冲突");
          candidates.push(binding);
        }
      }
    }
    if (candidates.length > 1) throw new Error("后台工作存在多个原生会话，请检查绑定");
    let binding = candidates[0];
    if (!binding) {
      const child = await reserveChatSession({ projectId: agent.id, chatHome: input.chatHome }, input.title,
        { parentSessionManager: origin.manager });
      binding = { id, longAgentId: agent.id, sessionId: child.manager.getSessionId(), originSessionId: input.originSessionId,
        originEntryId: origin.manager.getLeafId(), contextProjectId: input.contextProjectId, requestId: input.requestId,
        payloadHash, title: input.title.trim(), createdAt: new Date().toISOString() };
      child.manager.appendCustomEntry(WORK_BINDING, binding); child.manager.flush();
    }
    const saved = binding;
    await updateLongAgentState(input.chatHome, latest => ({ state: { ...latest, works: [...latest.works, saved] }, result: undefined }));
    return saved;
  });
  const turn = await acceptLongAgentTurn({ chatHome: input.chatHome, longAgentId: agent.id, projectId: agent.id,
    sessionId: work.sessionId, text: input.text, contextProjectId: work.contextProjectId, turnId: `work:${work.id}` });
  void drainLongAgentTurns(input.chatHome, agent.id, work.sessionId).catch(error => console.error("后台工作执行失败", error));
  return { schemaVersion: 1 as const, work, execution: friendExecution(input.chatHome, turn) };
}

export async function listFriendWork(home: string, agentId: string) {
  const state = await readLongAgentState(home);
  return { schemaVersion: 1 as const, works: state.works.filter(w => w.longAgentId === agentId).map(work => {
    const turn = state.turns.filter(t => t.workId === work.id).at(-1);
    return { work, execution: turn ? friendExecution(home, turn) : null };
  }) };
}

export async function readFriendWork(home: string, agentId: string, workId: string) {
  const item = (await listFriendWork(home, agentId)).works.find(item => item.work.id === workId);
  if (!item) throw new Error("找不到此Friend的后台工作");
  const session = await openChatSession({ chatHome: home, projectId: agentId, sessionId: item.work.sessionId });
  const branch = session.manager.getBranch();
  const marker = item.execution ? latestChatLongAgentTurn(branch, item.execution.id) : undefined;
  const start = marker ? branch.findIndex(e => e.id === marker.entryId) : -1;
  // A terminal marker follows the answer; locate the matching start to avoid returning an older turn's answer.
  const first = item.execution ? branch.findIndex(e => e.type === "custom" && e.customType === "chat.long_agent_turn"
    && typeof e.data === "object" && e.data !== null && "turnId" in e.data && e.data.turnId === item.execution!.id) : -1;
  const answer = start < 0 || first < 0 ? undefined : branch.slice(first + 1).findLast(e => e.type === "message" && e.message.role === "assistant");
  return { schemaVersion: 1 as const, ...item, result: answer?.type === "message" && answer.message.role === "assistant"
    ? { entryId: answer.id, text: answer.message.content.flatMap(p => p.type === "text" ? [p.text] : []).join("\n") } : null };
}

export async function cancelFriendWork(home: string, agentId: string, workId: string, expectedTurnId: string) {
  const item = await readFriendWork(home, agentId, workId);
  if (!item.execution || item.execution.id !== expectedTurnId) throw new Error("后台工作执行已变化，请刷新后再取消");
  await cancelFriendTurn(home, agentId, expectedTurnId);
  return readFriendWork(home, agentId, workId);
}

/** Durable turns are the outbox; native return markers are the consumption receipts. */
export async function deliverFriendWorkReturns(home: string): Promise<void> {
  const state = await readLongAgentState(home);
  for (const turn of state.turns.filter(t => t.workId !== undefined && !["queued", "running"].includes(t.status))) {
    const work = state.works.find(w => w.id === turn.workId);
    if (!work) throw new Error("后台工作绑定缺失");
    // Do not append to yesterday's closed direct conversation. The work list
    // remains the durable result inbox, with the immutable origin link.
    const { agentDate } = await import("./calendar.js");
    const day = state.dailySessions.find(d => d.sessionId === work.originSessionId && d.longAgentId === work.longAgentId);
    if (!day || day.date !== agentDate(day.timeZone) || day.summary.status !== "pending") continue;
    try { await withChatSessionOperationLock(chatSessionOperationKey(work.longAgentId, work.originSessionId), async () => {
      const latest = await readLongAgentState(home);
      if (latest.turns.filter(t => t.workId === work.id).at(-1)?.turnId !== turn.turnId) return;
      const currentDay = latest.dailySessions.find(d => d.sessionId === work.originSessionId);
      if (!currentDay || currentDay.date !== agentDate(currentDay.timeZone) || currentDay.summary.status !== "pending") return;
      const parent = await openChatSession({ chatHome: home, projectId: work.longAgentId, sessionId: work.originSessionId });
      if (parent.manager.getEntries().some(e => e.type === "custom_message" && e.customType === WORK_RETURN
        && typeof e.details === "object" && e.details !== null && "turnId" in e.details && e.details.turnId === turn.turnId)) return;
      parent.manager.appendCustomMessageEntry(WORK_RETURN,
        `后台工作「${work.title}」状态：${turn.status}。workId=${work.id}；独立会话=${work.sessionId}。结果保留在后台工作列表；已启用friend_work时可用get读取。这不是用户新消息。`,
        false, { workId: work.id, turnId: turn.turnId, sessionId: work.sessionId, status: turn.status });
      parent.manager.flush();
    }); } catch (error) {
      // Deleting the origin never deletes or resurrects the independent work.
      if (!(error instanceof Error && "code" in error && ["SESSION_NOT_FOUND", "ENOENT"].includes(String(error.code))))
        console.error(`后台工作 ${work.id} 返回待重试`, error);
    }
  }
}
