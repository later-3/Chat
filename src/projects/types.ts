export const PROJECT_MANIFEST_SCHEMA_VERSION = 1;
export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;
export const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ChatProjectManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface ChatProjectRegistryEntry {
  readonly projectId: string;
  readonly cachedName: string;
  readonly cachedDescription: string;
  readonly path: string;
  readonly firstOpenedAt: string;
  readonly lastOpenedAt: string;
}

export interface ChatProjectRegistry {
  readonly schemaVersion: 1;
  readonly projects: readonly ChatProjectRegistryEntry[];
}

export interface ChatProjectSummary extends ChatProjectRegistryEntry {
  readonly available: boolean;
}

export interface ChatProjectContext {
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly chatHome: string;
  readonly agentDir: string;
  readonly projectConfigDir: string;
  readonly projectConfigPath: string;
  readonly projectDataDir: string;
  readonly sessionDir: string;
  readonly memoryDir: string;
  readonly workflowDataDir: string;
}

export interface ChatExecutionContext extends ChatProjectContext {
  readonly personalId: "later";
  readonly sessionId?: string;
  readonly workflowId?: string;
  readonly workflowInvocationId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
}

export type ResourceTarget =
  | { readonly type: "personal" }
  | { readonly type: "project"; readonly projectId: string }
  | { readonly type: "session"; readonly projectId: string; readonly sessionId: string }
  | { readonly type: "invocation"; readonly invocationId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  const fields = new Set(allowed);
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (unknown.length > 0) throw new Error(`${subject}包含未知字段: ${unknown.join(", ")}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}必须是非空字符串`);
  return value.trim();
}

export function parseProjectManifest(value: unknown): ChatProjectManifest {
  if (!isRecord(value) || value.schemaVersion !== PROJECT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Project Manifest必须使用schemaVersion ${PROJECT_MANIFEST_SCHEMA_VERSION}`);
  }
  exactFields(value, ["schemaVersion", "id", "name", "description"], "Project Manifest");
  const id = requiredString(value.id, "Project id");
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new Error("Project id只能包含小写字母、数字和单个连字符分隔段");
  }
  return {
    schemaVersion: 1,
    id,
    name: requiredString(value.name, "Project name"),
    description: typeof value.description === "string" ? value.description.trim() : "",
  };
}

function parseRegistryEntry(value: unknown): ChatProjectRegistryEntry {
  if (!isRecord(value)) throw new Error("Project Registry entry必须是对象");
  exactFields(
    value,
    ["projectId", "cachedName", "cachedDescription", "path", "firstOpenedAt", "lastOpenedAt"],
    "Project Registry entry",
  );
  const projectId = requiredString(value.projectId, "Registry projectId");
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Registry projectId无效: ${projectId}`);
  const firstOpenedAt = requiredString(value.firstOpenedAt, "Registry firstOpenedAt");
  const lastOpenedAt = requiredString(value.lastOpenedAt, "Registry lastOpenedAt");
  if (Number.isNaN(Date.parse(firstOpenedAt)) || Number.isNaN(Date.parse(lastOpenedAt))) {
    throw new Error(`Registry ${projectId}时间无效`);
  }
  return {
    projectId,
    cachedName: requiredString(value.cachedName, "Registry cachedName"),
    cachedDescription: typeof value.cachedDescription === "string" ? value.cachedDescription : "",
    path: requiredString(value.path, "Registry path"),
    firstOpenedAt,
    lastOpenedAt,
  };
}

export function parseProjectRegistry(value: unknown): ChatProjectRegistry {
  if (!isRecord(value) || value.schemaVersion !== PROJECT_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Project Registry必须使用schemaVersion ${PROJECT_REGISTRY_SCHEMA_VERSION}`);
  }
  exactFields(value, ["schemaVersion", "projects"], "Project Registry");
  if (!Array.isArray(value.projects)) throw new Error("Project Registry projects必须是数组");
  const projects = value.projects.map(parseRegistryEntry);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.projectId)) throw new Error(`Project Registry存在重复projectId: ${project.projectId}`);
    if (paths.has(project.path)) throw new Error(`Project Registry存在重复path: ${project.path}`);
    ids.add(project.projectId);
    paths.add(project.path);
  }
  return { schemaVersion: 1, projects };
}
