import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertFileWithin, atomicWriteJson, withFileLock } from "../../persistence/versioned-file.js";
import { ConversationError, DEFAULT_CONVERSATION_BUDGET, parseConversationBudget, type ConversationBudget } from "./contract.js";
import { conversationDataDir } from "./discussions.js";

/**
 * Group background work (LA5 S8).
 *
 * A work is created from a *verified* public origin (the requesting entry must exist in the group's
 * authorized projection), runs in the member's own participation Session without holding any group
 * write lock, and on completion publishes only an authorized result reference.
 *
 * Budget attribution is explicit and never escapes the root:
 * - `source: "discussion"` is a sub-work derived from a discussion round. Its model call is charged
 *   to that discussion's frozen budget and refused once the root budget is exhausted.
 * - `source: "user"` is a task the user started independently; it has its own budget and is created
 *   only through the owner-facing API, so it cannot be used to bypass a discussion limit.
 */
export type ConversationWorkStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ConversationWorkSource = "user" | "discussion";

export interface ConversationWork {
  workId: string;
  conversationId: string;
  longAgentId: string;
  participationEpoch: number;
  /** Who started this work, which decides which budget it is charged to. */
  source: ConversationWorkSource;
  /** Set for discussion-derived sub-work: the root discussion whose budget it consumes. */
  discussionId: string | null;
  originEntryId: string | null;
  title: string;
  instruction: string;
  status: ConversationWorkStatus;
  /** The work's own durable Task Session; never the member's group participation Session. */
  sessionId: string | null;
  /**
   * Independent durable budget for a `user` work (snapshotted at creation). A `discussion`-derived
   * work ignores this and is charged to the root discussion instead.
   */
  budget: ConversationBudget;
  modelCalls: number;
  /** Accumulated provider-reported tokens; the token limit is soft (known only after a call). */
  tokensUsed: number;
  startedAt: string;
  publicationId: string | null;
  sourceSessionId: string | null;
  sourceEntryId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationWorkState {
  schemaVersion: 1;
  works: ConversationWork[];
}

const EMPTY: ConversationWorkState = { schemaVersion: 1, works: [] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new ConversationError(500, `群任务${label}无效`);
  return value;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  return value === null || value === undefined ? null : text(value, label, max);
}

function parseWork(value: unknown): ConversationWork {
  if (!record(value)) throw new ConversationError(500, "群任务记录无效");
  const statuses: ConversationWorkStatus[] = ["queued", "running", "completed", "failed", "cancelled"];
  const status = value.status;
  if (!statuses.includes(status as ConversationWorkStatus)) throw new ConversationError(500, "群任务状态无效");
  return {
    workId: text(value.workId, "id", 200),
    conversationId: text(value.conversationId, "群", 200),
    longAgentId: text(value.longAgentId, "成员", 120),
    participationEpoch: Number(value.participationEpoch),
    source: value.source === "discussion" ? "discussion" : "user",
    discussionId: optionalText(value.discussionId, "根讨论", 200),
    originEntryId: optionalText(value.originEntryId, "来源条目", 200),
    title: text(value.title, "名称", 120),
    instruction: text(value.instruction, "说明", 100_000),
    status: status as ConversationWorkStatus,
    sessionId: optionalText(value.sessionId, "任务 Session", 200),
    budget: value.budget === undefined ? { ...DEFAULT_CONVERSATION_BUDGET } : parseConversationBudget(value.budget),
    modelCalls: value.modelCalls === undefined ? 0 : Number(value.modelCalls),
    tokensUsed: value.tokensUsed === undefined ? 0 : Number(value.tokensUsed),
    startedAt: optionalText(value.startedAt, "开始时间", 64) ?? text(value.createdAt, "创建时间", 64),
    publicationId: optionalText(value.publicationId, "结果引用", 200),
    sourceSessionId: optionalText(value.sourceSessionId, "源 Session", 200),
    sourceEntryId: optionalText(value.sourceEntryId, "源条目", 200),
    error: optionalText(value.error, "错误", 2_000),
    createdAt: text(value.createdAt, "创建时间", 64),
    updatedAt: text(value.updatedAt, "更新时间", 64),
  };
}

async function worksFile(chatHome: string, storageProjectId: string, conversationId: string): Promise<string> {
  return resolve(await conversationDataDir(chatHome, storageProjectId, conversationId), "works.json");
}

export async function readConversationWorkState(chatHome: string, storageProjectId: string, conversationId: string): Promise<ConversationWorkState> {
  const file = await worksFile(chatHome, storageProjectId, conversationId);
  await assertFileWithin(file, chatHome);
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.works)) throw new ConversationError(500, "群任务存储格式无效");
    return { schemaVersion: 1, works: value.works.map(parseWork) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, works: [] };
    throw error;
  }
}

export async function changeWorkState<T>(chatHome: string, storageProjectId: string, conversationId: string, change: (state: ConversationWorkState) => T): Promise<T> {
  const file = await worksFile(chatHome, storageProjectId, conversationId);
  return withFileLock(file, async () => {
    const state = await readConversationWorkState(chatHome, storageProjectId, conversationId);
    const result = change(state);
    await atomicWriteJson(file, state);
    return result;
  });
}

export async function listConversationWorks(chatHome: string, storageProjectId: string, conversationId: string): Promise<ConversationWork[]> {
  return (await readConversationWorkState(chatHome, storageProjectId, conversationId)).works;
}

/** Independent budget state for a user work; token limits are soft (usage known after a call). */
export function workBudgetStopReason(work: Pick<ConversationWork, "budget" | "modelCalls" | "tokensUsed" | "startedAt">, now = Date.now()): string | null {
  if (work.modelCalls >= work.budget.maxModelCalls) return "达到模型调用预算";
  if (work.tokensUsed >= work.budget.maxTokensSoft) return "达到Token软预算";
  if (now - Date.parse(work.startedAt) >= work.budget.maxWallClockMs) return "达到墙钟预算";
  return null;
}

/** Atomically reserve one model call against a user work's own durable budget. */
export async function claimWorkModelCall(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  workId: string;
}): Promise<{ granted: boolean; reason: string | null; modelCalls: number }> {
  return changeWorkState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const work = state.works.find((candidate) => candidate.workId === input.workId);
    if (work === undefined) throw new ConversationError(404, "找不到该群任务");
    if (work.status !== "running") return { granted: false, reason: "任务已进入终态", modelCalls: work.modelCalls };
    const stop = workBudgetStopReason(work);
    if (stop !== null) return { granted: false, reason: stop, modelCalls: work.modelCalls };
    work.modelCalls += 1;
    work.updatedAt = new Date().toISOString();
    return { granted: true, reason: null, modelCalls: work.modelCalls };
  });
}

/** Add provider-reported tokens to a user work's durable usage counter. */
export async function recordWorkTokenUsage(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
  workId: string;
  tokens: number;
}): Promise<number> {
  if (!Number.isSafeInteger(input.tokens) || input.tokens < 0) return -1;
  return changeWorkState(input.chatHome, input.storageProjectId, input.conversationId, (state) => {
    const work = state.works.find((candidate) => candidate.workId === input.workId);
    if (work === undefined) throw new ConversationError(404, "找不到该群任务");
    work.tokensUsed += input.tokens;
    work.updatedAt = new Date().toISOString();
    return work.tokensUsed;
  });
}
