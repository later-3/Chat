import { assertFileWithin, expectRevision, PersistedWriteError, withFileLock } from "../persistence/versioned-file.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ensureChatHome, getChatHomePaths, resolveChatHome } from "../chat-home.js";
import { LONG_AGENT_ID_PATTERN } from "../long-agents/types.js";
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
export const DAILY_PROJECT_ID = "daily";
export const DAILY_PROJECT_NAME = "Daily";

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

function isMissingManifest(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("找不到Project Manifest:");
}

function slug(value: string): string | undefined {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return PROJECT_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function createProjectId(root: string): string {
  const prefix = slug(basename(root)) ?? "project";
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

export async function createProjectManifest(options: {
  readonly root: string;
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
}): Promise<ChatProjectManifest> {
  const root = await projectRoot(options.root);
  const id = options.id?.trim() || createProjectId(root);
  const manifest = parseProjectManifest({
    schemaVersion: 1,
    id,
    name: options.name?.trim() || basename(root),
    description: options.description?.trim() || "",
  });
  const path = resolve(root, PROJECT_MANIFEST_RELATIVE_PATH);
  await assertFileWithin(path, root);
  try {
    const existing = await readProjectManifest(root);
    if (existing.id !== manifest.id) throw new Error(`目录已经属于Project ${existing.id}`);
    return existing;
  } catch (error) {
    if (!isMissingManifest(error)) throw error;
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

interface ProjectPathOptions {
  readonly path: string;
  readonly chatHome?: string;
}

export interface OpenProjectOptions extends ProjectPathOptions {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
}

async function registerProject(
  root: string,
  manifest: ChatProjectManifest,
  chatHome: string,
): Promise<ChatProjectContext> {
  const dailyRoot = await realpath(getChatHomePaths(chatHome).dailyWorkspaceDir).catch(() =>
    resolve(getChatHomePaths(chatHome).dailyWorkspaceDir));
  if (manifest.id === DAILY_PROJECT_ID && root !== dailyRoot) {
    throw new Error(`Project id ${DAILY_PROJECT_ID}只保留给Chat管理的Daily Project`);
  }
  await upsertRegistry(root, manifest, chatHome);
  return resolveProjectContext(manifest.id, chatHome);
}

const AGENT_DAILY_PROJECT_PREFIX = "daily-";

/** 每个 Long Agent 的独立 Daily Project id（管理架构 S3）。 */
export function agentDailyProjectId(longAgentId: string): string {
  if (!LONG_AGENT_ID_PATTERN.test(longAgentId)) throw new Error(`longAgentId格式无效: ${longAgentId}`);
  return `${AGENT_DAILY_PROJECT_PREFIX}${longAgentId}`;
}

async function ensureManagedDailyProject(input: {
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly root: string;
  readonly chatHome: string;
}): Promise<ChatProjectContext> {
  const home = await ensureChatHome(input.chatHome);
  const root = input.root;
  const configDir = resolve(root, ".chat");
  await Promise.all([
    mkdir(root, { recursive: true, mode: 0o700 }),
    mkdir(resolve(configDir, "skills"), { recursive: true, mode: 0o700 }),
    mkdir(resolve(configDir, "extensions"), { recursive: true, mode: 0o700 }),
    mkdir(resolve(configDir, "prompts"), { recursive: true, mode: 0o700 }),
  ]);

  const manifestPath = resolve(root, PROJECT_MANIFEST_RELATIVE_PATH);
  let manifest: ChatProjectManifest;
  try {
    manifest = await readProjectManifest(root);
    if (manifest.id !== input.projectId) {
      throw new Error(`Daily Workspace已经声明为其他Project: ${manifest.id}`);
    }
  } catch (error) {
    if (!isMissingManifest(error)) throw error;
    manifest = {
      schemaVersion: 1,
      id: input.projectId,
      name: input.name,
      description: input.description,
    };
    await atomicWriteJson(manifestPath, manifest);
  }

  const configPath = resolve(configDir, "config.json");
  try {
    await stat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWriteJson(configPath, { schemaVersion: 1 });
  }

  const canonicalRoot = await projectRoot(root);
  const existing = (await readProjectRegistry(home.root)).projects.find(
    (project) => project.projectId === input.projectId,
  );
  if (existing !== undefined
    && existing.path === canonicalRoot
    && existing.cachedName === manifest.name
    && existing.cachedDescription === manifest.description) {
    return resolveProjectContext(input.projectId, home.root);
  }
  return registerProject(canonicalRoot, manifest, home.root);
}

/** Creates the stable system-managed Daily Project through the normal Project contract. */
export async function ensureDailyProject(chatHome = resolveChatHome()): Promise<ChatProjectContext> {
  const home = await ensureChatHome(chatHome);
  return ensureManagedDailyProject({
    projectId: DAILY_PROJECT_ID,
    name: DAILY_PROJECT_NAME,
    description: "Chat管理的默认日常Project",
    root: home.dailyWorkspaceDir,
    chatHome: home.root,
  });
}

/** 创建或解析某个 Long Agent 的独立 Daily Project 与 Managed Workspace。 */
export async function ensureAgentDailyProject(
  longAgentId: string,
  agentName: string,
  chatHome = resolveChatHome(),
): Promise<ChatProjectContext> {
  const home = await ensureChatHome(chatHome);
  const projectId = agentDailyProjectId(longAgentId);
  return ensureManagedDailyProject({
    projectId,
    name: `Daily · ${agentName}`,
    description: `Long Agent ${agentName} 的日常Project`,
    root: resolve(home.workspacesDir, projectId),
    chatHome: home.root,
  });
}

/** Opens only the selected directory; it never searches parent or child directories. */
export async function openExistingProject(options: ProjectPathOptions): Promise<ChatProjectContext> {
  const chatHome = resolve(options.chatHome ?? resolveChatHome());
  const root = await projectRoot(options.path);
  return registerProject(root, await readProjectManifest(root), chatHome);
}

const projectOpens = new Map<string, Promise<ChatProjectContext>>();

/** The directory explicitly opened by the user is the Project root. */
export async function openProject(options: OpenProjectOptions): Promise<ChatProjectContext> {
  const chatHome = resolve(options.chatHome ?? resolveChatHome());
  const root = await projectRoot(options.path);
  const key = `${chatHome}\0${root}`;
  const active = projectOpens.get(key);
  if (active !== undefined) return active;

  const opened = withFileLock(resolve(root, PROJECT_MANIFEST_RELATIVE_PATH), async () => {
    let manifest: ChatProjectManifest;
    try {
      manifest = await readProjectManifest(root);
    } catch (error) {
      if (!isMissingManifest(error)) throw error;
      manifest = await createProjectManifest({
        root,
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.description === undefined ? {} : { description: options.description }),
      });
    }
    return registerProject(root, manifest, chatHome);
  });
  projectOpens.set(key, opened);
  try {
    return await opened;
  } finally {
    if (projectOpens.get(key) === opened) projectOpens.delete(key);
  }
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
  await ensureDailyProject(chatHome);
  const registry = await readProjectRegistry(chatHome);
  return Promise.all(registry.projects.map(async (project) => ({
    ...project,
    available: await available(project),
    kind: project.projectId === DAILY_PROJECT_ID ? "daily" as const : "directory" as const,
  })));
}

export async function ensureProjectDataLayout(projectId: string, chatHome = resolveChatHome()) {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Project id无效: ${projectId}`);
  const home = await ensureChatHome(chatHome);
  const projectDataDir = resolve(home.projectsDir, projectId);
  const sessionDir = resolve(projectDataDir, "sessions");
  const memoryDir = resolve(projectDataDir, "memory");
  const promptResourceDir = resolve(projectDataDir, "prompt-resources");
  const workflowsDir = resolve(projectDataDir, "workflows");
  await Promise.all([
    mkdir(projectDataDir, { recursive: true, mode: 0o700 }),
    mkdir(sessionDir, { recursive: true, mode: 0o700 }),
    mkdir(memoryDir, { recursive: true, mode: 0o700 }),
    mkdir(promptResourceDir, { recursive: true, mode: 0o700 }),
    mkdir(workflowsDir, { recursive: true, mode: 0o700 }),
  ]);
  return { projectDataDir, sessionDir, memoryDir, promptResourceDir, workflowsDir };
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

/** Manifest owns identity; Registry metadata is a repairable display cache. */
export async function updateProjectManifest(
  projectId: string,
  changes: { readonly name?: string; readonly description?: string },
  expectedRevision: string,
  chatHome = resolveChatHome(),
): Promise<ChatProjectContext> {
  const project = await resolveProjectContext(projectId, chatHome);
  const path = resolve(project.projectConfigDir, "project.json");
  return withFileLock(path, async () => {
    await assertFileWithin(path, project.projectRoot);
    await expectRevision(path, expectedRevision);
    const manifest = parseProjectManifest({ ...await readProjectManifest(project.projectRoot), ...changes });
    await atomicWriteJson(path, manifest);
    try { return await registerProject(project.projectRoot, manifest, chatHome); }
    catch (error) {
      throw new PersistedWriteError("Project资料已保存，但Registry缓存刷新失败；重新打开该Project以恢复", { cause: error });
    }
  });
}
