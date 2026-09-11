import {
  type LongAgentAddress,
  type LongAgentInstanceConfig,
} from "./types.js";
import { chatChannelAuthorization } from "./channel-service-auth.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_GATEWAY_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_AGENT_MEMORY_CONTENT_BYTES = 900 * 1024;
const MAX_NANOCLAW_TEXT_BYTES = 1024 * 1024;

export class NanoClawGatewayError extends Error {
  readonly statusCode: number | undefined;
  readonly currentRevision: string | null | undefined;

  constructor(
    message: string,
    statusCode?: number,
    currentRevision?: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NanoClawGatewayError";
    this.statusCode = statusCode;
    this.currentRevision = currentRevision;
  }
}

export class NanoClawGatewayUnavailableError extends NanoClawGatewayError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, undefined, undefined, options);
    this.name = "NanoClawGatewayUnavailableError";
  }
}

export function isNanoClawTemporarilyUnavailable(error: unknown): boolean {
  return error instanceof NanoClawGatewayUnavailableError
    || (error instanceof NanoClawGatewayError && error.statusCode !== undefined && error.statusCode >= 500);
}

export interface NanoClawMemoryFileSummary {
  readonly path: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly revision: string;
}

export interface NanoClawMemoryFile extends NanoClawMemoryFileSummary {
  readonly content: string;
}

export interface NanoClawCoreMemoryFile extends NanoClawMemoryFile {
  readonly path: "index.md" | "system/definition.md";
}

export interface NanoClawAgentGroupSnapshot {
  readonly id: string;
  readonly name: string;
  readonly standingInstructions: string | null;
  readonly revision: string;
  readonly workspace: {
    readonly folder: string;
    readonly memoryFileCount: number;
  };
  readonly coreMemory: {
    readonly index: NanoClawCoreMemoryFile;
    readonly definition: NanoClawCoreMemoryFile;
  };
}

export interface NanoClawMemorySearchResult {
  readonly path: string;
  readonly revision: string;
  readonly score: number;
  readonly snippet: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  const fields = new Set(allowed);
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (unknown.length > 0) throw new NanoClawGatewayError(`${subject}包含未知字段`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new NanoClawGatewayError(`${field}无效`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new NanoClawGatewayError(`${field}无效`);
  return value as number;
}

function revision(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) throw new NanoClawGatewayError(`${field}无效`);
  return parsed;
}

function memoryPath(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (parsed.length > 1024 || parsed.startsWith("/") || parsed.includes("\\")
    || parsed.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new NanoClawGatewayError(`${field}无效`);
  }
  if (!parsed.endsWith(".md")) throw new NanoClawGatewayError(`${field}必须是Markdown相对路径`);
  return parsed;
}

function safeRelativeFolder(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (parsed.startsWith("/") || parsed.includes("\\")
    || parsed.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new NanoClawGatewayError(`${field}无效`);
  }
  return parsed;
}

function isoTimestamp(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (Number.isNaN(Date.parse(parsed))) throw new NanoClawGatewayError(`${field}无效`);
  return parsed;
}

function gatewayUrl(instance: LongAgentInstanceConfig, path: string): URL {
  return new URL(path.replace(/^\//, ""), `${instance.gatewayBaseUrl.replace(/\/$/, "")}/`);
}

async function readBoundedResponseText(response: Response, instanceId: string): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_GATEWAY_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new NanoClawGatewayError(`NanoClaw ${instanceId}响应超过大小限制`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_GATEWAY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new NanoClawGatewayError(`NanoClaw ${instanceId}响应超过大小限制`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return `${text}${decoder.decode()}`;
  } finally {
    reader.releaseLock();
  }
}

async function requestGateway(
  instance: LongAgentInstanceConfig,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetch(gatewayUrl(instance, path), {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: chatChannelAuthorization(),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      redirect: "error",
      signal: controller.signal,
    });
    const raw = await readBoundedResponseText(response, instance.id);
    if (!response.ok) {
      let data: unknown;
      try {
        data = raw === "" ? {} : JSON.parse(raw);
      } catch {
        data = {};
      }
      const currentRevision = isRecord(data)
        && (typeof data.currentRevision === "string" || data.currentRevision === null)
        ? data.currentRevision
        : undefined;
      // Upstream error text is intentionally not reflected: it can contain a
      // private host path or other NanoClaw implementation detail.
      throw new NanoClawGatewayError(
        `NanoClaw ${instance.id}请求失败（HTTP ${String(response.status)}）`,
        response.status,
        currentRevision,
      );
    }
    let data: unknown;
    try {
      data = raw === "" ? {} : JSON.parse(raw);
    } catch (error) {
      throw new NanoClawGatewayError(`NanoClaw ${instance.id}返回了无效JSON`, undefined, undefined, { cause: error });
    }
    return data;
  } catch (error) {
    if (error instanceof NanoClawGatewayError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new NanoClawGatewayUnavailableError(`NanoClaw ${instance.id} HTTP请求超时`, { cause: error });
    }
    throw new NanoClawGatewayUnavailableError(`NanoClaw ${instance.id}暂时不可用`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function parseCoreMemoryFile(value: unknown, expectedPath: "index.md" | "system/definition.md"): NanoClawCoreMemoryFile {
  const file = parseMemoryFile(value);
  if (file.path !== expectedPath) throw new NanoClawGatewayError("NanoClaw核心Memory路径无效");
  return { ...file, path: expectedPath };
}

function parseAgentGroupEnvelope(value: unknown, expectedAgentGroupId: string): NanoClawAgentGroupSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.agentGroup)) {
    throw new NanoClawGatewayError("NanoClaw Agent Group响应无效");
  }
  exactFields(value, ["schemaVersion", "agentGroup"], "NanoClaw Agent Group响应");
  const group = value.agentGroup;
  exactFields(group, ["id", "name", "standingInstructions", "revision", "workspace", "coreMemory"], "NanoClaw Agent Group");
  if (!isRecord(group.workspace) || !isRecord(group.coreMemory)) {
    throw new NanoClawGatewayError("NanoClaw Agent Group资源无效");
  }
  exactFields(group.workspace, ["folder", "memoryFileCount"], "NanoClaw Agent Group workspace");
  exactFields(group.coreMemory, ["index", "definition"], "NanoClaw Agent Group coreMemory");
  const id = requiredString(group.id, "agentGroup.id");
  if (id !== expectedAgentGroupId) throw new NanoClawGatewayError("NanoClaw返回了错误的Agent Group");
  const folder = safeRelativeFolder(group.workspace.folder, "agentGroup.workspace.folder");
  const name = requiredString(group.name, "agentGroup.name");
  const standingInstructions = nullableString(group.standingInstructions, "agentGroup.standingInstructions");
  if (name.length > 200 || (standingInstructions !== null
    && Buffer.byteLength(standingInstructions, "utf8") > MAX_NANOCLAW_TEXT_BYTES)) {
    throw new NanoClawGatewayError("NanoClaw Agent Group文本超过大小限制");
  }
  return {
    id,
    name,
    standingInstructions,
    revision: revision(group.revision, "agentGroup.revision"),
    workspace: {
      folder,
      memoryFileCount: nonNegativeInteger(group.workspace.memoryFileCount, "agentGroup.workspace.memoryFileCount"),
    },
    coreMemory: {
      index: parseCoreMemoryFile(group.coreMemory.index, "index.md"),
      definition: parseCoreMemoryFile(group.coreMemory.definition, "system/definition.md"),
    },
  };
}

function parseMemoryFileSummary(value: unknown): NanoClawMemoryFileSummary {
  if (!isRecord(value)) throw new NanoClawGatewayError("NanoClaw Memory文件摘要无效");
  exactFields(value, ["path", "size", "updatedAt", "revision"], "NanoClaw Memory文件摘要");
  const size = nonNegativeInteger(value.size, "memory.size");
  if (size > MAX_NANOCLAW_TEXT_BYTES) throw new NanoClawGatewayError("NanoClaw Memory文件超过大小限制");
  return {
    path: memoryPath(value.path, "memory.path"),
    size,
    updatedAt: isoTimestamp(value.updatedAt, "memory.updatedAt"),
    revision: revision(value.revision, "memory.revision"),
  };
}

function parseMemoryFile(value: unknown): NanoClawMemoryFile {
  if (!isRecord(value)) throw new NanoClawGatewayError("NanoClaw Memory文件无效");
  exactFields(value, ["path", "content", "size", "updatedAt", "revision"], "NanoClaw Memory文件");
  const summary = parseMemoryFileSummary({
    path: value.path,
    size: value.size,
    updatedAt: value.updatedAt,
    revision: value.revision,
  });
  if (typeof value.content !== "string") throw new NanoClawGatewayError("NanoClaw Memory内容无效");
  if (summary.size !== Buffer.byteLength(value.content, "utf8") || summary.size > MAX_NANOCLAW_TEXT_BYTES) {
    throw new NanoClawGatewayError("NanoClaw Memory大小无效");
  }
  return { ...summary, content: value.content };
}

async function requestAgentGroupResource(
  instance: LongAgentInstanceConfig,
  path: string,
  agentGroupId: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  return requestGateway(instance, path, {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, agentGroupId, ...body }),
  });
}

export async function getNanoClawAgentGroup(
  instance: LongAgentInstanceConfig,
  agentGroupId: string,
): Promise<NanoClawAgentGroupSnapshot> {
  return parseAgentGroupEnvelope(
    await requestAgentGroupResource(instance, "v1/agent-groups/get", agentGroupId),
    agentGroupId,
  );
}

export async function updateNanoClawAgentGroup(input: {
  readonly instance: LongAgentInstanceConfig;
  readonly agentGroupId: string;
  readonly expectedRevision: string;
  readonly name?: string;
  readonly standingInstructions?: string | null;
}): Promise<NanoClawAgentGroupSnapshot> {
  revision(input.expectedRevision, "expectedRevision");
  if (input.name !== undefined && (input.name.trim() === "" || input.name.length > 200)) {
    throw new NanoClawGatewayError("Agent Group name无效");
  }
  if (typeof input.standingInstructions === "string"
    && (input.standingInstructions.trim() === ""
      || Buffer.byteLength(input.standingInstructions, "utf8") > MAX_NANOCLAW_TEXT_BYTES)) {
    throw new NanoClawGatewayError("Agent Group standingInstructions无效");
  }
  return parseAgentGroupEnvelope(await requestAgentGroupResource(
    input.instance,
    "v1/agent-groups/update",
    input.agentGroupId,
    {
      expectedRevision: input.expectedRevision,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.standingInstructions === undefined ? {} : { standingInstructions: input.standingInstructions }),
    },
  ), input.agentGroupId);
}

export async function listNanoClawAgentMemory(
  instance: LongAgentInstanceConfig,
  agentGroupId: string,
): Promise<readonly NanoClawMemoryFileSummary[]> {
  const value = await requestAgentGroupResource(instance, "v1/agent-groups/memory/list", agentGroupId);
  if (!isRecord(value) || value.schemaVersion !== 1 || value.agentGroupId !== agentGroupId || !Array.isArray(value.files)) {
    throw new NanoClawGatewayError("NanoClaw Agent Memory列表响应无效");
  }
  exactFields(value, ["schemaVersion", "agentGroupId", "files"], "NanoClaw Agent Memory列表响应");
  if (value.files.length > 512) throw new NanoClawGatewayError("NanoClaw Agent Memory文件数超过限制");
  return value.files.map(parseMemoryFileSummary);
}

export async function readNanoClawAgentMemory(input: {
  readonly instance: LongAgentInstanceConfig;
  readonly agentGroupId: string;
  readonly path: string;
}): Promise<NanoClawMemoryFile> {
  const value = await requestAgentGroupResource(input.instance, "v1/agent-groups/memory/read", input.agentGroupId, {
    path: memoryPath(input.path, "path"),
  });
  if (!isRecord(value) || value.schemaVersion !== 1 || value.agentGroupId !== input.agentGroupId) {
    throw new NanoClawGatewayError("NanoClaw Agent Memory读取响应无效");
  }
  exactFields(value, ["schemaVersion", "agentGroupId", "file"], "NanoClaw Agent Memory读取响应");
  return parseMemoryFile(value.file);
}

export async function writeNanoClawAgentMemory(input: {
  readonly instance: LongAgentInstanceConfig;
  readonly agentGroupId: string;
  readonly path: string;
  readonly content: string;
  readonly expectedRevision: string | null;
}): Promise<NanoClawMemoryFile> {
  if (Buffer.byteLength(input.content, "utf8") > MAX_AGENT_MEMORY_CONTENT_BYTES) {
    throw new NanoClawGatewayError("Agent Memory内容超过900 KiB限制");
  }
  if (input.expectedRevision !== null) revision(input.expectedRevision, "expectedRevision");
  const value = await requestAgentGroupResource(input.instance, "v1/agent-groups/memory/write", input.agentGroupId, {
    path: memoryPath(input.path, "path"),
    content: input.content,
    expectedRevision: input.expectedRevision,
  });
  if (!isRecord(value) || value.schemaVersion !== 1 || value.agentGroupId !== input.agentGroupId) {
    throw new NanoClawGatewayError("NanoClaw Agent Memory写入响应无效");
  }
  exactFields(value, ["schemaVersion", "agentGroupId", "file"], "NanoClaw Agent Memory写入响应");
  return parseMemoryFile(value.file);
}

export async function deleteNanoClawAgentMemory(input: {
  readonly instance: LongAgentInstanceConfig;
  readonly agentGroupId: string;
  readonly path: string;
  readonly expectedRevision: string;
}): Promise<{ readonly deleted: true; readonly path: string }> {
  revision(input.expectedRevision, "expectedRevision");
  const expectedPath = memoryPath(input.path, "path");
  const value = await requestAgentGroupResource(input.instance, "v1/agent-groups/memory/delete", input.agentGroupId, {
    path: expectedPath,
    expectedRevision: input.expectedRevision,
  });
  if (!isRecord(value) || value.schemaVersion !== 1 || value.agentGroupId !== input.agentGroupId
    || value.deleted !== true || value.path !== expectedPath) {
    throw new NanoClawGatewayError("NanoClaw Agent Memory删除响应无效");
  }
  exactFields(value, ["schemaVersion", "agentGroupId", "deleted", "path"], "NanoClaw Agent Memory删除响应");
  return { deleted: true, path: expectedPath };
}

export async function searchNanoClawAgentMemory(input: {
  readonly instance: LongAgentInstanceConfig;
  readonly agentGroupId: string;
  readonly query: string;
  readonly limit?: number;
}): Promise<readonly NanoClawMemorySearchResult[]> {
  const query = requiredString(input.query, "query");
  if (query.length > 512 || query.trim().split(/\s+/).filter(Boolean).length > 32) {
    throw new NanoClawGatewayError("Agent Memory搜索词不能超过512个字符或32个空白分词");
  }
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
    throw new NanoClawGatewayError("Agent Memory搜索limit无效");
  }
  const value = await requestAgentGroupResource(input.instance, "v1/agent-groups/memory/search", input.agentGroupId, {
    query,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  if (!isRecord(value) || value.schemaVersion !== 1 || value.agentGroupId !== input.agentGroupId
    || !Array.isArray(value.results)) {
    throw new NanoClawGatewayError("NanoClaw Agent Memory搜索响应无效");
  }
  exactFields(value, ["schemaVersion", "agentGroupId", "results"], "NanoClaw Agent Memory搜索响应");
  if (value.results.length > 100) throw new NanoClawGatewayError("NanoClaw Agent Memory搜索结果超过限制");
  return value.results.map((result): NanoClawMemorySearchResult => {
    if (!isRecord(result)) throw new NanoClawGatewayError("NanoClaw Agent Memory搜索结果无效");
    exactFields(result, ["path", "revision", "score", "snippet"], "NanoClaw Agent Memory搜索结果");
    if (typeof result.score !== "number" || !Number.isFinite(result.score) || result.score <= 0) {
      throw new NanoClawGatewayError("NanoClaw Agent Memory搜索分数无效");
    }
    if (typeof result.snippet !== "string" || result.snippet.length > 320) {
      throw new NanoClawGatewayError("NanoClaw Agent Memory搜索摘要无效");
    }
    return {
      path: memoryPath(result.path, "result.path"),
      revision: revision(result.revision, "result.revision"),
      score: result.score,
      snippet: result.snippet,
    };
  });
}

export interface NanoClawTask {
  readonly id: string;
  readonly seriesId: string;
  readonly status: string;
  readonly processAfter: string | null;
  readonly recurrence: string | null;
  readonly prompt: string;
  readonly script: string | null;
  readonly originSessionId: string | null;
  readonly sessionId: string;
  readonly agentGroupId: string;
  readonly createdAt: string;
  readonly tries: number;
}

export type NanoClawTaskOperation =
  | { readonly operation: "list"; readonly status?: "pending" | "paused" }
  | { readonly operation: "get"; readonly taskId: string }
  | {
      readonly operation: "create";
      readonly name?: string;
      readonly prompt: string;
      readonly recurrence?: string | null;
      readonly script?: string | null;
      readonly processAfter?: string;
      readonly originSessionId?: string;
      readonly paused?: boolean;
    }
  | {
      readonly operation: "update";
      readonly taskId: string;
      readonly prompt?: string;
      readonly recurrence?: string | null;
      readonly script?: string | null;
      readonly processAfter?: string;
    }
  | { readonly operation: "pause" | "resume" | "delete" | "run"; readonly taskId: string };

function parseNanoClawTask(value: unknown, field: string): NanoClawTask {
  if (!isRecord(value)) throw new Error(`NanoClaw返回了无效的${field}`);
  const required = ["id", "seriesId", "status", "processAfter", "recurrence", "prompt", "sessionId", "agentGroupId", "createdAt"];
  for (const key of required) {
    const entry = value[key];
    if (entry !== null && typeof entry !== "string") throw new Error(`NanoClaw返回了无效的${field}.${key}`);
  }
  return value as unknown as NanoClawTask;
}

/** 该 Agent Group 的定时任务管理（list/get/create/update/pause/resume/delete/run）。 */
export async function requestNanoClawTasks(input: {
  readonly instance: LongAgentInstanceConfig;
  readonly agentGroupId: string;
  readonly operation: NanoClawTaskOperation;
}): Promise<{ readonly tasks?: readonly NanoClawTask[]; readonly task?: NanoClawTask; readonly firedTaskId?: string }> {
  const data = await requestGateway(input.instance, "v1/agent-groups/tasks", {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, agentGroupId: input.agentGroupId, ...input.operation }),
  });
  if (!isRecord(data)) throw new Error(`NanoClaw ${input.instance.id}返回了无效的任务响应`);
  const tasks = Array.isArray(data.tasks)
    ? data.tasks.map((task, index) => parseNanoClawTask(task, `tasks[${String(index)}]`))
    : undefined;
  const task = isRecord(data.task) ? parseNanoClawTask(data.task, "task") : undefined;
  return {
    ...(tasks === undefined ? {} : { tasks }),
    ...(task === undefined ? {} : { task }),
    ...(typeof data.firedTaskId === "string" ? { firedTaskId: data.firedTaskId } : {}),
  };
}

/**
 * Sends one proactive message from a Long Agent to its own bound channel
 * destination. NanoClaw validates the destination wiring; there is no inbound
 * trigger session for proactive sends.
 */
export async function sendNanoClawAgentMessage(input: {
  readonly instance: LongAgentInstanceConfig;
  readonly agentGroupId: string;
  readonly destination: LongAgentAddress & { readonly messagingGroupId: string };
  readonly messageId: string;
  readonly text: string;
}): Promise<{ readonly nanoSessionId: string }> {
  const data = await requestGateway(input.instance, "v1/agent-messages", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1,
      agentGroupId: input.agentGroupId,
      messagingGroupId: input.destination.messagingGroupId,
      threadId: input.destination.threadId,
      messageId: input.messageId,
      text: input.text,
    }),
  });
  if (!isRecord(data) || data.persisted !== true || data.messageId !== input.messageId
    || typeof data.nanoSessionId !== "string") {
    throw new Error(`NanoClaw ${input.instance.id}没有确认主动消息持久化`);
  }
  return { nanoSessionId: data.nanoSessionId };
}

export async function persistNanoClawDelivery(input: {
  readonly instance: LongAgentInstanceConfig;
  readonly agentGroupId: string;
  readonly nanoSessionId: string;
  readonly messageId: string;
  readonly chatSessionId: string;
  readonly destination: LongAgentAddress;
  readonly text: string;
  /** Optional channel-deliverable image attachments (base64 payload). */
  readonly files?: readonly { readonly filename: string; readonly data: string }[];
}): Promise<void> {
  const data = await requestGateway(input.instance, "v1/deliveries", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1,
      agentGroupId: input.agentGroupId,
      nanoSessionId: input.nanoSessionId,
      messageId: input.messageId,
      chatSessionId: input.chatSessionId,
      destination: input.destination,
      text: input.text,
      ...(input.files === undefined || input.files.length === 0 ? {} : { files: input.files }),
    }),
  });
  if (!isRecord(data) || data.persisted !== true || data.messageId !== input.messageId) {
    throw new Error(`NanoClaw ${input.instance.id}没有确认Delivery持久化`);
  }
}

export async function acknowledgeNanoClawInbound(input: {
  readonly instance: LongAgentInstanceConfig;
  readonly agentGroupId: string;
  readonly nanoSessionId: string;
  readonly messageId: string;
}): Promise<void> {
  const data = await requestGateway(input.instance, "v1/acks", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1,
      agentGroupId: input.agentGroupId,
      nanoSessionId: input.nanoSessionId,
      messageId: input.messageId,
    }),
  });
  if (!isRecord(data) || data.completed !== true || data.messageId !== input.messageId) {
    throw new Error(`NanoClaw ${input.instance.id}没有确认Inbound完成`);
  }
}

export async function checkNanoClawGateway(instance: LongAgentInstanceConfig): Promise<boolean> {
  try {
    const data = await requestGateway(instance, "v1/health");
    return isRecord(data) && data.ok === true && data.instanceId === instance.id;
  } catch {
    return false;
  }
}
