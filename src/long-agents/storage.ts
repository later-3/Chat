import { withFileLock } from "../persistence/versioned-file.js";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ensureChatHome, getChatHomePaths, resolveChatHome } from "../chat-home.js";
import {
  parseWorkflowAgentDefinition,
  type WorkflowAgentDefinition,
} from "../workflows/agent-config.js";
import {
  emptyLongAgentState,
  LONG_AGENT_ID_PATTERN,
  parseLongAgentRegistry,
  parseLongAgentState,
  type LongAgentConfig,
  type LongAgentRegistry,
  type LongAgentState,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  const content = await readFile(path, "utf8");
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${path}不是有效JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

/** Publish an immutable backup without an incomplete JSON file becoming visible. */
async function writeJsonOnce(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { await link(temporaryPath, path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally { await unlink(temporaryPath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
async function optionalJson(path: string): Promise<unknown | undefined> {
  try { return await readJson(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 每个 Long Agent 的独立配置根；目录按稳定 longAgentId 分区（管理架构 S1）。 */
export function longAgentConfigRoot(root: string, longAgentId: string): string {
  if (!LONG_AGENT_ID_PATTERN.test(longAgentId)) throw new Error(`longAgentId格式无效: ${longAgentId}`);
  return resolve(root, "long-agents", longAgentId);
}

/** 确保 Agent 自有资源目录存在（S4）；只创建目录，不写入任何配置内容。 */
export async function ensureLongAgentResourceDirs(root: string, longAgentId: string): Promise<void> {
  const base = longAgentConfigRoot(root, longAgentId);
  await Promise.all([
    mkdir(resolve(base, "skills"), { recursive: true, mode: 0o700 }),
    mkdir(resolve(base, "prompts"), { recursive: true, mode: 0o700 }),
    mkdir(resolve(base, "extensions"), { recursive: true, mode: 0o700 }),
  ]);
}

function longAgentDefinitionPath(root: string, longAgentId: string): string {
  return resolve(longAgentConfigRoot(root, longAgentId), "definition.json");
}

function longAgentMigrationDir(root: string): string {
  return resolve(root, "runtime", "migrations", "long-agent-definition-split");
}

/** 读取 Agent 的 definition.json；不存在返回 undefined（使用默认定义）。 */
async function readLongAgentDefinitionFile(
  root: string,
  agent: LongAgentConfig,
): Promise<WorkflowAgentDefinition | undefined> {
  const path = longAgentDefinitionPath(root, agent.id);
  let raw: unknown;
  try {
    raw = await readJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const definition = parseWorkflowAgentDefinition(raw);
  // 与 types.ts parseAgent 一致：空 description 回退为 "Chat Long Agent"。
  const expectedDescription = agent.description === "" ? "Chat Long Agent" : agent.description;
  if (definition.id !== agent.id || definition.name !== agent.name || definition.description !== expectedDescription) {
    throw new Error(`Long Agent ${agent.id} 的definition.json与登记身份不一致: ${path}`);
  }
  return definition;
}

/**
 * 一次性迁移：把 long-agents.json 内联的 definition 拆分到 long-agents/<id>/definition.json，
 * Registry 降级为索引。带备份与完成标记，可重入；失败时不写标记，下次读取重试。
 */
async function migrateDefinitionSplit(root: string): Promise<void> {
  const migrationDir = longAgentMigrationDir(root);
  const markerPath = resolve(migrationDir, "done.json");
  await withFileLock(markerPath, async () => {
    if (await optionalJson(markerPath) !== undefined) return;
    const raw = await readJson(getChatHomePaths(root).longAgentRegistryPath);
    const parsed = parseLongAgentRegistry(raw);
    if (!isRecord(raw) || !Array.isArray(raw.agents)) throw new Error("无效Long Agent索引");
    const inline = parsed.agents.filter((agent) => (raw.agents as unknown[]).some((entry) => isRecord(entry) && entry.id === agent.id && entry.definition !== undefined));
    // Validate every conflict before changing the index. A partial prior split is safe to retry.
    for (const agent of inline) {
      const current = await optionalJson(longAgentDefinitionPath(root, agent.id));
      if (current !== undefined && JSON.stringify(parseWorkflowAgentDefinition(current)) !== JSON.stringify(agent.definition)) {
        throw new Error(`Long Agent ${agent.id}定义迁移冲突；内联与独立文件均已保留，请检查后重试`);
      }
    }
    if (inline.length > 0) {
      await writeJsonOnce(resolve(migrationDir, "long-agents.json.bak"), raw);
      for (const agent of inline) await writeJsonOnce(longAgentDefinitionPath(root, agent.id), agent.definition);
      const stripped = { ...raw, agents: raw.agents.map((agent) => {
        if (!isRecord(agent)) return agent;
        const { definition: _definition, ...rest } = agent;
        return rest;
      }) };
      await atomicWriteJson(getChatHomePaths(root).longAgentRegistryPath, stripped);
    }
    await atomicWriteJson(markerPath, { doneAt: new Date().toISOString(), migratedAgents: inline.map((agent) => agent.id) });
  });
}

/** 拆分写入：definition 进 long-agents/<id>/definition.json，Registry 只保留索引字段。 */
async function writeRegistrySplit(root: string, registry: LongAgentRegistry): Promise<void> {
  for (const agent of registry.agents) {
    await atomicWriteJson(longAgentDefinitionPath(root, agent.id), agent.definition);
  }
  const index = {
    schemaVersion: registry.schemaVersion,
    instances: registry.instances,
    agents: registry.agents.map((agent) => {
      const { definition: _definition, ...rest } = agent;
      return rest;
    }),
  };
  await atomicWriteJson(getChatHomePaths(root).longAgentRegistryPath, index);
}

export async function readLongAgentRegistry(chatHome = resolveChatHome()): Promise<LongAgentRegistry> {
  const paths = await ensureChatHome(chatHome);
  let raw: unknown;
  try {
    raw = await readJson(paths.longAgentRegistryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, instances: [], agents: [] };
    }
    throw error;
  }
  await migrateDefinitionSplit(paths.root);
  const parsed = parseLongAgentRegistry(await readJson(paths.longAgentRegistryPath));
  const agents = await Promise.all(parsed.agents.map(async (agent) => {
    const definition = await readLongAgentDefinitionFile(paths.root, agent);
    return definition === undefined ? agent : { ...agent, definition };
  }));
  return { ...parsed, agents };
}

async function readLongAgentStateValue(chatHome: string): Promise<{
  readonly state: LongAgentState;
  readonly migrated: boolean;
}> {
  const paths = await ensureChatHome(chatHome);
  try {
    const raw = await readJson(paths.longAgentStatePath);
    const state = parseLongAgentState(raw);
    if (isRecord(raw) && raw.schemaVersion !== 4) {
      const backup = resolve(paths.root, "runtime/migrations/long-agent-daily-v4/source.json");
      await writeJsonOnce(backup, raw);
    }
    if (isRecord(raw) && raw.schemaVersion === 4) await completeDailyMigration(paths.root);
    return {
      state,
      migrated: typeof raw === "object" && raw !== null
        && "schemaVersion" in raw && raw.schemaVersion !== 4,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: emptyLongAgentState(), migrated: false };
    }
    throw error;
  }
}

async function completeDailyMigration(root: string): Promise<void> {
  const dir = resolve(root, "runtime/migrations/long-agent-daily-v4");
  if (await optionalJson(resolve(dir, "source.json")) === undefined) return;
  await writeJsonOnce(resolve(dir, "complete.json"), { schemaVersion: 1, completedAt: new Date().toISOString(), targetSchema: 4 });
}

const stateWrites = new Map<string, Promise<void>>();
const registryWrites = new Map<string, Promise<void>>();

export async function readLongAgentState(chatHome = resolveChatHome()): Promise<LongAgentState> {
  const root = resolveChatHome(chatHome);
  const current = await readLongAgentStateValue(root);
  if (!current.migrated) return current.state;

  // A legacy read is also a write. Re-read inside the state queue so a
  // concurrent runtime update cannot be overwritten by a stale migration.
  return updateLongAgentState(root, (latest) => ({ state: latest, result: latest }));
}

export async function updateLongAgentRegistry<T>(
  chatHome: string,
  update: (registry: LongAgentRegistry) => Promise<{ readonly registry: LongAgentRegistry; readonly result: T }> | {
    readonly registry: LongAgentRegistry;
    readonly result: T;
  },
): Promise<T> {
  const root = resolveChatHome(chatHome);
  const previous = registryWrites.get(root) ?? Promise.resolve();
  let result: T | undefined;
  const current = previous.catch(() => undefined).then(async () => {
    const changed = await update(await readLongAgentRegistry(root));
    const parsed = parseLongAgentRegistry(changed.registry);
    await writeRegistrySplit(root, parsed);
    result = changed.result;
  });
  registryWrites.set(root, current);
  try {
    await current;
    return result as T;
  } finally {
    if (registryWrites.get(root) === current) registryWrites.delete(root);
  }
}

export async function updateLongAgentState<T>(
  chatHome: string,
  update: (state: LongAgentState) => Promise<{ readonly state: LongAgentState; readonly result: T }> | {
    readonly state: LongAgentState;
    readonly result: T;
  },
): Promise<T> {
  const root = resolveChatHome(chatHome);
  const previous = stateWrites.get(root) ?? Promise.resolve();
  let result: T | undefined;
  const current = previous.catch(() => undefined).then(async () => {
    const currentState = await readLongAgentStateValue(root);
    const changed = await update(currentState.state);
    const parsed = parseLongAgentState(changed.state);
    await atomicWriteJson(getChatHomePaths(root).longAgentStatePath, parsed);
    await completeDailyMigration(root);
    result = changed.result;
  });
  stateWrites.set(root, current);
  try {
    await current;
    return result as T;
  } finally {
    if (stateWrites.get(root) === current) stateWrites.delete(root);
  }
}

export async function writeLongAgentRegistry(
  value: unknown,
  chatHome = resolveChatHome(),
): Promise<LongAgentRegistry> {
  const registry = parseLongAgentRegistry(value);
  return updateLongAgentRegistry(chatHome, () => ({ registry, result: registry }));
}
