import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import {
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { openProject, resolveProjectContext } from "./projects/registry.js";
import type { ChatProjectContext } from "./projects/types.js";
import { requireActiveChatSessionFile } from "./session-state.js";
import { listActiveSessionFiles } from "./session-files.js";
import { readInactiveChatSessionState } from "./removed-session-index.js";
import { SessionLifecycleError } from "./session-errors.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "./session-operation-lock.js";
import { CHAT_WORKFLOW_AGENT_HANDOFF_CUSTOM_TYPE } from "./workflows/session-conversation.js";
import { LEGACY_PLANNING_HANDOFF_CUSTOM_TYPE } from "./workflows/planning-execution/context.js";

export interface ChatSessionInput {
  readonly projectId?: string;
  readonly cwd?: string;
  readonly chatHome?: string;
  readonly sessionId?: string;
}

export interface ChatSession {
  readonly projectId?: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly manager: SessionManager;
  readonly projectContext?: ChatProjectContext;
}

export interface ReserveChatSessionOptions {
  /** Establishes Pi-native Session lineage without copying any parent entries. */
  readonly parentSessionManager?: SessionManager;
  /** Backend-authorized parent storage, required for cross-project delegation. */
  readonly parentProjectId?: string;
}

/**
 * Allocates the durable Pi Session ID for a conversation before its first
 * Workflow starts. This is the HTTP acceptance boundary used by every Chat
 * client; Workflow steps subsequently reopen the same Session by ID.
 */
export async function reserveChatSession(
  input: ChatSessionInput,
  initialDisplayName?: string,
  options: ReserveChatSessionOptions = {},
): Promise<ChatSession> {
  if (input.sessionId !== undefined) {
    throw new Error("预创建Session时不能提供sessionId");
  }
  const session = await openChatSession(input);
  if (options.parentSessionManager !== undefined) {
    const parent = options.parentSessionManager;
    const parentFile = parent.getSessionFile();
    if (!parent.isPersisted() || parentFile === undefined) {
      throw new Error("父Session必须已经持久化才能创建Child Session");
    }
    if (options.parentProjectId !== undefined) {
      const parentProject = await resolveProjectContext(options.parentProjectId, session.projectContext!.chatHome);
      const info = await requireActiveChatSessionFile(parentProject, parent.getSessionId());
      if (resolve(info.path) !== resolve(parentFile) || parent.getCwd() !== parentProject.cwd) {
        throw new Error("父Session与已授权存储项目不一致");
      }
    } else if (resolve(parent.getCwd()) !== session.cwd
      || resolve(parent.getSessionDir()) !== resolve(session.sessionDir)) {
      throw new Error("跨Project子Session需要明确的父Project身份");
    }
    session.manager.newSession({ parentSession: parentFile });
  }
  const normalizedDisplayName = initialDisplayName?.replace(/\s+/g, " ").trim();
  if (normalizedDisplayName !== undefined && normalizedDisplayName !== "") {
    session.manager.appendSessionInfo(Array.from(normalizedDisplayName).slice(0, 50).join(""));
  }
  session.manager.flush();
  return session;
}

/** Keeps obsolete Chat-internal handoffs out of restore and compaction context. */
export function isChatAgentContextEntry(entry: SessionEntry): boolean {
  return entry.type !== "custom_message"
    || (
      entry.customType !== LEGACY_PLANNING_HANDOFF_CUSTOM_TYPE
      && entry.customType !== CHAT_WORKFLOW_AGENT_HANDOFF_CUSTOM_TYPE
    );
}

function configureChatSessionManager(manager: SessionManager): SessionManager {
  manager.setContextEntryFilter(isChatAgentContextEntry);
  return manager;
}

/**
 * Opens the Pi Session that represents a Chat conversation, or creates it for
 * the conversation's first turn. Browsers identify sessions by ID and never
 * provide a filesystem path.
 */
async function resolveChatSessionProject(input: ChatSessionInput): Promise<ChatProjectContext> {
  if (input.projectId === undefined && input.cwd === undefined) {
    throw new Error("打开Session必须提供projectId或cwd");
  }
  const projectContext = input.projectId === undefined
    ? await openProject({
        path: input.cwd as string,
        ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }),
      })
    : await resolveProjectContext(input.projectId, input.chatHome);
  const { cwd } = projectContext;
  if (input.cwd !== undefined && await realpath(resolve(input.cwd)) !== cwd) {
    throw new Error(`Project ${projectContext.projectId}与工作目录不一致`);
  }
  return projectContext;
}

/**
 * Creates or reopens a Chat Session with a CALLER-CHOSEN durable id.
 *
 * Takes the Session operation lock, so it MUST NOT be called while that lock is already held for the
 * same Project+Session (the lock is a queue and is not re-entrant): orchestration should reserve and
 * create the session first, then lock for the follow-up writes, or serialize the whole flow on its own
 * request-scoped lock. Flows whose retry identity must
 * survive a crash derive the id from their request (a topic node session is `f(topicId, requestId)`),
 * so no id mapping has to be reserved and persisted before the session file exists.
 */
export async function ensureChatSessionWithId(
  input: Omit<ChatSessionInput, "sessionId">,
  sessionId: string,
  initialDisplayName?: string,
): Promise<{ session: ChatSession; created: boolean }> {
  if (sessionId.trim() === "") throw new Error("sessionId不能为空");
  const projectContext = await resolveChatSessionProject(input);
  const { cwd, agentDir, sessionDir, projectId } = projectContext;
  const openSession = (path: string): ChatSession => ({
    projectId, projectContext, cwd, agentDir, sessionDir,
    manager: configureChatSessionManager(SessionManager.open(path, sessionDir)),
  });
  // The same lock that serializes lifecycle mutations and Workflow starts: "check -> create -> reopen"
  // must be one critical section, because Pi names the file `<timestamp>_<id>.jsonl` and two concurrent
  // creations of the same id would otherwise leave two session files behind.
  return withChatSessionOperationLock(chatSessionOperationKey(projectId, sessionId), async () => {
    const existing = (await listActiveSessionFiles(projectContext)).find((candidate) => candidate.id === sessionId);
    if (existing !== undefined) return { created: false, session: openSession(existing.path) };
    // Removal is a lifecycle state, not an absence: re-creating a removed/purged id would silently
    // resurrect a session (and a topic node that was marked `removed`). Restoring stays the only path.
    const inactive = await readInactiveChatSessionState(projectContext, sessionId);
    if (inactive === "pending")
      throw new SessionLifecycleError("SESSION_BUSY", `该Session的生命周期操作尚未完成，请稍后重试: ${sessionId}`);
    if (inactive === "removed")
      throw new SessionLifecycleError("SESSION_REMOVED", `Session已移除，不能按同一 ID 重建: ${sessionId}`);
    if (inactive === "purged")
      throw new SessionLifecycleError("SESSION_PURGED", `Session已被永久删除: ${sessionId}`);
    const manager = configureChatSessionManager(SessionManager.create(cwd, sessionDir, { id: sessionId }));
    const normalizedDisplayName = initialDisplayName?.replace(/\s+/g, " ").trim();
    if (normalizedDisplayName !== undefined && normalizedDisplayName !== "") {
      manager.appendSessionInfo(Array.from(normalizedDisplayName).slice(0, 50).join(""));
    }
    manager.flush();
    return { created: true, session: { projectId, projectContext, cwd, agentDir, sessionDir, manager } };
  });
}

export async function openChatSession(input: ChatSessionInput): Promise<ChatSession> {
  const projectContext = await resolveChatSessionProject(input);
  const { cwd, agentDir, sessionDir } = projectContext;

  if (input.sessionId === undefined) {
    return {
      projectId: projectContext.projectId,
      projectContext,
      cwd,
      agentDir,
      sessionDir,
      manager: configureChatSessionManager(SessionManager.create(cwd, sessionDir)),
    };
  }

  const sessionInfo = await requireActiveChatSessionFile(projectContext, input.sessionId);
  if (resolve(sessionInfo.cwd) !== cwd) {
    throw new Error(`Session ${input.sessionId}不属于工作目录${cwd}`);
  }

  return {
    projectId: projectContext.projectId,
    projectContext,
    cwd,
    agentDir,
    sessionDir,
    manager: configureChatSessionManager(SessionManager.open(sessionInfo.path, sessionDir)),
  };
}
