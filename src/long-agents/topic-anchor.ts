import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { collectChatLongAgentTurnMarkers } from "./session-turn.js";

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
  const byEntry = new Map<string, TopicSettledAnchor>();
  let settledCount = 0;
  for (const marker of collectChatLongAgentTurnMarkers(branch)) {
    if (marker.status !== "completed") continue;
    const markerPosition = positionById.get(marker.entryId);
    if (markerPosition === undefined) continue;
    // The round starts at the last user entry before this round's marker.
    let anchorEntryId: string | null = null;
    for (let index = markerPosition; index >= 0; index -= 1) {
      if (isUserMessageEntry(branch[index])) {
        anchorEntryId = (branch[index] as { id: string }).id;
        break;
      }
    }
    if (anchorEntryId === null) continue;
    if (byEntry.has(anchorEntryId)) continue;
    settledCount += 1;
    byEntry.set(anchorEntryId, {
      anchorEntryId,
      anchorSequence: settledCount,
      turnId: marker.turnId,
      settledAt: marker.completedAt ?? marker.startedAt,
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
  if (anchorSequence !== null && (!Number.isSafeInteger(anchorSequence) || Number(anchorSequence) < 1))
    throw new TopicAnchorError("锚点序号无效");
  const anchors = readTopicSettledAnchors(sessionManager);
  const anchor = anchors.find((candidate) => candidate.anchorEntryId === anchorEntryId);
  if (anchor === undefined)
    throw new TopicAnchorError(`锚点不是已完成的轮次：${anchorEntryId}`);
  if (anchorSequence !== null && anchor.anchorSequence !== anchorSequence)
    throw new TopicAnchorError(`锚点序号不一致：期望 ${String(anchorSequence)}，实际 ${String(anchor.anchorSequence)}`);
  return anchor;
}
