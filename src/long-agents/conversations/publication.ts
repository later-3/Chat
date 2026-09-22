import { createHash } from "node:crypto";
import { openChatSession } from "../../chat-session.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../../session-operation-lock.js";
import { ConversationError, activeMember, type Conversation } from "./contract.js";
import { readConversation } from "./service.js";

export const GROUP_PUBLICATION = "chat.group-publication.v1";
/** An external channel message attached to the public order, keeping its real sender identity. */
export const GROUP_EXTERNAL_MESSAGE = "chat.group-external-message.v1";

/** Public stream entries reference the author's own Session; they never copy the private reasoning. */
export interface ConversationPublication {
  conversationId: string;
  publicationId: string;
  authorLongAgentId: string;
  attemptId: string;
  participationEpoch: number;
  sourceSessionId: string;
  sourceEntryId: string;
  /** Summary of the published block, used to detect drift; the block itself stays in the source Session. */
  contentHash: string;
  seq: number;
  postedAt: string;
}

export interface ConversationPublicMessage {
  /** Stable identity: the native entry id for a user message, the publicationId for a publication. */
  entryId: string;
  /** 1-based position in the conversation's append-only public order; used as the reconnect cursor. */
  cursor: number;
  seq: number;
  authorLongAgentId: string;
  /** Display name for an external human sender; null for the local owner and Friends. */
  authorDisplayName: string | null;
  /** True when the message came from an external channel and is data, not the local owner's instruction. */
  external: boolean;
  publicationId: string | null;
  /** Resolved text; null when the source block is unavailable or its summary no longer matches. */
  text: string | null;
  unavailableReason: string | null;
  postedAt: string;
  sourceSessionId: string;
}

export function publicationIdOf(input: {
  conversationId: string; attemptId: string; sourceSessionId: string; sourceEntryId: string; version: number;
}): string {
  return `pub-${createHash("sha256").update(JSON.stringify([input.conversationId, input.attemptId, input.sourceSessionId, input.sourceEntryId, input.version])).digest("hex").slice(0, 32)}`;
}

export function blockHash(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** Trusted re-validation helpers shared by dispatch and publication. */
export function assertConversationAuthorization(
  conversation: Conversation,
  expected: { longAgentId: string; participationEpoch: number; authorizationRevision: number },
): void {
  if (conversation.lifecycle === "archived") throw new ConversationError(409, "群已归档，不能继续该轮");
  const member = activeMember(conversation, expected.longAgentId);
  if (member === null) throw new ConversationError(409, "成员资格已撤销，不能继续该轮");
  if (member.participationEpoch !== expected.participationEpoch)
    throw new ConversationError(409, "参与期已变化（可能已退群并重新加入），本轮不得继续");
  if (conversation.authorizationRevision !== expected.authorizationRevision)
    throw new ConversationError(409, "群授权已变化，本轮按旧授权冻结的能力不再有效");
}

export interface PublishSpeechInput {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  longAgentId: string;
  attemptId: string;
  participationEpoch: number;
  authorizationRevision: number;
  sourceSessionId: string;
  sourceEntryId: string;
  /**
   * Present when the source Session is a work's own Task Session. Publication then verifies the
   * durable work-session marker instead of the member's participation binding, so a background task
   * can publish an authorized result without ever running in (or reading from) the participation
   * Session.
   */
  workId?: string;
  /**
   * Re-asserted *inside* the public-root lock, immediately before the append. A work passes a guard
   * that acquires the work commit arbitration lock, re-reads its own status and returns the release
   * function; publication holds that release across the append, so cancellation and commit are
   * linearized. Without the option (participation speech) no extra guard runs.
   */
  assertStillAuthorized?: () => Promise<(() => void) | void>;
  /** The block the author explicitly marked public; private reasoning/tool output never reaches here. */
  text: string;
}

/** Validate that the source Session is an authorized speaker Session for this conversation. */
async function assertSourceSessionAuthorized(input: {
  conversation: Conversation;
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  longAgentId: string;
  participationEpoch: number;
  sourceSessionId: string;
  workId?: string;
}): Promise<void> {
  const member = activeMember(input.conversation, input.longAgentId);
  if (member === null) throw new ConversationError(409, "成员资格已撤销，拒绝发布");
  if (member.sessionId === input.sourceSessionId) return;
  if (input.workId === undefined)
    throw new ConversationError(409, "源 Session 不是该成员当前的参与 Session，拒绝发布");
  // A work result is only publishable from that work's own bound Task Session.
  const source = await openChatSession({ chatHome: input.chatHome, projectId: input.storageProjectId, sessionId: input.sourceSessionId });
  const marker = source.manager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "chat.group-work-session.v1");
  const body = marker?.type === "custom" && typeof marker.data === "object" && marker.data !== null ? marker.data as Record<string, unknown> : null;
  if (body === null
    || body.conversationId !== input.conversationId
    || body.longAgentId !== input.longAgentId
    || Number(body.participationEpoch) !== input.participationEpoch
    || body.workId !== input.workId)
    throw new ConversationError(409, "源 Session 不是该任务的绑定 Task Session，拒绝发布");
}

/**
 * Publish one speech into the public root. The authorization is re-read from storage and re-verified
 * here (never taken from the caller's copy), the source Session still has to be the member's current
 * participation Session, and the append is idempotent per `publicationId`, so a lost receipt can be
 * recovered by re-publishing only — the model is never called again.
 */
export async function publishConversationSpeech(input: PublishSpeechInput): Promise<{ publication: ConversationPublication; created: boolean }> {
  if (input.text.trim() === "") throw new ConversationError(400, "不能发布空的群消息");
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  assertConversationAuthorization(conversation, {
    longAgentId: input.longAgentId, participationEpoch: input.participationEpoch, authorizationRevision: input.authorizationRevision,
  });
  const member = activeMember(conversation, input.longAgentId);
  if (member === null)
    throw new ConversationError(409, "成员资格已撤销，拒绝发布");
  await assertSourceSessionAuthorized({
    conversation, chatHome: input.chatHome, storageProjectId: input.storageProjectId,
    conversationId: input.conversationId, longAgentId: input.longAgentId,
    participationEpoch: input.participationEpoch, sourceSessionId: input.sourceSessionId,
    ...(input.workId === undefined ? {} : { workId: input.workId }),
  });
  // The published block must exist in the author's own Session and match what we are about to publish.
  const source = await openChatSession({ chatHome: input.chatHome, projectId: input.storageProjectId, sessionId: input.sourceSessionId });
  const sourceEntry = source.manager.getEntries().find((entry) => entry.id === input.sourceEntryId);
  if (sourceEntry === undefined) throw new ConversationError(409, "源条目不存在，不能发布（不会回退读取私有历史）");
  const sourceText = entryText(sourceEntry);
  if (sourceText === null) throw new ConversationError(409, "源条目不是可发布的文本块");
  if (blockHash(sourceText) !== blockHash(input.text))
    throw new ConversationError(409, "发布的正文与源条目不一致，拒绝发布");
  const publicationId = publicationIdOf({
    conversationId: input.conversationId, attemptId: input.attemptId,
    sourceSessionId: input.sourceSessionId, sourceEntryId: input.sourceEntryId, version: 1,
  });
  // The public root is a shared Session: append under its operation lock and reopen the latest leaf.
  // Authorization is re-read and re-asserted *inside* the lock, so a revocation that lands between
  // the initial check and the commit can never be inherited by an in-flight publication.
  return withChatSessionOperationLock(chatSessionOperationKey(input.storageProjectId, conversation.publicSessionId), async () => {
    const current = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
    assertConversationAuthorization(current, {
      longAgentId: input.longAgentId, participationEpoch: input.participationEpoch, authorizationRevision: input.authorizationRevision,
    });
    await assertSourceSessionAuthorized({
      conversation: current, chatHome: input.chatHome, storageProjectId: input.storageProjectId,
      conversationId: input.conversationId, longAgentId: input.longAgentId,
      participationEpoch: input.participationEpoch, sourceSessionId: input.sourceSessionId,
      ...(input.workId === undefined ? {} : { workId: input.workId }),
    });
    const reopened = await openChatSession({ chatHome: input.chatHome, projectId: input.storageProjectId, sessionId: conversation.publicSessionId });
    const existing = readPublications(reopened.manager.getEntries()).find((entry) => entry.publicationId === publicationId);
    if (existing !== undefined) return { publication: existing, created: false };
    // Cancellation (or any other terminal transition) must win over a commit that has not appended
    // yet. The guard holds the work's commit arbitration lock from its status re-read through the
    // append, so a cancellation that already committed cannot be bypassed by a stale read, and a
    // later cancellation queues instead of racing.
    const releaseGuard = await input.assertStillAuthorized?.();
    try {
      const seq = readPublications(reopened.manager.getEntries()).reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
      const publication: ConversationPublication = {
        conversationId: input.conversationId,
        publicationId,
        authorLongAgentId: input.longAgentId,
        attemptId: input.attemptId,
        participationEpoch: input.participationEpoch,
        sourceSessionId: input.sourceSessionId,
        sourceEntryId: input.sourceEntryId,
        contentHash: blockHash(input.text),
        seq,
        postedAt: new Date().toISOString(),
      };
      reopened.manager.appendCustomEntry(GROUP_PUBLICATION, publication);
      reopened.manager.flush();
      return { publication, created: true };
    } finally {
      releaseGuard?.();
    }
  });
}

/** Only explicit published references are public; drafts and private entries never appear. */
export function readPublications(entries: readonly { type: string; customType?: string; data?: unknown }[]): ConversationPublication[] {
  const publications: ConversationPublication[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== GROUP_PUBLICATION) continue;
    const value = entry.data;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConversationError(500, "公共发布记录损坏");
    const body = value as Record<string, unknown>;
    publications.push({
      conversationId: String(body.conversationId),
      publicationId: String(body.publicationId),
      authorLongAgentId: String(body.authorLongAgentId),
      attemptId: String(body.attemptId),
      participationEpoch: Number(body.participationEpoch),
      sourceSessionId: String(body.sourceSessionId),
      sourceEntryId: String(body.sourceEntryId),
      contentHash: String(body.contentHash),
      seq: Number(body.seq),
      postedAt: String(body.postedAt),
    });
  }
  return publications.sort((left, right) => left.seq - right.seq);
}

/**
 * Authorized public projection: the user message stream plus resolved publication references.
 * Nothing is read from a member's private Session beyond the published block, and a source that is
 * missing or changed is reported as unavailable instead of falling back to private history.
 */
export async function readConversationPublicMessages(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  /** Viewers must be an active member or the conversation owner (`null` = the local user). */
  viewerLongAgentId: string | null;
}): Promise<ConversationPublicMessage[]> {
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  if (input.viewerLongAgentId !== null && activeMember(conversation, input.viewerLongAgentId) === null)
    throw new ConversationError(403, "只有群成员可以查看该群的公共消息");
  const publicSession = await openChatSession({ chatHome: input.chatHome, projectId: input.storageProjectId, sessionId: conversation.publicSessionId });
  const entries = publicSession.manager.getEntries();
  const messages: ConversationPublicMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      messages.push({
        entryId: entry.id, cursor: 0, seq: 0, authorLongAgentId: "user", authorDisplayName: null, external: false, publicationId: null,
        text: entryText(entry), unavailableReason: null, postedAt: new Date(entry.timestamp ?? Date.now()).toISOString(), sourceSessionId: conversation.publicSessionId,
      });
    }
  }
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== GROUP_EXTERNAL_MESSAGE) continue;
    const value = entry.data;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const body = value as Record<string, unknown>;
    messages.push({
      entryId: entry.id, cursor: 0, seq: 0,
      authorLongAgentId: `external:${String(body.senderExternalId ?? "unknown")}`,
      authorDisplayName: typeof body.senderDisplayName === "string" ? body.senderDisplayName : null,
      external: true, publicationId: null,
      text: typeof body.text === "string" ? body.text : null,
      unavailableReason: null,
      postedAt: typeof body.postedAt === "string" ? body.postedAt : new Date(entry.timestamp ?? Date.now()).toISOString(),
      sourceSessionId: conversation.publicSessionId,
    });
  }
  for (const publication of readPublications(entries)) {
    let text: string | null = null;
    let unavailableReason: string | null = null;
    try {
      const source = await openChatSession({ chatHome: input.chatHome, projectId: input.storageProjectId, sessionId: publication.sourceSessionId });
      const sourceEntry = source.manager.getEntries().find((entry) => entry.id === publication.sourceEntryId);
      const sourceText = sourceEntry === undefined ? null : entryText(sourceEntry);
      if (sourceText === null) unavailableReason = "源条目缺失或不可读";
      else if (blockHash(sourceText) !== publication.contentHash) unavailableReason = "源条目已变化，引用不可用";
      else text = sourceText;
    } catch {
      unavailableReason = "源 Session 不可读";
    }
    messages.push({
      entryId: publication.publicationId, cursor: 0, seq: publication.seq, authorLongAgentId: publication.authorLongAgentId,
      authorDisplayName: null, external: false,
      publicationId: publication.publicationId, text, unavailableReason, postedAt: publication.postedAt, sourceSessionId: publication.sourceSessionId,
    });
  }
  // One append-only public order: chronological, ties broken by stable id, then numbered. A user
  // message and a publication are delivered through the same cursor, so both are incremental and
  // deduplicated by their stable id instead of by ignoring later messages.
  const ordered = messages.sort((left, right) => left.postedAt.localeCompare(right.postedAt) || left.entryId.localeCompare(right.entryId));
  ordered.forEach((message, index) => { message.cursor = index + 1; });
  return ordered;
}

/** Recovery for a lost receipt: re-publish already produced content; never call the model again. */
export async function recoverConversationPublication(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  longAgentId: string;
  attemptId: string;
  sourceSessionId: string;
  sourceEntryId: string;
  text: string;
}): Promise<{ publication: ConversationPublication; created: boolean }> {
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  const member = activeMember(conversation, input.longAgentId);
  if (member === null || member.sessionId !== input.sourceSessionId)
    throw new ConversationError(409, "参与期已结束，迟到的结果只能保留审计，不能补发到该群");
  return publishConversationSpeech({
    ...input,
    participationEpoch: member.participationEpoch,
    authorizationRevision: conversation.authorizationRevision,
  });
}

function entryText(entry: { type: string; message?: { role?: string; content?: unknown }; content?: unknown; customType?: string; data?: unknown }): string | null {
  if (entry.type === "message" && entry.message !== undefined && typeof entry.message.content === "string") return entry.message.content;
  if (entry.type === "message" && Array.isArray(entry.message?.content)) {
    const text = (entry.message.content as Array<Record<string, unknown>>)
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
    return text === "" ? null : text;
  }
  return null;
}
