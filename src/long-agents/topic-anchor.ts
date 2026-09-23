import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { collectChatLongAgentTurnMarkers } from "./session-turn.js";

/**
 * Durable end-of-round fact written by the outer 「会话记忆」workflow. The workflow runs a node round as
 * `work` + `remember`, so the Long Agent turn marker only covers part of a round; this marker is what
 * says "this WHOLE round finished, and it started at this user entry".
 */
export const TOPIC_ROUND_CUSTOM_TYPE = "chat.topic-round";
export type TopicRoundStatus = "running" | "completed" | "failed" | "cancelled";

export interface TopicRoundMarker {
  readonly entryId: string;
  readonly roundId: string;
  readonly userEntryId: string;
  readonly status: TopicRoundStatus;
  readonly settledAt: string | null;
}

export function appendTopicRoundMarker(
  sessionManager: SessionManager,
  data: { roundId: string; userEntryId: string; status: TopicRoundStatus; settledAt?: string | null },
): string {
  if (typeof data.roundId !== "string" || data.roundId.trim() === "") throw new TopicAnchorError("轮次 roundId 无效");
  if (typeof data.userEntryId !== "string" || data.userEntryId.trim() === "") throw new TopicAnchorError("轮次 userEntryId 无效");
  if (!["running", "completed", "failed", "cancelled"].includes(data.status)) throw new TopicAnchorError("轮次状态无效");
  const settledAt = data.settledAt ?? (data.status === "running" ? null : new Date().toISOString());
  if (data.status !== "running" && (settledAt === null || Number.isNaN(Date.parse(settledAt))))
    throw new TopicAnchorError("终态轮次必须带 settledAt");
  return sessionManager.appendCustomEntry(TOPIC_ROUND_CUSTOM_TYPE, {
    roundId: data.roundId.trim(), userEntryId: data.userEntryId.trim(), status: data.status, settledAt,
  });
}

export function collectTopicRoundMarkers(entries: readonly unknown[]): TopicRoundMarker[] {
  const markers: TopicRoundMarker[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TOPIC_ROUND_CUSTOM_TYPE) continue;
    const data = entry.data;
    if (!isRecord(data) || typeof entry.id !== "string") continue;
    const roundId = typeof data.roundId === "string" ? data.roundId.trim() : "";
    const userEntryId = typeof data.userEntryId === "string" ? data.userEntryId.trim() : "";
    const status = data.status;
    const settledAt = data.settledAt === null || data.settledAt === undefined ? null : String(data.settledAt);
    if (roundId === "" || userEntryId === "" || (status !== "running" && status !== "completed" && status !== "failed" && status !== "cancelled")) continue;
    if (status !== "running" && (settledAt === null || Number.isNaN(Date.parse(settledAt)))) continue;
    markers.push({ entryId: entry.id, roundId, userEntryId, status, settledAt });
  }
  return markers;
}

/**
 * Topic anchors: the only forkable positions of a node session.
 *
 * A round is a user entry plus the Long Agent turn it started. It is forkable only when that outer
 * invocation FULLY completed — a running, failed or cancelled round is not an anchor, because a child
 * built on it would inherit a half-finished round. Everything here is read from the session's own
 * durable facts: the current branch entries plus the `chat.long_agent_turn` markers the runtime
 * appends per turn.
 */
export interface TopicSettledAnchor {
  /** The user entry that started the settled round. */
  readonly anchorEntryId: string;
  /** 1-based index among the settled rounds of this branch (stable for a frozen parent). */
  readonly anchorSequence: number;
  readonly turnId: string;
  readonly settledAt: string;
}

export class TopicAnchorError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "TopicAnchorError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUserMessageEntry(entry: unknown): boolean {
  if (!isRecord(entry) || entry.type !== "message") return false;
  const message = isRecord(entry.message) ? entry.message : entry;
  return message.role === "user";
}

/**
 * Settled anchors of the CURRENT branch, in order. Only the current branch is considered: an anchor on
 * an abandoned branch would not describe the conversation a child inherits.
 */
export function readTopicSettledAnchors(sessionManager: SessionManager): TopicSettledAnchor[] {
  const branch = sessionManager.getBranch();
  const positionById = new Map<string, number>();
  branch.forEach((entry, index) => {
    if (isRecord(entry) && typeof entry.id === "string") positionById.set(entry.id, index);
  });
  const settled: { position: number; anchorEntryId: string; turnId: string; settledAt: string }[] = [];
  // Source 1: a Long Agent turn that fully completed (its user entry is the last one before the marker).
  for (const marker of collectChatLongAgentTurnMarkers(branch)) {
    if (marker.status !== "completed") continue;
    const markerPosition = positionById.get(marker.entryId);
    if (markerPosition === undefined) continue;
    let anchorEntryId: string | null = null;
    for (let index = markerPosition; index >= 0; index -= 1) {
      if (isUserMessageEntry(branch[index])) {
        anchorEntryId = (branch[index] as { id: string }).id;
        break;
      }
    }
    if (anchorEntryId === null) continue;
    settled.push({ position: markerPosition, anchorEntryId, turnId: marker.turnId, settledAt: marker.completedAt ?? marker.startedAt });
  }
  // Source 2: the outer round marker, which names its own user entry and covers work + remember.
  for (const round of collectTopicRoundMarkers(branch)) {
    if (round.status !== "completed") continue;
    const position = positionById.get(round.entryId);
    const userPosition = positionById.get(round.userEntryId);
    if (position === undefined || userPosition === undefined || userPosition > position) continue;
    settled.push({ position, anchorEntryId: round.userEntryId, turnId: round.roundId, settledAt: round.settledAt ?? "" });
  }
  settled.sort((left, right) => left.position - right.position);
  const byEntry = new Map<string, TopicSettledAnchor>();
  for (const candidate of settled) {
    if (byEntry.has(candidate.anchorEntryId)) continue;
    byEntry.set(candidate.anchorEntryId, {
      anchorEntryId: candidate.anchorEntryId,
      anchorSequence: byEntry.size + 1,
      turnId: candidate.turnId,
      settledAt: candidate.settledAt,
    });
  }
  return [...byEntry.values()];
}

/** The anchor a parent session offers right now: its last fully completed round. */
export function readLatestTopicSettledAnchor(sessionManager: SessionManager): TopicSettledAnchor | null {
  return readTopicSettledAnchors(sessionManager).at(-1) ?? null;
}

/**
 * Verifies a requested anchor against the parent session while its operation lock is held. A null
 * anchor means "branch from the start" and is only accepted together with a null sequence.
 */
export function requireTopicAnchor(
  sessionManager: SessionManager,
  requested: { readonly anchorEntryId: unknown; readonly anchorSequence: unknown },
): TopicSettledAnchor | null {
  const anchorEntryId = requested.anchorEntryId ?? null;
  const anchorSequence = requested.anchorSequence ?? null;
  if (anchorEntryId === null && anchorSequence === null) return null;
  if (anchorEntryId === null)
    throw new TopicAnchorError("锚点缺少 entry；起始锚点不能带序号");
  if (typeof anchorEntryId !== "string" || anchorEntryId.trim() === "")
    throw new TopicAnchorError("锚点 entryId 无效");
  // The entry and its sequence are frozen together: a specific anchor must provide both.
  if (anchorSequence === null || !Number.isSafeInteger(anchorSequence) || Number(anchorSequence) < 1)
    throw new TopicAnchorError("锚点必须同时提供 entry 与序号");
  const anchors = readTopicSettledAnchors(sessionManager);
  const anchor = anchors.find((candidate) => candidate.anchorEntryId === anchorEntryId);
  if (anchor === undefined)
    throw new TopicAnchorError(`锚点不是已完成的轮次：${anchorEntryId}`);
  if (anchorSequence !== null && anchor.anchorSequence !== anchorSequence)
    throw new TopicAnchorError(`锚点序号不一致：期望 ${String(anchorSequence)}，实际 ${String(anchor.anchorSequence)}`);
  return anchor;
}
