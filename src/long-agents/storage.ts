import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureChatHome, getChatHomePaths, resolveChatHome } from "../chat-home.js";
import {
  emptyLongAgentState,
  parseLongAgentRegistry,
  parseLongAgentState,
  type LongAgentRegistry,
  type LongAgentState,
} from "./types.js";

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

export async function readLongAgentRegistry(chatHome = resolveChatHome()): Promise<LongAgentRegistry> {
  const paths = await ensureChatHome(chatHome);
  try {
    return parseLongAgentRegistry(await readJson(paths.longAgentRegistryPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, instances: [], agents: [] };
    }
    throw error;
  }
}

async function readLongAgentStateValue(chatHome: string): Promise<{
  readonly state: LongAgentState;
  readonly migrated: boolean;
}> {
  const paths = await ensureChatHome(chatHome);
  try {
    const raw = await readJson(paths.longAgentStatePath);
    const state = parseLongAgentState(raw);
    return {
      state,
      migrated: typeof raw === "object" && raw !== null
        && "schemaVersion" in raw && raw.schemaVersion !== 3,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: emptyLongAgentState(), migrated: false };
    }
    throw error;
  }
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
    await atomicWriteJson(getChatHomePaths(root).longAgentRegistryPath, parsed);
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
    const changed = await update((await readLongAgentStateValue(root)).state);
    const parsed = parseLongAgentState(changed.state);
    await atomicWriteJson(getChatHomePaths(root).longAgentStatePath, parsed);
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
