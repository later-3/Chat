import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { atomicWriteJson } from "../persistence/versioned-file.js";

export const SESSION_TITLE_CLEANUP_MIGRATION_VERSION = 1;

export interface SessionTitleCleanupMigrationResult {
  readonly schemaVersion: 1;
  readonly version: typeof SESSION_TITLE_CLEANUP_MIGRATION_VERSION;
  readonly cleared: number;
  readonly kept: number;
  readonly completedAt: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * 2026-10-05 标题合同：会话名只由用户写，其余由“第一句话”兜底。
 *
 * 迁移前系统会替用户命名（`<agent> · <project> · 新会话`、`<agent> · <date>`、工作/主题标题、
 * 普通会话的首条消息副本），这些名字把列表回退永远堵死。本迁移只清除**能精确重建的系统写入值**：
 * 名字必须等于该会话在 state 里对应记录推导出的期望值，用户自己改过的名字一律保留。
 * 清空在 Pi 语义里等于“清除标题”（`appendSessionInfo("")`），列表随即回退到第一句话。
 */
export async function migrateSessionTitleCleanup(root: string): Promise<SessionTitleCleanupMigrationResult> {
  const markerPath = resolve(root, "migrations", `session-title-cleanup-v${SESSION_TITLE_CLEANUP_MIGRATION_VERSION}.json`);
  try {
    const done = JSON.parse(await readFile(markerPath, "utf8")) as SessionTitleCleanupMigrationResult;
    if (done.schemaVersion === 1 && done.version === SESSION_TITLE_CLEANUP_MIGRATION_VERSION) return done;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  let agents: { id: string; name: string }[] = [];
  try {
    const registry = JSON.parse(await readFile(resolve(root, "long-agents.json"), "utf8")) as {
      agents?: readonly { id?: unknown; name?: unknown }[];
    };
    agents = (registry.agents ?? []).flatMap((agent) => typeof agent.id === "string"
      ? [{ id: agent.id, name: typeof agent.name === "string" ? agent.name : agent.id }] : []);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));

  let projectNames = new Map<string, string>();
  try {
    const registry = JSON.parse(await readFile(resolve(root, "projects", "registry.json"), "utf8")) as {
      projects?: readonly { projectId?: unknown; cachedName?: unknown }[];
    };
    projectNames = new Map((registry.projects ?? []).flatMap((project) =>
      typeof project.projectId === "string"
        ? [[project.projectId, typeof project.cachedName === "string" ? project.cachedName : project.projectId] as const] : []));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  /** sessionId → 该会话被系统写入过的名字（可能多个历史版本）。 */
  const expected = new Map<string, Set<string>>();
  const expect = (sessionId: unknown, value: string): void => {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const set = expected.get(sessionId) ?? new Set<string>();
    set.add(value);
    expected.set(sessionId, set);
  };

  try {
    const state = JSON.parse(await readFile(resolve(root, "runtime", "long-agent-state.json"), "utf8")) as {
      dailySessions?: readonly { longAgentId?: unknown; sessionId?: unknown; date?: unknown }[];
      additionalSessions?: readonly { longAgentId?: unknown; sessionId?: unknown; date?: unknown }[];
      projectSessions?: readonly { longAgentId?: unknown; projectId?: unknown; sessionId?: unknown }[];
      works?: readonly { longAgentId?: unknown; sessionId?: unknown; title?: unknown }[];
    };
    for (const day of state.dailySessions ?? []) {
      if (typeof day.date !== "string") continue;
      expect(day.sessionId, `${agentName.get(String(day.longAgentId)) ?? String(day.longAgentId)} · ${day.date}`);
    }
    for (const session of state.additionalSessions ?? []) {
      if (typeof session.date !== "string") continue;
      expect(session.sessionId, `${agentName.get(String(session.longAgentId)) ?? String(session.longAgentId)} · ${session.date} · 新会话`);
    }
    for (const binding of state.projectSessions ?? []) {
      const name = agentName.get(String(binding.longAgentId)) ?? String(binding.longAgentId);
      const project = projectNames.get(String(binding.projectId)) ?? String(binding.projectId);
      expect(binding.sessionId, `${name} · ${project} · 新会话`);
    }
    for (const work of state.works ?? []) {
      if (typeof work.title === "string") expect(work.sessionId, work.title);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  // 主题节点会话：节点标题在 Agent 根的 topics.json 里。
  for (const agent of agents) {
    try {
      const graph = JSON.parse(await readFile(resolve(root, "long-agents", agent.id, "topics.json"), "utf8")) as {
        nodes?: readonly { sessionId?: unknown; title?: unknown }[];
      };
      for (const node of graph.nodes ?? []) {
        if (typeof node.title === "string") expect(node.sessionId, node.title);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  const sessionIdOf = (fileName: string): string | undefined => {
    if (!fileName.endsWith(".jsonl")) return undefined;
    const marker = fileName.lastIndexOf("_");
    if (marker <= 0 || marker === fileName.length - 1) return undefined;
    return fileName.slice(marker + 1, -".jsonl".length);
  };

  let cleared = 0;
  let kept = 0;
  const clearPlaceholderName = (filePath: string, sessionId: string, firstUtterance: string): void => {
    const known = expected.get(sessionId);
    let manager: SessionManager;
    try {
      manager = SessionManager.open(filePath);
    } catch {
      kept += 1;
      return;
    }
    const name = manager.getSessionName();
    if (name === undefined || name === "") { kept += 1; return; }
    const systemWritten = known?.has(name) === true
      // 普通项目会话曾把首条消息副本写进标题；只有与当前第一句话一致时才算系统写入。
      || (firstUtterance !== "" && name === firstUtterance.slice(0, 50));
    if (!systemWritten) { kept += 1; return; }
    manager.appendSessionInfo("");
    manager.flush();
    cleared += 1;
  };

  const firstUtteranceOf = (filePath: string): string => {
    try {
      const manager = SessionManager.open(filePath);
      for (const entry of manager.getEntries()) {
        if (entry.type !== "message") continue;
        const message = entry.message as { role?: unknown; content?: unknown };
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = typeof message.content === "string" ? message.content
          : Array.isArray(message.content)
            ? message.content.flatMap((block) => (typeof block === "object" && block !== null
              && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"
              ? [(block as { text: string }).text] : [])).join("\n")
            : "";
        const trimmed = text.trim();
        if (trimmed !== "") return trimmed;
      }
    } catch {
      return "";
    }
    return "";
  };

  const scanSessionDir = async (sessionDir: string): Promise<void> => {
    const files = await readdir(sessionDir).catch(() => null as string[] | null) ?? [];
    for (const fileName of files) {
      const sessionId = sessionIdOf(fileName);
      if (sessionId === undefined) continue;
      const filePath = resolve(sessionDir, fileName);
      clearPlaceholderName(filePath, sessionId, firstUtteranceOf(filePath));
    }
  };

  // Agent 项目树（含 workspace 项目）里的会话
  const agentIds = (await readdir(resolve(root, "long-agents"), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const agentId of agentIds) {
    const projectsDir = resolve(root, "long-agents", agentId, "projects");
    const projectIds = (await readdir(projectsDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const projectId of projectIds) await scanSessionDir(resolve(projectsDir, projectId, "sessions"));
    // 迁移前的旧布局（会话直接在 Agent 根下）也一并处理。
    if (existsSync(resolve(root, "long-agents", agentId, "sessions"))) await scanSessionDir(resolve(root, "long-agents", agentId, "sessions"));
  }
  // 普通（共享）项目目录
  const sharedProjectIds = (await readdir(resolve(root, "projects"), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const projectId of sharedProjectIds) await scanSessionDir(resolve(root, "projects", projectId, "sessions"));

  const result: SessionTitleCleanupMigrationResult = {
    schemaVersion: 1,
    version: SESSION_TITLE_CLEANUP_MIGRATION_VERSION,
    cleared, kept,
    completedAt: new Date().toISOString(),
  };
  await atomicWriteJson(markerPath, result);
  return result;
}
