import { parseChatConfigOverride } from "../chat-config.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureChatHome } from "../chat-home.js";
import { assertFileWithin, atomicWriteJson, PersistedWriteError, withFileLock } from "../persistence/versioned-file.js";
import { openProject, resolveProjectContext } from "./registry.js";
import { PROJECT_ID_PATTERN } from "./types.js";
import { ProjectManagementError, type ProjectCreateInput } from "./management-contract.js";

interface CreateOperation {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly fingerprint: string;
  readonly status: "pending" | "completed";
}
function parseOperation(value: unknown): CreateOperation {
  if (typeof value !== "object" || value === null
    || Object.keys(value).some((key) => !["schemaVersion", "projectId", "fingerprint", "status"].includes(key)) || !("schemaVersion" in value) || value.schemaVersion !== 1
    || !("projectId" in value) || typeof value.projectId !== "string" || !PROJECT_ID_PATTERN.test(value.projectId)
    || value.projectId === "daily" || !("fingerprint" in value) || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !("status" in value) || (value.status !== "pending" && value.status !== "completed")) {
    throw new ProjectManagementError("PERSISTENCE_INCOMPLETE", "Project创建恢复标记损坏，不能继续创建");
  }
  return { schemaVersion: 1, projectId: value.projectId, fingerprint: value.fingerprint, status: value.status };
}

/** Durable idempotency is scoped to the trusted source Session, not an Agent-supplied owner. */
export async function createManagedProject(input: ProjectCreateInput, chatHome: string, sourceSessionId: string) {
  const home = await ensureChatHome(chatHome);
  const name = input.name.trim();
  if (!name) throw new ProjectManagementError("INVALID_INPUT", "Project名称不能为空");
  const description = input.description?.trim() ?? "";
  const key = createHash("sha256").update(JSON.stringify([sourceSessionId, input.requestId])).digest("hex");
  const marker = resolve(home.runtimeDir, "project-operations", `${key}.json`);
  const fingerprint = createHash("sha256").update(JSON.stringify([name, description])).digest("hex");
  return withFileLock(marker, async () => {
    await assertFileWithin(marker, home.root);
    let operation: CreateOperation;
    try { operation = parseOperation(JSON.parse(await readFile(marker, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      operation = { schemaVersion: 1, projectId: `project-${randomUUID().replaceAll("-", "")}`, fingerprint, status: "pending" };
      await atomicWriteJson(marker, operation);
    }
    if (operation.fingerprint !== fingerprint) throw new ProjectManagementError("IDEMPOTENCY_CONFLICT", "同一个requestId已用于不同的创建参数");
    if (operation.status === "completed") return { status: "existing", project: await resolveProjectContext(operation.projectId, home.root) };
    const root = resolve(home.workspacesDir, operation.projectId);
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
  });
}
