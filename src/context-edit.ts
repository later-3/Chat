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
// 块内子条目（用户 2026-10-13：区块要能展开看条目与内容，条目可单独勾选）
// ---------------------------------------------------------------------------

export interface SubEntry {
  /** 子条目标识（放在 blockId 的 `#` 之后；同一区块内唯一）。 */
  readonly id: string;
  /** 展示标题（条目行原文去掉 `## `）。 */
  readonly title: string;
  /** 原文片段（条目行到下一条目行之前），重组用。 */
  readonly raw: string;
  /** 内容（去掉条目行本身）。 */
  readonly text: string;
}

/** harness 四类文件条目：`## 纯规则 · <path>` / `## 通用规范 · <name>` / `## 通用资产 · <name>` / `## 本项目专属规范 · <name>`。 */
const HARNESS_ENTRY = /^##\s+(纯规则|通用规范|通用资产|本项目专属规范)\s*·\s*(\S.*)$/;
/** 其他区块的一级小节条目。 */
const SECTION_ENTRY = /^##\s+(\S.*)$/;

function normalizeSubId(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/#/g, "_");
}

/**
 * 把一个区块的内容切成子条目（前后端必须用同一规则；前端 `splitBlockSubEntries` 是它的镜像）。
 * 第一个条目之前的内容（前言）不成条目——它跟随区块本身，只能整块排除。
 */
export function splitSubEntries(tag: string, text: string): readonly SubEntry[] {
  const pattern = tag === "chat_interaction_harness" ? HARNESS_ENTRY : SECTION_ENTRY;
  const lines = text.split("\n");
  const entries: SubEntry[] = [];
  let current: { id: string; title: string; lines: string[] } | null = null;
  const push = () => {
    if (current === null) return;
    const raw = current.lines.join("\n");
    const bodyLines = current.lines.slice(1);
    entries.push({ id: current.id, title: current.title, raw,
      text: bodyLines.join("\n").replace(/^\n+/, "") });
    current = null;
  };
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match !== null) {
      push();
      const id = tag === "chat_interaction_harness" ? normalizeSubId(match[2] as string) : normalizeSubId(match[1] as string);
      current = { id, title: (tag === "chat_interaction_harness" ? (match[2] as string) : (match[1] as string)).trim(), lines: [line] };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  push();
  return entries;
}

/** 子条目 blockId：`tag:<tag>#<子条目标识>`。 */
export function tagSubEntryBlockId(tag: string, subId: string): string { return `${tagBlockId(tag)}#${subId}`; }

// ---------------------------------------------------------------------------
// 应用（gate 处；一期：excluded 的 system 区块与工具）
// ---------------------------------------------------------------------------

/**
 * 消息级修改（B5）：按"条目 id 顺序"把 `modified["entry:<id>"]` 的文字写回对应消息。
 * 预览（payload 消息带 entryId）与真实发送（transformContext 的消息数组）**共用本函数**，
 * 保证"所见即所发"。数量不一致 → 返回 undefined（调用方跳过并记日志，不猜、不静默错配）。
 */
export function applyMessageEdits(
  messages: readonly unknown[],
  entryIds: readonly string[],
  layer: ContextEditLayer,
): readonly unknown[] | undefined {
  if (entryIds.length !== messages.length) return undefined;
  const edits = new Map<string, string>();
  for (const [id, text] of Object.entries(layer.modified)) {
    if (id.startsWith(ENTRY_PREFIX)) edits.set(id.slice(ENTRY_PREFIX.length), text);
  }
  if (edits.size === 0) return messages;
  return messages.map((message, index) => {
    const text = edits.get(entryIds[index] as string);
    if (text === undefined) return message;
    return { ...(message as Record<string, unknown>), content: [{ type: "text", text }] };
  });
}

/** 编辑层里是否有消息（条目）级修改。 */
export function hasMessageEdits(layer: ContextEditLayer): boolean {
  return Object.keys(layer.modified).some((id) => id.startsWith(ENTRY_PREFIX));
}

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
  // modified 不产生"命中条目"，但要记入"改过"标志——否则末尾的快路径会把修改整个丢掉（F-67）。
  let modifiedAny = false;
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
      const tag = segment.tag;
      const blockId = tagBlockId(tag);
      if (excluded.has(blockId)) {
        hit.push(blockId);
        continue;
      }
      const openTag = segment.raw.slice(0, segment.raw.length - segment.text.length - `</${tag}>`.length);
      let body = segment.text;
      const modified = layer.modified[blockId];
      if (modified !== undefined) {
        body = modified;
        modifiedAny = true;
      } else {
        // 子条目级排除（用户 2026-10-13）：块没被整体勾掉时，逐条剔掉被勾掉的条目（前后端同一规则）。
        const excludedSubs = splitSubEntries(tag, segment.text)
          .filter((entry) => excluded.has(tagSubEntryBlockId(tag, entry.id)));
        if (excludedSubs.length > 0) {
          for (const entry of excludedSubs) {
            body = body.replace(entry.raw, "");
            hit.push(tagSubEntryBlockId(tag, entry.id));
          }
          body = body.replace(/\n{3,}/g, "\n\n");
        }
      }
      kept.push(`${openTag}${body}</${tag}>`);
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
  const untouched = hit.length === 0 && declaredEntries === 0 && !modifiedAny;
  return { payload: untouched ? payload : next, excludedCount: hit.length + declaredEntries, excludedIds: hit };
}

function toolDefinitionName(tool: unknown): string | undefined {
  if (tool === null || typeof tool !== "object") return undefined;
  const record = tool as { name?: unknown; function?: { name?: unknown } };
  if (typeof record.name === "string") return record.name;
  if (record.function !== null && typeof record.function === "object" && typeof record.function.name === "string") return record.function.name;
  return undefined;
}
