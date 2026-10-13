/**
 * 上下文编辑层（pi-004 B5）：发给模型的内容 = 一串可编辑的文字块。
 *
 * 一个机制管所有块（用户 E-1）：
 *   excluded: 勾选/取消（发送 / 不发送）——不再发给模型
 *   modified: 修改现有一条的文字（一期结构预留，按 D-5 顺序实现）
 *   added:    手写新增一条（一期结构预留，按 D-5 顺序实现）
 *
 * 存储：会话追加条目 `chat.context-edit`（覆盖式快照——最后一条即有效集；原记录零改写 E-6）。
 *       revision = 会话内该类型条目数（读写同源、单调）；expectedRevision 不符 → 409。
 * 生效：写入即冻结、下一轮生效（02 冻结合同）。
 * 应用（两个位置，见 knowledge/pi-sdk-request-chain.md）：
 *   ① 历史消息 → SessionManager.setContextEntryFilter（条目不进入上下文，压缩也算不到）
 *   ② system 区块 / 工具 → providerRequestGate（= Pi onPayload，返回值即发送内容）
 *
 * blockId 规范：
 *   tag:<chat_xxx>       system 区块整块
 *   tag:<tag>#<子标识>    区块内子条目（二期，见设计 §7 D-5）
 *   entry:<entryId>      历史消息条目
 *   tools:<工具名>        工具定义
 */
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveOwnedSessionProject } from "./session-location.js";
import { requireActiveChatSessionFile } from "./session-state.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "./session-operation-lock.js";

export const CONTEXT_EDIT_CUSTOM_TYPE = "chat.context-edit";

export interface ContextEditLayer {
  /** 不再发送的块（按 blockId）。 */
  readonly excluded: readonly string[];
  /** 修改后发送的文字（blockId → 新文字）。 */
  readonly modified: Readonly<Record<string, string>>;
  /** 手写新增的条目（组标识 → 文字列表）。 */
  readonly added: Readonly<Record<string, readonly string[]>>;
  /** 会话内该类型条目数（单调）。 */
  readonly revision: number;
}

export const EMPTY_CONTEXT_EDIT: ContextEditLayer = { excluded: [], modified: {}, added: {}, revision: 0 };

export function tagBlockId(tag: string): string { return `tag:${tag}`; }
export function tagSubBlockId(tag: string, sub: string): string { return `tag:${tag}#${sub}`; }
export function entryBlockId(entryId: string): string { return `entry:${entryId}`; }
export function toolBlockId(name: string): string { return `tools:${name}`; }

const ENTRY_PREFIX = "entry:";

/** 会话内该类型的当前编辑层（最后一条即有效集；无条目 = 空层）。 */
export function readContextEditFromEntries(
  entries: readonly { readonly type: string; readonly customType?: unknown; readonly data?: unknown }[],
): ContextEditLayer {
  let revision = 0;
  let result: ContextEditLayer | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === CONTEXT_EDIT_CUSTOM_TYPE) {
      revision += 1;
      result = normalizeContextEdit(entry.data, revision);
    }
  }
  return result ?? EMPTY_CONTEXT_EDIT;
}

function normalizeContextEdit(data: unknown, revision: number): ContextEditLayer {
  const record = (data ?? {}) as { excluded?: unknown; modified?: unknown; added?: unknown };
  const excluded = Array.isArray(record.excluded)
    ? record.excluded.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const modified: Record<string, string> = {};
  if (record.modified !== null && typeof record.modified === "object") {
    for (const [key, value] of Object.entries(record.modified as Record<string, unknown>)) {
      if (typeof value === "string") modified[key] = value;
    }
  }
  const added: Record<string, string[]> = {};
  if (record.added !== null && typeof record.added === "object") {
    for (const [key, value] of Object.entries(record.added as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
        if (items.length > 0) added[key] = items;
      }
    }
  }
  return { excluded: [...new Set(excluded)], modified, added, revision };
}

export function isContextEditEmpty(layer: ContextEditLayer): boolean {
  return layer.excluded.length === 0
    && Object.keys(layer.modified).length === 0
    && Object.values(layer.added).every((items) => items.length === 0);
}

export async function readContextEditBySessionFile(sessionFile: string): Promise<ContextEditLayer> {
  const manager = SessionManager.open(sessionFile, dirname(sessionFile));
  return readContextEditFromEntries(manager.getEntries());
}

export class ContextEditConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "ContextEditConflictError";
  }
}

/**
 * 写编辑层。约定与完整记录开关一致：revision = 会话内该类型条目数；expectedRevision 不符 → 409。
 * **不 assert idle**——从下一轮生效是产品语义（02 §2.1），允许活动会话编辑。
 */
export async function setSessionContextEdit(input: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly excluded: readonly string[];
  readonly modified: Readonly<Record<string, string>>;
  readonly added: Readonly<Record<string, readonly string[]>>;
  readonly expectedRevision: number;
  readonly chatHome?: string;
}): Promise<ContextEditLayer> {
  await resolveOwnedSessionProject(input.projectId, input.sessionId, input.chatHome);
  return await withChatSessionOperationLock(chatSessionOperationKey(input.projectId, input.sessionId), async () => {
    const project = await resolveOwnedSessionProject(input.projectId, input.sessionId, input.chatHome);
    const info = await requireActiveChatSessionFile(project, input.sessionId);
    const manager = SessionManager.open(info.path, project.sessionDir);
    const current = readContextEditFromEntries(manager.getEntries());
    if (current.revision !== input.expectedRevision) {
      throw new ContextEditConflictError(`编辑层已被修改（当前 revision ${current.revision}），请重新读取`);
    }
    const next = normalizeContextEdit(
      { excluded: input.excluded, modified: input.modified, added: input.added },
      current.revision + 1,
    );
    manager.appendCustomEntry(CONTEXT_EDIT_CUSTOM_TYPE, {
      schemaVersion: 1,
      excluded: next.excluded,
      modified: next.modified,
      added: next.added,
      revision: next.revision,
    });
    manager.flush();
    return next;
  });
}

// ---------------------------------------------------------------------------
// system prompt 的无损切分（原文片段可逐字重组——重组必须等于原文）
// ---------------------------------------------------------------------------

export interface SystemSegment {
  readonly kind: "text" | "block";
  /** block 片段的标签名（任意 XML 样式标签；排除时按 blockId 匹配）。 */
  readonly tag?: string;
  /** block 片段标签内的原文（不含标签本身）。 */
  readonly text: string;
  /** 原文片段（无损重组用）。 */
  readonly raw: string;
}

/**
 * 按标签把 system 文本切成片段序列；未闭合标签按文本处理。
 * `segments.map(s => s.raw).join("")` 必须逐字等于输入（由单测保证）。
 */
export function splitSystemSegments(systemContent: string): readonly SystemSegment[] {
  const segments: SystemSegment[] = [];
  const pattern = /<([a-zA-Z_][a-zA-Z0-9_.:-]*)([^>]*)>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(systemContent)) !== null) {
    const tag = match[1] as string;
    // 只把 chat_ 区块当可编辑块：system 里还有 Pi 自身的标签（agent/name/project/skill…，
    // 真实 payload 实测），它们属于文本片段，不参与编辑（避免误伤与碎片化）。
    if (!tag.startsWith("chat_")) continue;
    const closeTag = `</${tag}>`;
    const contentStart = match.index + match[0].length;
    const contentEnd = systemContent.indexOf(closeTag, contentStart);
    if (contentEnd === -1) break;
    if (match.index > cursor) {
      const text = systemContent.slice(cursor, match.index);
      segments.push({ kind: "text", text, raw: text });
    }
    const raw = systemContent.slice(match.index, contentEnd + closeTag.length);
    segments.push({ kind: "block", tag, text: systemContent.slice(contentStart, contentEnd), raw });
    cursor = contentEnd + closeTag.length;
    pattern.lastIndex = cursor;
  }
  if (cursor < systemContent.length) {
    const tail = systemContent.slice(cursor);
    segments.push({ kind: "text", text: tail, raw: tail });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// 应用（gate 处；一期：excluded 的 system 区块与工具）
// ---------------------------------------------------------------------------

export interface ApplyContextEditResult {
  readonly payload: unknown;
  /** 本轮实际排除的块数（system 块 + 工具 + 已声明的消息条目）。 */
  readonly excludedCount: number;
  /** 命中的 blockId（诊断用）。 */
  readonly excludedIds: readonly string[];
}

export function applyContextEdit(payload: unknown, api: string | undefined, layer: ContextEditLayer): ApplyContextEditResult {
  if (isContextEditEmpty(layer) || payload === null || typeof payload !== "object") {
    return { payload, excludedCount: 0, excludedIds: [] };
  }
  const excluded = new Set(layer.excluded);
  const hit: string[] = [];
  const root = payload as Record<string, unknown>;
  const next: Record<string, unknown> = { ...root };

  const applyText = (text: string): string => {
    const segments = splitSystemSegments(text);
    const kept: string[] = [];
    for (const segment of segments) {
      if (segment.kind !== "block" || segment.tag === undefined) {
        kept.push(segment.raw);
        continue;
      }
      const blockId = tagBlockId(segment.tag);
      if (excluded.has(blockId)) {
        hit.push(blockId);
        continue;
      }
      const modified = layer.modified[blockId];
      if (modified !== undefined) {
        const open = segment.raw.slice(0, segment.raw.length - segment.text.length - `</${segment.tag}>`.length);
        kept.push(`${open}${modified}</${segment.tag}>`);
        continue;
      }
      kept.push(segment.raw);
    }
    return kept.join("");
  };

  const editContent = (content: unknown): unknown => {
    if (typeof content === "string") return content.length === 0 ? content : applyText(content);
    if (Array.isArray(content)) {
      let touched = false;
      const parts = content.map((part) => {
        if (part !== null && typeof part === "object") {
          const record = part as { type?: unknown; text?: unknown };
          if (record.type === "text" && typeof record.text === "string") {
            const edited = applyText(record.text);
            if (edited !== record.text) { touched = true; return { ...(part as object), text: edited }; }
          }
        }
        return part;
      });
      return touched ? parts : content;
    }
    return content;
  };

  const messages = root.messages;
  if (Array.isArray(messages)) {
    let touched = false;
    const nextMessages = messages.map((message) => {
      if (message === null || typeof message !== "object") return message;
      const record = message as Record<string, unknown>;
      const isSystemMessage = record.role === "system" || (api === "openai-completions" && record.role === "developer");
      if (!isSystemMessage) return message;
      const edited = editContent(record.content);
      if (edited !== record.content) { touched = true; return { ...record, content: edited }; }
      return message;
    });
    if (touched) next.messages = nextMessages;
  }
  if (root.system !== undefined) {
    const edited = editContent(root.system);
    if (edited !== root.system) next.system = edited;
  }

  const tools = root.tools;
  if (Array.isArray(tools)) {
    const keptTools = tools.filter((tool) => {
      const name = toolDefinitionName(tool);
      if (name === undefined) return true;
      const blockId = toolBlockId(name);
      if (excluded.has(blockId)) { hit.push(blockId); return false; }
      return true;
    });
    if (keptTools.length !== tools.length) next.tools = keptTools;
  }

  // 消息条目的排除发生在上下文层（gate 处已看不到它们）——按声明计数，保持 excluded.count 语义完整。
  const declaredEntries = layer.excluded.filter((id) => id.startsWith(ENTRY_PREFIX)).length;
  return { payload: hit.length === 0 && declaredEntries === 0 ? payload : next, excludedCount: hit.length + declaredEntries, excludedIds: hit };
}

function toolDefinitionName(tool: unknown): string | undefined {
  if (tool === null || typeof tool !== "object") return undefined;
  const record = tool as { name?: unknown; function?: { name?: unknown } };
  if (typeof record.name === "string") return record.name;
  if (record.function !== null && typeof record.function === "object" && typeof record.function.name === "string") return record.function.name;
  return undefined;
}
