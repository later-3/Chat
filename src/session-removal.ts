import { rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { appendChatAuditEvent } from "./audit-log.js";
import { resolveChatConfig } from "./chat-config.js";
import { listProjects, resolveProjectContext } from "./projects/registry.js";
import type { ChatProjectContext } from "./projects/types.js";
import {
  activeSessionRecordPath,
  completeRemovedSessionIndex,
  prepareRemovedSessionIndexOperation,
  readRecoveredRemovedSessionIndex,
  removedSessionPathExists,
  removedSessionRecordPath,
  type RemovedSessionRecord,
  withRemovedSessionIndexMutation,
  writeRemovedSessionIndex,
} from "./removed-session-index.js";
import { assertChatSessionIsIdle } from "./session-activity.js";
import { SessionLifecycleError } from "./session-errors.js";
import {
  chatSessionOperationKey,
  withChatSessionOperationLock,
} from "./session-operation-lock.js";
import { firstSessionUtterance, listActiveSessionFiles } from "./session-files.js";

export type { RemovedSessionRecord } from "./removed-session-index.js";

export interface RemovedSessionListItem extends Omit<RemovedSessionRecord, "fileName"> {
  readonly projectId: string;
}

function publicRecord(projectId: string, record: RemovedSessionRecord): RemovedSessionListItem {
  const { fileName: _fileName, ...item } = record;
  return { ...item, projectId };
}

function recordFromSession(
  session: SessionInfo,
  activeSessions: readonly SessionInfo[],
  removedAt: Date,
  retentionDays: number,
): RemovedSessionRecord {
  const path = resolve(session.path);
  const fileName = basename(path);
  const parentSessionId = session.parentSessionPath === undefined
    ? undefined
    : activeSessions.find((candidate) => (
        resolve(candidate.path) === resolve(session.parentSessionPath as string)
      ))?.id;
  return {
    id: session.id,
    fileName,
    cwd: session.cwd,
    ...(session.name === undefined ? {} : { name: session.name }),
    created: session.created.toISOString(),
    modified: session.modified.toISOString(),
    messageCount: session.messageCount,
    firstMessage: firstSessionUtterance(session),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    removedAt: removedAt.toISOString(),
    purgeAt: new Date(removedAt.getTime() + retentionDays * 86_400_000).toISOString(),
  };
}

async function purgeExpiredRecords(
  projectId: string,
  project: ChatProjectContext,
  now: Date,
): Promise<void> {
  let index = await readRecoveredRemovedSessionIndex(project);
  const expired = Object.values(index.sessions).filter((record) => Date.parse(record.purgeAt) <= now.getTime());
  for (const record of expired) {
    const prepared = prepareRemovedSessionIndexOperation(index, "purge", record, now);
    await writeRemovedSessionIndex(project, prepared);
    const source = removedSessionRecordPath(project, record);
    if (await removedSessionPathExists(source)) await unlink(source);
    const sessions = { ...prepared.sessions };
    delete sessions[record.id];
    const completed = completeRemovedSessionIndex(prepared, sessions, {
      ...prepared.tombstones,
      [record.id]: { id: record.id, purgedAt: now.toISOString() },
    });
    await writeRemovedSessionIndex(project, completed);
    index = completed;
    await appendChatAuditEvent({
      action: "session.purge",
      target: { type: "session", projectId, sessionId: record.id },
      details: { automatic: true, removedAt: record.removedAt },
    }, project.chatHome);
  }
}

export async function listRemovedChatSessions(
  projectId: string,
  chatHome?: string,
  now = new Date(),
): Promise<{ readonly sessions: RemovedSessionListItem[]; readonly retentionDays: number }> {
  const project = await resolveProjectContext(projectId, chatHome);
  const retentionDays = (await resolveChatConfig(projectId, chatHome)).effective.sessions.removedRetentionDays;
  return withRemovedSessionIndexMutation(project, async () => {
    await purgeExpiredRecords(projectId, project, now);
    const index = await readRecoveredRemovedSessionIndex(project);
    return {
      sessions: Object.values(index.sessions)
        .sort((left, right) => right.removedAt.localeCompare(left.removedAt))
        .map((record) => publicRecord(projectId, record)),
      retentionDays,
    };
  });
}

/** Applies retention on startup without making an unavailable Project block Chat. */
export async function purgeExpiredRemovedSessionsAcrossProjects(chatHome?: string, now = new Date()): Promise<void> {
  const projects = await listProjects(chatHome);
  await Promise.all(projects.filter((project) => project.available).map(async (project) => {
    try {
      await listRemovedChatSessions(project.projectId, chatHome, now);
    } catch (error) {
      console.error(
        `Project ${project.projectId}清理过期Session失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }));
}

export async function removeChatSession(
  projectId: string,
  sessionId: string,
  chatHome?: string,
  now = new Date(),
): Promise<RemovedSessionListItem> {
  const project = await resolveProjectContext(projectId, chatHome);
  return withChatSessionOperationLock(chatSessionOperationKey(projectId, sessionId), async () => (
    withRemovedSessionIndexMutation(project, async () => {
      const index = await readRecoveredRemovedSessionIndex(project);
      const existing = index.sessions[sessionId];
      if (existing !== undefined) return publicRecord(projectId, existing);
      if (index.tombstones[sessionId] !== undefined) {
        throw new SessionLifecycleError("SESSION_PURGED", `Session已被永久删除: ${sessionId}`);
      }
      const activeSessions = await listActiveSessionFiles(project);
      const session = activeSessions.find((candidate) => candidate.id === sessionId);
      if (session === undefined) {
        throw new SessionLifecycleError("SESSION_NOT_FOUND", `找不到Session: ${sessionId}`);
      }
      if (dirname(resolve(session.path)) !== resolve(project.sessionDir)) {
        throw new SessionLifecycleError("SESSION_STORAGE_CONFLICT", "Session文件不在Project正常Session目录");
      }
      await assertChatSessionIsIdle(project, sessionId);
      const retentionDays = (await resolveChatConfig(projectId, chatHome)).effective.sessions.removedRetentionDays;
      const record = recordFromSession(session, activeSessions, now, retentionDays);
      const target = removedSessionRecordPath(project, record);
      if (await removedSessionPathExists(target)) {
        throw new SessionLifecycleError("SESSION_STORAGE_CONFLICT", `移除区已存在Session文件: ${record.fileName}`);
      }
      const prepared = prepareRemovedSessionIndexOperation(index, "remove", record, now);
      await writeRemovedSessionIndex(project, prepared);
      await rename(session.path, target);
      const completed = completeRemovedSessionIndex(prepared, {
        ...prepared.sessions,
        [record.id]: record,
      }, Object.fromEntries(Object.entries(prepared.tombstones).filter(([id]) => id !== record.id)));
      await writeRemovedSessionIndex(project, completed);
      await appendChatAuditEvent({
        action: "session.remove",
        target: { type: "session", projectId, sessionId },
        details: { removedAt: record.removedAt, purgeAt: record.purgeAt },
      }, project.chatHome);
      return publicRecord(projectId, record);
    })
  ));
}

export async function restoreRemovedChatSession(
  projectId: string,
  sessionId: string,
  chatHome?: string,
  now = new Date(),
): Promise<{ readonly sessionId: string; readonly state: "active" }> {
  const project = await resolveProjectContext(projectId, chatHome);
  return withChatSessionOperationLock(chatSessionOperationKey(projectId, sessionId), async () => (
    withRemovedSessionIndexMutation(project, async () => {
      const index = await readRecoveredRemovedSessionIndex(project);
      const record = index.sessions[sessionId];
      if (record === undefined) {
        if (index.tombstones[sessionId] !== undefined) {
          throw new SessionLifecycleError("SESSION_PURGED", `Session已被永久删除: ${sessionId}`);
        }
        throw new SessionLifecycleError("SESSION_NOT_FOUND", `移除区中找不到Session: ${sessionId}`);
      }
      const target = activeSessionRecordPath(project, record);
      if (await removedSessionPathExists(target)) {
        throw new SessionLifecycleError("SESSION_STORAGE_CONFLICT", `正常目录已存在同名Session文件: ${record.fileName}`);
      }
      const prepared = prepareRemovedSessionIndexOperation(index, "restore", record, now);
      await writeRemovedSessionIndex(project, prepared);
      await rename(removedSessionRecordPath(project, record), target);
      const sessions = { ...prepared.sessions };
      delete sessions[sessionId];
      await writeRemovedSessionIndex(project, completeRemovedSessionIndex(prepared, sessions));
      await appendChatAuditEvent({
        action: "session.restore",
        target: { type: "session", projectId, sessionId },
        details: { restoredAt: now.toISOString() },
      }, project.chatHome);
      return { sessionId, state: "active" };
    })
  ));
}

export async function purgeRemovedChatSession(
  projectId: string,
  sessionId: string,
  chatHome?: string,
  now = new Date(),
): Promise<{ readonly sessionId: string; readonly state: "purged"; readonly purgedAt: string }> {
  const project = await resolveProjectContext(projectId, chatHome);
  return withChatSessionOperationLock(chatSessionOperationKey(projectId, sessionId), async () => (
    withRemovedSessionIndexMutation(project, async () => {
      const index = await readRecoveredRemovedSessionIndex(project);
      const tombstone = index.tombstones[sessionId];
      if (tombstone !== undefined) return { sessionId, state: "purged", purgedAt: tombstone.purgedAt };
      const record = index.sessions[sessionId];
      if (record === undefined) {
        throw new SessionLifecycleError("SESSION_NOT_FOUND", `移除区中找不到Session: ${sessionId}`);
      }
      const prepared = prepareRemovedSessionIndexOperation(index, "purge", record, now);
      await writeRemovedSessionIndex(project, prepared);
      const source = removedSessionRecordPath(project, record);
      if (await removedSessionPathExists(source)) await unlink(source);
      const sessions = { ...prepared.sessions };
      delete sessions[sessionId];
      const purgedAt = now.toISOString();
      await writeRemovedSessionIndex(project, completeRemovedSessionIndex(prepared, sessions, {
        ...prepared.tombstones,
        [sessionId]: { id: sessionId, purgedAt },
      }));
      await appendChatAuditEvent({
        action: "session.purge",
        target: { type: "session", projectId, sessionId },
        details: { automatic: false, purgedAt },
      }, project.chatHome);
      return { sessionId, state: "purged", purgedAt };
    })
  ));
}
