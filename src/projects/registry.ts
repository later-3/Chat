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
  type ChatProjectKind,
  type ChatProjectSummary,
} from "./types.js";

export const PROJECT_MANIFEST_RELATIVE_PATH = join(".chat", "project.json");
/** 公共 Long Agent 资源共享空间（归一后替代旧共享 daily）。 */
export const LONG_AGENT_SHARE_PROJECT_ID = "longagentshare";
export const LONG_AGENT_SHARE_PROJECT_NAME = "Long Agent 共享";
/** 归一迁移前的共享 daily id；仅供迁移模块识别旧数据。 */
export const LEGACY_DAILY_PROJECT_ID = "daily";

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
  kind: ChatProjectKind = "project",
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
      ...(kind === "project" ? {} : { kind }),
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
  kind: ChatProjectKind = "project",
): Promise<ChatProjectContext> {
  const shareRoot = await realpath(getChatHomePaths(chatHome).longAgentShareWorkspaceDir).catch(() =>
    resolve(getChatHomePaths(chatHome).longAgentShareWorkspaceDir));
  if (manifest.id === LONG_AGENT_SHARE_PROJECT_ID && root !== shareRoot) {
    throw new Error(`Project id ${LONG_AGENT_SHARE_PROJECT_ID}只保留给Chat管理的Long Agent共享空间`);
  }
  await upsertRegistry(root, manifest, chatHome, kind);
  return resolveProjectContext(manifest.id, chatHome);
}

/** 每个 Long Agent 的 home Project id 就是它的稳定 longAgentId。 */
export function agentHomeProjectId(longAgentId: string): string {
  if (!LONG_AGENT_ID_PATTERN.test(longAgentId)) throw new Error(`longAgentId格式无效: ${longAgentId}`);
  return longAgentId;
}

/** 归一迁移前的 per-agent Daily Project id；只供迁移模块识别旧数据。 */
export function legacyAgentDailyProjectId(longAgentId: string): string {
  return `daily-${longAgentId}`;
}

async function ensureManagedProject(input: {
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly root: string;
  readonly chatHome: string;
  readonly kind: ChatProjectKind;
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
      throw new Error(`受管Workspace已经声明为其他Project: ${manifest.id}`);
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
  return registerProject(canonicalRoot, manifest, home.root, input.kind);
}

/** 公共 Long Agent 资源共享空间（原共享 daily）：不默认打开，也不属于任何用户项目。 */
export async function ensureLongAgentShareProject(chatHome = resolveChatHome()): Promise<ChatProjectContext> {
  const home = await ensureChatHome(chatHome);
  return ensureManagedProject({
    projectId: LONG_AGENT_SHARE_PROJECT_ID,
    name: LONG_AGENT_SHARE_PROJECT_NAME,
    description: "公共 Long Agent 资源共享空间",
    root: home.longAgentShareWorkspaceDir,
    chatHome: home.root,
    kind: "share",
  });
}

/**
 * 创建或解析某个 Long Agent 的 home Project：项目 id 就是它的 longAgentId，
 * 根目录就是它的 Agent Workspace（`long-agents/<id>/workspace`），
 * 数据目录（会话、memory、资源）也在 `long-agents/<id>/` 下。
 */
export async function ensureAgentHomeProject(
  longAgentId: string,
  agentName: string,
  chatHome = resolveChatHome(),
): Promise<ChatProjectContext> {
  const home = await ensureChatHome(chatHome);
  return ensureManagedProject({
    projectId: agentHomeProjectId(longAgentId),
    name: agentName,
    description: `Long Agent ${agentName} 的 home`,
    root: resolve(home.root, "long-agents", longAgentId, "workspace"),
    chatHome: home.root,
    kind: "agent",
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
  // 系统管理目录不能打开为用户项目：Agent home 根与共享空间都有自己的归属。
  // （workspaces/ 下还住着用户经 project_create 建的受管项目，不能一并拦掉。）
  const home = getChatHomePaths(chatHome);
  const systemRoots = await Promise.all(
    [resolve(home.root, "long-agents"), home.longAgentShareWorkspaceDir].map(async (systemRoot) => (
      await realpath(systemRoot).catch(() => resolve(systemRoot))
    )),
  );
  for (const systemRoot of systemRoots) {
    if (root === systemRoot || root.startsWith(`${systemRoot}/`)) {
      throw new Error(`该目录由 Chat 系统管理，不能打开为项目: ${root}`);
    }
  }
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
  await ensureLongAgentShareProject(chatHome);
  const registry = await readProjectRegistry(chatHome);
  return Promise.all(registry.projects.map(async (project) => ({
    ...project,
    available: await available(project),
    kind: project.kind ?? "project" as const,
  })));
}

export async function ensureProjectDataLayout(
  projectId: string,
  chatHome = resolveChatHome(),
  kind: ChatProjectKind = "project",
) {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Project id无效: ${projectId}`);
  const home = await ensureChatHome(chatHome);
  // Agent home 的全部事实（会话、资源、memory、workspace）都在 long-agents/<id>/ 下。
  const projectDataDir = kind === "agent"
    ? resolve(home.root, "long-agents", projectId)
    : resolve(home.projectsDir, projectId);
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
  const kind: ChatProjectKind = entry.kind ?? "project";
  const data = await ensureProjectDataLayout(projectId, home.root, kind);
  const projectConfigDir = resolve(root, ".chat");
  return {
    projectId,
    name: manifest.name,
    description: manifest.description,
    kind,
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
