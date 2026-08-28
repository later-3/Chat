import { resolve } from "node:path";
import {
  buildContextEntries,
  buildSessionContext,
  sessionEntryToContextMessages,
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

/** Chat统一保存Pi Coding Agent运行记录的目录。浏览器不能直接访问该目录。 */
export function getChatSessionDir(): string {
  return resolve(process.cwd(), ".pi/sessions");
}

export interface ChatSessionListItem {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string;
  projectRoot: string;
  projectAvailable: true;
  projectKey: string;
  transient: false;
  sessionSource: "chat";
  readOnly: false;
}

function toListItems(infos: SessionInfo[]): ChatSessionListItem[] {
  const idByPath = new Map(infos.map((info) => [resolve(info.path), info.id]));
  return infos.map((info) => {
    const parentSessionId = info.parentSessionPath === undefined
      ? undefined
      : idByPath.get(resolve(info.parentSessionPath));
    return {
      path: info.path,
      id: info.id,
      cwd: info.cwd,
      ...(info.name === undefined ? {} : { name: info.name }),
      created: info.created.toISOString(),
      modified: info.modified.toISOString(),
      messageCount: info.messageCount,
      firstMessage: info.firstMessage,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      projectRoot: info.cwd,
      projectAvailable: true,
      projectKey: info.cwd,
      transient: false,
      sessionSource: "chat",
      readOnly: false,
    };
  });
}

/** 只枚举Chat自己的`.pi/sessions`，不会扫描用户主目录下的`~/.pi`。 */
export async function listChatSessions(): Promise<ChatSessionListItem[]> {
  return toListItems(await SessionManager.listAll(getChatSessionDir()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pi保存的ToolCall使用`id/name/arguments`，Pi Web前端使用另一组字段名。 */
export function normalizeMessageForFrontend(message: unknown): unknown {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((block) => {
      if (!isRecord(block) || block.type !== "toolCall") return block;
      return {
        type: "toolCall",
        toolCallId: typeof block.toolCallId === "string"
          ? block.toolCallId
          : (typeof block.id === "string" ? block.id : ""),
        toolName: typeof block.toolName === "string"
          ? block.toolName
          : (typeof block.name === "string" ? block.name : ""),
        input: isRecord(block.input)
          ? block.input
          : (isRecord(block.arguments) ? block.arguments : {}),
      };
    }),
  };
}

export interface SessionProjectionOptions {
  readonly deferThinking?: boolean;
  readonly deferToolResultImages?: boolean;
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;
  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), ...(mime ? { mime } : {}) };
}

function applyProjectionOptions(message: unknown, options: SessionProjectionOptions): unknown {
  if (!isRecord(message) || !Array.isArray(message.content)) return message;
  if (options.deferThinking && message.role === "assistant") {
    return {
      ...message,
      content: message.content.map((block) => (
        isRecord(block) && block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== ""
          ? { ...block, thinking: "", deferred: true }
          : block
      )),
    };
  }
  if (!options.deferToolResultImages || message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;
  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  return {
    ...message,
    content: [...content, {
      type: "text",
      text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
    }],
  };
}

/** 使用Pi自己的分支与压缩选择逻辑，同时生成与消息一一对应的前端节点ID。 */
export function projectSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: SessionProjectionOptions = {},
) {
  const contextEntries = buildContextEntries(entries, leafId);
  const context = buildSessionContext(entries, leafId);
  const messages: unknown[] = [];
  const entryIds: string[] = [];
  for (const entry of contextEntries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      messages.push(applyProjectionOptions(normalizeMessageForFrontend(message), options));
      entryIds.push(entry.id);
    }
  }
  return {
    messages,
    entryIds,
    thinkingLevel: context.thinkingLevel,
    model: context.model,
  };
}

async function findChatSession(sessionId: string): Promise<ChatSessionListItem> {
  const session = (await listChatSessions()).find((item) => item.id === sessionId);
  if (session === undefined) throw new Error(`找不到Session: ${sessionId}`);
  return session;
}

export async function readChatSession(
  sessionId: string,
  leafId?: string | null,
  options: SessionProjectionOptions = {},
) {
  const info = await findChatSession(sessionId);
  const manager = SessionManager.open(info.path, getChatSessionDir());
  const entries = manager.getEntries();
  if (leafId && manager.getEntry(leafId) === undefined) {
    throw new Error(`找不到Session节点: ${leafId}`);
  }

  const selectedLeafId = leafId === undefined ? manager.getLeafId() : leafId;
  const context = projectSessionContext(entries, selectedLeafId, options);

  return {
    sessionId: manager.getSessionId(),
    filePath: info.path,
    totalActiveMs: 0,
    tree: manager.getTree(),
    leafId: selectedLeafId ?? null,
    context: {
      messages: context.messages,
      entryIds: context.entryIds,
      thinkingLevel: context.thinkingLevel,
      model: context.model,
    },
  };
}
