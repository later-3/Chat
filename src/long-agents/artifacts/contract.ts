import { createHash } from "node:crypto";

export type ArtifactKind = "post" | "note";
export type ArtifactState = "pending" | "committed" | "failed";
export type ArtifactAudience = "friends" | "self";
export type ArtifactTarget =
  | { kind: "file"; path: string }
  | { kind: "social"; audience: ArtifactAudience };
export type ArtifactVersionOrigin = "generated" | "user";
export interface ArtifactContentVersion {
  revision: number;
  contentHash: string;
  content: string;
  /** Who produced this version: the Friend, or a preserved workspace edit. */
  origin: ArtifactVersionOrigin;
  /** Absolute path of the immutable version file; null for legacy records. */
  versionFile: string | null;
  at: string;
}
export type ArtifactWorkspaceState = "clean" | "older" | "edited" | "missing";
export interface ArtifactNoteConflict {
  /** Where the external edit was found: the user-visible note file, or a version file. */
  source: "workspace" | "version-file";
  contentHash: string;
  content: string;
  /** Immutable file preserving the external edit; null if it could not be preserved yet. */
  preservedFile: string | null;
  at: string;
}
/**
 * Immutable note storage: the workspace file is the user's own copy (created once, never
 * overwritten by the service), versions live in immutable files, and the current revision is
 * pinned by a pointer whose authoritative copy is this record.
 */
export interface ArtifactNoteStore {
  versionFile: string;
  pointerFile: string;
  workspacePath: string;
  /** Hash of the workspace file at the last inspection; null when it was absent. */
  workspaceHash: string | null;
  workspaceState: ArtifactWorkspaceState;
  conflict: ArtifactNoteConflict | null;
  conflictResolution: "user" | "generated" | null;
}
export interface FriendArtifact {
  id: string;
  /** Stable identity of one artifact slot in one occurrence; retries must reuse it. */
  artifactKey: string;
  longAgentId: string;
  kind: ArtifactKind;
  slot: string;
  date: string;
  taskId: string | null;
  occurrenceId: string | null;
  workId: string | null;
  dutyId: string | null;
  goalRevision: number | null;
  progressEntryId: string | null;
  state: ArtifactState;
  revision: number;
  contentHash: string;
  content: string;
  target: ArtifactTarget;
  /** postId for a social post, absolute path for a note; null until verified. */
  resourceId: string | null;
  provenance: { materials: string[] };
  attempts: number;
  /** False when retrying cannot succeed (authorization changed, target owned by a newer version). */
  retryable: boolean;
  failure: string | null;
  createdAt: string;
  updatedAt: string;
  revisions: ArtifactContentVersion[];
  /** Note storage state; null for posts and for legacy notes not yet upgraded. */
  note: ArtifactNoteStore | null;
}
export class FriendArtifactError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
export function artifactDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function artifactKeyOf(input: { taskId: string | null; occurrenceId: string | null; kind: ArtifactKind; slot: string; target: string }): string {
  return artifactDigest([input.taskId, input.occurrenceId, input.kind, input.slot, input.target]).slice(0, 48);
}
export function artifactIdOf(longAgentId: string, artifactKey: string): string {
  return `art-${artifactDigest([longAgentId, artifactKey]).slice(0, 32)}`;
}
export const ARTIFACT_SLOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_ARTIFACT_CONTENT = 60_000;

function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FriendArtifactError(400, "产物数据必须是对象");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new FriendArtifactError(400, "产物文字为空或超出长度限制");
  return value;
}
function timestamp(value: unknown): string {
  const raw = text(value, 64);
  if (!Number.isFinite(Date.parse(raw))) throw new FriendArtifactError(400, "产物时间无效");
  return new Date(raw).toISOString();
}
export function parseArtifactKind(value: unknown): ArtifactKind {
  if (value !== "post" && value !== "note") throw new FriendArtifactError(400, "产物类型必须是 post 或 note");
  return value;
}
export function parseArtifactSlot(value: unknown): string {
  const slot = text(value, 40);
  if (!ARTIFACT_SLOT_PATTERN.test(slot))
    throw new FriendArtifactError(400, "槽位只能是小写字母、数字和连字符（1–40 字符）");
  return slot;
}
export function parseArtifactAudience(value: unknown): ArtifactAudience {
  if (value !== "friends" && value !== "self") throw new FriendArtifactError(400, "受众必须是 friends 或 self");
  return value;
}
function parseTarget(value: unknown): ArtifactTarget {
  record(value);
  if (value.kind === "file") {
    if (Object.keys(value).some((key) => key !== "kind" && key !== "path")) throw new FriendArtifactError(400, "产物目标包含未知字段");
    return { kind: "file", path: text(value.path, 1024) };
  }
  if (value.kind === "social") {
    if (Object.keys(value).some((key) => key !== "kind" && key !== "audience")) throw new FriendArtifactError(400, "产物目标包含未知字段");
    return { kind: "social", audience: parseArtifactAudience(value.audience) };
  }
  throw new FriendArtifactError(400, "产物目标无效");
}
export function parseArtifact(value: unknown): FriendArtifact {
  record(value);
  const keys = ["id", "artifactKey", "longAgentId", "kind", "slot", "date", "taskId", "occurrenceId", "workId", "dutyId", "goalRevision", "progressEntryId", "state", "revision", "contentHash", "content", "target", "resourceId", "provenance", "attempts", "retryable", "failure", "createdAt", "updatedAt", "revisions", "note"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new FriendArtifactError(400, "产物包含未知字段");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new FriendArtifactError(400, "产物版本无效");
  if (!["pending", "committed", "failed"].includes(String(value.state))) throw new FriendArtifactError(400, "产物状态无效");
  if (!Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0) throw new FriendArtifactError(400, "产物尝试次数无效");
  if (!/^art-[a-f0-9]{32}$/.test(String(value.id)) || !/^[a-f0-9]{48}$/.test(String(value.artifactKey)))
    throw new FriendArtifactError(400, "产物标识无效");
  record(value.provenance);
  if (Object.keys(value.provenance).some((key) => key !== "materials") || !Array.isArray(value.provenance.materials))
    throw new FriendArtifactError(400, "产物来源无效");
  if (!Array.isArray(value.revisions)) throw new FriendArtifactError(400, "产物修订记录无效");
  return {
    id: String(value.id),
    artifactKey: String(value.artifactKey),
    longAgentId: text(value.longAgentId, 120),
    kind: parseArtifactKind(value.kind),
    slot: parseArtifactSlot(value.slot),
    date: timestamp(`${value.date}T00:00:00.000Z`).slice(0, 10),
    taskId: value.taskId === null ? null : text(value.taskId, 200),
    occurrenceId: value.occurrenceId === null ? null : text(value.occurrenceId, 200),
    workId: value.workId === null ? null : text(value.workId, 200),
    dutyId: value.dutyId === null ? null : text(value.dutyId, 200),
    goalRevision: value.goalRevision === null ? null : Number(value.goalRevision),
    progressEntryId: value.progressEntryId === null ? null : text(value.progressEntryId, 200),
    state: value.state as ArtifactState,
    revision: Number(value.revision),
    contentHash: text(value.contentHash, 128),
    content: String(value.content ?? ""),
    target: parseTarget(value.target),
    resourceId: value.resourceId === null ? null : text(value.resourceId, 1024),
    provenance: { materials: value.provenance.materials.map((item) => text(item, 1024)) },
    attempts: Number(value.attempts),
    // Documents written before this field existed were retried by default.
    retryable: typeof value.retryable === "boolean" ? value.retryable : true,
    failure: value.failure === null ? null : String(value.failure).slice(0, 2000),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    revisions: value.revisions.map((item) => {
      record(item);
      return {
        revision: Number(item.revision),
        contentHash: text(item.contentHash, 128),
        content: String(item.content ?? ""),
        origin: item.origin === "user" ? "user" : "generated",
        // Legacy records stored the same path under resourceId.
        versionFile: item.versionFile === undefined
          ? (item.resourceId === null || item.resourceId === undefined ? null : text(item.resourceId, 1024))
          : (item.versionFile === null ? null : text(item.versionFile, 1024)),
        at: timestamp(item.at),
      };
    }),
    note: parseNoteStore(value.note),
  };
}
function parseNoteStore(value: unknown): ArtifactNoteStore | null {
  if (value === null || value === undefined) return null;
  record(value);
  const keys = ["versionFile", "pointerFile", "workspacePath", "workspaceHash", "workspaceState", "conflict", "conflictResolution"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new FriendArtifactError(400, "笔记存储包含未知字段");
  if (!["clean", "older", "edited", "missing"].includes(String(value.workspaceState)))
    throw new FriendArtifactError(400, "笔记工作区状态无效");
  const conflict = value.conflict === null || value.conflict === undefined ? null : (() => {
    record(value.conflict);
    const conflictKeys = ["source", "contentHash", "content", "preservedFile", "at"];
    if (Object.keys(value.conflict).some((key) => !conflictKeys.includes(key)))
      throw new FriendArtifactError(400, "笔记冲突记录包含未知字段");
    return {
      source: value.conflict.source === "version-file" ? "version-file" as const : "workspace" as const,
      contentHash: text(value.conflict.contentHash, 128),
      content: String(value.conflict.content ?? ""),
      preservedFile: value.conflict.preservedFile === null ? null : text(value.conflict.preservedFile, 1024),
      at: timestamp(value.conflict.at),
    };
  })();
  return {
    versionFile: text(value.versionFile, 1024),
    pointerFile: text(value.pointerFile, 1024),
    workspacePath: text(value.workspacePath, 1024),
    workspaceHash: value.workspaceHash === null || value.workspaceHash === undefined ? null : text(value.workspaceHash, 128),
    workspaceState: value.workspaceState as ArtifactWorkspaceState,
    conflict,
    conflictResolution: value.conflictResolution === "user" || value.conflictResolution === "generated" ? value.conflictResolution : null,
  };
}
