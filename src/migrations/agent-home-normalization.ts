import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ensureChatHome, getChatHomePaths, resolveChatHome } from "../chat-home.js";
import { readLongAgentRegistry, updateLongAgentRegistry, updateLongAgentState } from "../long-agents/storage.js";
import { ensureProjectLongAgent } from "../long-agents/project-agent.js";
import {
  ensureAgentHomeProject,
  ensureLongAgentShareProject,
  LEGACY_DAILY_PROJECT_ID,
  legacyAgentDailyProjectId,
  readProjectRegistry,
} from "../projects/registry.js";
import { atomicWriteJson } from "../persistence/versioned-file.js";
import type { LongAgentState } from "../long-agents/types.js";

export const AGENT_HOME_NORMALIZATION_VERSION = 1;
const MIGRATION_NAME = "agent-home-normalization";

export interface AgentHomeNormalizationResult {
  readonly schemaVersion: 1;
  readonly completedAt: string;
  readonly migratedAgents: readonly string[];
  readonly movedSessions: readonly { readonly sessionId: string; readonly longAgentId: string }[];
  readonly movedMemoriesToPersonal: number;
  readonly shareRenamed: boolean;
}

function migrationDir(root: string): string {
  return resolve(getChatHomePaths(root).runtimeDir, "migrations", MIGRATION_NAME);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 将 source 的内容合并进 target（同名目录递归合并，绝不丢数据），最后删除已清空的 source。
 * 目标已存在的同名文件保留 target 版本。
 */
async function moveDirectoryContents(source: string, target: string): Promise<number> {
  if (!(await exists(source))) return 0;
  await mkdir(target, { recursive: true, mode: 0o700 });
  const entries = await readdir(source);
  let moved = 0;
  for (const entry of entries) {
    const from = resolve(source, entry);
    const to = resolve(target, entry);
    if (await exists(to)) {
      const [fromStat, toStat] = await Promise.all([stat(from), stat(to)]);
      if (fromStat.isDirectory() && toStat.isDirectory()) {
        moved += await moveDirectoryContents(from, to);
        continue;
      }
      // 同名文件：保留目标，源文件保留在原处并报告，不静默删除。
      moved += 0;
      continue;
    }
    await rename(from, to);
    moved += 1;
  }
  const remaining = await readdir(source);
  if (remaining.length === 0) await rm(source, { recursive: true, force: true });
  return moved;
}

/** Reads one JSONL session file and returns the Long Agent ids referenced by turn markers. */
async function sessionLongAgentIds(filePath: string): Promise<string[]> {
  const ids = new Set<string>();
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const entry: unknown = JSON.parse(trimmed);
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (record.type !== "custom") continue;
      for (const key of ["data", "details"]) {
        const payload = record[key];
        if (typeof payload !== "object" || payload === null) continue;
        const longAgentId = (payload as Record<string, unknown>).longAgentId;
        if (typeof longAgentId === "string" && longAgentId !== "") ids.add(longAgentId);
      }
    } catch {
      // A malformed line must not abort the whole migration.
    }
  }
  return [...ids];
}

/** Moves legacy agent memory rows into Personal Memory; returns how many rows moved. */
async function drainLegacyMemory(catalogPath: string, chatHome: string): Promise<number> {
  if (!(await exists(catalogPath))) return 0;
  // Raw copy keeps archived rows and revisions intact; the catalog is the fact source.
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(catalogPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT id, text, kind, group_id, metadata_json, status, version FROM memories").all() as {
      id: string; text: string; kind: string; group_id: string | null; metadata_json: string; status: string; version: number;
    }[];
    if (rows.length === 0) return 0;
    const personal = new Database(resolve(getChatHomePaths(chatHome).personalMemoryDir, "catalog.db"));
    try {
      const insert = personal.prepare(`
        INSERT OR IGNORE INTO memories (
          id, text, kind, scope, project_id, group_id, metadata_json,
          source_project_id, source_session_id, source_entry_ids_json,
          source_workflow_invocation_id, status, version,
          mem0_id, index_status, index_error, created_at, updated_at
        ) VALUES (?, ?, ?, 'personal', NULL, ?, ?, NULL, NULL, '[]', NULL, ?, ?, NULL, 'pending', NULL, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const row of rows) {
        let metadata: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(row.metadata_json);
          if (typeof parsed === "object" && parsed !== null) metadata = parsed as Record<string, unknown>;
        } catch {
          metadata = {};
        }
        insert.run(
          `migrated-${row.id}`,
          row.text,
          row.kind,
          row.group_id ?? row.id,
          JSON.stringify({ ...metadata, migratedFrom: LEGACY_DAILY_PROJECT_ID }),
          row.status,
          row.version,
          now,
          now,
        );
      }
      return rows.length;
    } finally {
      personal.close();
    }
  } finally {
    db.close();
  }
}

/**
 * 归一迁移（幂等，带备份与完成标记）：
 * 1. Long Agent 的日常项目并入它自己的根 `long-agents/<id>/`（workspace + sessions + memory）。
 * 2. 共享 `daily` 改名为 `longagentshare`，定位为公共 Long Agent 资源共享空间。
 * 3. 共享空间里遗留的 Agent 历史会话按 turn marker 迁回对应 Agent 的根。
 * 4. 共享空间遗留的 catalog 记忆归并到 Personal Memory。
 * 5. Long Agent state 的 projectId / 绑定 id 重写为归一后的形态。
 */
export async function migrateAgentHomeNormalization(
  chatHome = resolveChatHome(),
): Promise<AgentHomeNormalizationResult | null> {
  const home = await ensureChatHome(chatHome);
  const dir = migrationDir(home.root);
  const markerPath = resolve(dir, "done.json");
  if (await exists(markerPath)) return null;

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const registryPath = getChatHomePaths(home.root).projectRegistryPath;
  const longAgentRegistryPath = getChatHomePaths(home.root).longAgentRegistryPath;
  const statePath = getChatHomePaths(home.root).longAgentStatePath;
  for (const [source, name] of [
    [registryPath, "projects-registry.json.bak"],
    [longAgentRegistryPath, "long-agents.json.bak"],
    [statePath, "long-agent-state.json.bak"],
  ] as const) {
    if (await exists(source)) await cp(source, resolve(dir, name));
  }

  const longAgentRegistry = await readLongAgentRegistry(home.root);
  const agents = longAgentRegistry.agents;
  const migratedAgents: string[] = [];
  const movedSessions: { sessionId: string; longAgentId: string }[] = [];
  let movedMemoriesToPersonal = 0;

  // ── 1. Agent 根归一 ────────────────────────────────────────────────
  for (const agent of agents) {
    const agentRoot = resolve(home.root, "long-agents", agent.id);
    const legacyDataDir = resolve(home.projectsDir, legacyAgentDailyProjectId(agent.id));
    const legacyWorkspace = resolve(home.workspacesDir, legacyAgentDailyProjectId(agent.id));
    await ensureAgentHomeProject(agent.id, agent.name, home.root);
    await moveDirectoryContents(resolve(legacyDataDir, "sessions"), resolve(agentRoot, "sessions"));
    await moveDirectoryContents(resolve(legacyDataDir, "prompt-resources"), resolve(agentRoot, "prompt-resources"));
    await moveDirectoryContents(resolve(legacyDataDir, "workflows"), resolve(agentRoot, "workflows"));
    movedMemoriesToPersonal += await drainLegacyMemory(resolve(legacyDataDir, "memory", "catalog.db"), home.root);
    await rm(legacyDataDir, { recursive: true, force: true });
    await moveDirectoryContents(legacyWorkspace, resolve(agentRoot, "workspace"));
    if (agent.defaultProjectId !== agent.id) {
      migratedAgents.push(agent.id);
    }
  }

  // ── 2. 共享 daily → longagentshare ────────────────────────────────
  const legacyShareRoot = resolve(home.workspacesDir, LEGACY_DAILY_PROJECT_ID);
  const legacyShareData = resolve(home.projectsDir, LEGACY_DAILY_PROJECT_ID);
  const agentIds = new Set(agents.map((agent) => agent.id));
  let shareRenamed = false;

  // 先把共享空间里属于 Agent 的历史会话迁回各自的根。
  const legacyShareSessions = resolve(legacyShareData, "sessions");
  if (await exists(legacyShareSessions)) {
    for (const file of await readdir(legacyShareSessions)) {
      if (!file.endsWith(".jsonl")) continue;
      const owners = (await sessionLongAgentIds(resolve(legacyShareSessions, file))).filter((id) => agentIds.has(id));
      if (owners.length !== 1) continue;
      const longAgentId = owners[0] as string;
      const target = resolve(home.root, "long-agents", longAgentId, "sessions");
      await mkdir(target, { recursive: true, mode: 0o700 });
      const sessionId = basename(file).match(/_([0-9a-f-]{36})\.jsonl$/)?.[1] ?? basename(file);
      await rename(resolve(legacyShareSessions, file), resolve(target, file));
      movedSessions.push({ sessionId, longAgentId });
    }
  }
  movedMemoriesToPersonal += await drainLegacyMemory(resolve(legacyShareData, "memory", "catalog.db"), home.root);
  const legacyMemoryDir = resolve(legacyShareData, "memory");
  if (await exists(legacyMemoryDir)) await rm(legacyMemoryDir, { recursive: true, force: true });

  const shareWorkspaceTarget = home.longAgentShareWorkspaceDir;
  if (await exists(legacyShareRoot)) {
    if (!(await exists(shareWorkspaceTarget))) {
      await rename(legacyShareRoot, shareWorkspaceTarget);
      shareRenamed = true;
    } else {
      await moveDirectoryContents(legacyShareRoot, shareWorkspaceTarget);
    }
  }
  const shareDataTarget = resolve(home.projectsDir, "longagentshare");
  if (await exists(legacyShareData) && !(await exists(shareDataTarget))) {
    await rename(legacyShareData, shareDataTarget);
  } else if (await exists(legacyShareData)) {
    await moveDirectoryContents(legacyShareData, shareDataTarget);
  }
  await ensureLongAgentShareProject(home.root);

  // ── 3. state 重写：projectId 与绑定 id 归一 ──────────────────────
  const updatedAgents = await updateLongAgentRegistry(home.root, (registry) => ({
    registry: {
      ...registry,
      agents: registry.agents.map((agent) => (
        agent.defaultProjectId === legacyAgentDailyProjectId(agent.id) || agent.defaultProjectId === LEGACY_DAILY_PROJECT_ID
          ? { ...agent, defaultProjectId: agent.id }
          : agent
      )),
    },
    result: undefined,
  }));
  void updatedAgents;

  // 旧的 per-Agent daily 项目登记不再需要；共享 daily 由新共享空间取代。
  const registry = await readProjectRegistry(home.root);
  const prune = registry.projects.filter((entry) => (
    entry.projectId === LEGACY_DAILY_PROJECT_ID
    || (entry.projectId.startsWith("daily-") && agentIds.has(entry.projectId.slice("daily-".length)))
  ));
  if (prune.length > 0) {
    await atomicWriteJson(registryPath, {
      schemaVersion: 1,
      projects: registry.projects.filter((entry) => !prune.some((item) => item.projectId === entry.projectId)),
    });
  }

  // 为每个 Agent 建立（或复用）home 的当日会话，并把旧绑定指向它。
  const homeBindingIds = new Map<string, string>();
  for (const agent of (await readLongAgentRegistry(home.root)).agents) {
    const ensured = await ensureProjectLongAgent({ chatHome: home.root, projectId: agent.id, agent });
    homeBindingIds.set(agent.id, ensured.projectAgent.id);
  }
  await updateLongAgentState(home.root, (state) => {
    const legacyProjectIds = new Set<string>([
      LEGACY_DAILY_PROJECT_ID,
      ...[...agentIds].map((id) => legacyAgentDailyProjectId(id)),
    ]);
    const legacyBindings = new Map<string, string>();
    for (const projectAgent of state.projectAgents) {
      if (!legacyProjectIds.has(projectAgent.projectId)) continue;
      const home = homeBindingIds.get(projectAgent.longAgentId);
      if (home !== undefined) legacyBindings.set(projectAgent.id, home);
    }
    const next: LongAgentState = {
      ...state,
      projectAgents: state.projectAgents.filter((projectAgent) => !legacyProjectIds.has(projectAgent.projectId)),
      bindings: state.bindings.map((binding) => {
        const target = legacyBindings.get(binding.projectLongAgentId);
        return target === undefined
          ? binding
          : { ...binding, projectLongAgentId: target, updatedAt: new Date().toISOString() };
      }),
    };
    return { state: next, result: undefined };
  });

  const result: AgentHomeNormalizationResult = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    migratedAgents,
    movedSessions,
    movedMemoriesToPersonal,
    shareRenamed,
  };
  await atomicWriteJson(markerPath, result);
  return result;
}

/**
 * 幂等清理：归一后遗留的 `workspaces/daily*` 脚手架目录（只包含旧 `.chat` 元数据、
 * 已不在 Registry 中的项目）。目录里如果还有任何其他内容就保留，绝不删除数据。
 */
export async function sweepLegacyAgentProjectDirs(chatHome = resolveChatHome()): Promise<number> {
  const home = await ensureChatHome(chatHome);
  const registry = await readProjectRegistry(home.root);
  const registered = new Set(registry.projects.map((entry) => entry.projectId));
  let removed = 0;
  for (const name of await readdir(home.workspacesDir).catch(() => [] as string[])) {
    if (!/^daily(-|$)/.test(name)) continue;
    if (registered.has(name)) continue;
    const dir = resolve(home.workspacesDir, name);
    const entries = await readdir(dir).catch(() => [] as string[]);
    if (entries.some((entry) => entry !== ".chat")) continue;
    await rm(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
