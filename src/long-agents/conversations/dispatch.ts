import { openChatSession } from "../../chat-session.js";
import { createChatPiAgentSession } from "../../agents/pi-agent-session.js";
import { prepareLongAgentAssembly } from "../assembly.js";
import { readLongAgentRegistry } from "../storage.js";
import { ConversationError, activeMember } from "./contract.js";
import { assertConversationAuthorization, publishConversationSpeech, type ConversationPublication } from "./publication.js";
import { readConversation, resolveParticipationScope } from "./service.js";
import {
  claimDiscussionModelCall,
  claimSpeechAttempt,
  discussionBudgetStopReason,
  finishSpeechAttempt,
  readDiscussionState,
  recordDiscussionTokenUsage,
  recoverDiscussionState,
  recordDiscussionModelCall,
  stopDiscussion,
  type SpeechAttempt,
} from "./discussions.js";
import { participationTurnKey, withParticipationTurnLock } from "./turn-lock.js";
import { deliverConversationPublication } from "./channel.js";
import { acquireWorkCommitLock, workCommitKey } from "./work-commit-lock.js";

const activeDrains = new Map<string, Promise<void>>();
const drainKey = (chatHome: string, projectId: string, conversationId: string) => `${chatHome}\0${projectId}\0${conversationId}`;

/** A free-discussion turn that explicitly chooses not to speak is recorded as skipped, not published. */
export const CONVERSATION_SILENCE_MARKER = "<silent/>";

interface AssistantMessageLike {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** Provider-reported token total for one assistant message; 0 when the provider omitted usage. */
function assistantTokens(message: AssistantMessageLike): number {
  const usage = message.usage;
  if (usage === undefined) return 0;
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return Math.max(0, Math.trunc(usage.totalTokens));
  const sum = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return Number.isFinite(sum) ? Math.max(0, Math.trunc(sum)) : 0;
}

function assistantText(message: AssistantMessageLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
}

/**
 * Execute one queued speech attempt in the member's own participation Session.
 *
 * Everything security-relevant is derived here, in this call stack, from the stored conversation:
 * the participation binding, the frozen scope and its grants commitment, and the authorization is
 * asserted both before the model call and again before the public commit. The caller cannot supply a
 * scope, a session, or an authorization revision that the record does not already hold.
 */
export async function dispatchConversationAttempt(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  discussionId: string;
  attemptId: string;
}): Promise<{ attempt: SpeechAttempt; publication: ConversationPublication | null }> {
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  const state = await readDiscussionState(input.chatHome, input.storageProjectId, input.conversationId);
  const discussion = state.discussions.find((candidate) => candidate.discussionId === input.discussionId);
  if (discussion === undefined) throw new ConversationError(404, "找不到该轮讨论");
  const attempt = discussion.attempts.find((candidate) => candidate.attemptId === input.attemptId);
  if (attempt === undefined) throw new ConversationError(404, "找不到该发言尝试");
  if (attempt.status !== "queued") throw new ConversationError(409, "该发言尝试不在待执行状态");
  // Frozen budget: never start a model call the discussion may not afford.
  const budgetStop = discussionBudgetStopReason(discussion);
  if (budgetStop !== null) {
    await finishSpeechAttempt({ ...input, status: "skipped", reason: budgetStop });
    throw new ConversationError(409, budgetStop);
  }
  const member = activeMember(conversation, attempt.speakerLongAgentId);
  if (member === null) {
    await finishSpeechAttempt({ ...input, status: "cancelled", reason: "成员资格已撤销，不执行该发言" });
    throw new ConversationError(409, "成员资格已撤销，不执行该发言");
  }
  // The attempt must have been queued against the authorization it is now running under.
  assertConversationAuthorization(conversation, {
    longAgentId: attempt.speakerLongAgentId,
    participationEpoch: attempt.participationEpoch,
    authorizationRevision: attempt.authorizationRevision,
  });
  if (member.participationEpoch !== attempt.participationEpoch) {
    await finishSpeechAttempt({ ...input, status: "cancelled", reason: "参与期已变化" });
    throw new ConversationError(409, "参与期已变化");
  }
  const agent = (await readLongAgentRegistry(input.chatHome)).agents
    .find((candidate) => candidate.id === attempt.speakerLongAgentId && candidate.enabled && candidate.status !== "archived");
  if (agent === undefined) {
    await finishSpeechAttempt({ ...input, status: "failed", reason: "找不到可用 Friend" });
    throw new ConversationError(409, "找不到可用 Friend");
  }
  let sessionId = member.sessionId;
  if (sessionId === null) {
    const { bindParticipationSession } = await import("./service.js");
    sessionId = (await bindParticipationSession({
      chatHome: input.chatHome, storageProjectId: input.storageProjectId,
      conversationId: input.conversationId, longAgentId: attempt.speakerLongAgentId,
    })).sessionId;
  }
  // Trusted scope resolution happens in this same call stack as execution, never via a caller.
  const resolved = await resolveParticipationScope({
    chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
    longAgentId: attempt.speakerLongAgentId, sessionId,
  });
  const claimed = await claimSpeechAttempt({ ...input });
  if (claimed === null) throw new ConversationError(409, "该发言尝试已被其他worker领取");
  // One participation Session runs one model turn at a time; two rounds/works cannot interleave it.
  return withParticipationTurnLock(participationTurnKey(input.storageProjectId, sessionId), async () => {
  const chatSession = await openChatSession({ chatHome: input.chatHome, projectId: input.storageProjectId, sessionId });
  let created: Awaited<ReturnType<typeof createChatPiAgentSession>> | undefined;
  try {
    const prepared = await prepareLongAgentAssembly({
      agent, chatHome: input.chatHome, projectId: resolved.scope.authorization.collaborationProjectId, turnId: input.attemptId,
      scope: resolved.scope, scopeGrantsDigest: resolved.grantsDigest,
    });
    // Every real provider request (including tool continuations) passes this fail-closed gate at the
    // public Pi assembly's request boundary, so one prompt cannot spend more than the root budget.
    let budgetDenied: string | null = null;
    let usageCommit: Promise<unknown> = Promise.resolve();
    const providerRequestGate = async (payload: unknown) => {
      await usageCommit;
      const reservation = await claimDiscussionModelCall({
        chatHome: input.chatHome, storageProjectId: input.storageProjectId,
        conversationId: input.conversationId, discussionId: input.discussionId,
      });
      if (!reservation.granted) {
        budgetDenied = reservation.reason ?? "模型调用预算";
        throw new ConversationError(409, `根预算已用尽：${budgetDenied}`);
      }
      return payload;
    };
    created = await createChatPiAgentSession({
      chatSession,
      sessionManager: chatSession.manager,
      ...prepared,
      providerRequestGate,
      toolContext: { purpose: "execution", agentId: agent.id, longAgentId: agent.id, longAgentTurnId: input.attemptId },
    });
    let lastAssistant: AssistantMessageLike | undefined;
    const unsubscribe = created.session.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      lastAssistant = event.message;
      // Durable token metering: the next provider request's gate reads this counter.
      usageCommit = usageCommit.then(() => recordDiscussionTokenUsage({
        chatHome: input.chatHome, storageProjectId: input.storageProjectId,
        conversationId: input.conversationId, discussionId: input.discussionId,
        tokens: assistantTokens(event.message),
      }));
      // The synchronous event emitter cannot await this write. Observe rejection here, but keep
      // the original rejected promise for the next request gate and final settlement to enforce.
      void usageCommit.catch(() => undefined);
    });
    try {
      await created.session.prompt(attempt.instruction);
    } finally {
      unsubscribe();
      await usageCommit;
    }
    if (budgetDenied !== null) {
      const skipped = await finishSpeechAttempt({ ...input, status: "skipped", reason: `根预算已用尽：${budgetDenied}` });
      return { attempt: skipped, publication: null };
    }
    if (lastAssistant === undefined || lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")
      throw new ConversationError(409, lastAssistant?.errorMessage ?? "Friend 没有返回可发布的发言");
    const text = assistantText(lastAssistant);
    if (text.trim() === "") throw new ConversationError(409, "Friend 没有返回可发布的文本");
    // Free discussion may explicitly decline to speak; a silence is a terminal skip, not a publication.
    if (text.trim() === CONVERSATION_SILENCE_MARKER) {
      const skipped = await finishSpeechAttempt({ ...input, status: "skipped", reason: "本轮选择不发言" });
      return { attempt: skipped, publication: null };
    }
    const assistantEntry = chatSession.manager.getEntries()
      .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
      .at(-1);
    if (assistantEntry === undefined) throw new ConversationError(409, "缺少可发布的源条目");
    // Second authorization check: the run may have been revoked while the model was working.
    const after = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
    assertConversationAuthorization(after, {
      longAgentId: attempt.speakerLongAgentId,
      participationEpoch: attempt.participationEpoch,
      authorizationRevision: attempt.authorizationRevision,
    });
    const published = await publishConversationSpeech({
      chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
      longAgentId: attempt.speakerLongAgentId, attemptId: input.attemptId,
      participationEpoch: attempt.participationEpoch, authorizationRevision: attempt.authorizationRevision,
      sourceSessionId: sessionId, sourceEntryId: assistantEntry.id, text,
      assertStillAuthorized: async () => {
        const release = await acquireWorkCommitLock(workCommitKey(input.storageProjectId, input.conversationId));
        try {
          const latest = (await readDiscussionState(input.chatHome, input.storageProjectId, input.conversationId))
            .discussions.find((item) => item.discussionId === input.discussionId);
          if (latest === undefined || latest.status === "stopped" || latest.status === "interrupted")
            throw new ConversationError(409, "讨论已停止，拒绝发布迟到结果");
          return release;
        } catch (error) { release(); throw error; }
      },
    });
    const finished = await finishSpeechAttempt({
      ...input, status: "published", publicationId: published.publication.publicationId,
      sourceSessionId: sessionId, sourceEntryId: assistantEntry.id,
    });
    // Outbound channel delivery is a separate, retryable step; it resolves the public reference itself
    // and never regenerates the answer.
    await deliverConversationPublication({
      chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
      publicationId: published.publication.publicationId,
    }).catch((error: unknown) => console.error("群外部投递失败", error instanceof Error ? error.message : String(error)));
    return { attempt: finished, publication: published.publication };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSpeechAttempt({ ...input, status: "failed", reason: message }).catch(() => undefined);
    throw error;
  } finally {
    created?.session.dispose();
  }
  });
}

/**
 * Ordered worker for one conversation: recover first (a `running` attempt without a terminal state is
 * marked interrupted and never replayed), then execute queued attempts one at a time. Waiting for the
 * model releases the file locks because each attempt is a short lock-and-write, not a held lock.
 */
export function drainConversationAttempts(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
}): Promise<void> {
  const key = drainKey(input.chatHome, input.storageProjectId, input.conversationId);
  const existing = activeDrains.get(key);
  if (existing !== undefined) return existing;
  const run = (async () => {
    await recoverDiscussionState(input);
    for (;;) {
      const state = await readDiscussionState(input.chatHome, input.storageProjectId, input.conversationId);
      const queued = state.discussions
        .flatMap((discussion) => discussion.attempts.map((attempt) => ({ discussion, attempt })))
        .filter(({ attempt }) => attempt.status === "queued")
        .sort((left, right) => left.attempt.createdAt.localeCompare(right.attempt.createdAt) || left.attempt.attemptId.localeCompare(right.attempt.attemptId));
      if (queued.length === 0) {
        // A discussion that stopped only to wait for capacity is complete once the queue drained.
        for (const discussion of state.discussions) {
          if (discussion.status !== "waiting") continue;
          const terminal = discussion.attempts.every((attempt) =>
            attempt.status === "published" || attempt.status === "skipped" || attempt.status === "failed" || attempt.status === "cancelled" || attempt.status === "interrupted");
          if (!terminal) continue;
          await stopDiscussion({
            ...input, discussionId: discussion.discussionId,
            status: discussion.attempts.some((attempt) => attempt.status === "failed") ? "failed" : "completed",
            stopReason: "并发容量已释放，本轮完成",
          });
        }
        return;
      }
      const next = queued[0]!;
      try {
        await dispatchConversationAttempt({
          ...input, discussionId: next.discussion.discussionId, attemptId: next.attempt.attemptId,
        });
      } catch (error) {
        // The attempt recorded its own failure; keep draining the remaining queued work.
        console.error("群发言执行失败", error instanceof Error ? error.message : String(error));
      }
    }
  })().finally(() => { if (activeDrains.get(key) === run) activeDrains.delete(key); });
  activeDrains.set(key, run);
  return run;
}

export function isConversationWorkerActive(chatHome: string, storageProjectId: string, conversationId: string): boolean {
  return activeDrains.has(drainKey(chatHome, storageProjectId, conversationId));
}
