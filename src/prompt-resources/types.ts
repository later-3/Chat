import { PROJECT_ID_PATTERN } from "../projects/types.js";

export const PROMPT_RESOURCE_SCHEMA_VERSION = 1;
export const MAX_PROMPT_RESOURCE_CONTENT_CHARS = 100_000;
export const MAX_PROMPT_RESOURCE_TAGS = 32;

export type PromptResourceKind = "rule" | "experience";
export type PromptResourceStatus = "active" | "archived";
export type PromptResourceTarget =
  | { readonly type: "personal" }
  | { readonly type: "project"; readonly projectId: string };
export type PromptResourceAuthor =
  | { readonly type: "user" }
  | { readonly type: "agent"; readonly agentId: string };

export interface PromptResourceSource {
  readonly type: "session" | "manual";
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly workflowInvocationId?: string;
  readonly entryIds: readonly string[];
  readonly context: string;
  readonly capturedAt: string;
}

export interface PromptResourceRevision {
  readonly schemaVersion: typeof PROMPT_RESOURCE_SCHEMA_VERSION;
  readonly id: string;
  readonly revision: number;
  readonly kind: PromptResourceKind;
  readonly title: string;
  readonly purpose: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly status: PromptResourceStatus;
  readonly sources: readonly PromptResourceSource[];
  readonly author: PromptResourceAuthor;
  readonly createdAt: string;
}

export interface AddressedPromptResourceRevision extends PromptResourceRevision {
  readonly target: PromptResourceTarget;
}

export interface PromptResourceDocument {
  readonly schemaVersion: typeof PROMPT_RESOURCE_SCHEMA_VERSION;
  readonly id: string;
  readonly revisions: readonly PromptResourceRevision[];
}

export interface PromptResourceDraft {
  readonly schemaVersion: typeof PROMPT_RESOURCE_SCHEMA_VERSION;
  readonly id: string;
  readonly baseResourceId?: string;
  readonly baseRevision?: number;
  readonly kind: PromptResourceKind;
  readonly title: string;
  readonly purpose: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly status: PromptResourceStatus;
  readonly sources: readonly PromptResourceSource[];
  readonly author: PromptResourceAuthor;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AddressedPromptResourceDraft extends PromptResourceDraft {
  readonly target: PromptResourceTarget;
}

export interface PromptResourceDraftInput {
  readonly baseResourceId?: string;
  readonly kind: PromptResourceKind;
  readonly title: string;
  readonly purpose: string;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly status?: PromptResourceStatus;
  readonly sources?: readonly PromptResourceSource[];
  readonly author: PromptResourceAuthor;
}

export interface PromptResourceDraftPatch {
  readonly expectedUpdatedAt: string;
  readonly kind?: PromptResourceKind;
  readonly title?: string;
  readonly purpose?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly status?: PromptResourceStatus;
  readonly sources?: readonly PromptResourceSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownFields(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  const fields = new Set(allowed);
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (unknown.length > 0) throw new Error(`${subject}包含未知字段: ${unknown.join(", ")}`);
}

function readString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new Error(`${field}必须是${allowEmpty ? "字符串" : "非空字符串"}`);
  }
  if (value.length > max) throw new Error(`${field}不能超过${max}个字符`);
  return value;
}

function readIsoTime(value: unknown, field: string): string {
  const time = readString(value, field, 64);
  if (Number.isNaN(Date.parse(time))) throw new Error(`${field}必须是ISO时间`);
  return time;
}

export function parsePromptResourceId(value: unknown, field = "id"): string {
  const id = readString(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`${field}格式无效`);
  return id;
}

function readStringArray(value: unknown, field: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${field}必须是字符串数组`);
  if (value.length > maxItems) throw new Error(`${field}不能超过${maxItems}项`);
  return [...new Set(value.map((item, index) => readString(item, `${field}[${index}]`, maxChars)))];
}

function parseKind(value: unknown): PromptResourceKind {
  if (value !== "rule" && value !== "experience") throw new Error("kind必须是rule或experience");
  return value;
}

function parseStatus(value: unknown): PromptResourceStatus {
  if (value !== "active" && value !== "archived") throw new Error("status必须是active或archived");
  return value;
}

export function parsePromptResourceTarget(value: unknown): PromptResourceTarget {
  if (!isRecord(value)) throw new Error("Prompt资源Target必须是对象");
  if (value.type === "personal") {
    assertKnownFields(value, ["type"], "Personal Prompt资源Target");
    return { type: "personal" };
  }
  if (value.type === "project") {
    assertKnownFields(value, ["type", "projectId"], "Project Prompt资源Target");
    if (typeof value.projectId !== "string" || !PROJECT_ID_PATTERN.test(value.projectId)) {
      throw new Error("Prompt资源Target projectId无效");
    }
    return { type: "project", projectId: value.projectId };
  }
  throw new Error("Prompt资源Target type必须是personal或project");
}

export function promptResourceTargetKey(target: PromptResourceTarget): string {
  return target.type === "personal" ? "personal" : `project:${target.projectId}`;
}

export function parsePromptResourceAuthor(value: unknown): PromptResourceAuthor {
  if (!isRecord(value)) throw new Error("author必须是对象");
  if (value.type === "user") {
    assertKnownFields(value, ["type"], "user author");
    return { type: "user" };
  }
  if (value.type === "agent") {
    assertKnownFields(value, ["type", "agentId"], "agent author");
    return { type: "agent", agentId: parsePromptResourceId(value.agentId, "author.agentId") };
  }
  throw new Error("author.type无效");
}

export function parsePromptResourceSource(value: unknown): PromptResourceSource {
  if (!isRecord(value) || (value.type !== "session" && value.type !== "manual")) {
    throw new Error("source.type必须是session或manual");
  }
  assertKnownFields(
    value,
    ["type", "projectId", "sessionId", "workflowInvocationId", "entryIds", "context", "capturedAt"],
    "Prompt资源source",
  );
  const projectId = value.projectId === undefined
    ? undefined
    : readString(value.projectId, "source.projectId", 128);
  if (projectId !== undefined && !PROJECT_ID_PATTERN.test(projectId)) throw new Error("source.projectId无效");
  const sessionId = value.sessionId === undefined
    ? undefined
    : parsePromptResourceId(value.sessionId, "source.sessionId");
  if (value.type === "session" && (projectId === undefined || sessionId === undefined)) {
    throw new Error("Session来源必须包含projectId和sessionId");
  }
  const workflowInvocationId = value.workflowInvocationId === undefined
    ? undefined
    : parsePromptResourceId(value.workflowInvocationId, "source.workflowInvocationId");
  return {
    type: value.type,
    ...(projectId === undefined ? {} : { projectId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(workflowInvocationId === undefined ? {} : { workflowInvocationId }),
    entryIds: value.entryIds === undefined
      ? []
      : readStringArray(value.entryIds, "source.entryIds", 128, 128),
    context: readString(value.context ?? "", "source.context", 20_000, true),
    capturedAt: readIsoTime(value.capturedAt, "source.capturedAt"),
  };
}

function parseSources(value: unknown): PromptResourceSource[] {
  if (!Array.isArray(value)) throw new Error("sources必须是数组");
  if (value.length > 32) throw new Error("sources不能超过32项");
  return value.map(parsePromptResourceSource);
}

function parseFields(value: Record<string, unknown>) {
  return {
    kind: parseKind(value.kind),
    title: readString(value.title, "title", 200),
    purpose: readString(value.purpose, "purpose", 4_000),
    content: readString(value.content, "content", MAX_PROMPT_RESOURCE_CONTENT_CHARS),
    tags: value.tags === undefined ? [] : readStringArray(value.tags, "tags", MAX_PROMPT_RESOURCE_TAGS, 64),
    status: value.status === undefined ? "active" as const : parseStatus(value.status),
    sources: value.sources === undefined ? [] : parseSources(value.sources),
  };
}

export function parsePromptResourceDraftInput(value: unknown): PromptResourceDraftInput {
  if (!isRecord(value)) throw new Error("Prompt资源草稿必须是对象");
  assertKnownFields(
    value,
    ["baseResourceId", "kind", "title", "purpose", "content", "tags", "status", "sources", "author"],
    "Prompt资源草稿",
  );
  const baseResourceId = value.baseResourceId === undefined
    ? undefined
    : parsePromptResourceId(value.baseResourceId, "baseResourceId");
  return {
    ...(baseResourceId === undefined ? {} : { baseResourceId }),
    ...parseFields(value),
    author: parsePromptResourceAuthor(value.author),
  };
}

export function parsePromptResourceDraftPatch(value: unknown): PromptResourceDraftPatch {
  if (!isRecord(value)) throw new Error("Prompt资源草稿修改必须是对象");
  assertKnownFields(
    value,
    ["expectedUpdatedAt", "kind", "title", "purpose", "content", "tags", "status", "sources"],
    "Prompt资源草稿修改",
  );
  const patch = {
    expectedUpdatedAt: readIsoTime(value.expectedUpdatedAt, "expectedUpdatedAt"),
    ...(value.kind === undefined ? {} : { kind: parseKind(value.kind) }),
    ...(value.title === undefined ? {} : { title: readString(value.title, "title", 200) }),
    ...(value.purpose === undefined ? {} : { purpose: readString(value.purpose, "purpose", 4_000) }),
    ...(value.content === undefined
      ? {}
      : { content: readString(value.content, "content", MAX_PROMPT_RESOURCE_CONTENT_CHARS) }),
    ...(value.tags === undefined
      ? {}
      : { tags: readStringArray(value.tags, "tags", MAX_PROMPT_RESOURCE_TAGS, 64) }),
    ...(value.status === undefined ? {} : { status: parseStatus(value.status) }),
    ...(value.sources === undefined ? {} : { sources: parseSources(value.sources) }),
  };
  if (Object.keys(patch).length === 1) throw new Error("Prompt资源草稿修改至少包含一个变更字段");
  return patch;
}

export function parsePromptResourceRevision(value: unknown): PromptResourceRevision {
  if (!isRecord(value) || value.schemaVersion !== PROMPT_RESOURCE_SCHEMA_VERSION) {
    throw new Error("Prompt资源版本必须使用schemaVersion 1");
  }
  assertKnownFields(
    value,
    ["schemaVersion", "id", "revision", "kind", "title", "purpose", "content", "tags", "status", "sources", "author", "createdAt"],
    "Prompt资源版本",
  );
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw new Error("revision必须是正整数");
  }
  return {
    schemaVersion: PROMPT_RESOURCE_SCHEMA_VERSION,
    id: parsePromptResourceId(value.id),
    revision: value.revision as number,
    ...parseFields(value),
    author: parsePromptResourceAuthor(value.author),
    createdAt: readIsoTime(value.createdAt, "createdAt"),
  };
}

export function parsePromptResourceDocument(value: unknown): PromptResourceDocument {
  if (!isRecord(value) || value.schemaVersion !== PROMPT_RESOURCE_SCHEMA_VERSION) {
    throw new Error("Prompt资源文档必须使用schemaVersion 1");
  }
  assertKnownFields(value, ["schemaVersion", "id", "revisions"], "Prompt资源文档");
  const id = parsePromptResourceId(value.id);
  if (!Array.isArray(value.revisions) || value.revisions.length === 0) {
    throw new Error("Prompt资源文档必须包含版本");
  }
  const revisions = value.revisions.map(parsePromptResourceRevision);
  if (revisions.some((revision, index) => revision.id !== id || revision.revision !== index + 1)) {
    throw new Error("Prompt资源版本链无效");
  }
  return { schemaVersion: PROMPT_RESOURCE_SCHEMA_VERSION, id, revisions };
}

export function parsePromptResourceDraft(value: unknown): PromptResourceDraft {
  if (!isRecord(value) || value.schemaVersion !== PROMPT_RESOURCE_SCHEMA_VERSION) {
    throw new Error("Prompt资源草稿必须使用schemaVersion 1");
  }
  assertKnownFields(
    value,
    ["schemaVersion", "id", "baseResourceId", "baseRevision", "kind", "title", "purpose", "content", "tags", "status", "sources", "author", "createdAt", "updatedAt"],
    "Prompt资源草稿",
  );
  const baseResourceId = value.baseResourceId === undefined
    ? undefined
    : parsePromptResourceId(value.baseResourceId, "baseResourceId");
  const baseRevision = value.baseRevision;
  if (baseRevision !== undefined && (!Number.isSafeInteger(baseRevision) || (baseRevision as number) < 1)) {
    throw new Error("baseRevision必须是正整数");
  }
  return {
    schemaVersion: PROMPT_RESOURCE_SCHEMA_VERSION,
    id: parsePromptResourceId(value.id),
    ...(baseResourceId === undefined ? {} : { baseResourceId }),
    ...(baseRevision === undefined ? {} : { baseRevision: baseRevision as number }),
    ...parseFields(value),
    author: parsePromptResourceAuthor(value.author),
    createdAt: readIsoTime(value.createdAt, "createdAt"),
    updatedAt: readIsoTime(value.updatedAt, "updatedAt"),
  };
}
