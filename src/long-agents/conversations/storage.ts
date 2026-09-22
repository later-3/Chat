import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureChatHome } from "../../chat-home.js";
import { ensureProjectDataLayout, readProjectRegistry } from "../../projects/registry.js";
import { assertFileWithin, atomicWriteJson, withFileLock } from "../../persistence/versioned-file.js";
import { ConversationError, parseConversation, type Conversation } from "./contract.js";

export interface ConversationState {
  schemaVersion: 1;
  conversations: Conversation[];
}

export function conversationFile(projectDataDir: string): string {
  return resolve(projectDataDir, "conversations.json");
}

/** Conversations belong to their fixed storage Project; the registry lives beside that Project's sessions. */
export async function conversationStorageFile(chatHome: string, storageProjectId: string): Promise<string> {
  const layout = await ensureProjectDataLayout(storageProjectId, chatHome);
  return conversationFile(layout.projectDataDir);
}

async function readConversationStateFile(file: string, storageProjectId: string): Promise<ConversationState> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, conversations: [] };
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConversationError(500, "会话存储格式无效");
  const body = value as Record<string, unknown>;
  if (body.schemaVersion !== 1 || !Array.isArray(body.conversations)) throw new ConversationError(500, "会话存储格式无效");
  const conversations = body.conversations.map(parseConversation);
  if (conversations.some((conversation) => conversation.storageProjectId !== storageProjectId))
    throw new ConversationError(500, "会话存储归属冲突");
  if (new Set(conversations.map((conversation) => conversation.id)).size !== conversations.length)
    throw new ConversationError(500, "会话存储包含重复身份");
  return { schemaVersion: 1, conversations };
}

export async function readConversationState(chatHome: string, storageProjectId: string): Promise<ConversationState> {
  const file = await conversationStorageFile(chatHome, storageProjectId);
  await assertFileWithin(file, chatHome);
  return readConversationStateFile(file, storageProjectId);
}

/**
 * Locate a conversation by its stable id, without trusting a client-supplied Project scope. The
 * registry is scanned server-side; the found record's own `storageProjectId` is what the caller must
 * use for every later read. Corrupt or unreadable unrelated Projects are skipped, not fatal.
 */
export async function findConversation(
  chatHome: string,
  conversationId: string,
): Promise<{ conversation: Conversation; storageProjectId: string }> {
  const home = await ensureChatHome(chatHome);
  const registry = await readProjectRegistry(home.root);
  for (const entry of registry.projects) {
    // Agent homes keep their own layout; a conversation's storage Project is always a user/share Project.
    if ((entry.kind ?? "project") === "agent") continue;
    const file = resolve(home.projectsDir, entry.projectId, "conversations.json");
    let state: ConversationState;
    try {
      state = await readConversationStateFile(file, entry.projectId);
    } catch {
      continue;
    }
    const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
    if (conversation !== undefined) return { conversation, storageProjectId: entry.projectId };
  }
  throw new ConversationError(404, "找不到该群");
}

/** Every conversation across the registered storage Projects, without a member filter. */
export async function listAllConversations(
  chatHome: string,
): Promise<{ conversation: Conversation; storageProjectId: string }[]> {
  const home = await ensureChatHome(chatHome);
  const registry = await readProjectRegistry(home.root);
  const found: { conversation: Conversation; storageProjectId: string }[] = [];
  for (const entry of registry.projects) {
    if ((entry.kind ?? "project") === "agent") continue;
    const file = resolve(home.projectsDir, entry.projectId, "conversations.json");
    try {
      const state = await readConversationStateFile(file, entry.projectId);
      for (const conversation of state.conversations) found.push({ conversation, storageProjectId: entry.projectId });
    } catch {
      continue;
    }
  }
  return found;
}

/** Every conversation a Friend is (or was) a member of, across the registered storage Projects. */
export async function listConversationsForMember(
  chatHome: string,
  longAgentId: string,
): Promise<{ conversation: Conversation; storageProjectId: string }[]> {
  const home = await ensureChatHome(chatHome);
  const registry = await readProjectRegistry(home.root);
  const found: { conversation: Conversation; storageProjectId: string }[] = [];
  for (const entry of registry.projects) {
    if ((entry.kind ?? "project") === "agent") continue;
    const file = resolve(home.projectsDir, entry.projectId, "conversations.json");
    let state: ConversationState;
    try {
      state = await readConversationStateFile(file, entry.projectId);
    } catch {
      continue;
    }
    for (const conversation of state.conversations) {
      if (conversation.members.some((member) => member.longAgentId === longAgentId))
        found.push({ conversation, storageProjectId: entry.projectId });
    }
  }
  return found;
}

export async function changeConversationState<T>(
  chatHome: string,
  storageProjectId: string,
  change: (state: ConversationState) => T | Promise<T>,
): Promise<T> {
  const file = await conversationStorageFile(chatHome, storageProjectId);
  return withFileLock(file, async () => {
    const state = await readConversationState(chatHome, storageProjectId);
    const result = await change(state);
    await atomicWriteJson(file, state);
    return result;
  });
}

export function requireConversation(state: ConversationState, conversationId: string): Conversation {
  const conversation = state.conversations.find((candidate) => candidate.id === conversationId);
  if (conversation === undefined) throw new ConversationError(404, "找不到该群");
  return conversation;
}
