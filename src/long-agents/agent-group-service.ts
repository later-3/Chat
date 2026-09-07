import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { appendChatAuditEvent } from "../audit-log.js";
import { getChatHomePaths, resolveChatHome } from "../chat-home.js";
import {
  deleteNanoClawAgentMemory,
  getNanoClawAgentGroup,
  listNanoClawAgentMemory,
  readNanoClawAgentMemory,
  searchNanoClawAgentMemory,
  updateNanoClawAgentGroup,
  writeNanoClawAgentMemory,
  isNanoClawTemporarilyUnavailable,
  MAX_AGENT_MEMORY_CONTENT_BYTES,
  type NanoClawAgentGroupSnapshot,
  type NanoClawMemoryFile,
  type NanoClawMemoryFileSummary,
  type NanoClawMemorySearchResult,
} from "./nanoclaw-client.js";
import { readLongAgentRegistry } from "./storage.js";
import { LONG_AGENT_ID_PATTERN, type LongAgentConfig, type LongAgentInstanceConfig } from "./types.js";

const AGENT_GROUP_SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_AGENT_GROUP_NAME_CHARS = 200;
const MAX_STANDING_INSTRUCTIONS_BYTES = 1024 * 1024;
const MAX_PROMPT_STANDING_INSTRUCTIONS_CODE_POINTS = 32_000;
const MAX_PROMPT_CORE_MEMORY_CODE_POINTS = 16_000;

export class LongAgentResourceInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LongAgentResourceInvalidError";
  }
}

export class LongAgentResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LongAgentResourceNotFoundError";
  }
}

export interface LongAgentNanoTarget {
  readonly agent: LongAgentConfig;
  readonly instance: LongAgentInstanceConfig;
}

interface CachedAgentGroupSnapshot {
  readonly schemaVersion: typeof AGENT_GROUP_SNAPSHOT_SCHEMA_VERSION;
  readonly longAgentId: string;
  readonly agentGroupId: string;
  readonly contextRevision: string;
  readonly stale: boolean;
  readonly fetchedAt: string;
  readonly snapshot: NanoClawAgentGroupSnapshot;
}

export interface LongAgentAgentGroupDocument {
  readonly schemaVersion: 1;
  readonly stale: boolean;
  readonly fetchedAt: string;
  readonly group: {
    readonly id: string;
    readonly name: string;
    readonly standingInstructions: string | null;
    readonly revision: string;
  };
  readonly workspace: NanoClawAgentGroupSnapshot["workspace"];
  readonly coreMemory: NanoClawAgentGroupSnapshot["coreMemory"];
}

export interface LongAgentAgentGroupContextRevision {
  readonly contextRevision: string;
  readonly agentGroupId: string;
  readonly agentGroupRevision: string;
  readonly indexRevision: string;
  readonly definitionRevision: string;
  readonly stale: boolean;
  readonly fetchedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  const fields = new Set(allowed);
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (unknown.length > 0) throw new LongAgentResourceInvalidError(`${subject}包含未知字段: ${unknown.join(", ")}`);
}

function nonEmptyString(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new LongAgentResourceInvalidError(`${field}必须是非空字符串`);
  if (maxLength !== undefined && value.length > maxLength) {
    throw new LongAgentResourceInvalidError(`${field}不能超过${String(maxLength)}个字符`);
  }
  return value;
}

function parseLongAgentId(value: unknown): string {
  const id = nonEmptyString(value, "Long Agent ID").trim();
  if (!LONG_AGENT_ID_PATTERN.test(id)) throw new LongAgentResourceInvalidError("Long Agent ID格式无效");
  return id;
}

function parseRevision(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const parsed = nonEmptyString(value, field);
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) throw new LongAgentResourceInvalidError(`${field}格式无效`);
  return parsed;
}

export function parseAgentMemoryPath(value: unknown): string {
  const path = nonEmptyString(value, "path").trim();
  if (path.length > 1024 || path.startsWith("/") || path.includes("\\")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new LongAgentResourceInvalidError("path必须是Agent Memory内的安全相对路径");
  }
  if (!path.endsWith(".md")) throw new LongAgentResourceInvalidError("path必须指向Markdown文件");
  return path;
}

function snapshotPath(chatHome: string, longAgentId: string): string {
  return resolve(getChatHomePaths(chatHome).longAgentsRuntimeDir, longAgentId, "agent-group-snapshot.json");
}

function snapshotHistoryPath(chatHome: string, longAgentId: string, contextRevision: string): string {
  return resolve(
    getChatHomePaths(chatHome).longAgentsRuntimeDir,
    longAgentId,
    "snapshots",
    `${contextRevision.slice("sha256:".length)}.json`,
  );
}

function contextRevisionFor(snapshot: NanoClawAgentGroupSnapshot, stale: boolean): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ snapshot, stale })).digest("hex")}`;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function atomicCreateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

function parseCachedSnapshot(value: unknown, target: LongAgentNanoTarget): CachedAgentGroupSnapshot {
  if (!isRecord(value) || value.schemaVersion !== AGENT_GROUP_SNAPSHOT_SCHEMA_VERSION
    || value.longAgentId !== target.agent.id || value.agentGroupId !== target.agent.nanoclawAgentGroupId
    || typeof value.fetchedAt !== "string" || Number.isNaN(Date.parse(value.fetchedAt)) || !isRecord(value.snapshot)) {
    throw new Error("Long Agent的Agent Group缓存无效");
  }
  // Reuse the network parser's already-normalized shape by checking every
  // persisted field locally. A cache is never trusted merely because it is JSON.
  const snapshot = value.snapshot;
  const group = snapshot as unknown as NanoClawAgentGroupSnapshot;
  if (group.id !== target.agent.nanoclawAgentGroupId
    || typeof group.name !== "string" || group.name.trim() === ""
    || (group.standingInstructions !== null && typeof group.standingInstructions !== "string")
    || typeof group.revision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(group.revision)
    || !isRecord(group.workspace) || typeof group.workspace.folder !== "string"
    || group.workspace.folder.startsWith("/") || group.workspace.folder.includes("\\")
    || group.workspace.folder.split("/").some((part) => part === "" || part === "." || part === "..")
    || !Number.isSafeInteger(group.workspace.memoryFileCount) || group.workspace.memoryFileCount < 0
    || !isRecord(group.coreMemory) || !isRecord(group.coreMemory.index) || !isRecord(group.coreMemory.definition)
    || group.coreMemory.index.path !== "index.md" || group.coreMemory.definition.path !== "system/definition.md"
    || typeof group.coreMemory.index.content !== "string" || typeof group.coreMemory.definition.content !== "string"
    || !Number.isSafeInteger(group.coreMemory.index.size) || group.coreMemory.index.size < 0
    || !Number.isSafeInteger(group.coreMemory.definition.size) || group.coreMemory.definition.size < 0
    || typeof group.coreMemory.index.updatedAt !== "string" || Number.isNaN(Date.parse(group.coreMemory.index.updatedAt))
    || typeof group.coreMemory.definition.updatedAt !== "string" || Number.isNaN(Date.parse(group.coreMemory.definition.updatedAt))
    || !/^sha256:[a-f0-9]{64}$/.test(group.coreMemory.index.revision)
    || !/^sha256:[a-f0-9]{64}$/.test(group.coreMemory.definition.revision)) {
    throw new Error("Long Agent的Agent Group缓存内容无效");
  }
  const stale = value.stale === undefined ? false : value.stale;
  if (typeof stale !== "boolean") throw new Error("Long Agent的Agent Group缓存stale状态无效");
  const computedContextRevision = contextRevisionFor(group, stale);
  if (value.contextRevision !== undefined && value.contextRevision !== computedContextRevision) {
    throw new Error("Long Agent的Agent Group缓存内容Revision无效");
  }
  return {
    schemaVersion: AGENT_GROUP_SNAPSHOT_SCHEMA_VERSION,
    longAgentId: target.agent.id,
    agentGroupId: target.agent.nanoclawAgentGroupId,
    contextRevision: computedContextRevision,
    stale,
    fetchedAt: value.fetchedAt,
    snapshot: group,
  };
}

async function readCachedSnapshot(chatHome: string, target: LongAgentNanoTarget): Promise<CachedAgentGroupSnapshot | undefined> {
  try {
    return parseCachedSnapshot(JSON.parse(await readFile(snapshotPath(chatHome, target.agent.id), "utf8")) as unknown, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function preserveImmutableSnapshot(
  chatHome: string,
  target: LongAgentNanoTarget,
  cache: CachedAgentGroupSnapshot,
): Promise<CachedAgentGroupSnapshot> {
  const path = snapshotHistoryPath(chatHome, target.agent.id, cache.contextRevision);
  await atomicCreateJson(path, cache);
  return parseCachedSnapshot(JSON.parse(await readFile(path, "utf8")) as unknown, target);
}

export async function resolveLongAgentNanoTarget(
  longAgentIdValue: unknown,
  chatHomeValue?: string,
): Promise<LongAgentNanoTarget> {
  const chatHome = resolveChatHome(chatHomeValue);
  const longAgentId = parseLongAgentId(longAgentIdValue);
  const registry = await readLongAgentRegistry(chatHome);
  const agent = registry.agents.find((candidate) => candidate.id === longAgentId);
  if (agent === undefined) throw new LongAgentResourceNotFoundError("找不到Long Agent");
  const instance = registry.instances.find((candidate) => candidate.id === agent.instanceId);
  if (instance === undefined) throw new Error("Long Agent引用的NanoClaw Instance不存在");
  return { agent, instance };
}

function documentOf(cache: CachedAgentGroupSnapshot): LongAgentAgentGroupDocument {
  return {
    schemaVersion: 1,
    stale: cache.stale,
    fetchedAt: cache.fetchedAt,
    group: {
      id: cache.snapshot.id,
      name: cache.snapshot.name,
      standingInstructions: cache.snapshot.standingInstructions,
      revision: cache.snapshot.revision,
    },
    workspace: cache.snapshot.workspace,
    coreMemory: cache.snapshot.coreMemory,
  };
}

export function agentGroupContextRevisionOf(
  document: LongAgentAgentGroupDocument,
): LongAgentAgentGroupContextRevision {
  return {
    contextRevision: contextRevisionFor({
      id: document.group.id,
      name: document.group.name,
      standingInstructions: document.group.standingInstructions,
      revision: document.group.revision,
      workspace: document.workspace,
      coreMemory: document.coreMemory,
    }, document.stale),
    agentGroupId: document.group.id,
    agentGroupRevision: document.group.revision,
    indexRevision: document.coreMemory.index.revision,
    definitionRevision: document.coreMemory.definition.revision,
    stale: document.stale,
    fetchedAt: document.fetchedAt,
  };
}

function snapshotMatchesRevision(
  cache: CachedAgentGroupSnapshot,
  expected: LongAgentAgentGroupContextRevision,
): boolean {
  return cache.contextRevision === expected.contextRevision
    && cache.agentGroupId === expected.agentGroupId
    && cache.snapshot.revision === expected.agentGroupRevision
    && cache.snapshot.coreMemory.index.revision === expected.indexRevision
    && cache.snapshot.coreMemory.definition.revision === expected.definitionRevision;
}

/** Resolves the exact snapshot recorded by an earlier attempt of one stable Turn. */
export async function readFrozenLongAgentAgentGroup(
  longAgentId: unknown,
  expected: LongAgentAgentGroupContextRevision,
  chatHomeValue?: string,
): Promise<LongAgentAgentGroupDocument> {
  const chatHome = resolveChatHome(chatHomeValue);
  const target = await resolveLongAgentNanoTarget(longAgentId, chatHome);
  const historicalPath = snapshotHistoryPath(chatHome, target.agent.id, expected.contextRevision);
  let cached: CachedAgentGroupSnapshot | undefined;
  try {
    cached = parseCachedSnapshot(JSON.parse(await readFile(historicalPath, "utf8")) as unknown, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (cached === undefined || !snapshotMatchesRevision(cached, expected)) {
    throw new Error("Long Agent Turn记录的Agent Group Snapshot已不可用；拒绝以不同Revision重试");
  }
  return documentOf(cached);
}

export async function readLongAgentAgentGroup(
  longAgentId: unknown,
  chatHomeValue?: string,
): Promise<LongAgentAgentGroupDocument> {
  const chatHome = resolveChatHome(chatHomeValue);
  const target = await resolveLongAgentNanoTarget(longAgentId, chatHome);
  try {
    const snapshot = await getNanoClawAgentGroup(target.instance, target.agent.nanoclawAgentGroupId);
    const cache: CachedAgentGroupSnapshot = {
      schemaVersion: AGENT_GROUP_SNAPSHOT_SCHEMA_VERSION,
      longAgentId: target.agent.id,
      agentGroupId: target.agent.nanoclawAgentGroupId,
      contextRevision: contextRevisionFor(snapshot, false),
      stale: false,
      fetchedAt: new Date().toISOString(),
      snapshot,
    };
    await atomicWriteJson(snapshotPath(chatHome, target.agent.id), cache);
    await preserveImmutableSnapshot(chatHome, target, cache);
    return documentOf(cache);
  } catch (liveError) {
    if (isNanoClawTemporarilyUnavailable(liveError)) {
      const cached = await readCachedSnapshot(chatHome, target).catch(() => undefined);
      if (cached !== undefined) {
        const staleCache: CachedAgentGroupSnapshot = {
          ...cached,
          contextRevision: contextRevisionFor(cached.snapshot, true),
          stale: true,
        };
        await preserveImmutableSnapshot(chatHome, target, staleCache);
        return documentOf(staleCache);
      }
    }
    throw liveError;
  }
}

export function parseAgentGroupUpdate(value: unknown): {
  readonly expectedRevision: string;
  readonly name?: string;
  readonly standingInstructions?: string | null;
} {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new LongAgentResourceInvalidError("Agent Group更新必须使用schemaVersion 1");
  }
  exactFields(value, ["schemaVersion", "expectedRevision", "name", "standingInstructions"], "Agent Group更新");
  if (value.name === undefined && value.standingInstructions === undefined) {
    throw new LongAgentResourceInvalidError("Agent Group更新至少需要name或standingInstructions");
  }
  if (value.standingInstructions !== undefined && value.standingInstructions !== null
    && typeof value.standingInstructions !== "string") {
    throw new LongAgentResourceInvalidError("standingInstructions必须是字符串或null");
  }
  if (typeof value.standingInstructions === "string" && value.standingInstructions.trim() === "") {
    throw new LongAgentResourceInvalidError("standingInstructions不能为空；清除时请使用null");
  }
  if (typeof value.standingInstructions === "string"
    && Buffer.byteLength(value.standingInstructions, "utf8") > MAX_STANDING_INSTRUCTIONS_BYTES) {
    throw new LongAgentResourceInvalidError("standingInstructions不能超过1 MiB UTF-8数据");
  }
  return {
    expectedRevision: parseRevision(value.expectedRevision, "expectedRevision") as string,
    ...(value.name === undefined ? {} : { name: nonEmptyString(value.name, "name", MAX_AGENT_GROUP_NAME_CHARS).trim() }),
    ...(value.standingInstructions === undefined ? {} : { standingInstructions: value.standingInstructions }),
  };
}

export async function updateLongAgentAgentGroup(
  longAgentId: unknown,
  value: unknown,
  chatHomeValue?: string,
): Promise<LongAgentAgentGroupDocument> {
  const chatHome = resolveChatHome(chatHomeValue);
  const target = await resolveLongAgentNanoTarget(longAgentId, chatHome);
  const update = parseAgentGroupUpdate(value);
  const snapshot = await updateNanoClawAgentGroup({
    instance: target.instance,
    agentGroupId: target.agent.nanoclawAgentGroupId,
    ...update,
  });
  const cache: CachedAgentGroupSnapshot = {
    schemaVersion: AGENT_GROUP_SNAPSHOT_SCHEMA_VERSION,
    longAgentId: target.agent.id,
    agentGroupId: target.agent.nanoclawAgentGroupId,
    contextRevision: contextRevisionFor(snapshot, false),
    stale: false,
    fetchedAt: new Date().toISOString(),
    snapshot,
  };
  await atomicWriteJson(snapshotPath(chatHome, target.agent.id), cache);
  await appendChatAuditEvent({
    action: "long-agent.agent-group.update",
    target: { longAgentId: target.agent.id, agentGroupId: target.agent.nanoclawAgentGroupId },
    source: { type: "web-settings" },
    details: {
      revision: snapshot.revision,
      changedFields: [
        ...(update.name === undefined ? [] : ["name"]),
        ...(update.standingInstructions === undefined ? [] : ["standingInstructions"]),
      ],
      result: "updated",
    },
  }, chatHome);
  await preserveImmutableSnapshot(chatHome, target, cache);
  return documentOf(cache);
}

export async function listLongAgentMemory(longAgentId: unknown, chatHomeValue?: string): Promise<{
  readonly schemaVersion: 1;
  readonly stale: false;
  readonly agentGroupId: string;
  readonly files: readonly NanoClawMemoryFileSummary[];
}> {
  const target = await resolveLongAgentNanoTarget(longAgentId, chatHomeValue);
  return {
    schemaVersion: 1,
    stale: false,
    agentGroupId: target.agent.nanoclawAgentGroupId,
    files: await listNanoClawAgentMemory(target.instance, target.agent.nanoclawAgentGroupId),
  };
}

export async function readLongAgentMemory(longAgentId: unknown, pathValue: unknown, chatHomeValue?: string): Promise<{
  readonly schemaVersion: 1;
  readonly stale: false;
  readonly agentGroupId: string;
  readonly file: NanoClawMemoryFile;
}> {
  const target = await resolveLongAgentNanoTarget(longAgentId, chatHomeValue);
  return {
    schemaVersion: 1,
    stale: false,
    agentGroupId: target.agent.nanoclawAgentGroupId,
    file: await readNanoClawAgentMemory({
      instance: target.instance,
      agentGroupId: target.agent.nanoclawAgentGroupId,
      path: parseAgentMemoryPath(pathValue),
    }),
  };
}

export async function searchLongAgentMemory(
  longAgentId: unknown,
  queryValue: unknown,
  limitValue: unknown,
  chatHomeValue?: string,
): Promise<{
  readonly schemaVersion: 1;
  readonly stale: false;
  readonly agentGroupId: string;
  readonly results: readonly NanoClawMemorySearchResult[];
}> {
  const query = nonEmptyString(queryValue, "query", 512);
  if (query.trim().split(/\s+/).filter(Boolean).length > 32) {
    throw new LongAgentResourceInvalidError("query不能超过32个空白分词");
  }
  let limit: number | undefined;
  if (limitValue !== undefined) {
    const numeric = typeof limitValue === "string" && /^\d+$/.test(limitValue) ? Number(limitValue) : limitValue;
    if (!Number.isSafeInteger(numeric) || (numeric as number) < 1 || (numeric as number) > 100) {
      throw new LongAgentResourceInvalidError("limit必须是1到100之间的整数");
    }
    limit = numeric as number;
  }
  const target = await resolveLongAgentNanoTarget(longAgentId, chatHomeValue);
  return {
    schemaVersion: 1,
    stale: false,
    agentGroupId: target.agent.nanoclawAgentGroupId,
    results: await searchNanoClawAgentMemory({
      instance: target.instance,
      agentGroupId: target.agent.nanoclawAgentGroupId,
      query,
      ...(limit === undefined ? {} : { limit }),
    }),
  };
}

export function parseAgentMemoryMutation(value: unknown):
  | { readonly operation: "write"; readonly path: string; readonly content: string; readonly expectedRevision: string | null }
  | { readonly operation: "delete"; readonly path: string; readonly expectedRevision: string } {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new LongAgentResourceInvalidError("Agent Memory更新必须使用schemaVersion 1");
  }
  if (value.operation === "write") {
    exactFields(value, ["schemaVersion", "operation", "path", "content", "expectedRevision"], "Agent Memory写入");
    if (typeof value.content !== "string") throw new LongAgentResourceInvalidError("content必须是字符串");
    if (Buffer.byteLength(value.content, "utf8") > MAX_AGENT_MEMORY_CONTENT_BYTES) {
      throw new LongAgentResourceInvalidError("content不能超过900 KiB UTF-8数据");
    }
    return {
      operation: "write",
      path: parseAgentMemoryPath(value.path),
      content: value.content,
      expectedRevision: parseRevision(value.expectedRevision, "expectedRevision", true),
    };
  }
  if (value.operation === "delete") {
    exactFields(value, ["schemaVersion", "operation", "path", "expectedRevision"], "Agent Memory删除");
    return {
      operation: "delete",
      path: parseAgentMemoryPath(value.path),
      expectedRevision: parseRevision(value.expectedRevision, "expectedRevision") as string,
    };
  }
  throw new LongAgentResourceInvalidError("operation必须是write或delete");
}

export async function mutateLongAgentMemory(longAgentId: unknown, value: unknown, chatHomeValue?: string): Promise<unknown> {
  const mutation = parseAgentMemoryMutation(value);
  const target = await resolveLongAgentNanoTarget(longAgentId, chatHomeValue);
  if (mutation.operation === "write") {
    const file = await writeNanoClawAgentMemory({
      instance: target.instance,
      agentGroupId: target.agent.nanoclawAgentGroupId,
      path: mutation.path,
      content: mutation.content,
      expectedRevision: mutation.expectedRevision,
    });
    await appendChatAuditEvent({
      action: "long-agent.agent-memory.write",
      target: { longAgentId: target.agent.id, agentGroupId: target.agent.nanoclawAgentGroupId },
      source: { type: "web-settings" },
      details: { resourcePath: file.path, revision: file.revision, result: "written" },
    }, resolveChatHome(chatHomeValue));
    return { schemaVersion: 1, stale: false, agentGroupId: target.agent.nanoclawAgentGroupId, file };
  }
  const deleted = await deleteNanoClawAgentMemory({
    instance: target.instance,
    agentGroupId: target.agent.nanoclawAgentGroupId,
    path: mutation.path,
    expectedRevision: mutation.expectedRevision,
  });
  await appendChatAuditEvent({
    action: "long-agent.agent-memory.delete",
    target: { longAgentId: target.agent.id, agentGroupId: target.agent.nanoclawAgentGroupId },
    source: { type: "web-settings" },
    details: {
      resourcePath: deleted.path,
      revision: mutation.expectedRevision,
      result: "deleted",
    },
  }, resolveChatHome(chatHomeValue));
  return { schemaVersion: 1, stale: false, agentGroupId: target.agent.nanoclawAgentGroupId, ...deleted };
}

export function buildAgentGroupContextInstructions(document: LongAgentAgentGroupDocument): string {
  function promptText(value: string, maxCodePoints: number, field: string): string {
    const codePoints = [...value];
    if (codePoints.length <= maxCodePoints) return value;
    return [
      codePoints.slice(0, maxCodePoints).join(""),
      `<truncation_notice field="${field}" original_code_points="${String(codePoints.length)}" included_code_points="${String(maxCodePoints)}">Use agent_memory_read to inspect the complete Markdown file when needed.</truncation_notice>`,
    ].join("\n");
  }
  const instructions = document.group.standingInstructions?.trim();
  const standingPrompt = instructions === undefined
    ? undefined
    : promptText(instructions, MAX_PROMPT_STANDING_INSTRUCTIONS_CODE_POINTS, "standingInstructions");
  const indexPrompt = promptText(
    document.coreMemory.index.content,
    MAX_PROMPT_CORE_MEMORY_CODE_POINTS,
    document.coreMemory.index.path,
  );
  const definitionPrompt = promptText(
    document.coreMemory.definition.content,
    MAX_PROMPT_CORE_MEMORY_CODE_POINTS,
    document.coreMemory.definition.path,
  );
  return [
    `<nanoclaw_agent_group_context agent_group_id="${document.group.id}" revision="${document.group.revision}" stale="${String(document.stale)}">`,
    `<runtime_identity_name>${document.group.name}</runtime_identity_name>`,
    "<identity_rule>NanoClaw Agent Group name and standing instructions are the authoritative runtime identity and long-running role. Chat display alias and summary are UI metadata only.</identity_rule>",
    standingPrompt ? `<standing_instructions>\n${standingPrompt}\n</standing_instructions>` : "",
    `<agent_memory_core path="${document.coreMemory.index.path}" revision="${document.coreMemory.index.revision}">\n${indexPrompt}\n</agent_memory_core>`,
    `<agent_memory_system_definition path="${document.coreMemory.definition.path}" revision="${document.coreMemory.definition.revision}">\n${definitionPrompt}\n</agent_memory_system_definition>`,
    document.stale
      ? "<context_notice>NanoClaw当前不可达；以上Agent Group上下文来自最后有效缓存，可能已经过期。</context_notice>"
      : "",
    "</nanoclaw_agent_group_context>",
  ].filter((line) => line !== "").join("\n");
}
