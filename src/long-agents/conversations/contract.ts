import { createHash } from "node:crypto";
import type { LongAgentToolGrants } from "../scope.js";

/** Group chat objects (LA5). See docs/modules/long-agents/group-chat.md §3. */
export type ConversationLifecycle = "active" | "archived";
export type ConversationPolicy = "mention" | "round-robin" | "parallel" | "moderator" | "free";

export interface ConversationMember {
  longAgentId: string;
  /** 1-based authorization period; re-joining creates a new epoch and a new participation Session. */
  participationEpoch: number;
  sessionId: string | null;
  joinedAt: string;
  revokedAt: string | null;
  /** Explicit capability grants; the scope is default-deny without them. */
  grants: LongAgentToolGrants;
}

export interface ConversationPolicyConfig {
  defaultPolicy: ConversationPolicy;
  moderatorLongAgentId: string | null;
  roundRobinOrder: string[];
}

export interface ConversationBudget {
  maxRounds: number;
  maxModelCalls: number;
  maxWallClockMs: number;
  maxConcurrentSpeakers: number;
  maxDelegationDepth: number;
  maxTokensSoft: number;
}

export interface Conversation {
  schemaVersion: 1;
  id: string;
  title: string;
  storageProjectId: string;
  /** Frozen collaboration target, separate from the storage Project; null means own workspace only. */
  collaborationProjectId: string | null;
  publicSessionId: string;
  lifecycle: ConversationLifecycle;
  /** Bumps whenever members/grants/policy change, so in-flight runs never inherit new authorization. */
  authorizationRevision: number;
  policy: ConversationPolicyConfig;
  budget: ConversationBudget;
  members: ConversationMember[];
  createdAt: string;
  updatedAt: string;
  /** Compare-and-swap revision for configuration writes. */
  revision: number;
}

export class ConversationError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const DEFAULT_CONVERSATION_BUDGET: ConversationBudget = {
  maxRounds: 3,
  maxModelCalls: 12,
  maxWallClockMs: 15 * 60 * 1000,
  maxConcurrentSpeakers: 2,
  maxDelegationDepth: 1,
  maxTokensSoft: 200_000,
};

export const EMPTY_TOOL_GRANTS: LongAgentToolGrants = { systemToolAddresses: [], nativeTools: [], extensionTools: [] };

export function conversationIdOf(requestId: string): string {
  return `conv-${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
}

export function conversationContentRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ConversationError(400, `${label}包含未知字段`);
}

function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new ConversationError(400, `${label}无效`);
  return value;
}

function positiveInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new ConversationError(400, `${label}必须是 1–${max} 的整数`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new ConversationError(400, `${label}必须是 0–${max} 的整数`);
  return Number(value);
}

function textList(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new ConversationError(400, `${label}无效`);
  return value.map((item) => text(item, label, 200));
}

export function parseToolGrants(value: unknown, label = "工具授权"): LongAgentToolGrants {
  if (value === undefined) return { ...EMPTY_TOOL_GRANTS };
  if (!record(value)) throw new ConversationError(400, `${label}无效`);
  exactKeys(value, ["systemToolAddresses", "nativeTools", "extensionTools"], label);
  return {
    systemToolAddresses: textList(value.systemToolAddresses ?? [], `${label}的Chat系统Tool`, 200),
    nativeTools: textList(value.nativeTools ?? [], `${label}的原生Tool`, 200),
    extensionTools: textList(value.extensionTools ?? [], `${label}的Extension/MCP Tool`, 200),
  };
}

export function parseConversationBudget(value: unknown): ConversationBudget {
  if (value === undefined) return { ...DEFAULT_CONVERSATION_BUDGET };
  if (!record(value)) throw new ConversationError(400, "预算无效");
  exactKeys(value, ["maxRounds", "maxModelCalls", "maxWallClockMs", "maxConcurrentSpeakers", "maxDelegationDepth", "maxTokensSoft"], "预算");
  return {
    maxRounds: positiveInteger(value.maxRounds, "maxRounds", 50),
    maxModelCalls: positiveInteger(value.maxModelCalls, "maxModelCalls", 500),
    maxWallClockMs: positiveInteger(value.maxWallClockMs, "maxWallClockMs", 24 * 60 * 60 * 1000),
    maxConcurrentSpeakers: positiveInteger(value.maxConcurrentSpeakers, "maxConcurrentSpeakers", 16),
    maxDelegationDepth: nonNegativeInteger(value.maxDelegationDepth, "maxDelegationDepth", 5),
    maxTokensSoft: positiveInteger(value.maxTokensSoft, "maxTokensSoft", 10_000_000),
  };
}

export function parseConversationPolicy(value: unknown, memberIds: readonly string[]): ConversationPolicyConfig {
  if (value === undefined) return { defaultPolicy: "mention", moderatorLongAgentId: null, roundRobinOrder: [...memberIds] };
  if (!record(value)) throw new ConversationError(400, "策略无效");
  exactKeys(value, ["defaultPolicy", "moderatorLongAgentId", "roundRobinOrder"], "策略");
  const policies: ConversationPolicy[] = ["mention", "round-robin", "parallel", "moderator", "free"];
  if (!policies.includes(value.defaultPolicy as ConversationPolicy)) throw new ConversationError(400, "策略类型无效");
  const moderator = value.moderatorLongAgentId === null || value.moderatorLongAgentId === undefined ? null : String(value.moderatorLongAgentId);
  const order = textList(value.roundRobinOrder ?? memberIds, "圆桌顺序", 64);
  for (const id of [moderator, ...order]) {
    if (id !== null && !memberIds.includes(id)) throw new ConversationError(400, "策略引用了非成员 Friend");
  }
  return { defaultPolicy: value.defaultPolicy as ConversationPolicy, moderatorLongAgentId: moderator, roundRobinOrder: order };
}

export function parseConversationMember(value: unknown): ConversationMember {
  if (!record(value)) throw new ConversationError(400, "成员无效");
  exactKeys(value, ["longAgentId", "participationEpoch", "sessionId", "joinedAt", "revokedAt", "grants"], "成员");
  return {
    longAgentId: text(value.longAgentId, "成员Friend", 120),
    participationEpoch: positiveInteger(value.participationEpoch, "参与期", 1_000_000),
    sessionId: value.sessionId === null || value.sessionId === undefined ? null : text(value.sessionId, "参与Session", 200),
    joinedAt: text(value.joinedAt, "加入时间", 64),
    revokedAt: value.revokedAt === null || value.revokedAt === undefined ? null : text(value.revokedAt, "退出时间", 64),
    grants: parseToolGrants(value.grants),
  };
}

export function parseConversation(value: unknown): Conversation {
  if (!record(value)) throw new ConversationError(400, "会话无效");
  exactKeys(value, ["schemaVersion", "id", "title", "storageProjectId", "collaborationProjectId", "publicSessionId", "lifecycle", "authorizationRevision", "policy", "budget", "members", "createdAt", "updatedAt", "revision"], "会话");
  if (value.schemaVersion !== 1) throw new ConversationError(400, "会话版本无效");
  const id = text(value.id, "会话 id", 64);
  if (!/^conv-[a-f0-9]{32}$/.test(id)) throw new ConversationError(400, "会话 id 无效");
  if (value.lifecycle !== "active" && value.lifecycle !== "archived") throw new ConversationError(400, "会话生命周期无效");
  if (!Array.isArray(value.members)) throw new ConversationError(400, "成员列表无效");
  const members = value.members.map(parseConversationMember);
  if (new Set(members.map((member) => member.longAgentId)).size !== members.length)
    throw new ConversationError(400, "会话包含重复成员");
  return {
    schemaVersion: 1,
    id,
    title: text(value.title, "群名称", 120),
    storageProjectId: text(value.storageProjectId, "存储 Project", 120),
    collaborationProjectId: value.collaborationProjectId === null || value.collaborationProjectId === undefined
      ? null : text(value.collaborationProjectId, "协作项目", 120),
    publicSessionId: text(value.publicSessionId, "公共 Session", 200),
    lifecycle: value.lifecycle,
    authorizationRevision: positiveInteger(value.authorizationRevision, "授权修订", 1_000_000),
    policy: parseConversationPolicy(value.policy, members.map((member) => member.longAgentId)),
    budget: parseConversationBudget(value.budget),
    members,
    createdAt: text(value.createdAt, "创建时间", 64),
    updatedAt: text(value.updatedAt, "更新时间", 64),
    revision: positiveInteger(value.revision, "会话修订", 1_000_000),
  };
}

/** Active member for a Friend in a conversation, or null when not a member / already revoked. */
export function activeMember(conversation: Conversation, longAgentId: string): ConversationMember | null {
  const member = conversation.members.find((candidate) => candidate.longAgentId === longAgentId);
  if (member === undefined || member.revokedAt !== null) return null;
  return member;
}

/** Browser-safe group summary; never includes private participation content. */
export function conversationSummary(conversation: Conversation) {
  return {
    schemaVersion: 1 as const,
    id: conversation.id,
    title: conversation.title,
    storageProjectId: conversation.storageProjectId,
    collaborationProjectId: conversation.collaborationProjectId,
    publicSessionId: conversation.publicSessionId,
    lifecycle: conversation.lifecycle,
    revision: conversation.revision,
    authorizationRevision: conversation.authorizationRevision,
    policy: conversation.policy,
    budget: conversation.budget,
    members: conversation.members.map((member) => ({
      longAgentId: member.longAgentId,
      participationEpoch: member.participationEpoch,
      active: member.revokedAt === null,
      joinedAt: member.joinedAt,
      revokedAt: member.revokedAt,
      grants: member.grants,
      hasParticipationSession: member.sessionId !== null,
    })),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}
