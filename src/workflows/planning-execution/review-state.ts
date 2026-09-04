import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PlanReviewDecision, PlanReviewReadiness, PlanReviewReference } from "./review.js";

export const CHAT_PLAN_REVIEW_CUSTOM_TYPE = "chat.plan_review";
export const CHAT_PLAN_REVIEW_DECISION_CUSTOM_TYPE = "chat.plan_review_decision";
const RUN_RECORD_SCHEMA_VERSION = 1;

export interface ChatPlanReview extends PlanReviewReference {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly stageId: "review";
  readonly sessionId: string;
  readonly planEntryId: string;
  readonly plan: string;
  readonly readiness: PlanReviewReadiness;
  readonly blockingQuestions: readonly string[];
  readonly createdAt: string;
}

export type ChatPlanReviewDecisionEntry = PlanReviewDecision & {
  readonly schemaVersion: 1 | 2 | 3;
  readonly workflowId: string;
  readonly stageId: "review";
  /** Native user MessageEntry containing request-revision feedback (schema v2). */
  readonly feedbackEntryId?: string;
  /** Native user MessageEntry expressing the human review action (schema v3). */
  readonly messageEntryId?: string;
  readonly decidedAt: string;
};

export type ChatPlanReviewDecisionMarker = ChatPlanReviewDecisionEntry & { readonly entryId: string };

export type PlanningExecutionPhase =
  | "starting"
  | "planning"
  | "waiting_review"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

export interface PlanningExecutionRunRecord {
  readonly schemaVersion: typeof RUN_RECORD_SCHEMA_VERSION;
  readonly projectId: string;
  readonly workflowId: string;
  readonly workflowInvocationId: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly phase: PlanningExecutionPhase;
  readonly currentReview?: ChatPlanReview;
  readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireWorkflowId(workflowId: string): string {
  if (!/^[A-Za-z0-9:_-]+$/.test(workflowId)) throw new Error("Workflow ID无效");
  return workflowId;
}

function reviewRunsRoot(projectDataDir: string): string {
  return resolve(projectDataDir, "workflow-runs");
}

function reviewRunDir(projectDataDir: string, workflowId: string): string {
  return resolve(reviewRunsRoot(projectDataDir), requireWorkflowId(workflowId));
}

function recordPath(projectDataDir: string, workflowId: string, workflowInvocationId: string): string {
  if (!/^[A-Za-z0-9:_-]+$/.test(workflowInvocationId)) throw new Error("Workflow Invocation ID无效");
  return resolve(reviewRunDir(projectDataDir, workflowId), `${workflowInvocationId}.json`);
}

function parseRunRecord(value: unknown): PlanningExecutionRunRecord {
  if (!isRecord(value) || value.schemaVersion !== RUN_RECORD_SCHEMA_VERSION
    || typeof value.workflowId !== "string" || value.workflowId.trim() === "" || typeof value.projectId !== "string"
    || typeof value.workflowInvocationId !== "string" || typeof value.phase !== "string"
    || typeof value.updatedAt !== "string") {
    throw new Error("规划执行Run记录无效");
  }
  const phases = new Set<PlanningExecutionPhase>([
    "starting",
    "planning",
    "waiting_review",
    "executing",
    "completed",
    "failed",
    "cancelled",
  ]);
  if (!phases.has(value.phase as PlanningExecutionPhase)) throw new Error("规划执行Run阶段无效");
  if (value.runId !== undefined && (typeof value.runId !== "string" || value.runId.trim() === "")) {
    throw new Error("规划执行Run ID无效");
  }
  if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.trim() === "")) {
    throw new Error("规划执行Session ID无效");
  }
  const currentReview = value.currentReview === undefined ? undefined : parsePlanReview(value.currentReview);
  if (value.currentReview !== undefined && currentReview === undefined) throw new Error("规划执行审核状态无效");
  if (value.phase === "waiting_review" && currentReview === undefined) throw new Error("等待审核阶段缺少计划");
  return {
    schemaVersion: RUN_RECORD_SCHEMA_VERSION,
    projectId: value.projectId,
    workflowId: value.workflowId,
    workflowInvocationId: value.workflowInvocationId,
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    phase: value.phase as PlanningExecutionPhase,
    ...(currentReview === undefined ? {} : { currentReview }),
    updatedAt: value.updatedAt,
  };
}

async function readRunRecord(path: string): Promise<PlanningExecutionRunRecord | undefined> {
  try {
    return parseRunRecord(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, value: PlanningExecutionRunRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

const writes = new Map<string, Promise<PlanningExecutionRunRecord>>();

async function updateRunRecord(
  projectDataDir: string,
  workflowId: string,
  workflowInvocationId: string,
  update: (current: PlanningExecutionRunRecord | undefined) => PlanningExecutionRunRecord,
): Promise<PlanningExecutionRunRecord> {
  const path = recordPath(projectDataDir, workflowId, workflowInvocationId);
  const previous = writes.get(path) ?? Promise.resolve(undefined);
  const current = previous.catch(() => undefined).then(async () => {
    const next = update(await readRunRecord(path));
    await atomicWrite(path, next);
    return next;
  });
  writes.set(path, current);
  try {
    return await current;
  } finally {
    if (writes.get(path) === current) writes.delete(path);
  }
}

export async function bindPlanningExecutionRun(input: {
  readonly projectDataDir: string;
  readonly projectId: string;
  readonly workflowInvocationId: string;
  readonly workflowId?: string;
  readonly runId: string;
  readonly sessionId?: string;
}): Promise<PlanningExecutionRunRecord> {
  const workflowId = input.workflowId ?? "planning-execution";
  return updateRunRecord(input.projectDataDir, workflowId, input.workflowInvocationId, (existing) => {
    const sessionId = input.sessionId ?? existing?.sessionId;
    return {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      projectId: input.projectId,
      workflowId,
      workflowInvocationId: input.workflowInvocationId,
      runId: input.runId,
      ...(sessionId === undefined ? {} : { sessionId }),
      phase: existing?.phase ?? "starting",
      ...(existing?.currentReview === undefined ? {} : { currentReview: existing.currentReview }),
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function setPlanningExecutionPhase(input: {
  readonly projectDataDir: string;
  readonly projectId: string;
  readonly workflowInvocationId: string;
  readonly workflowId?: string;
  readonly sessionId?: string;
  readonly phase: Exclude<PlanningExecutionPhase, "waiting_review">;
}): Promise<PlanningExecutionRunRecord> {
  const workflowId = input.workflowId ?? "planning-execution";
  return updateRunRecord(input.projectDataDir, workflowId, input.workflowInvocationId, (existing) => {
    if (existing !== undefined && isTerminalPlanningExecutionPhase(existing.phase)
      && existing.phase !== input.phase) return existing;
    const sessionId = input.sessionId ?? existing?.sessionId;
    return {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      projectId: input.projectId,
      workflowId,
      workflowInvocationId: input.workflowInvocationId,
      ...(existing?.runId === undefined ? {} : { runId: existing.runId }),
      ...(sessionId === undefined ? {} : { sessionId }),
      phase: input.phase,
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function publishPlanReviewState(input: {
  readonly projectDataDir: string;
  readonly projectId: string;
  readonly review: ChatPlanReview;
}): Promise<PlanningExecutionRunRecord> {
  return updateRunRecord(
    input.projectDataDir,
    input.review.workflowId,
    input.review.workflowInvocationId,
    (existing) => {
    if (existing !== undefined && isTerminalPlanningExecutionPhase(existing.phase)) return existing;
    return {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      projectId: input.projectId,
      workflowId: input.review.workflowId,
      workflowInvocationId: input.review.workflowInvocationId,
      ...(existing?.runId === undefined ? {} : { runId: existing.runId }),
      sessionId: input.review.sessionId,
      phase: "waiting_review",
      currentReview: input.review,
      updatedAt: new Date().toISOString(),
    };
    },
  );
}

export async function getPlanningExecutionRun(
  projectDataDir: string,
  workflowInvocationId: string,
  workflowId?: string,
): Promise<PlanningExecutionRunRecord | undefined> {
  if (workflowId !== undefined) {
    return readRunRecord(recordPath(projectDataDir, workflowId, workflowInvocationId));
  }
  let workflowDirectories;
  try {
    workflowDirectories = await readdir(reviewRunsRoot(projectDataDir), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const directory of workflowDirectories) {
    if (!directory.isDirectory()) continue;
    const record = await readRunRecord(recordPath(projectDataDir, directory.name, workflowInvocationId));
    if (record !== undefined) return record;
  }
  return undefined;
}

export function isTerminalPlanningExecutionPhase(phase: PlanningExecutionPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

/** Reads every non-terminal reviewed Workflow Run once for Session-list projections. */
export async function listActivePlanningExecutionRuns(
  projectDataDir: string,
): Promise<PlanningExecutionRunRecord[]> {
  let workflowDirectories;
  try {
    workflowDirectories = await readdir(reviewRunsRoot(projectDataDir), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = (await Promise.all(workflowDirectories
    .filter((directory) => directory.isDirectory())
    .map(async (directory) => {
      const directoryPath = reviewRunDir(projectDataDir, directory.name);
      const names = await readdir(directoryPath);
      return Promise.all(names
        .filter((name) => name.endsWith(".json"))
        .map((name) => readRunRecord(resolve(directoryPath, name))));
    }))).flat();
  return records
    .filter((record): record is PlanningExecutionRunRecord => record !== undefined
      && !isTerminalPlanningExecutionPhase(record.phase))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Finds the latest non-terminal planning Run bound to one durable Chat Session. */
export async function findActivePlanningExecutionRun(
  projectDataDir: string,
  sessionId: string,
): Promise<PlanningExecutionRunRecord | undefined> {
  return (await listActivePlanningExecutionRuns(projectDataDir))
    .find((record) => record.sessionId === sessionId);
}

export function planSha256(plan: string): string {
  return createHash("sha256").update(plan, "utf8").digest("hex");
}

export function appendPlanReview(
  sessionManager: SessionManager,
  review: ChatPlanReview,
): string {
  return sessionManager.appendCustomEntry(CHAT_PLAN_REVIEW_CUSTOM_TYPE, review);
}

export function appendPlanReviewDecision(
  sessionManager: SessionManager,
  decision: ChatPlanReviewDecisionEntry,
): string {
  return sessionManager.appendCustomEntry(CHAT_PLAN_REVIEW_DECISION_CUSTOM_TYPE, decision);
}

function parsePlanReview(value: unknown): ChatPlanReview | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1
    || typeof value.workflowId !== "string" || value.workflowId.trim() === ""
    || value.stageId !== "review" || typeof value.reviewId !== "string"
    || typeof value.workflowInvocationId !== "string" || !Number.isSafeInteger(value.planRevision)
    || typeof value.planSha256 !== "string" || typeof value.sessionId !== "string"
    || typeof value.planEntryId !== "string" || typeof value.plan !== "string"
    || typeof value.createdAt !== "string") return undefined;
  const readiness = value.readiness === undefined
    ? "ready_for_review"
    : value.readiness;
  if (readiness !== "ready_for_review" && readiness !== "needs_clarification") return undefined;
  const blockingQuestions = value.blockingQuestions === undefined ? [] : value.blockingQuestions;
  if (!Array.isArray(blockingQuestions)
    || blockingQuestions.some((question) => typeof question !== "string" || question.trim() === "")) return undefined;
  if (readiness === "ready_for_review" && blockingQuestions.length > 0) return undefined;
  if (readiness === "needs_clarification" && blockingQuestions.length === 0) return undefined;
  return {
    schemaVersion: 1,
    workflowId: value.workflowId,
    stageId: "review",
    reviewId: value.reviewId,
    workflowInvocationId: value.workflowInvocationId,
    sessionId: value.sessionId,
    planRevision: value.planRevision as number,
    planSha256: value.planSha256,
    planEntryId: value.planEntryId,
    plan: value.plan,
    readiness,
    blockingQuestions: blockingQuestions as string[],
    createdAt: value.createdAt,
  };
}

function decisionReviewId(value: unknown): string | undefined {
  return isRecord(value) && (value.schemaVersion === 1 || value.schemaVersion === 2 || value.schemaVersion === 3)
    && typeof value.workflowId === "string" && value.workflowId.trim() !== ""
    && value.stageId === "review" && typeof value.reviewId === "string"
    ? value.reviewId
    : undefined;
}

function parsePlanReviewDecisionEntry(value: unknown): ChatPlanReviewDecisionEntry | undefined {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3)
    || typeof value.workflowId !== "string" || value.workflowId.trim() === ""
    || value.stageId !== "review" || (value.kind !== "approve" && value.kind !== "request_revision")
    || typeof value.reviewId !== "string" || typeof value.workflowInvocationId !== "string"
    || !Number.isSafeInteger(value.planRevision) || typeof value.planSha256 !== "string"
    || typeof value.decidedAt !== "string") return undefined;
  if (value.kind === "request_revision" && typeof value.feedback !== "string") return undefined;
  if (value.feedbackEntryId !== undefined && typeof value.feedbackEntryId !== "string") return undefined;
  if (value.messageEntryId !== undefined && typeof value.messageEntryId !== "string") return undefined;
  if (value.schemaVersion === 2 && value.kind === "request_revision"
    && (typeof value.feedbackEntryId !== "string" || value.feedbackEntryId.trim() === "")) return undefined;
  if (value.schemaVersion === 3
    && (typeof value.messageEntryId !== "string" || value.messageEntryId.trim() === "")) return undefined;
  if (value.schemaVersion === 3 && value.kind === "request_revision"
    && value.feedbackEntryId !== value.messageEntryId) return undefined;
  return value as unknown as ChatPlanReviewDecisionEntry;
}

/** Canonical visible utterance for a button-based human review action. */
export function planReviewDecisionMessage(decision: PlanReviewDecision): string {
  return decision.kind === "approve"
    ? `已通过执行计划 v${String(decision.planRevision)}，开始执行。`
    : decision.feedback;
}

/** Reconstructs the latest unresolved review from append-only Session entries. */
export function collectPendingPlanReview(entries: readonly unknown[]): ChatPlanReview | undefined {
  const reviews: ChatPlanReview[] = [];
  const decided = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || !isRecord(entry.data)) continue;
    if (entry.customType === CHAT_PLAN_REVIEW_CUSTOM_TYPE) {
      const review = parsePlanReview(entry.data);
      if (review !== undefined) reviews.push(review);
    } else if (entry.customType === CHAT_PLAN_REVIEW_DECISION_CUSTOM_TYPE) {
      const reviewId = decisionReviewId(entry.data);
      if (reviewId !== undefined) decided.add(reviewId);
    }
  }
  return reviews.findLast((review) => !decided.has(review.reviewId));
}

export function hasPlanReview(entries: readonly unknown[], reviewId: string): boolean {
  return entries.some((entry) => isRecord(entry) && entry.type === "custom"
    && entry.customType === CHAT_PLAN_REVIEW_CUSTOM_TYPE && isRecord(entry.data)
    && entry.data.reviewId === reviewId);
}

export function hasPlanReviewDecision(entries: readonly unknown[], reviewId: string): boolean {
  return entries.some((entry) => isRecord(entry) && entry.type === "custom"
    && entry.customType === CHAT_PLAN_REVIEW_DECISION_CUSTOM_TYPE && isRecord(entry.data)
    && entry.data.reviewId === reviewId);
}

export function collectPlanReviewDecisions(entries: readonly unknown[]): ChatPlanReviewDecisionMarker[] {
  const decisions: ChatPlanReviewDecisionMarker[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CHAT_PLAN_REVIEW_DECISION_CUSTOM_TYPE
      || typeof entry.id !== "string" || !isRecord(entry.data)) continue;
    const decision = parsePlanReviewDecisionEntry(entry.data);
    if (decision !== undefined) decisions.push({ entryId: entry.id, ...decision });
  }
  return decisions;
}
