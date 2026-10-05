import { readFile, readdir, rename, rmdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteJson } from "../persistence/versioned-file.js";

export const AGENT_PROJECTS_LAYOUT_MIGRATION_VERSION = 1;

export interface AgentProjectsLayoutMigrationResult {
  readonly schemaVersion: 1;
  readonly version: typeof AGENT_PROJECTS_LAYOUT_MIGRATION_VERSION;
  readonly movedDirs: number;
  readonly movedFiles: number;
  readonly keptExisting: number;
  readonly completedAt: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** 2026-10-04 存储合同：Long Agent 的会话事实落在 Agent 根下 projects/<projectId>/sessions/
 * （workspace 自身也是一个 projectId = agent id）；durable 工作流配置、memory、prompt-resources
 * 属于身份/配置层，保留在 Agent 根。旧布局两类位置归位：
 * ① long-agents/<agent>/ 顶层的 sessions|memory|prompt-resources|workflows|days|summaries|session-memory；
 * ② 用户项目 projects/<P>/ 下由 projectSessions 绑定登记的 Agent 会话文件（位置=归属）；
 * ③ kind=agent 早期 shared projects/<agent>/ 顶层的数据并入 workspace 树。
 * 目标已存在的新位置副本永远胜出（升级后的权威）；逐项 rename 不覆盖目标，可重入。 */
export async function migrateAgentProjectsLayout(root: string): Promise<AgentProjectsLayoutMigrationResult> {
  const markerPath = resolve(root, "migrations", `agent-projects-layout-v${AGENT_PROJECTS_LAYOUT_MIGRATION_VERSION}.json`);
  try {
    const done = JSON.parse(await readFile(markerPath, "utf8")) as AgentProjectsLayoutMigrationResult;
    if (done.schemaVersion === 1 && done.version === AGENT_PROJECTS_LAYOUT_MIGRATION_VERSION) return done;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const members = ["sessions", "days", "summaries"] as const;  // session-memory/removed 随 sessions 子树
  let movedDirs = 0;
  let movedFiles = 0;
  let keptExisting = 0;

  /** 目录已有新位置：逐项并入（目标存在 → 保留新位置副本），搬空后移除空源目录。 */
  const mergeInto = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true, mode: 0o700 });
    const entries = await readdir(from, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const target = resolve(to, entry.name);
      if (entry.isDirectory()) {
        if (!existsSync(target)) {
          try {
            await rename(resolve(from, entry.name), target);
            movedDirs += 1;
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
          }
        }
        await mergeInto(resolve(from, entry.name), target);
        continue;
      }
      if (existsSync(target)) { keptExisting += 1; continue; }
      try {
        await rename(resolve(from, entry.name), target);
        movedFiles += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        keptExisting += 1;
      }
    }
    const rest = await readdir(from).catch(() => null);
    if (rest !== null && rest.length === 0) await rmdir(from).catch(() => undefined);
  };

  let agentIds: string[] = [];
  try {
    agentIds = (await readdir(resolve(root, "long-agents"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  // Phase 1: Agent 根顶层数据目录 → long-agents/<agent>/projects/<agent>/
  for (const agentId of agentIds) {
    const base = resolve(root, "long-agents", agentId);
    const workspaceDataDir = resolve(base, "projects", agentId);
    await mkdir(workspaceDataDir, { recursive: true, mode: 0o700 });
    for (const member of members) {
      const from = resolve(base, member);
      if (!existsSync(from)) continue;
      const target = resolve(workspaceDataDir, member);
      if (existsSync(target)) { await mergeInto(from, target); continue; }
      try {
        await rename(from, target);
        movedDirs += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
        await mergeInto(from, target);
      }
    }
    // Phase 3: kind=agent 早期 shared 目录并入 Agent 树（目标胜出）。
    const legacyShared = resolve(root, "projects", agentId);
    if (existsSync(resolve(legacyShared, "sessions")) || existsSync(resolve(legacyShared, "memory"))
      || existsSync(resolve(legacyShared, "workflows")) || existsSync(resolve(legacyShared, "prompt-resources"))) {
      for (const member of members) {
        const from = resolve(legacyShared, member);
        if (!existsSync(from)) continue;
        await mergeInto(from, resolve(workspaceDataDir, member));
      }
    }
  }

  // Phase 2: projectSessions 绑定的会话/记忆从 shared projects/<P>/ 归位到 Agent 项目树。
  const ownership = new Map<string, { longAgentId: string; projectId: string }>();
  try {
    const state = JSON.parse(await readFile(resolve(root, "runtime", "long-agent-state.json"), "utf8")) as {
      projectSessions?: readonly { longAgentId?: unknown; projectId?: unknown; sessionId?: unknown }[];
    };
    for (const binding of state.projectSessions ?? []) {
      if (typeof binding.longAgentId === "string" && typeof binding.projectId === "string" && typeof binding.sessionId === "string") {
        ownership.set(binding.sessionId, { longAgentId: binding.longAgentId, projectId: binding.projectId });
      }
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const sessionIdOfJsonl = (fileName: string): string | undefined => {
    const marker = fileName.lastIndexOf("_");
    if (marker <= 0 || marker === fileName.length - 1) return undefined;
    return fileName.slice(marker + 1, -".jsonl".length);
  };
  const sessionIdOfJson = (fileName: string): string | undefined =>
    fileName.endsWith(".json") && fileName !== "complete.json" ? fileName.slice(0, -".json".length) : undefined;

  let projectIds: string[] = [];
  try {
    projectIds = (await readdir(resolve(root, "projects"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  for (const projectId of projectIds) {
    if (agentIds.includes(projectId)) continue; // Agent 归属数据走 Phase 1/3，不按绑定表重复搬
    const scanDirs = [
      { segments: ["projects", projectId, "sessions"] as const, tail: ["sessions"] as const, isMemory: false },
      { segments: ["projects", projectId, "sessions", "session-memory"] as const, tail: ["sessions", "session-memory"] as const, isMemory: true },
    ];
    for (const scan of scanDirs) {
      const sourceDir = resolve(root, ...scan.segments);
      const files = await readdir(sourceDir).catch(() => null as string[] | null) ?? [];
      for (const fileName of files) {
        const sessionId = scan.isMemory ? sessionIdOfJson(fileName) : sessionIdOfJsonl(fileName);
        if (sessionId === undefined) continue;
        const owner = ownership.get(sessionId);
        if (owner === undefined) continue;
        const targetDir = resolve(root, "long-agents", owner.longAgentId, "projects", owner.projectId, ...scan.tail);
        await mkdir(targetDir, { recursive: true, mode: 0o700 });
        const target = resolve(targetDir, fileName);
        if (existsSync(target)) { keptExisting += 1; continue; }
        try {
          await rename(resolve(sourceDir, fileName), target);
          movedFiles += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          keptExisting += 1;
        }
      }
    }
  }

  const result: AgentProjectsLayoutMigrationResult = {
    schemaVersion: 1,
    version: AGENT_PROJECTS_LAYOUT_MIGRATION_VERSION,
    movedDirs, movedFiles, keptExisting,
    completedAt: new Date().toISOString(),
  };
  await atomicWriteJson(markerPath, result);
  return result;
}
