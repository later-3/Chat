import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { ensureChatHome, getChatHomePaths, resolveChatHome } from "../chat-home.js";
import {
  parseProjectManifest,
  parseProjectRegistry,
  PROJECT_ID_PATTERN,
  type ChatProjectContext,
  type ChatProjectManifest,
  type ChatProjectRegistry,
  type ChatProjectRegistryEntry,
  type ChatProjectSummary,
} from "./types.js";

export const PROJECT_MANIFEST_RELATIVE_PATH = join(".chat", "project.json");

function defaultRegistry(): ChatProjectRegistry {
  return { schemaVersion: 1, projects: [] };
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

const registryWrites = new Map<string, Promise<void>>();

async function serializeRegistryWrite(root: string, operation: () => Promise<void>): Promise<void> {
  const previous = registryWrites.get(root) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  registryWrites.set(root, current);
  try {
    await current;
  } finally {
    if (registryWrites.get(root) === current) registryWrites.delete(root);
  }
}

export async function readProjectRegistry(chatHome = resolveChatHome()): Promise<ChatProjectRegistry> {
  const paths = await ensureChatHome(chatHome);
  try {
    return parseProjectRegistry(await readJson(paths.projectRegistryPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultRegistry();
    throw error;
  }
}

async function projectRoot(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Project路径不是目录: ${canonical}`);
  return canonical;
}

export async function readProjectManifest(root: string): Promise<ChatProjectManifest> {
  const path = resolve(root, PROJECT_MANIFEST_RELATIVE_PATH);
  try {
    return parseProjectManifest(await readJson(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`找不到Project Manifest: ${path}`);
    }
    throw error;
  }
}

export async function findProjectManifest(startPath: string): Promise<{ root: string; manifest: ChatProjectManifest } | null> {
  let current = await projectRoot(startPath);
  const filesystemRoot = parse(current).root;
  while (true) {
    try {
      return { root: current, manifest: await readProjectManifest(current) };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("找不到Project Manifest:")) throw error;
    }
    if (current === filesystemRoot) return null;
    current = dirname(current);
  }
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!PROJECT_ID_PATTERN.test(normalized)) throw new Error(`无法从目录名生成Project id: ${value}`);
  return normalized;
}

export async function createProjectManifest(options: {
  readonly root: string;
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
}): Promise<ChatProjectManifest> {
  const root = await projectRoot(options.root);
  const id = options.id?.trim() || slug(basename(root));
  const manifest = parseProjectManifest({
    schemaVersion: 1,
    id,
    name: options.name?.trim() || basename(root),
    description: options.description?.trim() || "",
  });
  const path = resolve(root, PROJECT_MANIFEST_RELATIVE_PATH);
  try {
    const existing = await readProjectManifest(root);
    if (existing.id !== manifest.id) throw new Error(`目录已经属于Project ${existing.id}`);
    return existing;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("找不到Project Manifest:")) throw error;
  }
  await atomicWriteJson(path, manifest);
  return manifest;
}

async function upsertRegistry(
  root: string,
  manifest: ChatProjectManifest,
  chatHome: string,
): Promise<ChatProjectRegistryEntry> {
  let result: ChatProjectRegistryEntry | undefined;
  await serializeRegistryWrite(chatHome, async () => {
    const registry = await readProjectRegistry(chatHome);
    const byPath = registry.projects.find((project) => project.path === root);
    if (byPath !== undefined && byPath.projectId !== manifest.id) {
      throw new Error(`Project路径已经登记为${byPath.projectId}: ${root}`);
    }
    const byId = registry.projects.find((project) => project.projectId === manifest.id);
    const now = new Date().toISOString();
    result = {
      projectId: manifest.id,
      cachedName: manifest.name,
      cachedDescription: manifest.description,
      path: root,
      firstOpenedAt: byId?.firstOpenedAt ?? now,
      lastOpenedAt: now,
    };
    const projects = registry.projects.filter((project) => project.projectId !== manifest.id);
    await atomicWriteJson(getChatHomePaths(chatHome).projectRegistryPath, {
      schemaVersion: 1,
      projects: [...projects, result].sort((left, right) => left.projectId.localeCompare(right.projectId)),
    });
  });
  return result as ChatProjectRegistryEntry;
}

export async function openProject(options: {
  readonly path: string;
  readonly createIfMissing?: boolean;
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly chatHome?: string;
}): Promise<ChatProjectContext> {
  const chatHome = resolve(options.chatHome ?? resolveChatHome());
  const start = await projectRoot(options.path);
  let located = await findProjectManifest(start);
  if (located === null) {
    if (options.createIfMissing !== true) throw new Error(`目录尚未初始化为Chat Project: ${start}`);
    const manifest = await createProjectManifest({
      root: start,
      ...(options.id === undefined ? {} : { id: options.id }),
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.description === undefined ? {} : { description: options.description }),
    });
    located = { root: start, manifest };
  }
  await upsertRegistry(located.root, located.manifest, chatHome);
  return resolveProjectContext(located.manifest.id, chatHome);
}

async function available(entry: ChatProjectRegistryEntry): Promise<boolean> {
  try {
    const root = await projectRoot(entry.path);
    return (await readProjectManifest(root)).id === entry.projectId;
  } catch {
    return false;
  }
}

export async function listProjects(chatHome = resolveChatHome()): Promise<readonly ChatProjectSummary[]> {
  const registry = await readProjectRegistry(chatHome);
  return Promise.all(registry.projects.map(async (project) => ({ ...project, available: await available(project) })));
}

export async function ensureProjectDataLayout(projectId: string, chatHome = resolveChatHome()) {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Project id无效: ${projectId}`);
  const home = await ensureChatHome(chatHome);
  const projectDataDir = resolve(home.projectsDir, projectId);
  const sessionDir = resolve(projectDataDir, "sessions");
  const memoryDir = resolve(projectDataDir, "memory");
  const workflowDataDir = resolve(projectDataDir, "workflow-data");
  await Promise.all([
    mkdir(projectDataDir, { recursive: true, mode: 0o700 }),
    mkdir(sessionDir, { recursive: true, mode: 0o700 }),
    mkdir(memoryDir, { recursive: true, mode: 0o700 }),
    mkdir(workflowDataDir, { recursive: true, mode: 0o700 }),
  ]);
  return { projectDataDir, sessionDir, memoryDir, workflowDataDir };
}

export async function resolveProjectContext(
  projectId: string,
  chatHome = resolveChatHome(),
): Promise<ChatProjectContext> {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Project id无效: ${projectId}`);
  const registry = await readProjectRegistry(chatHome);
  const entry = registry.projects.find((project) => project.projectId === projectId);
  if (entry === undefined) throw new Error(`Project尚未登记: ${projectId}`);
  const root = await projectRoot(entry.path);
  const manifest = await readProjectManifest(root);
  if (manifest.id !== projectId) throw new Error(`Project Manifest与Registry不一致: ${projectId}`);
  const home = await ensureChatHome(chatHome);
  const data = await ensureProjectDataLayout(projectId, home.root);
  const projectConfigDir = resolve(root, ".chat");
  return {
    projectId,
    name: manifest.name,
    description: manifest.description,
    projectRoot: root,
    cwd: root,
    chatHome: home.root,
    agentDir: home.agentDir,
    projectConfigDir,
    projectConfigPath: resolve(projectConfigDir, "config.json"),
    ...data,
  };
}
