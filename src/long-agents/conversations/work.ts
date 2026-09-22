import { createHash } from "node:crypto";
import { openChatSession, reserveChatSession } from "../../chat-session.js";
import { createChatPiAgentSession } from "../../agents/pi-agent-session.js";
import { prepareLongAgentAssembly } from "../assembly.js";
import { readLongAgentRegistry } from "../storage.js";
import { ConversationError, activeMember } from "./contract.js";
import { GROUP_WORK_SESSION } from "./access.js";
import { assertConversationAuthorization, publishConversationSpeech, readConversationPublicMessages } from "./publication.js";
import { readConversation, resolveConversationWorkScope } from "./service.js";
import {
  changeWorkState,
  listConversationWorks,
  readConversationWorkState,
  claimWorkModelCall,
  recordWorkTokenUsage,
  type ConversationWork,
  type ConversationWorkSource,
} from "./work-store.js";
import { claimDiscussionModelCall, readDiscussionState, recordDiscussionModelCall, recordDiscussionTokenUsage } from "./discussions.js";
import { participationTurnKey, withParticipationTurnLock } from "./turn-lock.js";
import { deliverConversationPublication } from "./channel.js";
import { acquireWorkCommitLock, workCommitKey } from "./work-commit-lock.js";

export {
  listConversationWorks,
  readConversationWorkState,
} from "./work-store.js";
export type { ConversationWork, ConversationWorkStatus, ConversationWorkSource } from "./work-store.js";

/**
 * In-process registry of the model turn currently running for each work. It exists only to propagate
 * a cancel to the live Pi session; durable correctness (never publishing or overwriting a cancelled
 * terminal state) does not depend on it.
 */
const runningWorkSessions = new Map<string, { abort: () => Promise<void> }>();

/** Trusted origin: the requesting entry must be in the member's authorized public projection. */
async function verifiedOrigin(input: {
  chatHome: string; storageProjectId: string; conversationId: string;
  longAgentId: string; originEntryId: string | null;
}): Promise<void> {
  if (input.originEntryId === null) return;
  const visible = await readConversationPublicMessages({
    chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
    viewerLongAgentId: input.longAgentId,
  });
  if (!visible.some((message) => message.entryId === input.originEntryId))
    throw new ConversationError(409, "群任务的来源条目不在该成员有权读取的公共投影中，拒绝创建");
}

/** Create a group work; idempotent per `requestId`. */
export async function startConversationWork(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  longAgentId: string;
  requestId: string;
  title: string;
  instruction: string;
  /** `discussion` = sub-work of a round (charged to that root); `user` = independent owner task. */
  source?: ConversationWorkSource;
  /** Required when `source` is `discussion`. */
  discussionId?: string | null;
  originEntryId?: string | null;
}): Promise<{ work: ConversationWork; created: boolean }> {
  if (!input.requestId.trim() || input.requestId.length > 256) throw new ConversationError(400, "群任务需要有效 requestId");
  if (!input.title.trim() || input.title.length > 120) throw new ConversationError(400, "群任务需要有效名称");
  if (!input.instruction.trim() || input.instruction.length > 100_000) throw new ConversationError(400, "群任务需要有效说明");
  const source: ConversationWorkSource = input.source === "discussion" ? "discussion" : "user";
  const discussionId = source === "discussion" ? (input.discussionId ?? "") : null;
  if (source === "discussion" && (discussionId ?? "").trim() === "")
    throw new ConversationError(400, "讨论派生的子工作必须指明根讨论，不能自建独立预算");
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  if (conversation.lifecycle === "archived") throw new ConversationError(409, "群已归档，不能创建任务");
  const member = activeMember(conversation, input.longAgentId);
  if (member === null) throw new ConversationError(409, "该 Friend 不是当前成员，不能创建群任务");
  if (source === "discussion") {
    const discussions = await readDiscussionState(input.chatHome, input.storageProjectId, input.conversationId);
    if (discussions.discussions.find((item) => item.discussionId === (discussionId ?? "")) === undefined)
      throw new ConversationError(404, "找不到该子工作所属的根讨论");
  }
  await verifiedOrigin({
    chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
    longAgentId: input.longAgentId, originEntryId: input.originEntryId ?? null,
  });
  const workId = `cwork-${createHash("sha256").update(JSON.stringify([input.conversationId, input.longAgentId, input.requestId])).digest("hex").slice(0, 32)}`;
  return changeWorkState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const existing = state.works.find((work) => work.workId === workId);
    if (existing !== undefined) {
      if (existing.instruction !== input.instruction || existing.title !== input.title)
        throw new ConversationError(409, "同一 requestId 包含不同的群任务输入，不能重复创建");
      return { work: { ...existing }, created: false };
    }
    const now = new Date().toISOString();
    const work: ConversationWork = {
      workId, conversationId: input.conversationId, longAgentId: input.longAgentId, participationEpoch: member.participationEpoch,
      source, discussionId,
      originEntryId: input.originEntryId ?? null, title: input.title, instruction: input.instruction,
      status: "queued", sessionId: null,
      budget: { ...conversation.budget }, modelCalls: 0, tokensUsed: 0, startedAt: now,
      publicationId: null, sourceSessionId: null, sourceEntryId: null, error: null,
      createdAt: now, updatedAt: now,
    };
    state.works.push(work);
    return { work: { ...work }, created: true };
  });
}

/** Provider-reported token total for one assistant message; 0 when the provider omitted usage. */
function assistantTokens(message: { usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }): number {
  const usage = message.usage;
  if (usage === undefined) return 0;
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return Math.max(0, Math.trunc(usage.totalTokens));
  const sum = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return Number.isFinite(sum) ? Math.max(0, Math.trunc(sum)) : 0;
}

function assistantText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return (message.content as Array<Record<string, unknown>>)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text)).join("\n");
}

/** Create (once) the work's own durable Task Session, distinct from the member's participation Session. */
async function ensureWorkSession(input: {
  chatHome: string; storageProjectId: string; conversationId: string;
}, work: ConversationWork): Promise<string> {
  if (work.sessionId !== null) return work.sessionId;
  const reserved = await reserveChatSession(
    { chatHome: input.chatHome, projectId: input.storageProjectId },
    `群任务 · ${work.title}`,
  );
  const sessionId = reserved.manager.getSessionId();
  reserved.manager.appendCustomEntry(GROUP_WORK_SESSION, {
    conversationId: work.conversationId,
    storageProjectId: input.storageProjectId,
    longAgentId: work.longAgentId,
    participationEpoch: work.participationEpoch,
    workId: work.workId,
    boundAt: new Date().toISOString(),
  });
  reserved.manager.flush();
  return changeWorkState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const target = state.works.find((candidate) => candidate.workId === work.workId)!;
    if (target.sessionId === null) target.sessionId = sessionId;
    return target.sessionId ?? sessionId;
  });
}

/** Terminal write-back guarded by the current status: a cancelled work is never overwritten. */
async function finishWork(input: {
  chatHome: string; storageProjectId: string; conversationId: string; workId: string;
}, expected: ConversationWork["status"], next: Partial<ConversationWork> & { status: ConversationWork["status"] }): Promise<ConversationWork | null> {
  return changeWorkState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const target = state.works.find((candidate) => candidate.workId === input.workId)!;
    if (target.status !== expected) return null;
    Object.assign(target, next);
    target.updatedAt = new Date().toISOString();
    return { ...target };
  });
}

/**
 * Run one queued group work in its own durable Task Session.
 *
 * The task never opens the member's participation Session, so its transcript cannot leak into group
 * speech history and a long task never blocks that Friend's next group turn. A cancellation that
 * lands before the result is committed wins: the result is neither published nor used to overwrite
 * the `cancelled` terminal state.
 */
export async function executeConversationWork(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  workId: string;
}): Promise<ConversationWork> {
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  const state = await readConversationWorkState(input.chatHome, input.storageProjectId, input.conversationId);
  const work = state.works.find((candidate) => candidate.workId === input.workId);
  if (work === undefined) throw new ConversationError(404, "找不到该群任务");
  if (work.status !== "queued") throw new ConversationError(409, "该群任务不在待执行状态");
  const member = activeMember(conversation, work.longAgentId);
  if (member === null) {
    await finishWork(input, "queued", { status: "cancelled", error: "成员资格已撤销" });
    throw new ConversationError(409, "成员资格已撤销，不执行该群任务");
  }
  if (member.participationEpoch !== work.participationEpoch)
    throw new ConversationError(409, "参与期已变化，该群任务不能继续");
  const agent = (await readLongAgentRegistry(input.chatHome)).agents
    .find((candidate) => candidate.id === work.longAgentId && candidate.enabled && candidate.status !== "archived");
  if (agent === undefined) throw new ConversationError(409, "找不到可用 Friend");
  const claimed = await finishWork(input, "queued", { status: "running" });
  if (claimed === null) throw new ConversationError(409, "该群任务已被其他 worker 领取");
  const workSessionId = await ensureWorkSession(input, { ...work, sessionId: work.sessionId });
  // The trusted scope is bound to the work's own Task Session, never to the participation Session.
  const resolved = await resolveConversationWorkScope({
    chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
    longAgentId: work.longAgentId, workSessionId, participationEpoch: work.participationEpoch,
  });
  return withParticipationTurnLock(participationTurnKey(input.storageProjectId, workSessionId), async () => {
    const chatSession = await openChatSession({ chatHome: input.chatHome, projectId: input.storageProjectId, sessionId: workSessionId });
    let created: Awaited<ReturnType<typeof createChatPiAgentSession>> | undefined;
    try {
      const prepared = await prepareLongAgentAssembly({
        agent, chatHome: input.chatHome, projectId: resolved.scope.authorization.collaborationProjectId, turnId: work.workId,
        scope: resolved.scope, scopeGrantsDigest: resolved.grantsDigest,
      });
      const isDerived = work.source === "discussion" && work.discussionId !== null;
      // A discussion-derived sub-work shares the root budget; an independent user work enforces its
      // own durable budget. Both use the public Pi request gate on every provider request.
      let budgetDenied: string | null = null;
      let usageCommit: Promise<unknown> = Promise.resolve();
      const providerRequestGate = async (payload: unknown) => {
          await usageCommit;
          const reservation = isDerived
            ? await claimDiscussionModelCall({
                chatHome: input.chatHome, storageProjectId: input.storageProjectId,
                conversationId: input.conversationId, discussionId: work.discussionId as string,
              })
            : await claimWorkModelCall({
                chatHome: input.chatHome, storageProjectId: input.storageProjectId,
                conversationId: input.conversationId, workId: work.workId,
              });
          if (!reservation.granted) {
            budgetDenied = reservation.reason ?? "模型调用预算";
            throw new ConversationError(409, `${isDerived ? "根预算已用尽" : "预算已用尽"}：${budgetDenied}`);
          }
          return payload;
        };
      created = await createChatPiAgentSession({
        chatSession, sessionManager: chatSession.manager, ...prepared,
        providerRequestGate,
        toolContext: { purpose: "execution", agentId: agent.id, longAgentId: agent.id, longAgentTurnId: work.workId },
      });
      runningWorkSessions.set(work.workId, { abort: async () => { await created?.session.abort(); } });
      let last: { content?: unknown; stopReason?: string; errorMessage?: string; usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } | undefined;
      const unsubscribe = created.session.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        last = event.message;
        // Durable token metering for whichever budget this work is charged to.
        const tokens = assistantTokens(event.message);
        usageCommit = usageCommit.then(() => isDerived
          ? recordDiscussionTokenUsage({
              chatHome: input.chatHome, storageProjectId: input.storageProjectId,
              conversationId: input.conversationId, discussionId: work.discussionId as string, tokens,
            })
          : recordWorkTokenUsage({
              chatHome: input.chatHome, storageProjectId: input.storageProjectId,
              conversationId: input.conversationId, workId: work.workId, tokens,
            }));
        // Preserve failures for request admission and settlement; only suppress unhandled-rejection
        // reporting while the synchronous Pi event callback hands the write off.
        void usageCommit.catch(() => undefined);
      });
      try {
        await created.session.prompt(`[群内后台任务] ${work.title}\n${work.instruction}\n完成后只输出要发布回群里的结果正文。`);
      } finally {
        unsubscribe();
        await usageCommit;
      }
      if (budgetDenied !== null) {
        const label = isDerived ? "根预算已用尽" : "预算已用尽";
        const denied = await finishWork(input, "running", { status: "failed", error: `${label}：${budgetDenied}` });
        return denied ?? { ...work, status: "failed", error: `${label}：${budgetDenied}` };
      }
      // Any terminal state reached while the model ran (cancel, failure, crash recovery) wins over the
      // result: never publish and never overwrite it.
      const current = (await readConversationWorkState(input.chatHome, input.storageProjectId, input.conversationId))
        .works.find((candidate) => candidate.workId === work.workId);
      if (current === undefined || current.status !== "running") {
        return current ?? { ...work, status: "cancelled" };
      }
      if (last === undefined || last.stopReason === "error" || last.stopReason === "aborted")
        throw new ConversationError(409, last?.errorMessage ?? "群任务没有返回结果");
      const resultText = assistantText(last);
      if (resultText.trim() === "") throw new ConversationError(409, "群任务没有返回可发布的文本");
      const assistantEntry = chatSession.manager.getEntries()
        .filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
      if (assistantEntry === undefined) throw new ConversationError(409, "缺少群任务结果条目");
      const after = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
      // Frozen revision from the trusted scope, not the current one: a change while working must block.
      assertConversationAuthorization(after, {
        longAgentId: work.longAgentId, participationEpoch: work.participationEpoch,
        authorizationRevision: resolved.scope.authorization.authorizationRevision,
      });
      const published = await publishConversationSpeech({
        chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
        longAgentId: work.longAgentId, attemptId: work.workId, participationEpoch: work.participationEpoch,
        authorizationRevision: resolved.scope.authorization.authorizationRevision, sourceSessionId: workSessionId,
        workId: work.workId,
        sourceEntryId: assistantEntry.id, text: resultText,
        // Inside the public-root lock and the work commit lock: a cancellation that already committed
        // cannot be bypassed by a stale read, and a later cancellation queues behind this commit.
        assertStillAuthorized: async () => {
          const release = await acquireWorkCommitLock(workCommitKey(input.storageProjectId, input.conversationId));
          try {
            const latest = (await readConversationWorkState(input.chatHome, input.storageProjectId, input.conversationId))
              .works.find((candidate) => candidate.workId === work.workId);
            if (latest === undefined || latest.status !== "running")
              throw new ConversationError(409, "任务已取消或进入终态，拒绝发布到群");
            if (isDerived) {
              const root = (await readDiscussionState(input.chatHome, input.storageProjectId, input.conversationId))
                .discussions.find((item) => item.discussionId === work.discussionId);
              if (root === undefined || root.status === "stopped" || root.status === "interrupted")
                throw new ConversationError(409, "根讨论已停止，拒绝发布子任务结果");
            }
            // Successful acquisition transfers release ownership to the publication's finally.
            return release;
          } catch (error) {
            release();
            throw error;
          }
        },
      });
      const finished = await finishWork(input, "running", {
        status: "completed", publicationId: published.publication.publicationId,
        sourceSessionId: workSessionId, sourceEntryId: assistantEntry.id,
      });
      await deliverConversationPublication({
        chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
        publicationId: published.publication.publicationId,
      }).catch((error: unknown) => console.error("群外部投递失败", error instanceof Error ? error.message : String(error)));
      if (finished === null) {
        // Cancelled between the pre-check and the commit: do not overwrite the terminal state.
        return (await readConversationWorkState(input.chatHome, input.storageProjectId, input.conversationId))
          .works.find((candidate) => candidate.workId === work.workId) ?? { ...work, status: "cancelled" };
      }
      return finished;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A cancelled (or crash-recovered) work keeps its terminal state and resolves with it: the
      // caller must not see a rejected promise for a correct cancellation, and no failure may be
      // written over the terminal row.
      const latest = (await readConversationWorkState(input.chatHome, input.storageProjectId, input.conversationId))
        .works.find((candidate) => candidate.workId === work.workId);
      if (latest !== undefined && latest.status !== "running") return latest;
      await finishWork(input, "running", { status: "failed", error: message }).catch(() => undefined);
      throw error;
    } finally {
      runningWorkSessions.delete(work.workId);
      created?.session.dispose();
    }
  });
}

const drains = new Map<string, Promise<void>>();

/**
 * Restart recovery for group works: a `running` work lost its terminal state (the process died
 * mid-turn), so it becomes `failed` and is never replayed; `queued` works stay resumable.
 */
export async function recoverConversationWorks(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
}): Promise<{ queued: number; interrupted: number }> {
  return changeWorkState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    let queued = 0;
    let interrupted = 0;
    const now = new Date().toISOString();
    for (const work of state.works) {
      if (work.status === "queued") queued += 1;
      else if (work.status === "running") {
        work.status = "failed";
        work.error = "进程重启时缺少终态，标记为失败，不重放未知副作用";
        work.updatedAt = now;
        interrupted += 1;
      }
    }
    return { queued, interrupted };
  });
}

/** Ordered worker for one conversation's group works; independent of discussion rounds. */
export function drainConversationWorks(input: { chatHome: string; storageProjectId: string; conversationId: string }): Promise<void> {
  const key = `${input.chatHome}\0${input.storageProjectId}\0${input.conversationId}`;
  const existing = drains.get(key);
  if (existing !== undefined) return existing;
  const run = (async () => {
    for (;;) {
      const state = await readConversationWorkState(input.chatHome, input.storageProjectId, input.conversationId);
      const next = state.works.filter((work) => work.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (next === undefined) return;
      try {
        await executeConversationWork({ ...input, workId: next.workId });
      } catch (error) {
        console.error("群任务执行失败", error instanceof Error ? error.message : String(error));
      }
    }
  })().finally(() => { if (drains.get(key) === run) drains.delete(key); });
  drains.set(key, run);
  return run;
}

/** Cancel a queued or running work, then propagate the abort to its live model turn if any. */
export async function cancelConversationWork(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  workId: string;
}): Promise<ConversationWork> {
  // Same arbitration lock as the publication commit: whoever wins the lock linearizes first. The lock
  // covers only the status write, never the model turn or the abort below.
  const release = await acquireWorkCommitLock(workCommitKey(input.storageProjectId, input.conversationId));
  let cancelled: ConversationWork;
  try {
    cancelled = await changeWorkState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
      const work = state.works.find((candidate) => candidate.workId === input.workId);
      if (work === undefined) throw new ConversationError(404, "找不到该群任务");
      if (work.status !== "queued" && work.status !== "running") throw new ConversationError(409, "该群任务已结束，不能取消");
      work.status = "cancelled";
      work.updatedAt = new Date().toISOString();
      return { ...work };
    });
  } finally {
    release();
  }
  const live = runningWorkSessions.get(input.workId);
  if (live !== undefined) await live.abort().catch(() => undefined);
  return cancelled;
}
