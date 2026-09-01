import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import {
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { openProject, resolveProjectContext } from "./projects/registry.js";
import type { ChatProjectContext } from "./projects/types.js";
import { migrateSessionNativeMessagesV1 } from "./migrations/session-native-messages-v1.js";
import { CHAT_WORKFLOW_AGENT_HANDOFF_CUSTOM_TYPE } from "./workflows/session-conversation.js";
import { LEGACY_PLANNING_HANDOFF_CUSTOM_TYPE } from "./workflows/planning-execution/context.js";
import { findActivePlanningExecutionRun } from "./workflows/planning-execution/review-state.js";

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

/**
 * Allocates the durable Pi Session ID for a conversation before its first
 * Workflow starts. This is the HTTP acceptance boundary used by every Chat
 * client; Workflow steps subsequently reopen the same Session by ID.
 */
export async function reserveChatSession(input: ChatSessionInput): Promise<ChatSession> {
  if (input.sessionId !== undefined) {
    throw new Error("预创建Session时不能提供sessionId");
  }
  const session = await openChatSession(input);
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
export async function openChatSession(input: ChatSessionInput): Promise<ChatSession> {
  if (input.projectId === undefined && input.cwd === undefined) {
    throw new Error("打开Session必须提供projectId或cwd");
  }
  const projectContext = input.projectId === undefined
    ? await openProject({
        path: input.cwd as string,
        ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }),
      })
    : await resolveProjectContext(input.projectId, input.chatHome);
  const { cwd, agentDir, sessionDir } = projectContext;
  if (input.cwd !== undefined && await realpath(resolve(input.cwd)) !== cwd) {
    throw new Error(`Project ${projectContext.projectId}与工作目录不一致`);
  }

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

  const sessionInfo = (await SessionManager.listAll(sessionDir))
    .find((candidate) => candidate.id === input.sessionId);
  if (sessionInfo === undefined) throw new Error(`找不到Session: ${input.sessionId}`);
  if (resolve(sessionInfo.cwd) !== cwd) {
    throw new Error(`Session ${input.sessionId}不属于工作目录${cwd}`);
  }
  if (await findActivePlanningExecutionRun(projectContext.projectDataDir, input.sessionId) === undefined) {
    await migrateSessionNativeMessagesV1({
      sessionFile: sessionInfo.path,
      projectDataDir: projectContext.projectDataDir,
    });
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
