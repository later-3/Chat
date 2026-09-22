import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertFileWithin, withFileLock } from "../../persistence/versioned-file.js";
import { canonicalToolPath } from "../../agents/scoped-file-tools.js";
import { resolveProjectContext } from "../../projects/registry.js";
import { appendChatAuditEvent } from "../../audit-log.js";
import { openChatSession } from "../../chat-session.js";
import { readLongAgentRegistry, readLongAgentState } from "../storage.js";
import { agentDate } from "../calendar.js";
import { readTaskState } from "../tasks/storage.js";
import { readDutyState } from "../duties/storage.js";
import type { TaskOccurrence } from "../tasks/contract.js";
import { MAX_POST_TEXT_CHARS, findPostByArtifactKey, publishLongAgentPost } from "../social.js";
import { artifactFile, changeArtifactState, readArtifactState, requireArtifact, type ArtifactState } from "./storage.js";
import {
  contentHash as contentHashOf,
  inspectWorkspaceFile,
  materializeWorkspaceFile,
  noteStorePaths,
  readTextIfExists,
  versionFileName,
  writeImmutableFile,
  writeNotePointer,
  type WorkspaceInspection,
} from "./note-store.js";
import {
  FriendArtifactError,
  artifactDigest,
  artifactIdOf,
  artifactKeyOf,
  parseArtifactAudience,
  parseArtifactKind,
  type ArtifactAudience,
  type ArtifactNoteConflict,
  type ArtifactNoteStore,
  type FriendArtifact,
} from "./contract.js";

export const MAX_ARTIFACT_ATTEMPTS = 5;
export const MAX_NOTE_CONTENT = 60_000;
const ARTIFACT_NOTICE = "chat.friend-artifact.v1";
/** A blocked artifact cannot be fixed by retrying: authorization changed or the target moved on. */
class ArtifactBlockedError extends FriendArtifactError {}

function normalizeRelativePath(path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    throw new FriendArtifactError(400, "笔记路径必须是授权范围内的相对路径");
  return path.split(/[\\/]/).filter((part) => part !== "" && part !== ".").join("/");
}
async function owner(home: string, agentId: string) {
  const registry = await readLongAgentRegistry(home);
  const agent = registry.agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new FriendArtifactError(404, "找不到Friend");
  return agent;
}

interface ArtifactContext {
  taskId: string;
  occurrenceId: string;
  workId: string;
  slot: string;
  kind: FriendArtifact["kind"];
  date: string;
  target: FriendArtifact["target"];
  dutyId: string | null;
  goalRevision: number | null;
  progressEntryId: string | null;
}
function targetSignature(target: FriendArtifact["target"]): string {
  return target.kind === "social" ? `social:${target.audience}` : `file:${target.path}`;
}

/** Artifact identity is resolved from the durable execution context; a model cannot invent it. */
async function resolveArtifactContext(home: string, agentId: string, turnId: string, kind: FriendArtifact["kind"]): Promise<ArtifactContext> {
  const agentState = await readLongAgentState(home);
  const turn = agentState.turns.find((candidate) => candidate.longAgentId === agentId && candidate.turnId === turnId);
  if (!turn) throw new FriendArtifactError(400, "找不到该执行上下文");
  if (!turn.workId) throw new FriendArtifactError(400, "产物必须由独立工作提交，不能从主聊直接发布");
  const work = agentState.works.find((candidate) => candidate.id === turn.workId);
  if (!work) throw new FriendArtifactError(400, "后台工作绑定缺失");
  const taskState = await readTaskState(home, agentId);
  const occurrence = taskState.occurrences.find((candidate) => candidate.id === work.requestId);
  if (!occurrence || occurrence.workId !== work.id)
    throw new FriendArtifactError(400, "该执行不属于可提交产物的任务发生");
  const deliverable = occurrence.definition.deliverable;
  if (!deliverable) throw new FriendArtifactError(400, "该任务未配置为产物任务（deliverable），不能提交笔记或动态");
  if (deliverable.kind !== kind)
    throw new FriendArtifactError(400, `该任务配置的是 ${deliverable.kind} 产物，不能按 ${kind} 提交`);
  const target: FriendArtifact["target"] =
    deliverable.kind === "post"
      ? { kind: "social", audience: deliverable.audience ?? "friends" }
      : { kind: "file", path: "" };
  let progressEntryId: string | null = null;
  let goalRevision: number | null = null;
  if (occurrence.definition.dutyId) {
    const duty = (await readDutyState(home, agentId)).duties.find((candidate) => candidate.id === occurrence.definition.dutyId);
    goalRevision = occurrence.dutyGoalRevision ?? duty?.goalRevision ?? null;
    progressEntryId = duty?.progress.find((entry) => entry.advancementKey === occurrence.id && entry.applied)?.id ?? null;
  }
  return {
    taskId: occurrence.taskId,
    occurrenceId: occurrence.id,
    workId: work.id,
    slot: deliverable.slot,
    kind: deliverable.kind,
    date: agentDate(occurrence.definition.timeZone, new Date(occurrence.scheduledAt)),
    target,
    dutyId: occurrence.definition.dutyId ?? null,
    goalRevision,
    progressEntryId,
  };
}

/** The instruction appended to a deliverable task's work text; frozen with the occurrence. */
export function describeArtifactInstruction(occurrence: Pick<TaskOccurrence, "definition">): string | null {
  const deliverable = occurrence.definition.deliverable;
  if (!deliverable) return null;
  const audience = deliverable.kind === "post" ? `受众：${deliverable.audience ?? "friends"}（由用户配置，不能更改）` : "";
  const submission =
    deliverable.kind === "post"
      ? "2. 完成后必须调用 artifact_manage 的 submit（kind=post，content=动态正文）提交；发布由服务端执行并按发生去重，重复提交不会产生第二条动态。"
      : "2. 完成后必须调用 artifact_manage 的 submit（kind=note，path=相对工作区的笔记路径，content=笔记正文）提交；服务端写入不可变版本文件、更新当前版本指针并校验，绝不覆盖工作区已有文件。不要用普通写文件工具代替提交。";
  return [
    "",
    "【系统附加：本次是产物任务】",
    `类型：${deliverable.kind}；槽位：${deliverable.slot}；${audience}`,
    "1. 产出一份可独立阅读的完整内容；格式自选，但必须有实际内容，不得用占位或元描述充数。",
    submission,
    "3. 参考依据只能来自本次职责/任务的材料、已应用的进度与工作记录；不得引用未核验或未应用的历史，不得编造来源。",
    "4. 若材料不足或检查失败，不要提交空内容；在 report/回复中说明缺口。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function verifyPost(home: string, artifact: FriendArtifact): Promise<string | null> {
  try {
    const post = await findPostByArtifactKey({ chatHome: home, artifactKey: artifact.artifactKey });
    // Identity *and* body must match; a truncated or replaced body is not a committed artifact.
    if (post === null) return null;
    if (post.text !== artifact.content) throw new ArtifactBlockedError(409, "已存在同键帖子，但正文与冻结内容不一致（可能被截断或损坏），待人工核查");
    return post.id;
  } catch (error) {
    if (error instanceof ArtifactBlockedError) throw error;
    // An unreadable social store means "cannot verify yet", not a crash.
    return null;
  }
}
/** A note artifact is verified through its immutable version file, never through the user's file. */
async function verifyVersionFile(file: string, expectedHash: string): Promise<string | null> {
  try {
    const real = await realpath(file);
    const content = await readFile(real, "utf8");
    return contentHashOf(content) === expectedHash ? real : null;
  } catch {
    return null;
  }
}
async function workspaceRoot(home: string, agentId: string): Promise<string> {
  const context = await resolveProjectContext(agentId, home);
  return realpath(context.projectRoot).catch(() => context.projectRoot);
}

/** Authorization is re-checked against the live definition before any side effect. */
async function authorizeArtifact(home: string, agentId: string, artifact: FriendArtifact): Promise<void> {
  const taskState = await readTaskState(home, agentId);
  const task = artifact.taskId === null ? undefined : taskState.tasks.find((candidate) => candidate.id === artifact.taskId);
  if (task === undefined) throw new ArtifactBlockedError(409, "来源任务已不存在，产物保留为历史，不能按旧授权发布");
  if (task.status === "cancelled") throw new ArtifactBlockedError(409, "任务已取消，产物保留为历史，不能按旧授权发布");
  const deliverable = task.deliverable;
  if (deliverable === undefined || deliverable.kind !== artifact.kind || deliverable.slot !== artifact.slot)
    throw new ArtifactBlockedError(409, "任务产物配置已变更，产物保留为历史；请重新生成一次");
  if (deliverable.kind === "post") {
    const current = deliverable.audience ?? "friends";
    const frozen = artifact.target.kind === "social" ? artifact.target.audience : "friends";
    if (current !== frozen)
      throw new ArtifactBlockedError(409, `受众已由 ${frozen} 变更（当前 ${current}），未按旧授权发布；请重新生成一次`);
  }
  if (artifact.dutyId !== null) {
    const duty = (await readDutyState(home, agentId)).duties.find((candidate) => candidate.id === artifact.dutyId);
    if (duty === undefined || duty.status === "ended")
      throw new ArtifactBlockedError(409, "职责已结束或不存在，产物保留为历史，不能按旧授权发布");
    if (artifact.goalRevision !== null && duty.goalRevision !== artifact.goalRevision)
      throw new ArtifactBlockedError(409, "职责目标已修订，产物保留为历史，不能按旧目标发布；请重新生成一次");
  }
}
/**
 * Path ownership: the newest record for a note path (stable order: creation time, then id) owns the
 * current version. An older record may still keep history but must not advance the pointer or write
 * new versions after a newer record exists — that is the rollback this guard prevents.
 */
async function assertNoteOwner(home: string, agentId: string, artifact: FriendArtifact, path: string): Promise<void> {
  const store = await readArtifactState(home, agentId);
  const peers = store.artifacts.filter((other) => other.id !== artifact.id && other.target.kind === "file" && other.target.path === path);
  const newer = peers
    .filter((other) => other.createdAt > artifact.createdAt || (other.createdAt === artifact.createdAt && other.id > artifact.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (newer !== undefined)
    throw new ArtifactBlockedError(409, `笔记路径当前由更新的产物版本 ${newer.id} 占用，本记录保留为历史，不写入新版本`);
}

/**
 * Every path the note store derives from the (already authorized) note path must canonicalize to
 * itself inside the workspace: a pre-existing symlinked `.chat-notes`/`versions`/`user` or pointer
 * target would otherwise redirect writes outside the authorized root.
 */
async function authorizeNoteStore(root: string, canonical: string): Promise<ReturnType<typeof noteStorePaths>> {
  const paths = noteStorePaths(canonical);
  const entries: Array<readonly [string, string]> = [
    ["存储目录", paths.storeDir],
    ["版本目录", paths.versionsDir],
    ["冲突目录", paths.userDir],
    ["指针文件", paths.pointerFile],
  ];
  for (const [label, target] of entries) {
    let resolvedPath: string;
    try {
      resolvedPath = await canonicalToolPath(target);
      await assertFileWithin(resolvedPath, root);
    } catch (error) {
      throw new ArtifactBlockedError(409, `笔记${label}越出授权工作区，未写入：${error instanceof Error ? error.message : String(error)}`);
    }
    if (resolvedPath !== resolve(target))
      throw new ArtifactBlockedError(409, `笔记${label}经过符号链接或规范化后越出工作区，未写入`);
  }
  return paths;
}

/** Perform the side effect for a frozen artifact; never generates content. */
async function performSideEffect(
  home: string,
  agentId: string,
  artifact: FriendArtifact,
): Promise<{ resourceId: string; expectedRevision: number; expectedContentHash: string; note: ArtifactNoteStore | null }> {
  await authorizeArtifact(home, agentId, artifact);
  if (artifact.target.kind === "social") {
    const post = await publishLongAgentPost({
      chatHome: home,
      longAgentId: agentId,
      text: artifact.content,
      date: artifact.date,
      artifactKey: artifact.artifactKey,
      audience: artifact.target.audience,
      // Final gate inside the social append lock: a revocation that completed meanwhile still blocks.
      confirmPublish: async () => authorizeArtifact(home, agentId, artifact),
    });
    if (post.text !== artifact.content)
      throw new ArtifactBlockedError(502, "已发布正文与冻结内容不一致，未标记完成；请核查后重新生成");
    const verified = await verifyPost(home, artifact);
    if (verified === null) throw new FriendArtifactError(502, "动态已提交但回读校验失败，等待核查");
    return { resourceId: verified, expectedRevision: artifact.revision, expectedContentHash: artifact.contentHash, note: null };
  }
  const path = normalizeRelativePath(artifact.target.path);
  const root = await workspaceRoot(home, agentId);
  // Authorization happens before creating directories, temporary files or renaming anything.
  let canonical: string;
  try {
    canonical = await canonicalToolPath(resolve(root, path));
    await assertFileWithin(canonical, root);
  } catch (error) {
    throw new ArtifactBlockedError(409, `笔记路径越出授权工作区，未写入：${error instanceof Error ? error.message : String(error)}`);
  }
  if (canonical !== resolve(root, path))
    throw new ArtifactBlockedError(409, "笔记路径经过符号链接或规范化后越出工作区，未写入");
  // One managed writer per canonical path: ownership, version write, pointer and read-back
  // verification all happen inside this lock, so a stale record can never write after a newer one.
  return withFileLock(`${artifactFile(home, agentId)}.path:${canonical}`, async () => {
    await assertNoteOwner(home, agentId, artifact, path);
    const committed = await commitNoteVersion(home, agentId, artifact, canonical, path);
    const verified = await verifyVersionFile(committed.versionFile, artifact.contentHash);
    if (verified === null) throw new FriendArtifactError(502, "版本文件写入后校验失败，等待核查");
    return { resourceId: verified, expectedRevision: artifact.revision, expectedContentHash: artifact.contentHash, note: committed.note };
  });
}

/**
 * Immutable note commit. The service never overwrites an existing workspace file:
 * 1. the frozen content becomes an immutable version file (atomic create-if-absent, hash verified);
 * 2. the machine-managed pointer (authoritative copy: this record) is updated atomically;
 * 3. the user-visible note file is created only when absent, and afterwards only *inspected*: an
 *    edit that matches nothing we produced is preserved as its own immutable version and reported
 *    as a conflict, so both sides survive and nothing is silently overwritten.
 */
async function commitNoteVersion(
  home: string,
  agentId: string,
  artifact: FriendArtifact,
  canonical: string,
  workspacePath: string,
): Promise<{ versionFile: string; note: ArtifactNoteStore }> {
  const paths = await authorizeNoteStore(await workspaceRoot(home, agentId), canonical);
  const hash = artifact.contentHash;
  const written = await writeImmutableFile(paths.versionsDir, versionFileName(artifact.revision, hash), artifact.content, artifact.id.slice(-8));
  const stored = await readTextIfExists(written.path);
  if (stored === null || contentHashOf(stored) !== hash)
    throw new FriendArtifactError(502, "版本文件写入后校验失败，等待核查");
  const knownHashes = new Set<string>([hash, ...artifact.revisions.map((entry) => entry.contentHash)]);
  // Content produced by any other record for this same path is still "ours", never a user edit.
  for (const peer of (await readArtifactState(home, agentId)).artifacts) {
    if (peer.id === artifact.id || peer.target.kind !== "file" || peer.target.path !== workspacePath) continue;
    knownHashes.add(peer.contentHash);
    for (const entry of peer.revisions) knownHashes.add(entry.contentHash);
  }
  const preserve = async (content: string, source: ArtifactNoteConflict["source"]): Promise<ArtifactNoteConflict> => {
    const preserved = await writeImmutableFile(paths.userDir, versionFileName(artifact.revision, contentHashOf(content), "-user"), content, `user-${artifact.id.slice(-8)}`);
    return { source, contentHash: contentHashOf(content), content, preservedFile: preserved.path, at: new Date().toISOString() };
  };
  let inspection: WorkspaceInspection;
  if ((await readTextIfExists(canonical)) === null) {
    const created = await materializeWorkspaceFile(canonical, artifact.content, artifact.id.slice(-8));
    inspection = created === "created"
      ? { state: "clean", hash, conflict: null }
      : await inspectWorkspaceFile(canonical, knownHashes, hash, (content) => preserve(content, "workspace"));
  } else {
    inspection = await inspectWorkspaceFile(canonical, knownHashes, hash, (content) => preserve(content, "workspace"));
  }
  const note: ArtifactNoteStore = {
    versionFile: written.path,
    pointerFile: paths.pointerFile,
    workspacePath,
    workspaceHash: inspection.hash,
    workspaceState: inspection.state,
    conflict: inspection.conflict,
    conflictResolution: null,
  };
  await writeNotePointer(paths.pointerFile, {
    schemaVersion: 1,
    artifactId: artifact.id,
    artifactKey: artifact.artifactKey,
    revision: artifact.revision,
    contentHash: hash,
    versionFile: written.path,
    workspacePath,
    workspaceState: note.workspaceState,
    updatedAt: new Date().toISOString(),
  });
  return { versionFile: written.path, note };
}

async function settle(
  home: string,
  agentId: string,
  artifactId: string,
  expected: { revision: number; contentHash: string },
  update: { state: FriendArtifact["state"]; resourceId: string | null; failure: string | null; retryable: boolean; note?: ArtifactNoteStore | null },
): Promise<{ artifact: FriendArtifact; applied: boolean }> {
  return changeArtifactState(home, agentId, (store) => {
    const artifact = requireArtifact(store, artifactId);
    // The receipt must match the content version it was produced for; a stale one never completes
    // a newer (or failed) revision.
    if (artifact.revision !== expected.revision || artifact.contentHash !== expected.contentHash)
      return { artifact, applied: false };
    artifact.state = update.state;
    artifact.resourceId = update.resourceId;
    artifact.failure = update.failure;
    artifact.retryable = update.retryable;
    if (update.note !== undefined) {
      artifact.note = update.note;
      const entry = artifact.revisions.find((item) => item.revision === artifact.revision);
      if (entry && update.note !== null) entry.versionFile = update.note.versionFile;
    }
    artifact.updatedAt = new Date().toISOString();
    return { artifact, applied: true };
  });
}

/** Commit one artifact for the current occurrence; idempotent by identity, conflict on different content. */
export async function submitArtifact(home: string, agentId: string, body: Record<string, unknown>): Promise<FriendArtifact> {
  await owner(home, agentId);
  const kind = parseArtifactKind(body.kind);
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const limit = kind === "post" ? MAX_POST_TEXT_CHARS : MAX_NOTE_CONTENT;
  if (content === "") throw new FriendArtifactError(400, "产物内容为空");
  if (content.length > limit)
    throw new FriendArtifactError(400, kind === "post"
      ? `动态正文超过 ${MAX_POST_TEXT_CHARS} 字符上限（实际 ${content.length}）；发布服务不会截断，请缩短后重新提交`
      : `笔记内容超过 ${MAX_NOTE_CONTENT} 字符上限（实际 ${content.length}）`);
  const context = await resolveArtifactContext(home, agentId, String(body.turnId ?? ""), kind);
  const target: FriendArtifact["target"] =
    kind === "post"
      ? context.target
      : { kind: "file", path: normalizeRelativePath(String(body.path ?? "")) };
  const artifactKey = artifactKeyOf({ taskId: context.taskId, occurrenceId: context.occurrenceId, kind, slot: context.slot, target: targetSignature(target) });
  const artifactId = artifactIdOf(agentId, artifactKey);
  const contentHash = contentHashOf(content);
  const existing = (await readArtifactState(home, agentId)).artifacts.find((candidate) => candidate.id === artifactId);
  if (existing) {
    if (existing.contentHash !== contentHash)
      throw new FriendArtifactError(409, "同一次发生的产物内容已变化；如需修改笔记请使用 revise，动态请重新生成一次");
    return existing;
  }
  const now = new Date().toISOString();
  const artifact = await changeArtifactState(home, agentId, (store) => {
    if (store.artifacts.some((candidate) => candidate.id === artifactId))
      throw new FriendArtifactError(409, "产物已存在，请重新读取");
    const created: FriendArtifact = {
      id: artifactId,
      artifactKey,
      longAgentId: agentId,
      kind,
      slot: context.slot,
      date: context.date,
      taskId: context.taskId,
      occurrenceId: context.occurrenceId,
      workId: context.workId,
      dutyId: context.dutyId,
      goalRevision: context.goalRevision,
      progressEntryId: context.progressEntryId,
      state: "pending",
      revision: 1,
      contentHash,
      content,
      target,
      resourceId: null,
      provenance: { materials: [] },
      attempts: 0,
      retryable: true,
      failure: null,
      createdAt: now,
      updatedAt: now,
      revisions: [{ revision: 1, contentHash, content, origin: "generated", versionFile: null, at: now }],
      note: null,
    };
    store.artifacts.push(created);
    return created;
  });
  await appendChatAuditEvent({
    action: "long-agent.artifact.submit",
    target: { type: "long-agent", longAgentId: agentId },
    details: { artifactId, kind, slot: context.slot, occurrenceId: context.occurrenceId },
  }, home);
  return commitFrozen(home, agentId, artifact.id);
}

/**
 * Run (or re-run) the side effect for a frozen artifact. Serialized per artifact identity; the
 * receipt is committed with a revision/contentHash compare-and-swap so a stale verification can
 * never complete a newer revision.
 */
async function commitFrozen(home: string, agentId: string, artifactId: string): Promise<FriendArtifact> {
  return withFileLock(`${artifactFile(home, agentId)}.${artifactId}`, async () => {
    const artifact = requireArtifact(await readArtifactState(home, agentId), artifactId);
    if (artifact.state === "committed") return artifact;
    if (!artifact.retryable)
      throw new FriendArtifactError(409, artifact.failure ?? "产物被阻塞，不能重试；请重新生成或修订");
    const bumped = await changeArtifactState(home, agentId, (store) => {
      const current = requireArtifact(store, artifactId);
      current.attempts += 1;
      current.updatedAt = new Date().toISOString();
      return current;
    });
    try {
      const outcome = await performSideEffect(home, agentId, bumped);
      const settled = await settle(home, agentId, artifactId,
        { revision: outcome.expectedRevision, contentHash: outcome.expectedContentHash },
        { state: "committed", resourceId: outcome.resourceId, failure: null, retryable: true, note: outcome.note });
      if (settled.applied) {
        await appendChatAuditEvent({
          action: "long-agent.artifact.committed",
          target: { type: "long-agent", longAgentId: agentId },
          details: { artifactId, kind: settled.artifact.kind, resourceId: settled.artifact.resourceId },
        }, home);
      }
      return settled.artifact;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blocked = error instanceof ArtifactBlockedError;
      const settled = await settle(home, agentId, artifactId,
        { revision: bumped.revision, contentHash: bumped.contentHash },
        { state: "failed", resourceId: null, failure: message.slice(0, 2000), retryable: !blocked });
      return settled.artifact;
    }
  });
}

/** Re-run the commit for an already frozen artifact (补交已有产物); never generates content. */
export async function resubmitArtifact(home: string, agentId: string, artifactId: string): Promise<FriendArtifact> {
  await owner(home, agentId);
  const artifact = requireArtifact(await readArtifactState(home, agentId), artifactId);
  if (artifact.state === "committed") return artifact;
  return commitFrozen(home, agentId, artifactId);
}

/**
 * Recovery shares the exact commit protocol: posts are deduplicated and their *body* verified,
 * notes write immutable versions only. Never regenerates content and never overwrites a workspace file.
 */
export async function reconcileFriendArtifacts(home: string, agentId: string): Promise<void> {
  const state = await readArtifactState(home, agentId);
  for (const artifact of state.artifacts) {
    if (artifact.state === "committed") {
      if (artifact.kind === "note" && artifact.note !== null) {
        try {
          await refreshCommittedNote(home, agentId, artifact);
        } catch (error) {
          console.error(`笔记 ${artifact.id} 状态核查失败`, error instanceof Error ? error.message : error);
        }
      }
      continue;
    }
    if (!artifact.retryable) continue;
    // Bounded retries: a failed artifact is re-attempted at most MAX_ARTIFACT_ATTEMPTS times.
    if (artifact.attempts >= MAX_ARTIFACT_ATTEMPTS) continue;
    try {
      await commitFrozen(home, agentId, artifact.id);
    } catch (error) {
      console.error(`产物 ${artifact.id} 待核查`, error instanceof Error ? error.message : error);
    }
  }
}

/** Explicit note revision: same file, new content version; previous versions stay in the record. */
export async function reviseArtifact(home: string, agentId: string, body: Record<string, unknown>): Promise<FriendArtifact> {
  await owner(home, agentId);
  const artifactId = String(body.artifactId ?? "");
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (content === "" || content.length > MAX_NOTE_CONTENT)
    throw new FriendArtifactError(400, `产物内容为空或超过 ${MAX_NOTE_CONTENT} 字符上限`);
  const current = requireArtifact(await readArtifactState(home, agentId), artifactId);
  if (current.kind !== "note") throw new FriendArtifactError(400, "只有笔记支持内容修订；动态请重新生成一次");
  if (current.state !== "committed") throw new FriendArtifactError(409, "产物尚未完成，不能修订");
  const contentHash = contentHashOf(content);
  if (contentHash === current.contentHash) return current;
  const updated = await changeArtifactState(home, agentId, (store) => {
    const artifact = requireArtifact(store, artifactId);
    artifact.revision += 1;
    artifact.contentHash = contentHash;
    artifact.content = content;
    artifact.state = "pending";
    artifact.retryable = true;
    artifact.failure = null;
    artifact.updatedAt = new Date().toISOString();
    artifact.revisions.push({ revision: artifact.revision, contentHash, content, origin: "generated", versionFile: null, at: artifact.updatedAt });
    return artifact;
  });
  await appendChatAuditEvent({
    action: "long-agent.artifact.revised",
    target: { type: "long-agent", longAgentId: agentId },
    details: { artifactId, revision: updated.revision },
  }, home);
  return commitFrozen(home, agentId, artifactId);
}

/**
 * Keep a committed note true without ever writing the user's file: re-verify the immutable version
 * file (a hand-edited or deleted version file is preserved and re-created at a new path) and
 * re-classify the workspace file (new external content is preserved as its own version).
 */
async function refreshCommittedNote(home: string, agentId: string, snapshot: FriendArtifact): Promise<void> {
  const note = snapshot.note;
  if (note === null) return;
  const root = await workspaceRoot(home, agentId);
  const canonical = resolve(root, note.workspacePath);
  const paths = await authorizeNoteStore(root, canonical);
  const preserve = async (content: string, source: ArtifactNoteConflict["source"]): Promise<ArtifactNoteConflict> => {
    const preserved = await writeImmutableFile(paths.userDir, versionFileName(snapshot.revision, contentHashOf(content), "-user"), content, `user-${snapshot.id.slice(-8)}`);
    return { source, contentHash: contentHashOf(content), content, preservedFile: preserved.path, at: new Date().toISOString() };
  };
  let versionFile = note.versionFile;
  let versionConflict: ArtifactNoteConflict | null = null;
  const versionContent = await readTextIfExists(note.versionFile);
  if (versionContent === null || contentHashOf(versionContent) !== snapshot.contentHash) {
    if (versionContent !== null) versionConflict = await preserve(versionContent, "version-file");
    versionFile = (await writeImmutableFile(paths.versionsDir, versionFileName(snapshot.revision, snapshot.contentHash), snapshot.content, snapshot.id.slice(-8))).path;
  }
  const pointerRaw = await readTextIfExists(paths.pointerFile);
  const pointerOk = (() => {
    try {
      const parsed = JSON.parse(pointerRaw ?? "null") as Record<string, unknown> | null;
      return parsed !== null && parsed.artifactId === snapshot.id && parsed.revision === snapshot.revision &&
        parsed.contentHash === snapshot.contentHash && parsed.versionFile === versionFile;
    } catch {
      return false;
    }
  })();
  const knownHashes = new Set<string>([snapshot.contentHash, ...snapshot.revisions.map((entry) => entry.contentHash)]);
  for (const peer of (await readArtifactState(home, agentId)).artifacts) {
    if (peer.id === snapshot.id || peer.target.kind !== "file" || peer.target.path !== note.workspacePath) continue;
    knownHashes.add(peer.contentHash);
    for (const entry of peer.revisions) knownHashes.add(entry.contentHash);
  }
  const inspection = await inspectWorkspaceFile(canonical, knownHashes, snapshot.contentHash, (content) => preserve(content, "workspace"));
  const conflict = inspection.conflict ?? versionConflict;
  // A decision belongs to one conflict: different source or content invalidates the earlier choice.
  const conflictChanged = (conflict?.contentHash ?? null) !== (note.conflict?.contentHash ?? null) ||
    (conflict?.source ?? null) !== (note.conflict?.source ?? null);
  if (inspection.state === note.workspaceState && inspection.hash === note.workspaceHash && versionFile === note.versionFile && !conflictChanged && pointerOk)
    return;
  // The refresh may have started before a revision/settle, and an older record never owns the
  // pointer: both are enforced inside the record lock, and a stale refresh simply changes nothing.
  await changeArtifactState(home, agentId, async (store) => {
    const current = requireArtifact(store, snapshot.id);
    if (current.state !== "committed" || current.note === null) return;
    if (current.revision !== snapshot.revision || current.contentHash !== snapshot.contentHash || current.note.versionFile !== note.versionFile) return;
    const newer = store.artifacts.find((other) => other.id !== current.id && other.target.kind === "file" && other.target.path === note.workspacePath &&
      (other.createdAt > current.createdAt || (other.createdAt === current.createdAt && other.id > current.id)));
    if (newer !== undefined) return;
    current.note = {
      ...current.note,
      versionFile,
      workspaceHash: inspection.hash,
      workspaceState: inspection.state,
      conflict,
      conflictResolution: conflictChanged ? null : current.note.conflictResolution,
    };
    current.updatedAt = new Date().toISOString();
    if (versionFile !== note.versionFile || !pointerOk)
      await writeNotePointer(paths.pointerFile, {
        schemaVersion: 1,
        artifactId: current.id,
        artifactKey: current.artifactKey,
        revision: current.revision,
        contentHash: current.contentHash,
        versionFile,
        workspacePath: note.workspacePath,
        workspaceState: inspection.state,
        updatedAt: new Date().toISOString(),
      });
  });
}

/**
 * Resolve a workspace conflict without touching the user's file: either adopt the preserved edit as
 * a new note version (`user`), or keep the generated version current and remember the decision.
 */
export async function resolveNoteConflict(home: string, agentId: string, body: Record<string, unknown>): Promise<FriendArtifact> {
  await owner(home, agentId);
  const artifactId = String(body.artifactId ?? "");
  if (body.choice !== "user" && body.choice !== "generated")
    throw new FriendArtifactError(400, "冲突处理必须是 user（保留我的修改）或 generated（保留生成版本）");
  const current = requireArtifact(await readArtifactState(home, agentId), artifactId);
  if (current.kind !== "note" || current.note === null || current.note.conflict === null)
    throw new FriendArtifactError(409, "该笔记当前没有需要处理的冲突");
  const expected = { revision: current.revision, contentHash: current.contentHash, conflictHash: current.note.conflict.contentHash };
  const stillCurrent = (artifact: FriendArtifact) => {
    if (artifact.note === null || artifact.note.conflict === null) return false;
    return artifact.revision === expected.revision && artifact.contentHash === expected.contentHash &&
      artifact.note.conflict.contentHash === expected.conflictHash;
  };
  if (body.choice === "generated") {
    const kept = await changeArtifactState(home, agentId, (store) => {
      const artifact = requireArtifact(store, artifactId);
      if (!stillCurrent(artifact) || artifact.note === null)
        throw new FriendArtifactError(409, "冲突已变化，请重新读取后再处理");
      artifact.note = { ...artifact.note, conflictResolution: "generated" };
      artifact.updatedAt = new Date().toISOString();
      return artifact;
    });
    await appendChatAuditEvent({
      action: "long-agent.artifact.conflict-kept",
      target: { type: "long-agent", longAgentId: agentId },
      details: { artifactId, choice: "generated", conflictHash: current.note.conflict.contentHash },
    }, home);
    return kept;
  }
  const content = current.note.conflict.content;
  const hash = contentHashOf(content);
  const bumped = await changeArtifactState(home, agentId, (store) => {
    const artifact = requireArtifact(store, artifactId);
    if (!stillCurrent(artifact))
      throw new FriendArtifactError(409, "冲突已变化，请重新读取后再处理");
    artifact.revision += 1;
    artifact.contentHash = hash;
    artifact.content = content;
    artifact.state = "pending";
    artifact.retryable = true;
    artifact.failure = null;
    artifact.updatedAt = new Date().toISOString();
    artifact.revisions.push({ revision: artifact.revision, contentHash: hash, content, origin: "user", versionFile: null, at: artifact.updatedAt });
    return artifact;
  });
  await appendChatAuditEvent({
    action: "long-agent.artifact.conflict-adopted",
    target: { type: "long-agent", longAgentId: agentId },
    details: { artifactId, revision: bumped.revision, conflictHash: current.note.conflict.contentHash },
  }, home);
  return commitFrozen(home, agentId, bumped.id);
}

/**
 * Write the current version to a brand-new workspace file; an existing file is never replaced,
 * so a name collision produces a suffixed file instead.
 */
export async function exportArtifactVersion(home: string, agentId: string, body: Record<string, unknown>): Promise<{ path: string; relativePath: string }> {
  await owner(home, agentId);
  const artifact = requireArtifact(await readArtifactState(home, agentId), String(body.artifactId ?? ""));
  if (artifact.kind !== "note" || artifact.state !== "committed" || artifact.note === null)
    throw new FriendArtifactError(409, "只有已完成的新版笔记可以导出到工作区文件");
  const root = await workspaceRoot(home, agentId);
  const canonical = resolve(root, artifact.note.workspacePath);
  const requested = typeof body.path === "string" && body.path.trim() !== "" ? normalizeRelativePath(body.path) : null;
  let target = requested === null
    ? resolve(dirname(canonical), `${basename(canonical).replace(/\.md$/, "")}.v${artifact.revision}.md`)
    : resolve(root, requested);
  try {
    target = await canonicalToolPath(target);
    await assertFileWithin(target, root);
  } catch (error) {
    throw new FriendArtifactError(400, `导出路径越出授权工作区：${error instanceof Error ? error.message : String(error)}`);
  }
  if (target !== (requested === null ? resolve(dirname(canonical), `${basename(canonical).replace(/\.md$/, "")}.v${artifact.revision}.md`) : resolve(root, requested)))
    throw new FriendArtifactError(400, "导出路径经过符号链接或规范化后越出工作区");
  const written = await writeImmutableFile(dirname(target), basename(target), artifact.content, `export-${artifact.id.slice(-8)}`);
  await appendChatAuditEvent({
    action: "long-agent.artifact.exported",
    target: { type: "long-agent", longAgentId: agentId },
    details: { artifactId: artifact.id, revision: artifact.revision, path: written.path },
  }, home);
  return { path: written.path, relativePath: relative(root, written.path) };
}

export async function listFriendArtifacts(home: string, agentId: string, query: { from?: string; to?: string; kind?: string; state?: string } = {}) {
  await owner(home, agentId);
  const state = await readArtifactState(home, agentId);
  const artifacts = state.artifacts
    .filter((artifact) => query.from === undefined || artifact.date >= query.from)
    .filter((artifact) => query.to === undefined || artifact.date <= query.to)
    .filter((artifact) => query.kind === undefined || artifact.kind === query.kind)
    .filter((artifact) => query.state === undefined || artifact.state === query.state)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return {
    schemaVersion: 1 as const,
    longAgentId: agentId,
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      notePath: artifact.target.kind === "file" ? artifact.target.path : null,
      audience: artifact.target.kind === "social" ? artifact.target.audience : null,
    })),
    pending: artifacts.filter((artifact) => artifact.state !== "committed").length,
  };
}

/** Re-emit the durable return notice for a committed artifact; deduplicated per artifact. */
export async function notifyArtifact(home: string, agentId: string, artifactId: string): Promise<{ notified: boolean }> {
  await owner(home, agentId);
  const artifact = requireArtifact(await readArtifactState(home, agentId), artifactId);
  if (artifact.state !== "committed")
    throw new FriendArtifactError(409, "产物尚未确认完成，先补交或核查后再通知");
  const agentState = await readLongAgentState(home);
  const work = agentState.works.find((candidate) => candidate.id === artifact.workId);
  if (!work) throw new FriendArtifactError(409, "找不到该产物对应的工作，无法定位通知会话");
  const session = await openChatSession({ chatHome: home, projectId: agentId, sessionId: work.originSessionId });
  const already = session.manager.getEntries().some(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === ARTIFACT_NOTICE &&
      typeof entry.details === "object" &&
      entry.details !== null &&
      "artifactId" in entry.details &&
      entry.details.artifactId === artifact.id,
  );
  if (already) return { notified: false };
  const where = artifact.target.kind === "social"
    ? `站内动态 ${artifact.resourceId ?? ""}`
    : `笔记 ${artifact.target.path} v${artifact.revision}${artifact.note === null ? "" : `（版本文件 ${artifact.note.versionFile}）`}`;
  session.manager.appendCustomMessageEntry(
    ARTIFACT_NOTICE,
    `产物已确认完成：${artifact.kind}/${artifact.slot} → ${where}。artifactId=${artifact.id}；独立会话=${work.sessionId}。这不是用户新消息。`,
    false,
    { artifactId: artifact.id, kind: artifact.kind, slot: artifact.slot, resourceId: artifact.resourceId },
  );
  session.manager.flush();
  await appendChatAuditEvent({
    action: "long-agent.artifact.notified",
    target: { type: "long-agent", longAgentId: agentId },
    details: { artifactId: artifact.id },
  }, home);
  return { notified: true };
}

export type { ArtifactState };
