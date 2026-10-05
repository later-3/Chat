import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveChatHome } from "./chat-home.js";
import { readLongAgentRegistry } from "./long-agents/storage.js";
import { readProjectRegistry, resolveProjectContext } from "./projects/registry.js";
import { listActiveSessionFiles } from "./session-files.js";
import { listOwnedSessionRoots } from "./session-location.js";
import { readRecoveredRemovedSessionIndex } from "./removed-session-index.js";
import type { ChatProjectContext } from "./projects/types.js";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

const MAX_RESULTS = 200;
const SNIPPET_RADIUS = 40;

/** 搜索范围：当前项目（共享目录 + 该项目的 Long Agent 项目树）/ 某 Long Agent 的全部项目 / 全部会话。 */
export type SessionSearchScope = "project" | "agent" | "all";

export interface SessionSearchInput {
  readonly chatHome?: string;
  readonly scope?: SessionSearchScope;
  readonly projectId?: string;
  readonly ownerLongAgentId?: string;
  /** 关键词；匹配标题、第一句话与全部消息文本（不区分大小写）。 */
  readonly query?: string;
  /** 创建日期区间（含端点，YYYY-MM-DD）。 */
  readonly createdFrom?: string;
  readonly createdTo?: string;
  /** 是否把已移除的会话也纳入结果。 */
  readonly includeRemoved?: boolean;
  readonly limit?: number;
}

export interface SessionSearchItem {
  readonly sessionId: string;
  readonly projectId: string;
  readonly ownerLongAgentId?: string;
  readonly title: string;
  readonly firstMessage: string;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: "active" | "removed";
  /** 关键词在会话文本中的命中片段（无关键词或只命中标题时为 null）。 */
  readonly snippet: string | null;
}

interface SearchRoot {
  readonly projectId: string;
  readonly project: ChatProjectContext;
  readonly ownerLongAgentId?: string;
}

/** 枚举一个 Long Agent 的全部会话根：Agent Home 加上它参与过的每个项目。 */
async function agentRoots(home: string, agentId: string): Promise<SearchRoot[]> {
  const roots: SearchRoot[] = [];
  const projectsDir = resolve(home, "long-agents", agentId, "projects");
  const projectIds = (await readdir(projectsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const projectId of projectIds) {
    roots.push({
      projectId,
      project: await resolveProjectContext(projectId, home, { ownerLongAgentId: agentId }),
      ownerLongAgentId: agentId,
    });
  }
  return roots;
}

async function searchRoots(input: SessionSearchInput, home: string): Promise<SearchRoot[]> {
  const scope = input.scope ?? (input.projectId === undefined ? "all" : "project");
  if (scope === "project") {
    if (input.projectId === undefined) throw new Error("按项目搜索需要projectId");
    return (await listOwnedSessionRoots(input.projectId, home)).map((root) => ({
      projectId: root.project.projectId, project: root.project, ...(root.ownerLongAgentId === undefined ? {} : { ownerLongAgentId: root.ownerLongAgentId }),
    }));
  }
  const agents = (await readLongAgentRegistry(home)).agents.map((agent) => agent.id);
  if (scope === "agent") {
    if (input.ownerLongAgentId === undefined) throw new Error("按Long Agent搜索需要ownerLongAgentId");
    return await agentRoots(home, input.ownerLongAgentId);
  }
  const roots: SearchRoot[] = [];
  for (const agentId of agents) roots.push(...await agentRoots(home, agentId));
  const registry = await readProjectRegistry(home);
  for (const entry of registry.projects) {
    if (agents.includes(entry.projectId)) continue; // Agent Home 已由 agentRoots 覆盖
    roots.push({ projectId: entry.projectId, project: await resolveProjectContext(entry.projectId, home) });
  }
  return roots;
}

function matchesQuery(info: SessionInfo, query: string): boolean {
  if (query === "") return true;
  const haystack = `${info.name ?? ""}\n${info.firstMessage}\n${info.allMessagesText}`.toLowerCase();
  return haystack.includes(query);
}

function withinDates(info: SessionInfo, from?: string, to?: string): boolean {
  const created = info.created.toISOString().slice(0, 10);
  if (from !== undefined && created < from) return false;
  if (to !== undefined && created > to) return false;
  return true;
}

function snippetFor(text: string, query: string): string | null {
  if (query === "") return null;
  const index = text.toLowerCase().indexOf(query);
  if (index < 0) return null;
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + query.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function titleOf(info: SessionInfo): string {
  const name = info.name?.trim();
  if (name !== undefined && name !== "") return name;
  const first = info.firstMessage.replace(/\s+/g, " ").trim();
  return first === "" ? info.id.slice(0, 12) : first.slice(0, 50);
}

/**
 * 会话搜索：范围 + 创建日期 + 关键词（含全文）。已移除的会话作为范围之一可选，
 * 它们与活跃会话一样携带标题、时间、消息数与归属，因此可以直接在结果里恢复或永久删除。
 */
export async function searchChatSessions(input: SessionSearchInput): Promise<readonly SessionSearchItem[]> {
  const home = resolveChatHome(input.chatHome);
  const query = (input.query ?? "").trim().toLowerCase();
  const roots = await searchRoots(input, home);
  const items: SessionSearchItem[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const active = (await listActiveSessionFiles(root.project))
      .filter((info) => matchesQuery(info, query) && withinDates(info, input.createdFrom, input.createdTo));
    for (const info of active) {
      if (seen.has(info.id)) continue;
      seen.add(info.id);
      items.push({
        sessionId: info.id, projectId: root.projectId,
        ...(root.ownerLongAgentId === undefined ? {} : { ownerLongAgentId: root.ownerLongAgentId }),
        title: titleOf(info), firstMessage: info.firstMessage, messageCount: info.messageCount,
        createdAt: info.created.toISOString(), updatedAt: info.modified.toISOString(), state: "active",
        snippet: snippetFor(`${info.name ?? ""} ${info.firstMessage} ${info.allMessagesText}`, query),
      });
    }
    if (input.includeRemoved !== true) continue;
    const index = await readRecoveredRemovedSessionIndex(root.project).catch(() => null);
    if (index === null) continue;
    for (const record of Object.values(index.sessions)) {
      if (seen.has(record.id)) continue;
      const created = new Date(record.created);
      if (!withinDates({ created } as SessionInfo, input.createdFrom, input.createdTo)) continue;
      const matches = query === "" || `${record.name ?? ""}\n${record.firstMessage}`.toLowerCase().includes(query);
      if (!matches) continue;
      seen.add(record.id);
      items.push({
        sessionId: record.id, projectId: root.projectId,
        ...(root.ownerLongAgentId === undefined ? {} : { ownerLongAgentId: root.ownerLongAgentId }),
        title: record.name?.trim() || record.firstMessage.slice(0, 50) || record.id.slice(0, 12),
        firstMessage: record.firstMessage, messageCount: record.messageCount,
        createdAt: record.created, updatedAt: record.modified, state: "removed",
        snippet: snippetFor(`${record.name ?? ""} ${record.firstMessage}`, query),
      });
    }
  }
  return items
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, input.limit ?? MAX_RESULTS);
}
