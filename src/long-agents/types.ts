import { createHash } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { PROJECT_ID_PATTERN } from "../projects/types.js";
import { systemToolAddress } from "../tools/framework.js";
import { parseWorkflowImages } from "../workflows/image-input.js";
import {
  parseWorkflowAgentDefinition,
  type WorkflowAgentDefinition,
} from "../workflows/agent-config.js";

export const LONG_AGENT_SCHEMA_VERSION = 1;
export const LONG_AGENT_STATE_SCHEMA_VERSION = 3;
export const LONG_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export interface LongAgentAddress {
  readonly channelType: string;
  readonly instance: string;
  readonly platformId: string;
  readonly threadId: string | null;
}

export interface LongAgentInstanceConfig {
  readonly id: string;
  readonly name: string;
  readonly executionMode: "chat-pi";
  readonly gatewayBaseUrl: string;
}

export type LongAgentAvatar =
  | { readonly kind: "auto" }
  | { readonly kind: "emoji"; readonly emoji: string }
  | { readonly kind: "image"; readonly file: string; readonly revision: number };

export interface LongAgentConfig {
  readonly id: string;
  /** Chat UI display alias. NanoClaw Agent Group owns the runtime identity name. */
  readonly name: string;
  /** Chat UI summary. NanoClaw standingInstructions own the long-running role. */
  readonly description: string;
  /** Chat-owned display avatar; `auto` derives color and initials from the stable id. */
  readonly avatar: LongAgentAvatar;
  readonly enabled: boolean;
  readonly instanceId: string;
  readonly nanoclawAgentGroupId: string;
  readonly defaultProjectId: string;
  /** Channel 绑定；未绑定的 Agent 仅从 Chat Web 入口工作（S2 生命周期允许先创建后绑定）。 */
  readonly inbox?: LongAgentAddress & { readonly messagingGroupId: string };
  /** 生命周期状态；缺省为 active。archived 停止新工作但保留全部数据。 */
  readonly status: "active" | "archived";
  /**
   * 定义的工具集是否仍由默认托管：true 时启动补齐新增默认能力（只增不减）；
   * 用户在配置页自定义过工具后变为 false，补齐不再触碰。
   */
  readonly toolsManagedByDefault?: boolean;
  /** Chat-owned Pi capability definition. NanoClaw never receives this value. */
  readonly definition: WorkflowAgentDefinition;
}

/** Content revision of one LongAgent definition; any identity/avatar/config change moves it. */
export function longAgentConfigRevision(agent: LongAgentConfig): string {
  // toolsManagedByDefault 是托管标记，不是用户配置内容：不参与 revision，
  // 否则保存/补齐这个标记本身会干扰乐观并发控制。
  const { toolsManagedByDefault: _managed, ...config } = agent;
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export interface LongAgentRegistry {
  readonly schemaVersion: 1;
  readonly instances: readonly LongAgentInstanceConfig[];
  readonly agents: readonly LongAgentConfig[];
}

export interface LongAgentConversationBinding {
  readonly id: string;
  readonly projectLongAgentId: string;
  readonly nanoclawInstanceId: string;
  readonly nanoclawAgentGroupId: string;
  readonly nanoclawSessionId: string | null;
  readonly primaryMessagingGroupId: string | null;
  readonly source: LongAgentAddress;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectLongAgent {
  readonly id: string;
  readonly projectId: string;
  readonly longAgentId: string;
  readonly primarySessionId: string;
  readonly status: "active" | "paused";
  /** 仅 Agent 独立 Daily Project 使用：当前主 Session 所属的本地日期（YYYY-MM-DD），换日轮换。 */
  readonly sessionDate?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LongAgentState {
  readonly schemaVersion: 3;
  readonly projectAgents: readonly ProjectLongAgent[];
  readonly bindings: readonly LongAgentConversationBinding[];
  /** Durable HTTP ingress queue. Events leave this list only after Delivery/Ack completes. */
  readonly pendingEvents: readonly LongAgentPendingEvent[];
  /** Bounded idempotency ledger for HTTP retries after a completed event leaves the queue. */
  readonly processedEvents: readonly LongAgentProcessedEvent[];
}

export interface LongAgentPendingEvent {
  readonly event: NanoClawIntegrationEvent;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly lastError: string | null;
}

export interface LongAgentProcessedEvent {
  readonly eventId: string;
  readonly payloadHash: string;
  readonly processedAt: string;
}

export interface NanoClawIntegrationEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly instanceId: string;
  readonly direction: "in" | "out";
  readonly messageId: string;
  readonly nanoSessionId: string;
  readonly agentGroupId: string;
  readonly messagingGroupId: string | null;
  readonly isGroup: boolean;
  readonly senderId: string | null;
  readonly senderName: string;
  readonly text: string;
  /** Inbound image attachments in Pi ImageContent wire shape; absent for text-only events. */
  readonly images?: readonly ImageContent[];
  readonly kind: string;
  readonly timestamp: string;
  readonly source: LongAgentAddress | null;
  readonly delivery: LongAgentAddress | null;
  readonly chatSessionId: string | null;
  /** 定时任务触发时携带的任务 id；普通消息为 undefined（或 null）。 */
  readonly taskId?: string | null;
}

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

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function parseId(value: unknown, field: string): string {
  const id = requiredString(value, field);
  if (!LONG_AGENT_ID_PATTERN.test(id)) throw new Error(`${field}格式无效: ${id}`);
  return id;
}

export function parseLongAgentAddress(value: unknown, field: string): LongAgentAddress {
  if (!isRecord(value)) throw new Error(`${field}必须是对象`);
  exactFields(value, ["channelType", "instance", "platformId", "threadId"], field);
  return {
    channelType: requiredString(value.channelType, `${field}.channelType`),
    instance: requiredString(value.instance, `${field}.instance`),
    platformId: requiredString(value.platformId, `${field}.platformId`),
    threadId: nullableString(value.threadId, `${field}.threadId`),
  };
}

function parseInstance(value: unknown): LongAgentInstanceConfig {
  if (!isRecord(value)) throw new Error("LongAgent instance必须是对象");
  exactFields(value, ["id", "name", "executionMode", "gatewayBaseUrl"], "LongAgent instance");
  if (value.executionMode !== undefined && value.executionMode !== "chat-pi") {
    throw new Error("instance.executionMode必须是chat-pi");
  }
  const rawGatewayBaseUrl = requiredString(value.gatewayBaseUrl, "instance.gatewayBaseUrl");
  let gateway: URL;
  try {
    gateway = new URL(rawGatewayBaseUrl);
  } catch {
    throw new Error("instance.gatewayBaseUrl必须是有效HTTP URL");
  }
  if (gateway.protocol !== "http:" && gateway.protocol !== "https:") {
    throw new Error("instance.gatewayBaseUrl必须使用HTTP或HTTPS");
  }
  if (gateway.username || gateway.password || gateway.search || gateway.hash) {
    throw new Error("instance.gatewayBaseUrl不能包含Credential、查询参数或片段");
  }
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (gateway.protocol === "http:" && !localHosts.has(gateway.hostname)) {
    throw new Error("非本机NanoClaw Gateway必须使用HTTPS");
  }
  return {
    id: parseId(value.id, "instance.id"),
    name: requiredString(value.name, "instance.name"),
    executionMode: "chat-pi",
    gatewayBaseUrl: gateway.toString().replace(/\/$/, ""),
  };
}

function parseAgentAvatar(value: unknown): LongAgentAvatar {
  if (value === undefined) return { kind: "auto" };
  if (!isRecord(value)) throw new Error("agent.avatar必须是对象");
  exactFields(value, ["kind", "emoji", "file", "revision"], "agent.avatar");
  if (value.kind === "auto") return { kind: "auto" };
  if (value.kind === "emoji") {
    const emoji = requiredString(value.emoji, "agent.avatar.emoji");
    if ([...emoji].length > 16) throw new Error("agent.avatar.emoji最多16个字符");
    return { kind: "emoji", emoji };
  }
  if (value.kind === "image") {
    const file = requiredString(value.file, "agent.avatar.file");
    if (!/^avatar\.(png|jpe?g|webp)$/.test(file)) throw new Error(`agent.avatar.file格式无效: ${file}`);
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
      throw new Error("agent.avatar.revision必须是正整数");
    }
    return { kind: "image", file, revision: value.revision as number };
  }
  throw new Error("agent.avatar.kind必须是auto、emoji或image");
}

function parseAgent(value: unknown): LongAgentConfig {
  if (!isRecord(value)) throw new Error("LongAgent agent必须是对象");
  exactFields(
    value,
    ["id", "name", "description", "avatar", "enabled", "instanceId", "nanoclawAgentGroupId", "defaultProjectId", "inbox", "status", "toolsManagedByDefault", "definition"],
    "LongAgent agent",
  );
  if (value.inbox !== undefined) {
    if (!isRecord(value.inbox)) throw new Error("agent.inbox必须是对象");
    exactFields(
      value.inbox,
      ["messagingGroupId", "channelType", "instance", "platformId", "threadId"],
      "agent.inbox",
    );
  }
  const defaultProjectId = requiredString(value.defaultProjectId, "agent.defaultProjectId");
  if (!PROJECT_ID_PATTERN.test(defaultProjectId)) throw new Error(`agent.defaultProjectId格式无效: ${defaultProjectId}`);
  if (typeof value.enabled !== "boolean") throw new Error("agent.enabled必须是布尔值");
  const id = parseId(value.id, "agent.id");
  const name = requiredString(value.name, "agent.name");
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const defaultDefinition = buildDefaultLongAgentDefinition(id, name, description);
  const definition = value.definition === undefined
    ? parseWorkflowAgentDefinition(defaultDefinition)
    : parseWorkflowAgentDefinition(value.definition);
  if (definition.id !== id || definition.name !== name || definition.description !== defaultDefinition.description) {
    throw new Error("agent.definition的id、name和description必须与LongAgent身份一致");
  }
  return {
    id,
    name,
    description,
    avatar: parseAgentAvatar(value.avatar),
    enabled: value.enabled,
    instanceId: parseId(value.instanceId, "agent.instanceId"),
    nanoclawAgentGroupId: requiredString(value.nanoclawAgentGroupId, "agent.nanoclawAgentGroupId"),
    defaultProjectId,
    ...(value.inbox === undefined
      ? {}
      : {
          inbox: {
            messagingGroupId: requiredString(value.inbox.messagingGroupId, "agent.inbox.messagingGroupId"),
            ...parseLongAgentAddress({
              channelType: value.inbox.channelType,
              instance: value.inbox.instance,
              platformId: value.inbox.platformId,
              threadId: value.inbox.threadId,
            }, "agent.inbox.address"),
          },
        }),
    status: value.status === undefined ? "active" as const : parseAgentStatus(value.status),
    ...(value.toolsManagedByDefault === undefined
      ? {}
      : { toolsManagedByDefault: value.toolsManagedByDefault === true }),
    definition,
  };
}

function parseAgentStatus(value: unknown): "active" | "archived" {
  if (value !== "active" && value !== "archived") throw new Error("agent.status必须是active或archived");
  return value;
}

/** Long Agent 的默认能力定义（与 parseAgent 内联默认值同源，供默认能力补齐复用）。 */
export function buildDefaultLongAgentDefinition(id: string, name: string, description: string) {
  return {
    schemaVersion: 1,
    id,
    name,
    description: description === "" ? "Chat Long Agent" : description,
    systemPrompt: { mode: "pi-default" },
    customInstructions: [{
      text: [
        "你的运行身份名称和长期职责以本轮注入的NanoClaw Agent Group name与standingInstructions为准。",
        "你服务于当前Chat Project和Chat Session；入口可能是Chat Web、Telegram或定时任务，但入口不会改变Project与Session事实。",
        "需要稳定历史事实时主动使用memory_search；只有值得长期保留且明确的事实才使用memory_record。",
        "适合交给确定性流程完成的独立任务，可以使用workflow_call；不要把NanoClaw当作Agent Runtime。",
      ].filter((line) => line !== "").join("\n"),
    }],
    tools: {
      mode: "pi-default",
      addresses: [
        systemToolAddress("memory_search"),
        systemToolAddress("memory_record"),
        systemToolAddress("workflow_call"),
        systemToolAddress("agent_memory_search"),
        systemToolAddress("agent_memory_read"),
        systemToolAddress("agent_memory_write"),
        systemToolAddress("project_search"),
        systemToolAddress("project_read"),
        systemToolAddress("project_create"),
        systemToolAddress("project_open"),
        systemToolAddress("project_update"),
        systemToolAddress("project_configure"),
        systemToolAddress("channel_send"),
        systemToolAddress("task_manage"),
      ],
    },
    resources: { mode: "inherit" },
  } as const;
}

export function parseLongAgentRegistry(value: unknown): LongAgentRegistry {
  if (!isRecord(value) || value.schemaVersion !== LONG_AGENT_SCHEMA_VERSION) {
    throw new Error(`LongAgent Registry必须使用schemaVersion ${LONG_AGENT_SCHEMA_VERSION}`);
  }
  exactFields(value, ["schemaVersion", "instances", "agents"], "LongAgent Registry");
  if (!Array.isArray(value.instances) || !Array.isArray(value.agents)) {
    throw new Error("LongAgent Registry instances和agents必须是数组");
  }
  const instances = value.instances.map(parseInstance);
  const agents = value.agents.map(parseAgent);
  if (instances.length > 1) {
    throw new Error("LongAgent Registry schemaVersion 1只支持一个NanoClaw instance");
  }
  const instanceIds = new Set<string>();
  for (const instance of instances) {
    if (instanceIds.has(instance.id)) throw new Error(`LongAgent instance重复: ${instance.id}`);
    instanceIds.add(instance.id);
  }
  const agentIds = new Set<string>();
  const agentGroupIds = new Set<string>();
  for (const agent of agents) {
    if (agentIds.has(agent.id)) throw new Error(`LongAgent agent重复: ${agent.id}`);
    if (!instanceIds.has(agent.instanceId)) throw new Error(`LongAgent ${agent.id}引用未知instance: ${agent.instanceId}`);
    const groupKey = `${agent.instanceId}\0${agent.nanoclawAgentGroupId}`;
    if (agentGroupIds.has(groupKey)) throw new Error(`NanoClaw Agent Group被重复配置: ${agent.nanoclawAgentGroupId}`);
    agentIds.add(agent.id);
    agentGroupIds.add(groupKey);
  }
  return { schemaVersion: 1, instances, agents };
}

export function emptyLongAgentState(): LongAgentState {
  return { schemaVersion: 3, projectAgents: [], bindings: [], pendingEvents: [], processedEvents: [] };
}

function parseTimestamp(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${field}不是有效时间`);
  return text;
}

function parseBinding(value: unknown): LongAgentConversationBinding {
  if (!isRecord(value)) throw new Error("LongAgent binding必须是对象");
  exactFields(value, [
    "id", "projectLongAgentId", "nanoclawInstanceId", "nanoclawAgentGroupId",
    "nanoclawSessionId", "primaryMessagingGroupId", "source",
    "createdAt", "updatedAt",
  ], "LongAgent binding");
  return {
    id: requiredString(value.id, "binding.id"),
    projectLongAgentId: requiredString(value.projectLongAgentId, "binding.projectLongAgentId"),
    nanoclawInstanceId: parseId(value.nanoclawInstanceId, "binding.nanoclawInstanceId"),
    nanoclawAgentGroupId: requiredString(value.nanoclawAgentGroupId, "binding.nanoclawAgentGroupId"),
    nanoclawSessionId: nullableString(value.nanoclawSessionId, "binding.nanoclawSessionId"),
    primaryMessagingGroupId: nullableString(value.primaryMessagingGroupId, "binding.primaryMessagingGroupId"),
    source: parseLongAgentAddress(value.source, "binding.source"),
    createdAt: parseTimestamp(value.createdAt, "binding.createdAt"),
    updatedAt: parseTimestamp(value.updatedAt, "binding.updatedAt"),
  };
}

function parseProjectLongAgent(value: unknown): ProjectLongAgent {
  if (!isRecord(value)) throw new Error("Project Long Agent必须是对象");
  exactFields(value, [
    "id", "projectId", "longAgentId", "primarySessionId", "status", "sessionDate", "createdAt", "updatedAt",
  ], "Project Long Agent");
  const projectId = requiredString(value.projectId, "projectLongAgent.projectId");
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`projectLongAgent.projectId格式无效: ${projectId}`);
  if (value.status !== "active" && value.status !== "paused") {
    throw new Error("projectLongAgent.status必须是active或paused");
  }
  if (value.sessionDate !== undefined
    && (typeof value.sessionDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.sessionDate))) {
    throw new Error("projectLongAgent.sessionDate必须是YYYY-MM-DD");
  }
  return {
    id: requiredString(value.id, "projectLongAgent.id"),
    projectId,
    longAgentId: parseId(value.longAgentId, "projectLongAgent.longAgentId"),
    primarySessionId: requiredString(value.primarySessionId, "projectLongAgent.primarySessionId"),
    status: value.status,
    ...(value.sessionDate === undefined ? {} : { sessionDate: value.sessionDate as string }),
    createdAt: parseTimestamp(value.createdAt, "projectLongAgent.createdAt"),
    updatedAt: parseTimestamp(value.updatedAt, "projectLongAgent.updatedAt"),
  };
}

function parsePendingEvent(value: unknown): LongAgentPendingEvent {
  if (!isRecord(value)) throw new Error("LongAgent pending event必须是对象");
  exactFields(value, ["event", "attempts", "nextAttemptAt", "lastError"], "LongAgent pending event");
  if (!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0) {
    throw new Error("LongAgent pending event attempts无效");
  }
  return {
    event: parseNanoClawIntegrationEvent(value.event),
    attempts: value.attempts as number,
    nextAttemptAt: parseTimestamp(value.nextAttemptAt, "pendingEvent.nextAttemptAt"),
    lastError: value.lastError === null ? null : requiredString(value.lastError, "pendingEvent.lastError"),
  };
}

function parseProcessedEvent(value: unknown): LongAgentProcessedEvent {
  if (!isRecord(value)) throw new Error("LongAgent processed event必须是对象");
  exactFields(value, ["eventId", "payloadHash", "processedAt"], "LongAgent processed event");
  const payloadHash = requiredString(value.payloadHash, "processedEvent.payloadHash");
  if (!/^[a-f0-9]{64}$/.test(payloadHash)) throw new Error("processedEvent.payloadHash无效");
  return {
    eventId: requiredString(value.eventId, "processedEvent.eventId"),
    payloadHash,
    processedAt: parseTimestamp(value.processedAt, "processedEvent.processedAt"),
  };
}

interface LegacyLongAgentBinding {
  readonly id: string;
  readonly projectId: string;
  readonly chatSessionId: string;
  readonly longAgentId: string;
  readonly nanoclawInstanceId: string;
  readonly nanoclawAgentGroupId: string;
  readonly nanoclawSessionId: string | null;
  readonly primaryMessagingGroupId: string | null;
  readonly source: LongAgentAddress;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function parseLegacyBinding(value: unknown): LegacyLongAgentBinding {
  if (!isRecord(value)) throw new Error("Legacy LongAgent binding必须是对象");
  const projectId = requiredString(value.projectId, "binding.projectId");
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`binding.projectId格式无效: ${projectId}`);
  return {
    id: requiredString(value.id, "binding.id"),
    projectId,
    chatSessionId: requiredString(value.chatSessionId, "binding.chatSessionId"),
    longAgentId: parseId(value.longAgentId, "binding.longAgentId"),
    nanoclawInstanceId: parseId(value.nanoclawInstanceId, "binding.nanoclawInstanceId"),
    nanoclawAgentGroupId: requiredString(value.nanoclawAgentGroupId, "binding.nanoclawAgentGroupId"),
    nanoclawSessionId: nullableString(value.nanoclawSessionId, "binding.nanoclawSessionId"),
    primaryMessagingGroupId: nullableString(value.primaryMessagingGroupId, "binding.primaryMessagingGroupId"),
    source: parseLongAgentAddress(value.source, "binding.source"),
    createdAt: parseTimestamp(value.createdAt, "binding.createdAt"),
    updatedAt: parseTimestamp(value.updatedAt, "binding.updatedAt"),
  };
}

function projectLongAgentId(projectId: string, longAgentId: string): string {
  return `project-long-agent:${projectId}:${longAgentId}`;
}

/** Migrates the original per-session binding model without rewriting Pi session history. */
export function migrateLongAgentState(value: unknown): LongAgentState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.cursors) || !Array.isArray(value.bindings)) {
    throw new Error("Legacy LongAgent State必须使用schemaVersion 1");
  }
  const cursors: Record<string, number> = {};
  for (const [instanceId, cursor] of Object.entries(value.cursors)) {
    parseId(instanceId, "cursor.instanceId");
    if (!Number.isSafeInteger(cursor) || (cursor as number) < 0) throw new Error(`cursor ${instanceId}无效`);
    cursors[instanceId] = cursor as number;
  }
  const legacy = value.bindings.map(parseLegacyBinding);
  const groups = new Map<string, LegacyLongAgentBinding[]>();
  for (const binding of legacy) {
    const key = `${binding.projectId}\0${binding.longAgentId}`;
    groups.set(key, [...(groups.get(key) ?? []), binding]);
  }
  const projectAgents: ProjectLongAgent[] = [];
  const bindings: LongAgentConversationBinding[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((left, right) => {
      const channelPreference = Number(left.source.channelType === "chat-web") - Number(right.source.channelType === "chat-web");
      return channelPreference || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    });
    const primary = sorted[0];
    if (primary === undefined) continue;
    const id = projectLongAgentId(primary.projectId, primary.longAgentId);
    projectAgents.push({
      id,
      projectId: primary.projectId,
      longAgentId: primary.longAgentId,
      primarySessionId: primary.chatSessionId,
      status: "active",
      createdAt: primary.createdAt,
      updatedAt: sorted.reduce((latest, binding) => binding.updatedAt > latest ? binding.updatedAt : latest, primary.updatedAt),
    });
    for (const binding of sorted.filter((candidate) => candidate.source.channelType !== "chat-web")) {
      bindings.push({
        id: binding.id,
        projectLongAgentId: id,
        nanoclawInstanceId: binding.nanoclawInstanceId,
        nanoclawAgentGroupId: binding.nanoclawAgentGroupId,
        nanoclawSessionId: binding.nanoclawSessionId,
        primaryMessagingGroupId: binding.primaryMessagingGroupId,
        source: binding.source,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      });
    }
  }
  return parseLongAgentState({ schemaVersion: 3, projectAgents, bindings, pendingEvents: [], processedEvents: [] });
}

export function parseLongAgentState(value: unknown): LongAgentState {
  if (isRecord(value) && value.schemaVersion === 1) return migrateLongAgentState(value);
  if (isRecord(value) && value.schemaVersion === 2) {
    exactFields(value, ["schemaVersion", "cursors", "projectAgents", "bindings"], "Legacy LongAgent State");
    return parseLongAgentState({
      schemaVersion: 3,
      projectAgents: value.projectAgents,
      bindings: value.bindings,
      pendingEvents: [],
      processedEvents: [],
    });
  }
  if (!isRecord(value) || value.schemaVersion !== LONG_AGENT_STATE_SCHEMA_VERSION) {
    throw new Error(`LongAgent State必须使用schemaVersion ${LONG_AGENT_STATE_SCHEMA_VERSION}`);
  }
  exactFields(value, ["schemaVersion", "projectAgents", "bindings", "pendingEvents", "processedEvents"], "LongAgent State");
  if (!Array.isArray(value.projectAgents) || !Array.isArray(value.bindings)
    || !Array.isArray(value.pendingEvents) || !Array.isArray(value.processedEvents)) {
    throw new Error("LongAgent State projectAgents、bindings、pendingEvents和processedEvents必须是数组");
  }
  const projectAgents = value.projectAgents.map(parseProjectLongAgent);
  const bindings = value.bindings.map(parseBinding);
  const pendingEvents = value.pendingEvents.map(parsePendingEvent);
  const processedEvents = value.processedEvents.map(parseProcessedEvent);
  const ids = new Set<string>();
  const projectAgentKeys = new Set<string>();
  const sessions = new Set<string>();
  for (const projectAgent of projectAgents) {
    if (ids.has(projectAgent.id)) throw new Error(`Project Long Agent id重复: ${projectAgent.id}`);
    const key = `${projectAgent.projectId}\0${projectAgent.longAgentId}`;
    if (projectAgentKeys.has(key)) throw new Error(`Project存在重复LongAgent: ${projectAgent.longAgentId}`);
    const sessionKey = `${projectAgent.projectId}\0${projectAgent.primarySessionId}`;
    if (sessions.has(sessionKey)) throw new Error(`Chat Session被多个Project Long Agent占用: ${projectAgent.primarySessionId}`);
    ids.add(projectAgent.id);
    projectAgentKeys.add(key);
    sessions.add(sessionKey);
  }
  const bindingIds = new Set<string>();
  const nanoSessions = new Set<string>();
  for (const binding of bindings) {
    if (bindingIds.has(binding.id)) throw new Error(`LongAgent binding id重复: ${binding.id}`);
    if (!ids.has(binding.projectLongAgentId)) {
      throw new Error(`LongAgent binding引用未知Project Long Agent: ${binding.projectLongAgentId}`);
    }
    const nanoKey = binding.nanoclawSessionId === null
      ? null
      : `${binding.nanoclawInstanceId}\0${binding.nanoclawSessionId}`;
    if (nanoKey !== null && nanoSessions.has(nanoKey)) throw new Error(`NanoClaw Session存在多个Channel binding: ${binding.nanoclawSessionId}`);
    bindingIds.add(binding.id);
    if (nanoKey !== null) nanoSessions.add(nanoKey);
  }
  const eventIds = new Set<string>();
  for (const pending of pendingEvents) {
    if (eventIds.has(pending.event.eventId)) throw new Error(`LongAgent pending event重复: ${pending.event.eventId}`);
    eventIds.add(pending.event.eventId);
  }
  for (const processed of processedEvents) {
    if (eventIds.has(processed.eventId)) throw new Error(`LongAgent processed event重复: ${processed.eventId}`);
    eventIds.add(processed.eventId);
  }
  return { schemaVersion: 3, projectAgents, bindings, pendingEvents, processedEvents };
}

export function parseNanoClawIntegrationEvent(value: unknown): NanoClawIntegrationEvent {
  if (!isRecord(value)) throw new Error("NanoClaw integration event必须是对象");
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) <= 0) throw new Error("event.seq无效");
  if (value.direction !== "in" && value.direction !== "out") throw new Error("event.direction无效");
  if (typeof value.isGroup !== "boolean") throw new Error("event.isGroup无效");
  const images = parseWorkflowImages(value.images);
  return {
    seq: value.seq as number,
    eventId: requiredString(value.eventId, "event.eventId"),
    instanceId: parseId(value.instanceId, "event.instanceId"),
    direction: value.direction,
    messageId: requiredString(value.messageId, "event.messageId"),
    nanoSessionId: requiredString(value.nanoSessionId, "event.nanoSessionId"),
    agentGroupId: requiredString(value.agentGroupId, "event.agentGroupId"),
    messagingGroupId: value.messagingGroupId === null ? null : requiredString(value.messagingGroupId, "event.messagingGroupId"),
    isGroup: value.isGroup,
    senderId: value.senderId === null ? null : requiredString(value.senderId, "event.senderId"),
    senderName: typeof value.senderName === "string" ? value.senderName : "",
    text: typeof value.text === "string" ? value.text : "",
    ...(images === undefined ? {} : { images }),
    kind: requiredString(value.kind, "event.kind"),
    timestamp: parseTimestamp(value.timestamp, "event.timestamp"),
    source: value.source === null ? null : parseLongAgentAddress(value.source, "event.source"),
    delivery: value.delivery === null ? null : parseLongAgentAddress(value.delivery, "event.delivery"),
    chatSessionId: value.chatSessionId === null ? null : requiredString(value.chatSessionId, "event.chatSessionId"),
    ...(value.taskId === undefined || value.taskId === null
      ? {}
      : { taskId: requiredString(value.taskId, "event.taskId") }),
  };
}
