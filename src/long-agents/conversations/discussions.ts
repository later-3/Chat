import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ensureProjectDataLayout } from "../../projects/registry.js";
import { assertFileWithin, atomicWriteJson, withFileLock } from "../../persistence/versioned-file.js";
import { acquireWorkCommitLock, workCommitKey } from "./work-commit-lock.js";
import {
  ConversationError,
  parseConversationBudget,
  type ConversationBudget,
  type ConversationPolicy,
} from "./contract.js";

/**
 * Discussion / SpeechAttempt / Delegation records (LA5 §3, §6).
 *
 * The registry lives beside the conversation it belongs to. It is the durable authority for what was
 * queued, what is running and which publication a speech produced, so a restart can recover queued
 * work and mark a run that lost its terminal state as `interrupted` instead of replaying it.
 */
export type DiscussionStatus = "planned" | "running" | "waiting" | "completed" | "stopped" | "failed" | "interrupted";
export type SpeechAttemptStatus = "queued" | "running" | "published" | "failed" | "skipped" | "cancelled" | "interrupted";

export interface SpeechAttempt {
  attemptId: string;
  round: number;
  speakerLongAgentId: string;
  participationEpoch: number;
  /** Public cursor/entry the speech was allowed to read; freezes the input cut-off. */
  inputCutoffEntryId: string | null;
  replyToEntryId: string | null;
  causationId: string | null;
  /** Authorization revision frozen at queue time; dispatch re-verifies it before and after running. */
  authorizationRevision: number;
  /** Server-built instruction derived from the authorised public projection. */
  instruction: string;
  status: SpeechAttemptStatus;
  reason: string | null;
  publicationId: string | null;
  sourceSessionId: string | null;
  sourceEntryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Discussion {
  discussionId: string;
  conversationId: string;
  policy: ConversationPolicy;
  round: number;
  inputCutoffEntryId: string | null;
  budget: ConversationBudget;
  status: DiscussionStatus;
  stopReason: string | null;
  /** Actual model calls counted for this discussion; the only budget counter that can be checked. */
  modelCalls: number;
  /** Accumulated tokens reported by the provider. Token budgets are soft: usage is known only after a call. */
  tokensUsed: number;
  startedAt: string;
  attempts: SpeechAttempt[];
  createdAt: string;
  updatedAt: string;
}

export interface DiscussionStop {
  stopReason: string;
}

export interface DiscussionState {
  schemaVersion: 1;
  discussions: Discussion[];
}

const DISCUSSION_STATUSES: readonly DiscussionStatus[] = ["planned", "running", "waiting", "completed", "stopped", "failed", "interrupted"];
const ATTEMPT_STATUSES: readonly SpeechAttemptStatus[] = ["queued", "running", "published", "failed", "skipped", "cancelled", "interrupted"];
const POLICIES: readonly ConversationPolicy[] = ["mention", "round-robin", "parallel", "moderator", "free"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ConversationError(500, `${label}包含未知字段`);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new ConversationError(500, `${label}无效`);
  return value;
}

function nonEmptyText(value: unknown, label: string, max: number): string {
  const result = text(value, label, max);
  if (result.trim() === "") throw new ConversationError(500, `${label}无效`);
  return result;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return nonEmptyText(value, label, max);
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new ConversationError(500, `${label}无效`);
  return Number(value);
}

function isoTime(value: unknown, label: string): string {
  const result = nonEmptyText(value, label, 64);
  if (Number.isNaN(Date.parse(result))) throw new ConversationError(500, `${label}无效`);
  return result;
}

function parseAttempt(value: unknown): SpeechAttempt {
  if (!record(value)) throw new ConversationError(500, "发言尝试无效");
  exactKeys(value, [
    "attemptId", "round", "speakerLongAgentId", "participationEpoch", "inputCutoffEntryId", "replyToEntryId",
    "causationId", "authorizationRevision", "instruction", "status", "reason", "publicationId",
    "sourceSessionId", "sourceEntryId", "createdAt", "updatedAt",
  ], "发言尝试");
  if (!ATTEMPT_STATUSES.includes(value.status as SpeechAttemptStatus)) throw new ConversationError(500, "发言尝试状态无效");
  return {
    attemptId: nonEmptyText(value.attemptId, "attemptId", 200),
    round: integer(value.round, "round", 0, 10_000),
    speakerLongAgentId: nonEmptyText(value.speakerLongAgentId, "speaker", 120),
    participationEpoch: integer(value.participationEpoch, "participationEpoch", 1, 1_000_000),
    inputCutoffEntryId: optionalText(value.inputCutoffEntryId, "inputCutoffEntryId", 200),
    replyToEntryId: optionalText(value.replyToEntryId, "replyToEntryId", 200),
    causationId: optionalText(value.causationId, "causationId", 200),
    authorizationRevision: integer(value.authorizationRevision, "authorizationRevision", 1, 1_000_000),
    instruction: text(value.instruction, "instruction", 100_000),
    status: value.status as SpeechAttemptStatus,
    reason: optionalText(value.reason, "reason", 2_000),
    publicationId: optionalText(value.publicationId, "publicationId", 200),
    sourceSessionId: optionalText(value.sourceSessionId, "sourceSessionId", 200),
    sourceEntryId: optionalText(value.sourceEntryId, "sourceEntryId", 200),
    createdAt: isoTime(value.createdAt, "createdAt"),
    updatedAt: isoTime(value.updatedAt, "updatedAt"),
  };
}

function parseDiscussion(value: unknown): Discussion {
  if (!record(value)) throw new ConversationError(500, "讨论记录无效");
  exactKeys(value, [
    "discussionId", "conversationId", "policy", "round", "inputCutoffEntryId", "budget", "status",
    "stopReason", "modelCalls", "tokensUsed", "startedAt", "attempts", "createdAt", "updatedAt",
  ], "讨论");
  if (!DISCUSSION_STATUSES.includes(value.status as DiscussionStatus)) throw new ConversationError(500, "讨论状态无效");
  if (!POLICIES.includes(value.policy as ConversationPolicy)) throw new ConversationError(500, "讨论策略无效");
  if (!Array.isArray(value.attempts)) throw new ConversationError(500, "讨论尝试列表无效");
  const startedAt = isoTime(value.startedAt, "startedAt");
  return {
    discussionId: nonEmptyText(value.discussionId, "discussionId", 200),
    conversationId: nonEmptyText(value.conversationId, "conversationId", 200),
    policy: value.policy as ConversationPolicy,
    round: integer(value.round, "round", 0, 10_000),
    inputCutoffEntryId: optionalText(value.inputCutoffEntryId, "inputCutoffEntryId", 200),
    budget: parseConversationBudget(value.budget),
    status: value.status as DiscussionStatus,
    stopReason: optionalText(value.stopReason, "stopReason", 2_000),
    modelCalls: integer(value.modelCalls, "modelCalls", 0, 10_000_000),
    tokensUsed: value.tokensUsed === undefined ? 0 : integer(value.tokensUsed, "tokensUsed", 0, 1_000_000_000),
    startedAt,
    attempts: value.attempts.map(parseAttempt),
    createdAt: isoTime(value.createdAt, "createdAt"),
    updatedAt: isoTime(value.updatedAt, "updatedAt"),
  };
}

export function conversationDataDir(chatHome: string, storageProjectId: string, conversationId: string): Promise<string> {
  return ensureProjectDataLayout(storageProjectId, chatHome).then((layout) =>
    resolve(layout.projectDataDir, "conversations", conversationId));
}

export async function discussionsFile(chatHome: string, storageProjectId: string, conversationId: string): Promise<string> {
  const dir = await conversationDataDir(chatHome, storageProjectId, conversationId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return resolve(dir, "discussions.json");
}

export async function readDiscussionState(chatHome: string, storageProjectId: string, conversationId: string): Promise<DiscussionState> {
  const file = await discussionsFile(chatHome, storageProjectId, conversationId);
  await assertFileWithin(file, chatHome);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, discussions: [] };
    throw error;
  }
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.discussions))
    throw new ConversationError(500, "讨论存储格式无效");
  const discussions = value.discussions.map(parseDiscussion);
  if (discussions.some((discussion) => discussion.conversationId !== conversationId))
    throw new ConversationError(500, "讨论存储归属冲突");
  if (new Set(discussions.map((discussion) => discussion.discussionId)).size !== discussions.length)
    throw new ConversationError(500, "讨论存储包含重复身份");
  return { schemaVersion: 1, discussions };
}

export async function changeDiscussionState<T>(
  chatHome: string,
  storageProjectId: string,
  conversationId: string,
  change: (state: DiscussionState) => T | Promise<T>,
): Promise<T> {
  const file = await discussionsFile(chatHome, storageProjectId, conversationId);
  return withFileLock(file, async () => {
    const state = await readDiscussionState(chatHome, storageProjectId, conversationId);
    const result = await change(state);
    await atomicWriteJson(file, state);
    return result;
  });
}

export function requireDiscussion(state: DiscussionState, discussionId: string): Discussion {
  const discussion = state.discussions.find((candidate) => candidate.discussionId === discussionId);
  if (discussion === undefined) throw new ConversationError(404, "找不到该轮讨论");
  return discussion;
}

export function requireAttempt(discussion: Discussion, attemptId: string): SpeechAttempt {
  const attempt = discussion.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (attempt === undefined) throw new ConversationError(404, "找不到该发言尝试");
  return attempt;
}

export interface QueueSpeechAttemptInput {
  discussionId: string;
  attemptId: string;
  policy: ConversationPolicy;
  round: number;
  speakerLongAgentId: string;
  participationEpoch: number;
  inputCutoffEntryId: string | null;
  replyToEntryId: string | null;
  causationId: string | null;
  authorizationRevision: number;
  instruction: string;
  budget: ConversationBudget;
  /** Optional reason recorded while the attempt waits (e.g. capacity). Cleared on terminal states. */
  queueReason?: string | null;
}

/** Create (idempotently) the discussion container so planning can persist a stop reason before any attempt. */
export async function startConversationDiscussion(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  discussionId: string;
  policy: ConversationPolicy;
  round: number;
  inputCutoffEntryId: string | null;
  budget: ConversationBudget;
}): Promise<Discussion> {
  return changeDiscussionState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const existing = state.discussions.find((candidate) => candidate.discussionId === input.discussionId);
    if (existing !== undefined) {
      if (existing.status !== "running") throw new ConversationError(409, "该轮讨论已结束，不能继续");
      return { ...existing };
    }
    const now = new Date().toISOString();
    const discussion: Discussion = {
      discussionId: input.discussionId,
      conversationId: input.conversationId,
      policy: input.policy,
      round: input.round,
      inputCutoffEntryId: input.inputCutoffEntryId,
      budget: input.budget,
      status: "running",
      stopReason: null,
      modelCalls: 0,
      tokensUsed: 0,
      startedAt: now,
      attempts: [],
      createdAt: now,
      updatedAt: now,
    };
    state.discussions.push(discussion);
    return { ...discussion };
  });
}

/** Queue one bounded speech attempt. Duplicate `attemptId` re-queues only while still queued. */
export async function queueSpeechAttempt(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  attempt: QueueSpeechAttemptInput;
}): Promise<SpeechAttempt> {
  const attempt = input.attempt;
  if (attempt.instruction.trim() === "") throw new ConversationError(400, "发言指令不能为空");
  return changeDiscussionState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    let discussion = state.discussions.find((candidate) => candidate.discussionId === attempt.discussionId);
    const now = new Date().toISOString();
    if (discussion === undefined) {
      discussion = {
        discussionId: attempt.discussionId,
        conversationId: input.conversationId,
        policy: attempt.policy,
        round: attempt.round,
        inputCutoffEntryId: attempt.inputCutoffEntryId,
        budget: attempt.budget,
        status: "running",
        stopReason: null,
        modelCalls: 0,
        tokensUsed: 0,
        startedAt: now,
        attempts: [],
        createdAt: now,
        updatedAt: now,
      };
      state.discussions.push(discussion);
    }
    if (discussion.status !== "running") throw new ConversationError(409, "该轮讨论已结束，不能继续排队发言");
    const existing = discussion.attempts.find((candidate) => candidate.attemptId === attempt.attemptId);
    if (existing !== undefined) {
      if (existing.status !== "queued") throw new ConversationError(409, "该发言尝试已进入终态，不能重复排队");
      return existing;
    }
    const queued: SpeechAttempt = {
      attemptId: attempt.attemptId,
      round: attempt.round,
      speakerLongAgentId: attempt.speakerLongAgentId,
      participationEpoch: attempt.participationEpoch,
      inputCutoffEntryId: attempt.inputCutoffEntryId,
      replyToEntryId: attempt.replyToEntryId,
      causationId: attempt.causationId,
      authorizationRevision: attempt.authorizationRevision,
      instruction: attempt.instruction,
      status: "queued",
      reason: attempt.queueReason ?? null,
      publicationId: null,
      sourceSessionId: null,
      sourceEntryId: null,
      createdAt: now,
      updatedAt: now,
    };
    discussion.attempts.push(queued);
    discussion.updatedAt = now;
    return queued;
  });
}

/** Claim one queued attempt for execution. Returns the frozen record, or null when already claimed. */
export async function claimSpeechAttempt(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  discussionId: string;
  attemptId: string;
}): Promise<SpeechAttempt | null> {
  return changeDiscussionState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const discussion = requireDiscussion(state, input.discussionId);
    const attempt = requireAttempt(discussion, input.attemptId);
    if (attempt.status !== "queued") return null;
    attempt.status = "running";
    attempt.updatedAt = new Date().toISOString();
    discussion.updatedAt = attempt.updatedAt;
    return { ...attempt };
  });
}

export async function finishSpeechAttempt(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  discussionId: string;
  attemptId: string;
  status: Exclude<SpeechAttemptStatus, "queued" | "running">;
  reason?: string | null;
  publicationId?: string | null;
  sourceSessionId?: string | null;
  sourceEntryId?: string | null;
}): Promise<SpeechAttempt> {
  return changeDiscussionState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const discussion = requireDiscussion(state, input.discussionId);
    const attempt = requireAttempt(discussion, input.attemptId);
    if (attempt.status !== "running" && attempt.status !== "queued")
      throw new ConversationError(409, "该发言尝试已进入终态，不能被覆盖");
    attempt.status = input.status;
    attempt.reason = input.reason ?? null;
    attempt.publicationId = input.publicationId ?? null;
    attempt.sourceSessionId = input.sourceSessionId ?? null;
    attempt.sourceEntryId = input.sourceEntryId ?? null;
    attempt.updatedAt = new Date().toISOString();
    discussion.updatedAt = attempt.updatedAt;
    if (input.status === "failed" && discussion.status !== "stopped" && discussion.status !== "interrupted") {
      discussion.status = "failed";
      discussion.stopReason = input.reason ?? "发言失败";
    }
    return { ...attempt };
  });
}

/** Count one actual model call against the discussion's frozen budget. */
export async function recordDiscussionModelCall(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  discussionId: string;
}): Promise<number> {
  return changeDiscussionState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const discussion = requireDiscussion(state, input.discussionId);
    discussion.modelCalls += 1;
    discussion.updatedAt = new Date().toISOString();
    return discussion.modelCalls;
  });
}

/**
 * Atomically reserve one model call against a discussion's frozen root budget.
 *
 * The check and the increment happen inside the same discussions-file lock, so two concurrent
 * executors (a speech attempt and a discussion-derived sub-work, or two members) cannot both read an
 * un-spent budget and then each call the model. This is the only correct place to enforce a root
 * budget: a per-session lock serializes execution but does not arbitrate a shared counter.
 */
export async function claimDiscussionModelCall(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  discussionId: string;
}): Promise<{ granted: boolean; reason: string | null; modelCalls: number }> {
  return changeDiscussionState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const discussion = requireDiscussion(state, input.discussionId);
    const stop = discussionBudgetStopReason(discussion);
    if (stop !== null) return { granted: false, reason: stop, modelCalls: discussion.modelCalls };
    discussion.modelCalls += 1;
    discussion.updatedAt = new Date().toISOString();
    return { granted: true, reason: null, modelCalls: discussion.modelCalls };
  });
}

/** Add a provider-reported token total to the discussion's durable usage counter. */
export async function recordDiscussionTokenUsage(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  discussionId: string;
  tokens: number;
}): Promise<number> {
  if (!Number.isSafeInteger(input.tokens) || input.tokens < 0) return -1;
  return changeDiscussionState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const discussion = requireDiscussion(state, input.discussionId);
    discussion.tokensUsed += input.tokens;
    discussion.updatedAt = new Date().toISOString();
    return discussion.tokensUsed;
  });
}

/**
 * A frozen budget check the orchestrator runs before queueing/dispatching, and the provider gate runs
 * before each real request. Token limits are soft: usage is known only after a provider call, so this
 * refuses the *next* request once the accumulated total has reached the limit.
 */
export function discussionBudgetStopReason(discussion: Discussion, now = Date.now()): string | null {
  if (discussion.status === "stopped" || discussion.status === "interrupted" || discussion.status === "failed")
    return discussion.stopReason ?? "讨论已停止";
  if (discussion.modelCalls >= discussion.budget.maxModelCalls) return "达到模型调用预算";
  if (discussion.tokensUsed >= discussion.budget.maxTokensSoft) return "达到Token软预算";
  if (discussion.round > discussion.budget.maxRounds) return "达到最大轮数";
  if (now - Date.parse(discussion.startedAt) >= discussion.budget.maxWallClockMs) return "达到墙钟预算";
  return null;
}

export async function stopDiscussion(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  discussionId: string;
  status: Exclude<DiscussionStatus, "planned">;
  stopReason: string;
}): Promise<Discussion> {
  const release = await acquireWorkCommitLock(workCommitKey(input.storageProjectId, input.conversationId));
  try {
    return await changeDiscussionState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
      const discussion = requireDiscussion(state, input.discussionId);
      if (discussion.status === "stopped" || discussion.status === "interrupted") return { ...discussion };
      discussion.status = input.status;
      discussion.stopReason = input.stopReason;
      discussion.updatedAt = new Date().toISOString();
      return { ...discussion };
    });
  } finally { release(); }
}

/**
 * Restart recovery for one conversation: a `running` attempt lost its terminal state (the process
 * died mid-flight), so it becomes `interrupted` and is never replayed — the model/tool side effects
 * are unknown. `queued` attempts stay queued and are safe to dispatch again.
 */
export async function recoverDiscussionState(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
}): Promise<{ queued: SpeechAttempt[]; interrupted: SpeechAttempt[] }> {
  return changeDiscussionState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const queued: SpeechAttempt[] = [];
    const interrupted: SpeechAttempt[] = [];
    const now = new Date().toISOString();
    for (const discussion of state.discussions) {
      let discussionInterrupted = false;
      for (const attempt of discussion.attempts) {
        if (attempt.status === "queued") queued.push({ ...attempt });
        else if (attempt.status === "running") {
          attempt.status = "interrupted";
          attempt.reason = "进程重启时缺少终态，标记为中断，不重放未知副作用";
          attempt.updatedAt = now;
          discussionInterrupted = true;
          interrupted.push({ ...attempt });
        }
      }
      if (discussion.status === "running" && discussion.attempts.every((attempt) =>
        attempt.status === "published" || attempt.status === "failed" || attempt.status === "skipped" || attempt.status === "cancelled")) {
        discussion.status = discussion.attempts.some((attempt) => attempt.status === "failed") ? "failed" : "completed";
      } else if (discussion.status === "running" && discussionInterrupted) {
        discussion.status = "interrupted";
        discussion.stopReason = "进程重启时缺少终态";
      }
      discussion.updatedAt = now;
    }
    return { queued, interrupted };
  });
}
