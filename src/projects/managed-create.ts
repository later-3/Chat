import { parseChatConfigOverride } from "../chat-config.js";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureChatHome } from "../chat-home.js";
import { assertFileWithin, atomicWriteJson, PersistedWriteError, withFileLock } from "../persistence/versioned-file.js";
import { openProject, readProjectRegistry, resolveProjectContext } from "./registry.js";
import { PROJECT_ID_PATTERN } from "./types.js";
import { ProjectManagementError, type ProjectCreateInput } from "./management-contract.js";

function isWorkspaceName(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value !== "" && value !== "." && value !== ".."
    && !/[\\/<>:"|?*\x00-\x1f\x7f]/u.test(value) && !value.endsWith(".")
    && Buffer.byteLength(value, "utf8") <= 255;
}

async function assertProjectIdAvailable(projectId: string, chatHome: string): Promise<void> {
  if (projectId === "daily" || projectId === "longagentshare") {
    throw new ProjectManagementError("INVALID_INPUT", `Project id ${projectId} 为系统保留`);
  }
  if ((await readProjectRegistry(chatHome)).projects.some((project) => project.projectId === projectId)) {
    throw new ProjectManagementError("IDENTITY_CONFLICT", `Project id 已存在: ${projectId}`);
  }
}

interface CreateOperation {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly fingerprint: string;
  readonly status: "pending" | "completed";
  /** Missing on legacy receipts: their workspace remains named by projectId. */
  readonly workspaceName?: string;
}
function parseOperation(value: unknown): CreateOperation {
  if (typeof value !== "object" || value === null
    || Object.keys(value).some((key) => !["schemaVersion", "projectId", "fingerprint", "status", "workspaceName"].includes(key)) || !("schemaVersion" in value) || value.schemaVersion !== 1
    || !("projectId" in value) || typeof value.projectId !== "string" || !PROJECT_ID_PATTERN.test(value.projectId)
    || value.projectId === "daily" || !("fingerprint" in value) || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !("status" in value) || (value.status !== "pending" && value.status !== "completed")
    || ("workspaceName" in value && !isWorkspaceName(value.workspaceName))) {
    throw new ProjectManagementError("PERSISTENCE_INCOMPLETE", "Project创建恢复标记损坏，不能继续创建");
  }
  return { schemaVersion: 1, projectId: value.projectId, fingerprint: value.fingerprint, status: value.status,
    ...("workspaceName" in value ? { workspaceName: value.workspaceName as string } : {}) };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function allocateWorkspace(name: string, projectId: string, operationsDir: string, workspacesDir: string) {
  const reserved = new Set(["daily", "longagentshare"]);
  // Pending receipts reserve names even if the process stopped before mkdir.
  const files = await readdir(operationsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
    const path = resolve(operationsDir, file);
    await assertFileWithin(path, operationsDir);
    const operation = parseOperation(JSON.parse(await readFile(path, "utf8")));
    if (operation.projectId === projectId) throw new ProjectManagementError("IDENTITY_CONFLICT", "Project id已被其他创建请求使用");
    if (operation.status === "pending") reserved.add((operation.workspaceName ?? operation.projectId).normalize("NFC").toLowerCase());
  }
  for (let suffix = 1; ; suffix++) {
    const candidate = suffix === 1 ? name : `${name} (${suffix})`;
    if (!reserved.has(candidate.normalize("NFC").toLowerCase()) && !await exists(resolve(workspacesDir, candidate))) return candidate;
  }
}

/** Durable idempotency is scoped to the trusted source Session, not an Agent-supplied owner. */
export async function createManagedProject(input: ProjectCreateInput, chatHome: string, sourceSessionId: string) {
  const home = await ensureChatHome(chatHome);
  const name = input.name.trim();
  if (!name) throw new ProjectManagementError("INVALID_INPUT", "Project名称不能为空");
  const description = input.description?.trim() ?? "";
  const explicitId = input.id?.trim() ?? "";
  if (explicitId !== "" && !PROJECT_ID_PATTERN.test(explicitId)) {
    throw new ProjectManagementError("INVALID_INPUT", "Project id只能包含小写字母、数字和单个连字符分隔段");
  }
  const key = createHash("sha256").update(JSON.stringify([sourceSessionId, input.requestId])).digest("hex");
  const operationsDir = resolve(home.runtimeDir, "project-operations");
  const marker = resolve(operationsDir, `${key}.json`);
  const fingerprint = createHash("sha256").update(JSON.stringify([name, description, explicitId || null])).digest("hex");
  const legacyFingerprint = createHash("sha256").update(JSON.stringify([name, description])).digest("hex");
  // Allocate IDs and readable directory names together in the single Backend.
  return withFileLock(operationsDir, () => withFileLock(marker, async () => {
    await assertFileWithin(marker, home.root);
    let operation: CreateOperation;
    try { operation = parseOperation(JSON.parse(await readFile(marker, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!isWorkspaceName(name) || Buffer.byteLength(name, "utf8") > 240) throw new ProjectManagementError("INVALID_INPUT", "Project名称须为有效目录名：不能包含路径分隔符、控制字符或特殊路径，UTF-8长度最多240字节");
      const projectId = explicitId !== "" ? explicitId : randomBytes(16).toString("hex");
      await assertProjectIdAvailable(projectId, home.root);
      if (await exists(resolve(home.projectsDir, projectId))) throw new ProjectManagementError("IDENTITY_CONFLICT", "Project id已有运行数据");
      const workspaceName = await allocateWorkspace(name, projectId, operationsDir, home.workspacesDir);
      operation = { schemaVersion: 1, projectId, fingerprint, status: "pending", workspaceName };
      await atomicWriteJson(marker, operation);
    }
    if (operation.fingerprint !== fingerprint && !(explicitId === "" && operation.workspaceName === undefined && operation.fingerprint === legacyFingerprint)) {
      throw new ProjectManagementError("IDEMPOTENCY_CONFLICT", "同一个requestId已用于不同的创建参数");
    }
    if (operation.status === "completed") return { status: "existing", project: await resolveProjectContext(operation.projectId, home.root) };
    const root = resolve(home.workspacesDir, operation.workspaceName ?? operation.projectId);
    await assertFileWithin(root, home.workspacesDir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const config = resolve(root, ".chat", "config.json");
    await assertFileWithin(config, root);
    const manifest = resolve(root, ".chat", "project.json");
    await assertFileWithin(manifest, root);
    // Verify a resumed operation owns existing files before opening or registering them.
    try {
      const existing: unknown = JSON.parse(await readFile(manifest, "utf8"));
      if (typeof existing !== "object" || existing === null || !("id" in existing) || existing.id !== operation.projectId) {
        throw new ProjectManagementError("IDENTITY_CONFLICT", "托管目录已有其他Project身份");
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await withFileLock(config, async () => {
      try { parseChatConfigOverride(JSON.parse(await readFile(config, "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await atomicWriteJson(config, { schemaVersion: 1 });
      }
    });
    const project = await openProject({ path: root, id: operation.projectId, name, description, chatHome: home.root });
    try { await atomicWriteJson(marker, { ...operation, status: "completed" }); }
    catch (error) { throw new PersistedWriteError("Project已登记但恢复标记未完成；请使用相同requestId重试", { cause: error }); }
    return { status: "created", project };
  }));
}
