import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureChatHome, getChatHomePaths, resolveChatHome } from "../chat-home.js";
import { readLongAgentRegistry, readLongAgentState, updateLongAgentRegistry, updateLongAgentState } from "../long-agents/storage.js";
import { parseLongAgentState } from "../long-agents/types.js";
import { collectChatLongAgentTurnMarkers } from "../long-agents/session-turn.js";
import { ensureAgentHomeProject, ensureLongAgentShareProject, legacyAgentDailyProjectId, readProjectRegistry } from "../projects/registry.js";
import { PROJECT_ID_PATTERN, parseProjectRegistry } from "../projects/types.js";
import { atomicWriteJson } from "../persistence/versioned-file.js";

export const AGENT_HOME_NORMALIZATION_VERSION = 2;
const MIGRATION_NAME = "agent-home-normalization";
export interface LegacyFriendSession {
  readonly sourceProjectId: string;
  readonly targetProjectId: string;
  readonly sessionId: string;
  readonly longAgentId: string | null;
}
export interface AgentHomeNormalizationResult {
  readonly schemaVersion: 2;
  readonly completedAt: string;
  readonly migratedAgents: readonly string[];
  readonly sessions: readonly LegacyFriendSession[];
  readonly previousVersion: 1 | null;
}
function migrationDir(root: string): string {
  return resolve(getChatHomePaths(root).runtimeDir, "migrations", MIGRATION_NAME);
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function backupOnce(source: string, target: string): Promise<void> {
  if (!(await exists(source))) return;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    try { await link(temporary, target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally { await unlink(temporary).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
/** Preserve both sides on conflicts. A retry never replaces either the source or the first backup. */
async function copyPreserving(source: string, target: string, workspace = false): Promise<void> {
  if (!(await exists(source))) return;
  if (await exists(target) && (await lstat(target)).isSymbolicLink()) throw new Error(`迁移目标不能是符号链接: ${target}`);
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`迁移不跟随符号链接，请先检查: ${source}`);
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of await readdir(source)) {
      // Home has its own identity/configuration. Keep old Project metadata in the original root.
      if (workspace && name === ".chat") continue;
      await copyPreserving(resolve(source, name), resolve(target, name));
    }
    return;
  }
  if (!info.isFile()) throw new Error(`迁移遇到不支持的文件类型: ${source}`);
  await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
  try { await copyFile(source, target, constants.COPYFILE_EXCL); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()
      || !(await readFile(source)).equals(await readFile(target))) {
      throw new Error(`迁移文件冲突；两份原件均已保留，请检查后重试: ${source} → ${target}`);
    }
  }
}

export async function readLegacyFriendSessions(chatHome: string): Promise<readonly LegacyFriendSession[]> {
  const path = resolve(migrationDir(chatHome), "done-v2.json");
  if (!(await exists(path))) return [];
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof raw !== "object" || raw === null || !("schemaVersion" in raw) || raw.schemaVersion !== 2
    || !("sessions" in raw) || !Array.isArray(raw.sessions)) throw new Error("Friend迁移记录无效");
  return raw.sessions.map((value: unknown) => {
    if (typeof value !== "object" || value === null) throw new Error("Friend历史映射无效");
    const entry = value as Record<string, unknown>;
    for (const key of ["sourceProjectId", "targetProjectId"]) {
      if (typeof entry[key] !== "string" || !PROJECT_ID_PATTERN.test(entry[key])) throw new Error("Friend历史项目映射无效");
    }
    if (entry.longAgentId !== null && (typeof entry.longAgentId !== "string" || !PROJECT_ID_PATTERN.test(entry.longAgentId))) throw new Error("Friend历史身份无效");
    if (typeof entry.sessionId !== "string" || !/^[a-zA-Z0-9-]+$/.test(entry.sessionId)) throw new Error("Friend历史Session映射无效");
    return entry as unknown as LegacyFriendSession;
  });
}

const migrations = new Map<string, Promise<AgentHomeNormalizationResult | null>>();
export async function migrateAgentHomeNormalization(chatHome = resolveChatHome()): Promise<AgentHomeNormalizationResult | null> {
  const root = resolveChatHome(chatHome);
  const pending = migrations.get(root);
  if (pending !== undefined) return pending;
  const operation = migrate(root);
  migrations.set(root, operation);
  try { return await operation; } finally { migrations.delete(root); }
}

/** Add Home roots without removing legacy Projects, history, Memory, or channel bindings. */
async function migrate(chatHome: string): Promise<AgentHomeNormalizationResult | null> {
  const home = await ensureChatHome(chatHome);
  const dir = migrationDir(home.root);
  const marker = resolve(dir, "done-v2.json");
  if (await exists(marker)) { await readLegacyFriendSessions(home.root); return null; }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const paths = getChatHomePaths(home.root);
  for (const [source, name] of [
    [paths.projectRegistryPath, "projects-registry"], [paths.longAgentRegistryPath, "long-agents"],
    [paths.longAgentStatePath, "long-agent-state"],
  ] as const) await backupOnce(source, resolve(dir, `${name}.v2.bak.json`));
  const previousVersion = await exists(resolve(dir, "done.json")) ? 1 : null;
  const agents = (await readLongAgentRegistry(home.root)).agents;
  const state = await readLongAgentState(home.root);
  const priorStatePath = resolve(dir, "long-agent-state.json.bak");
  const priorState = previousVersion === 1 && await exists(priorStatePath)
    ? parseLongAgentState(JSON.parse(await readFile(priorStatePath, "utf8"))) : state;
  const priorRegistryPath = resolve(dir, "projects-registry.json.bak");
  const priorRegistry = previousVersion === 1 && await exists(priorRegistryPath)
    ? parseProjectRegistry(JSON.parse(await readFile(priorRegistryPath, "utf8"))) : await readProjectRegistry(home.root);
  const sessions: LegacyFriendSession[] = [];
  // Schema 1 could have several Web/channel Sessions for one Project/Friend. The old
  // primary projection is lossy, so retain each validated source binding for history.
  const legacyStatePath = previousVersion === 1 && await exists(priorStatePath)
    ? priorStatePath : resolve(dir, "long-agent-state.v2.bak.json");
  const historicalBindings = [...priorState.projectAgents];
  if (await exists(legacyStatePath)) {
    const raw: unknown = JSON.parse(await readFile(legacyStatePath, "utf8"));
    parseLongAgentState(raw);
    if (typeof raw === "object" && raw !== null && "schemaVersion" in raw && raw.schemaVersion === 1 && "bindings" in raw && Array.isArray(raw.bindings)) {
      for (const value of raw.bindings) {
        // parseLongAgentState above validates these exact legacy fields.
        const binding = value as { projectId: string; chatSessionId: string; longAgentId: string; createdAt: string; updatedAt: string };
        if (!historicalBindings.some((entry) => entry.projectId === binding.projectId && entry.primarySessionId === binding.chatSessionId)) {
          historicalBindings.push({ id: `legacy:${binding.chatSessionId}`, projectId: binding.projectId, primarySessionId: binding.chatSessionId,
            longAgentId: binding.longAgentId, status: "active", createdAt: binding.createdAt, updatedAt: binding.updatedAt });
        }
      }
    }
  }
  for (const agent of agents) {
    const own = await ensureAgentHomeProject(agent.id, agent.name, home.root);
    const legacyId = legacyAgentDailyProjectId(agent.id);
    await copyPreserving(resolve(home.workspacesDir, legacyId), own.projectRoot, true);
    // Native history and Prompt/Memory retain their old Project scope. Only v1 data
    // that was already moved needs a new physical location in the compatibility receipt.
    for (const sourceProjectId of [legacyId, "daily"]) {
      const sourceDir = resolve(home.projectsDir, sourceProjectId, "sessions");
      const candidateDir = await exists(sourceDir) ? sourceDir : own.sessionDir;
      for (const file of await readdir(candidateDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const source = resolve(candidateDir, file);
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`历史Session不是普通文件: ${source}`);
        const lines: unknown[] = (await readFile(source, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
        const header = lines[0];
        if (typeof header !== "object" || header === null || !("id" in header) || typeof header.id !== "string") throw new Error(`历史Session头无效: ${source}`);
        const id = header.id;
        const bindingOwner = historicalBindings.find((item) => item.projectId === sourceProjectId && item.primarySessionId === id)?.longAgentId;
        const turnOwners = new Set(collectChatLongAgentTurnMarkers(lines).map((turn) => turn.longAgentId));
        const legacyRoot = priorRegistry.projects.find((entry) => entry.projectId === sourceProjectId)?.path;
        const previousLocation = previousVersion === 1 && candidateDir === own.sessionDir
          && "cwd" in header && header.cwd === legacyRoot;
        const owned = bindingOwner === agent.id || (sourceProjectId === legacyId)
          || (turnOwners.size === 1 && turnOwners.has(agent.id));
        // For a completed v1 migration, only the old binding / receipt proves the old URL.
        if (!owned || (candidateDir === own.sessionDir && bindingOwner !== agent.id && !previousLocation)) continue;
        sessions.push({ sourceProjectId, targetProjectId: candidateDir === own.sessionDir ? agent.id : sourceProjectId, sessionId: id, longAgentId: agent.id });
      }
    }
  }
  // Preserve business-project histories in place and their source ownership after channel rebinding.
  for (const old of historicalBindings) {
    if (!agents.some((agent) => agent.id === old.longAgentId) || old.projectId === old.longAgentId) continue;
    if (sessions.some((item) => item.sourceProjectId === old.projectId && item.sessionId === old.primarySessionId)) continue;
    if (!priorRegistry.projects.some((project) => project.projectId === old.projectId)) continue;
    const targetProjectId = old.projectId === legacyAgentDailyProjectId(old.longAgentId) || old.projectId === "daily" ? old.longAgentId : old.projectId;
    sessions.push({ sourceProjectId: old.projectId, targetProjectId, sessionId: old.primarySessionId, longAgentId: old.longAgentId });
  }
  const share = await ensureLongAgentShareProject(home.root);
  // v1 also moved ordinary Daily history. Preserve read access by the old exact URL.
  if (previousVersion === 1) {
    const oldRoot = priorRegistry.projects.find((entry) => entry.projectId === "daily")?.path;
    for (const file of await readdir(share.sessionDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const header: unknown = JSON.parse((await readFile(resolve(share.sessionDir, file), "utf8")).split("\n")[0] ?? "null");
      if (typeof header !== "object" || header === null || !("cwd" in header) || header.cwd !== oldRoot || !("id" in header) || typeof header.id !== "string") continue;
      sessions.push({ sourceProjectId: "daily", targetProjectId: share.projectId, sessionId: header.id, longAgentId: null });
    }
  }
  const migratedAgents: string[] = [];
  await updateLongAgentRegistry(home.root, (registry) => ({
    registry: { ...registry, agents: registry.agents.map((agent) => {
      if (agent.defaultProjectId !== legacyAgentDailyProjectId(agent.id) && agent.defaultProjectId !== "daily") return agent;
      migratedAgents.push(agent.id);
      return { ...agent, defaultProjectId: agent.id };
    }) }, result: undefined,
  }));
  await updateLongAgentState(home.root, (current) => ({ state: { ...current, bindings: current.bindings.map((binding) => {
    if (binding.contextProjectId !== undefined) return binding;
    const old = current.projectAgents.find((entry) => entry.id === binding.projectLongAgentId);
    const project = priorRegistry.projects.find((entry) => entry.projectId === old?.projectId);
    const legacy = old !== undefined && (old.projectId === "daily" || old.projectId === legacyAgentDailyProjectId(old.longAgentId));
    return { ...binding, contextProjectId: project !== undefined && !legacy && (project.kind ?? "project") === "project" ? project.projectId : null };
  }) }, result: undefined }));
  const result: AgentHomeNormalizationResult = { schemaVersion: 2, completedAt: new Date().toISOString(), migratedAgents, sessions, previousVersion };
  await atomicWriteJson(marker, result);
  return result;
}
