import { resolve } from "node:path";
import {
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ensureChatDataLayout, getChatDataPaths } from "./chat-data.js";
import { LEGACY_PLANNING_HANDOFF_CUSTOM_TYPE } from "./workflows/planning-execution/context.js";
import { collectChatWorkflowStageMarkers } from "./workflows/workflow-stage.js";

export interface ChatSessionInput {
  readonly cwd: string;
  readonly sessionId?: string;
}

export interface ChatSession {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly manager: SessionManager;
}

export function getChatAgentDir(): string {
  return getChatDataPaths().agentDir;
}

export function getChatSessionDir(): string {
  return getChatDataPaths().sessionDir;
}

/** Keeps obsolete Chat-internal handoffs out of restore and compaction context. */
export function isChatAgentContextEntry(entry: SessionEntry): boolean {
  return entry.type !== "custom_message"
    || entry.customType !== LEGACY_PLANNING_HANDOFF_CUSTOM_TYPE;
}

function configureChatSessionManager(manager: SessionManager): SessionManager {
  const stageByEntryId = new Map(
    collectChatWorkflowStageMarkers(manager.getBranch())
      .map((stage) => [stage.entryId, stage]),
  );
  const legacyPlannerMessageIds = new Set<string>();
  let activeAgentId: string | undefined;
  for (const entry of manager.getBranch()) {
    const stage = stageByEntryId.get(entry.id);
    if (stage !== undefined) {
      activeAgentId = stage.agentId;
    } else if (
      activeAgentId === "planner"
      && entry.type === "message"
      && entry.message.role === "assistant"
    ) {
      legacyPlannerMessageIds.add(entry.id);
    }
  }
  manager.setContextEntryFilter((entry) => (
    isChatAgentContextEntry(entry) && !legacyPlannerMessageIds.has(entry.id)
  ));
  return manager;
}

/**
 * Opens the Pi Session that represents a Chat conversation, or creates it for
 * the conversation's first turn. Browsers identify sessions by ID and never
 * provide a filesystem path.
 */
export async function openChatSession(input: ChatSessionInput): Promise<ChatSession> {
  const cwd = resolve(input.cwd);
  const { agentDir, sessionDir } = await ensureChatDataLayout();

  if (input.sessionId === undefined) {
    return {
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

  return {
    cwd,
    agentDir,
    sessionDir,
    manager: configureChatSessionManager(SessionManager.open(sessionInfo.path, sessionDir)),
  };
}
