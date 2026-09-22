import { reserveChatSession } from "../../chat-session.js";
import { resolveProjectContext } from "../../projects/registry.js";
import { readLongAgentRegistry } from "../storage.js";
import { resolveLongAgentScope, assertConversationGrantsAllowed, type LongAgentScope, type LongAgentToolGrants } from "../scope.js";
import {
  ConversationError,
  DEFAULT_CONVERSATION_BUDGET,
  EMPTY_TOOL_GRANTS,
  activeMember,
  conversationIdOf,
  parseConversationBudget,
  parseConversationPolicy,
  parseToolGrants,
  type Conversation,
  type ConversationBudget,
  type ConversationPolicy,
  type ConversationPolicyConfig,
} from "./contract.js";
import { changeConversationState, readConversationState, requireConversation } from "./storage.js";
import { GROUP_PARTICIPATION } from "./access.js";

async function enabledFriend(chatHome: string, longAgentId: string): Promise<void> {
  const agent = (await readLongAgentRegistry(chatHome)).agents.find((candidate) => candidate.id === longAgentId);
  if (agent === undefined) throw new ConversationError(404, `找不到 Friend：${longAgentId}`);
  if (!agent.enabled || agent.status === "archived") throw new ConversationError(409, `Friend 已停用或归档：${longAgentId}`);
}

/** Create a group with a public root Session; idempotent per creation requestId. */
export async function createConversation(input: {
  chatHome: string;
  storageProjectId: string;
  title: string;
  requestId: string;
  memberLongAgentIds: readonly string[];
  /** Optional collaboration target; it is NOT the storage Project unless the user says so. */
  collaborationProjectId?: string | null;
  policy?: { defaultPolicy?: ConversationPolicy; moderatorLongAgentId?: string | null; roundRobinOrder?: string[] };
  budget?: Partial<ConversationBudget>;
}): Promise<Conversation> {
  if (input.requestId.trim() === "" || input.requestId.length > 256) throw new ConversationError(400, "创建请求需要有效 requestId");
  if (input.memberLongAgentIds.length === 0) throw new ConversationError(400, "群至少需要一位 Friend");
  const members = [...new Set(input.memberLongAgentIds)];
  for (const longAgentId of members) await enabledFriend(input.chatHome, longAgentId);
  const collaborationProjectId = input.collaborationProjectId ?? null;
  if (collaborationProjectId !== null) await resolveProjectContext(collaborationProjectId, input.chatHome);
  const id = conversationIdOf(input.requestId);
  const existing = (await readConversationState(input.chatHome, input.storageProjectId)).conversations.find((candidate) => candidate.id === id);
  if (existing !== undefined) return existing;
  // The public root is a native Session of the storage Project; it never runs a shared Agent loop.
  const publicSession = await reserveChatSession({ chatHome: input.chatHome, projectId: input.storageProjectId }, input.title);
  const now = new Date().toISOString();
  return changeConversationState(input.chatHome, input.storageProjectId, (state) => {
    const duplicate = state.conversations.find((candidate) => candidate.id === id);
    if (duplicate !== undefined) return duplicate;
    const policyInput = {
      defaultPolicy: input.policy?.defaultPolicy ?? "mention",
      moderatorLongAgentId: input.policy?.moderatorLongAgentId ?? null,
      roundRobinOrder: input.policy?.roundRobinOrder ?? members,
    };
    const policy = parseConversationPolicy(policyInput, members);
    const budget = parseConversationBudget({ ...DEFAULT_CONVERSATION_BUDGET, ...(input.budget ?? {}) });
    const conversation: Conversation = {
      schemaVersion: 1,
      id,
      title: input.title,
      storageProjectId: input.storageProjectId,
      collaborationProjectId,
      publicSessionId: publicSession.manager.getSessionId(),
      lifecycle: "active",
      authorizationRevision: 1,
      policy,
      budget,
      members: members.map((longAgentId) => ({
        longAgentId, participationEpoch: 1, sessionId: null, joinedAt: now, revokedAt: null, grants: { ...EMPTY_TOOL_GRANTS },
      })),
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    state.conversations.push(conversation);
    return conversation;
  });
}

export async function listConversations(chatHome: string, storageProjectId: string): Promise<Conversation[]> {
  return (await readConversationState(chatHome, storageProjectId)).conversations;
}

export async function readConversation(chatHome: string, storageProjectId: string, conversationId: string): Promise<Conversation> {
  return requireConversation(await readConversationState(chatHome, storageProjectId), conversationId);
}

/**
 * Configuration write with CAS. Any change to members, grants or policy bumps
 * `authorizationRevision`, so runs that already froze an older revision never inherit it.
 */
export async function updateConversation(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  expectedRevision: number;
  title?: string;
  policy?: ConversationPolicyConfig;
  budget?: ConversationBudget;
  memberLongAgentIds?: readonly string[];
  collaborationProjectId?: string | null;
}): Promise<Conversation> {
  return changeConversationState(input.chatHome, input.storageProjectId, async (state) => {
    const conversation = requireConversation(state, input.conversationId);
    if (conversation.revision !== input.expectedRevision)
      throw new ConversationError(409, `群配置已被修改（当前 revision ${conversation.revision}），请重新读取后再更新`);
    if (conversation.lifecycle === "archived") throw new ConversationError(409, "已归档的群不能修改配置");
    let authorizationChanged = false;
    if (input.memberLongAgentIds !== undefined) {
      const next = [...new Set(input.memberLongAgentIds)];
      if (next.length === 0) throw new ConversationError(400, "群至少需要一位 Friend");
      for (const longAgentId of next) {
        if (activeMember(conversation, longAgentId) === null) await enabledFriend(input.chatHome, longAgentId);
      }
      const now = new Date().toISOString();
      const members = next.map((longAgentId) => {
        const existing = conversation.members.find((member) => member.longAgentId === longAgentId);
        return existing ?? { longAgentId, participationEpoch: 1, sessionId: null, joinedAt: now, revokedAt: null, grants: { ...EMPTY_TOOL_GRANTS } };
      });
      if (members.length !== conversation.members.length) authorizationChanged = true;
      conversation.members = members;
    }
    if (input.title !== undefined) conversation.title = input.title;
    if (input.collaborationProjectId !== undefined) {
      const next = input.collaborationProjectId;
      if (next !== null) await resolveProjectContext(next, input.chatHome);
      if (conversation.collaborationProjectId !== next) {
        conversation.collaborationProjectId = next;
        authorizationChanged = true;
      }
    }
    if (input.policy !== undefined) {
      conversation.policy = parseConversationPolicy(input.policy, conversation.members.map((member) => member.longAgentId));
      authorizationChanged = true;
    }
    if (input.budget !== undefined) conversation.budget = parseConversationBudget(input.budget);
    if (authorizationChanged) conversation.authorizationRevision += 1;
    conversation.revision += 1;
    conversation.updatedAt = new Date().toISOString();
    return conversation;
  });
}

/** Explicit capability grants for one member; default-deny stays in force for everything else. */
export async function setMemberGrants(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  longAgentId: string;
  expectedRevision: number;
  grants: LongAgentToolGrants;
}): Promise<Conversation> {
  return changeConversationState(input.chatHome, input.storageProjectId, (state) => {
    const conversation = requireConversation(state, input.conversationId);
    if (conversation.revision !== input.expectedRevision)
      throw new ConversationError(409, `群配置已被修改（当前 revision ${conversation.revision}），请重新读取后再更新`);
    const member = activeMember(conversation, input.longAgentId);
    if (member === null) throw new ConversationError(409, "该 Friend 不是当前成员，不能设置授权");
    // Fail at write time: a grant the turn can never use must not look like a successful setting.
    assertConversationGrantsAllowed(input.grants);
    member.grants = parseToolGrants(input.grants);
    conversation.authorizationRevision += 1;
    conversation.revision += 1;
    conversation.updatedAt = new Date().toISOString();
    return conversation;
  });
}

/** Revoking keeps history but ends the participation: the old Session must not carry context back in. */
export async function revokeMember(input: {
  chatHome: string; storageProjectId: string; conversationId: string; longAgentId: string; expectedRevision: number;
}): Promise<Conversation> {
  return changeConversationState(input.chatHome, input.storageProjectId, (state) => {
    const conversation = requireConversation(state, input.conversationId);
    if (conversation.revision !== input.expectedRevision)
      throw new ConversationError(409, `群配置已被修改（当前 revision ${conversation.revision}），请重新读取后再更新`);
    const member = activeMember(conversation, input.longAgentId);
    if (member === null) throw new ConversationError(409, "该 Friend 不是当前成员");
    member.revokedAt = new Date().toISOString();
    member.sessionId = null;
    member.grants = { ...EMPTY_TOOL_GRANTS };
    conversation.authorizationRevision += 1;
    conversation.revision += 1;
    conversation.updatedAt = new Date().toISOString();
    return conversation;
  });
}

/** Re-joining starts a new participation period with no context or grants from the previous one. */
export async function rejoinMember(input: {
  chatHome: string; storageProjectId: string; conversationId: string; longAgentId: string; expectedRevision: number;
}): Promise<Conversation> {
  await enabledFriend(input.chatHome, input.longAgentId);
  return changeConversationState(input.chatHome, input.storageProjectId, (state) => {
    const conversation = requireConversation(state, input.conversationId);
    if (conversation.revision !== input.expectedRevision)
      throw new ConversationError(409, `群配置已被修改（当前 revision ${conversation.revision}），请重新读取后再更新`);
    const member = conversation.members.find((candidate) => candidate.longAgentId === input.longAgentId);
    if (member === undefined) throw new ConversationError(404, "该 Friend 从未加入该群");
    if (member.revokedAt === null) throw new ConversationError(409, "该 Friend 当前仍是成员");
    member.participationEpoch += 1;
    member.sessionId = null;
    member.revokedAt = null;
    member.joinedAt = new Date().toISOString();
    member.grants = { ...EMPTY_TOOL_GRANTS };
    conversation.authorizationRevision += 1;
    conversation.revision += 1;
    conversation.updatedAt = new Date().toISOString();
    return conversation;
  });
}

export async function archiveConversation(input: {
  chatHome: string; storageProjectId: string; conversationId: string; expectedRevision: number;
}): Promise<Conversation> {
  return changeConversationState(input.chatHome, input.storageProjectId, (state) => {
    const conversation = requireConversation(state, input.conversationId);
    if (conversation.revision !== input.expectedRevision)
      throw new ConversationError(409, `群配置已被修改（当前 revision ${conversation.revision}），请重新读取后再更新`);
    if (conversation.lifecycle === "archived") return conversation;
    conversation.lifecycle = "archived";
    conversation.revision += 1;
    conversation.updatedAt = new Date().toISOString();
    return conversation;
  });
}

/** Bind (or create) the member's own participation Session; every Friend keeps an independent one. */
export async function bindParticipationSession(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  longAgentId: string;
}): Promise<{ conversation: Conversation; sessionId: string; participationEpoch: number; created: boolean }> {
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  const member = activeMember(conversation, input.longAgentId);
  if (member === null) throw new ConversationError(409, "该 Friend 当前不是群成员，不能建立参与 Session");
  if (member.sessionId !== null) return { conversation, sessionId: member.sessionId, participationEpoch: member.participationEpoch, created: false };
  const reserved = await reserveChatSession(
    { chatHome: input.chatHome, projectId: input.storageProjectId },
    `${conversation.title} · ${input.longAgentId}`,
  );
  const sessionId = reserved.manager.getSessionId();
  // Mark the Session durably: every later read can tell it is a group participation context and
  // re-check the current authorization rather than trusting an old binding.
  reserved.manager.appendCustomEntry(GROUP_PARTICIPATION, {
    conversationId: conversation.id,
    storageProjectId: conversation.storageProjectId,
    longAgentId: input.longAgentId,
    participationEpoch: member.participationEpoch,
    boundAt: new Date().toISOString(),
  });
  reserved.manager.flush();
  const updated = await changeConversationState(input.chatHome, input.storageProjectId, (state) => {
    const current = requireConversation(state, input.conversationId);
    const currentMember = activeMember(current, input.longAgentId);
    if (currentMember === null || currentMember.participationEpoch !== member.participationEpoch)
      throw new ConversationError(409, "参与期已变化，请重新读取后再绑定");
    if (currentMember.sessionId === null) {
      currentMember.sessionId = sessionId;
      current.revision += 1;
      current.updatedAt = new Date().toISOString();
    }
    return current;
  });
  const bound = activeMember(updated, input.longAgentId);
  return { conversation: updated, sessionId: bound?.sessionId ?? sessionId, participationEpoch: bound?.participationEpoch ?? member.participationEpoch, created: true };
}

/**
 * Trusted scope resolution for one member turn. The Backend calls this with the conversation it read
 * from storage; the grants commitment returned here is what the assembly verifies, so a client- or
 * model-supplied scope can never widen the turn.
 */
export async function resolveParticipationScope(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  longAgentId: string;
  sessionId: string;
}): Promise<{ conversation: Conversation; scope: LongAgentScope; grantsDigest: string }> {
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  const member = activeMember(conversation, input.longAgentId);
  if (member === null) throw new ConversationError(409, "该 Friend 当前不是群成员，不能参与本轮");
  if (member.sessionId === null || member.sessionId !== input.sessionId)
    throw new ConversationError(409, "参与 Session 与该成员当前绑定不一致");
  if (conversation.lifecycle === "archived") throw new ConversationError(409, "群已归档，不能启动新的发言");
  const scope = resolveLongAgentScope({
    kind: "conversation",
    longAgentId: input.longAgentId,
    sessionId: input.sessionId,
    conversationId: conversation.id,
    participationEpoch: member.participationEpoch,
    authorizationRevision: conversation.authorizationRevision,
    storageProjectId: conversation.storageProjectId,
    collaborationProjectId: collaborationProjectOf(conversation),
    grants: member.grants,
  });
  return { conversation, scope, grantsDigest: scope.authorization.grantsDigest };
}

/**
 * Trusted scope for a work's own Task Session. The membership and participation period still come
 * from the conversation record; only the native Session identity is the work's independent one, so a
 * background task never runs in (or writes into) the member's group participation Session.
 */
export async function resolveConversationWorkScope(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  longAgentId: string;
  workSessionId: string;
  participationEpoch: number;
}): Promise<{ conversation: Conversation; scope: LongAgentScope; grantsDigest: string }> {
  const conversation = await readConversation(input.chatHome, input.storageProjectId, input.conversationId);
  if (conversation.lifecycle === "archived") throw new ConversationError(409, "群已归档，不能继续任务");
  const member = activeMember(conversation, input.longAgentId);
  if (member === null) throw new ConversationError(409, "该 Friend 当前不是群成员，不能继续任务");
  if (member.participationEpoch !== input.participationEpoch)
    throw new ConversationError(409, "参与期已变化，该任务不能继续");
  if (input.workSessionId.trim() === "" || input.workSessionId === member.sessionId)
    throw new ConversationError(409, "群后台任务必须使用独立的任务 Session");
  const scope = resolveLongAgentScope({
    kind: "conversation",
    longAgentId: input.longAgentId,
    sessionId: input.workSessionId,
    conversationId: conversation.id,
    participationEpoch: member.participationEpoch,
    authorizationRevision: conversation.authorizationRevision,
    storageProjectId: conversation.storageProjectId,
    collaborationProjectId: collaborationProjectOf(conversation),
    grants: member.grants,
  });
  return { conversation, scope, grantsDigest: scope.authorization.grantsDigest };
}

/** The collaboration target of a group turn: the configured project, never the storage Project by default. */
function collaborationProjectOf(conversation: Conversation): string | null {
  return conversation.collaborationProjectId;
}
