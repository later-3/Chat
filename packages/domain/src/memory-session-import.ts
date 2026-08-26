import { hashCanonical, sha256Hex } from "./canonical-hash.js";

export const MEMORY_SESSION_CONVERSION_VERSION = "conversation-turns.v1" as const;
export const MAX_MEMORY_SESSION_IMPORT_ITEMS = 200;

export interface NormalizedMemorySessionMessage {
  readonly sourceMessageKey: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface NormalizedMemorySessionSnapshot {
  readonly sourceKind: "chat" | "codex";
  readonly sourceSessionId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messages: readonly NormalizedMemorySessionMessage[];
}

export interface ConvertedMemorySessionItem {
  readonly sourceItemKey: string;
  readonly sourceItemSha256: string;
  readonly title: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly sourceTurnKey: string;
}

export class MemorySessionConversionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MemorySessionConversionError";
    this.code = code;
  }
}

function visibleText(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

export function computeMemorySessionSnapshotSha256(
  snapshot: NormalizedMemorySessionSnapshot,
): string {
  return hashCanonical("memory-session-source-snapshot.v1", {
    sourceKind: snapshot.sourceKind,
    sourceSessionId: snapshot.sourceSessionId,
    title: snapshot.title,
    updatedAt: snapshot.updatedAt,
    messages: snapshot.messages.map((message) => ({
      sourceMessageKey: message.sourceMessageKey,
      role: message.role,
      text: visibleText(message.text),
      createdAt: message.createdAt,
    })),
  });
}

function boundedTitle(turnNumber: number, userText: string): string {
  const firstLine =
    userText
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "对话";
  const prefix = `第 ${String(turnNumber)} 轮 · `;
  return `${prefix}${firstLine}`.slice(0, 200);
}

function safeChunk(value: string, maxCharacters: number): readonly string[] {
  if (value.length <= maxCharacters) return [value];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(offset + maxCharacters, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "")) end -= 1;
    if (end <= offset) end = Math.min(offset + maxCharacters, value.length);
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function turnContent(userText: string, assistantTexts: readonly string[]): string {
  const sections = [`用户：\n${userText}`];
  if (assistantTexts.length > 0) sections.push(`助手：\n${assistantTexts.join("\n\n")}`);
  return sections.join("\n\n");
}

/** 只采用用户与助手可见正文；Developer、Tool、Reasoning和隐藏内容不进入Memory。 */
export function convertMemorySessionToItems(input: {
  readonly snapshot: NormalizedMemorySessionSnapshot;
  readonly maxContentCharacters: number;
}): readonly ConvertedMemorySessionItem[] {
  if (
    !Number.isInteger(input.maxContentCharacters) ||
    input.maxContentCharacters < 128 ||
    input.maxContentCharacters > 50_000
  ) {
    throw new MemorySessionConversionError(
      "memory.session_import.provider_limit_invalid",
      "Memory Provider写入长度合同无效",
    );
  }
  const normalized = input.snapshot.messages
    .map((message) => ({ ...message, text: visibleText(message.text) }))
    .filter((message) => /[^\p{C}\s]/u.test(message.text));
  const turns: Array<{
    user: (typeof normalized)[number];
    assistants: Array<(typeof normalized)[number]>;
  }> = [];
  for (const message of normalized) {
    if (message.role === "user") {
      turns.push({ user: message, assistants: [] });
      continue;
    }
    turns.at(-1)?.assistants.push(message);
  }
  const items: ConvertedMemorySessionItem[] = [];
  for (const [turnIndex, turn] of turns.entries()) {
    const content = turnContent(
      turn.user.text,
      turn.assistants.map((message) => message.text),
    );
    const chunks = safeChunk(content, input.maxContentCharacters);
    for (const [partIndex, chunk] of chunks.entries()) {
      const baseKey = turn.user.sourceMessageKey;
      const sourceItemKey =
        chunks.length === 1 ? baseKey : `${baseKey}:part:${String(partIndex + 1)}`;
      if (sourceItemKey.length > 200) {
        throw new MemorySessionConversionError(
          "memory.session_import.source_key_too_long",
          "Session消息身份超过导入合同上限",
        );
      }
      const titleBase = boundedTitle(turnIndex + 1, turn.user.text);
      const title =
        chunks.length === 1
          ? titleBase
          : `${titleBase.slice(0, 180)}（${String(partIndex + 1)}/${String(chunks.length)}）`;
      const sourceItemSha256 = hashCanonical("memory-session-import-item.v1", {
        sourceKind: input.snapshot.sourceKind,
        sourceSessionId: input.snapshot.sourceSessionId,
        sourceItemKey,
        messages: [turn.user, ...turn.assistants].map((message) => ({
          sourceMessageKey: message.sourceMessageKey,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
        partIndex,
        content: chunk,
      });
      items.push({
        sourceItemKey,
        sourceItemSha256,
        title,
        content: chunk,
        contentSha256: sha256Hex(chunk),
        sourceTurnKey: sourceItemKey,
      });
      if (items.length > MAX_MEMORY_SESSION_IMPORT_ITEMS) {
        throw new MemorySessionConversionError(
          "memory.session_import.too_many_items",
          `单次Session导入最多${String(MAX_MEMORY_SESSION_IMPORT_ITEMS)}项`,
        );
      }
    }
  }
  return items;
}
