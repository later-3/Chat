import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureChatHome } from "../chat-home.js";
import { resolveProjectContext } from "../projects/registry.js";
import { assertFileWithin, atomicWriteJson, withFileLock } from "../persistence/versioned-file.js";
import { longAgentConfigRoot, readLongAgentState } from "./storage.js";

/**
 * Per-Friend collaboration project (LA6 A).
 *
 * The association belongs to the current local user and one stable `longAgentId`; it is stored in its
 * own file under the Friend's config root so it never rewrites the Agent definition, the registry or
 * NanoClaw state. The Backend is the authority: `projectId` is a preference, and every execution
 * target is still frozen on the accepted turn.
 *
 * Three states are distinct:
 * - no record            -> `unset`: the effective project is null and nothing is written implicitly.
 * - record `projectId:null` -> explicit clear: the effective project is null.
 * - record with a project -> `active`, or `unavailable` when the project no longer resolves.
 */
export interface LongAgentInteractionProject {
  schemaVersion: 1;
  projectId: string | null;
  revision: number;
  updatedAt: string;
}

export type InteractionProjectAvailability = "none" | "active" | "unavailable";

export interface LongAgentInteractionProjectState {
  /** `unset` means no record exists; `set` means an explicit choice (including an explicit clear). */
  status: "unset" | "set";
  projectId: string | null;
  revision: number;
  updatedAt: string | null;
  effective: {
    projectId: string | null;
    availability: InteractionProjectAvailability;
    reason: string | null;
  };
}

export class InteractionProjectError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function interactionFile(chatHome: string, longAgentId: string): string {
  return resolve(longAgentConfigRoot(chatHome, longAgentId), "interaction.json");
}

function parseInteractionProject(value: unknown): LongAgentInteractionProject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InteractionProjectError(500, "项目关联记录损坏");
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => !["schemaVersion", "projectId", "revision", "updatedAt"].includes(key));
  if (unknown.length > 0 || body.schemaVersion !== 1) throw new InteractionProjectError(500, "项目关联记录损坏");
  if (body.projectId !== null && (typeof body.projectId !== "string" || body.projectId === ""))
    throw new InteractionProjectError(500, "项目关联记录损坏");
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) throw new InteractionProjectError(500, "项目关联 revision 无效");
  if (typeof body.updatedAt !== "string" || Number.isNaN(Date.parse(body.updatedAt)))
    throw new InteractionProjectError(500, "项目关联时间无效");
  return {
    schemaVersion: 1,
    projectId: (body.projectId as string | null) ?? null,
    revision: Number(body.revision),
    updatedAt: body.updatedAt,
  };
}

async function readRecord(chatHome: string, longAgentId: string): Promise<LongAgentInteractionProject | null> {
  const file = interactionFile(chatHome, longAgentId);
  await assertFileWithin(file, chatHome);
  try {
    return parseInteractionProject(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The effective project the Backend computes for a turn; the record value itself is never trusted as authorization. */
export async function readLongAgentInteractionProject(chatHome: string, longAgentId: string): Promise<LongAgentInteractionProjectState> {
  await ensureChatHome(chatHome);
  const record = await readRecord(chatHome, longAgentId);
  if (record === null) {
    return { status: "unset", projectId: null, revision: 0, updatedAt: null, effective: { projectId: null, availability: "none", reason: null } };
  }
  if (record.projectId === null) {
    return { status: "set", projectId: null, revision: record.revision, updatedAt: record.updatedAt, effective: { projectId: null, availability: "none", reason: null } };
  }
  try {
    const project = await resolveProjectContext(record.projectId, chatHome);
    if (project.kind !== "project") {
      return { status: "set", projectId: record.projectId, revision: record.revision, updatedAt: record.updatedAt, effective: { projectId: null, availability: "unavailable", reason: "关联的 Project 不是用户项目" } };
    }
    return { status: "set", projectId: record.projectId, revision: record.revision, updatedAt: record.updatedAt, effective: { projectId: record.projectId, availability: "active", reason: null } };
  } catch {
    return { status: "set", projectId: record.projectId, revision: record.revision, updatedAt: record.updatedAt, effective: { projectId: null, availability: "unavailable", reason: "关联的 Project 已不存在或不可用" } };
  }
}

/**
 * Explicit write with revision CAS. `expectedRevision` is 0 for the first write (unset), otherwise the
 * revision the caller last read. A non-null project must resolve to a user Project now; later removal
 * is surfaced as `unavailable` instead of silently switching to another project.
 */
export async function setLongAgentInteractionProject(input: {
  chatHome: string;
  longAgentId: string;
  projectId: string | null;
  expectedRevision: number;
}): Promise<LongAgentInteractionProjectState> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    throw new InteractionProjectError(400, "expectedRevision 无效");
  const home = await ensureChatHome(input.chatHome);
  if (input.projectId !== null) {
    if (input.projectId.trim() === "") throw new InteractionProjectError(400, "projectId 无效");
    const project = await resolveProjectContext(input.projectId, home.root).catch(() => null);
    if (project === null || project.kind !== "project")
      throw new InteractionProjectError(404, "找不到可关联的用户 Project");
  }
  const file = interactionFile(home.root, input.longAgentId);
  return withFileLock(`${home.root}/runtime/friend-accept`, async () => withFileLock(file, async () => {
    const current = await readRecord(home.root, input.longAgentId);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.expectedRevision)
      throw new InteractionProjectError(409, `项目关联已被修改（当前 revision ${String(currentRevision)}），请刷新后重试`);
    await atomicWriteJson(file, {
      schemaVersion: 1,
      projectId: input.projectId,
      revision: currentRevision + 1,
      updatedAt: new Date().toISOString(),
    } satisfies LongAgentInteractionProject);
    return readLongAgentInteractionProject(home.root, input.longAgentId);
  }));
}

/**
 * Whether one accepted turn is the trusted owner's own private chat.
 *
 * `longAgentId` alone only proves which Friend is speaking; a channel, scheduled or background turn
 * carries the same identity. Management authority for the private association is therefore resolved
 * from the authoritative accepted-turn record: only `chat-web`, with no work binding, no channel type
 * and no inbound event, is the local owner talking to this Friend.
 */
export async function isOwnerPrivateTurn(chatHome: string, longAgentId: string, longAgentTurnId: string | undefined): Promise<boolean> {
  if (longAgentTurnId === undefined || longAgentTurnId.trim() === "") return false;
  const turn = (await readLongAgentState(chatHome)).turns.find((candidate) =>
    candidate.turnId === longAgentTurnId && candidate.longAgentId === longAgentId);
  if (turn === undefined) return false;
  return turn.source === "chat-web" && turn.workId === undefined
    && (turn.channelType === null || turn.channelType === "chat-web")
    && turn.inboundEventId === null;
}

/** Remove the record entirely, returning the Friend to `unset` (used by tests and lifecycle repair). */
export async function clearLongAgentInteractionProjectRecord(chatHome: string, longAgentId: string): Promise<void> {
  const home = await ensureChatHome(chatHome);
  await rm(interactionFile(home.root, longAgentId), { force: true });
}
