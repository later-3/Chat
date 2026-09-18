import { appendChatAuditEvent } from "../audit-log.js";
import { resolveChatHome } from "../chat-home.js";
import { agentHomeProjectId, ensureAgentHomeProject, readProjectRegistry } from "../projects/registry.js";
import { checkNanoClawGateway, getNanoClawAgentGroup, provisionNanoClawAgentGroup } from "./nanoclaw-client.js";
import { removeLongAgentAvatarAssets } from "./avatars.js";
import { readFile, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { assertFileWithin, atomicWriteJson, withFileLock } from "../persistence/versioned-file.js";
import { resolve } from "node:path";
import { getChatHomePaths } from "../chat-home.js";
import { ensureDefaultLongAgentTasks } from "./agent-tasks.js";
import { parseWorkflowAgentDefinition } from "../workflows/agent-config.js";
import { ensureLongAgentResourceDirs, longAgentConfigRoot, readLongAgentRegistry, updateLongAgentRegistry } from "./storage.js";
import {
  buildDefaultLongAgentDefinition,
  LONG_AGENT_ID_PATTERN,
  parseLongAgentRegistry,
  type LongAgentConfig,
  type LongAgentRegistry,
} from "./types.js";

export class LongAgentLifecycleError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "LongAgentLifecycleError";
    this.statusCode = statusCode;
  }
}

export interface CreateLongAgentInput {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly instanceId?: string;
  readonly nanoclawAgentGroupId?: string;
  readonly chatHome?: string;
  /** 测试与装配可注入的 Group 存在性校验；默认走 NanoClaw 管理 API。 */
  readonly verifyAgentGroup?: (
    instance: LongAgentRegistry["instances"][number],
    agentGroupId: string,
  ) => Promise<void>;
}

function findInstanceOrThrow(registry: LongAgentRegistry, instanceId: string) {
  const instance = registry.instances.find((candidate) => candidate.id === instanceId);
  if (instance === undefined) throw new LongAgentLifecycleError(400, `找不到NanoClaw实例: ${instanceId}`);
  return instance;
}

/**
 * 创建 Long Agent（管理架构 S2）：一次 provisioning 配齐配置根、独立 Daily Project
 * 和 Registry 索引。省略 Group 时通过窄管理 API 幂等初始化；显式 Group 用于绑定
 * 已有实体。失败不返回成功，初始化记录保留以便重试；Channel 可之后连接。
 */
export async function createLongAgent(input: CreateLongAgentInput): Promise<LongAgentConfig> {
  const chatHome = resolveChatHome(input.chatHome);
  if (!LONG_AGENT_ID_PATTERN.test(input.id)) {
    throw new LongAgentLifecycleError(400, `longAgentId格式无效: ${input.id}`);
  }
  const name = input.name.trim();
  if (name === "" || name.length > 200 || input.id.length > 80) throw new LongAgentLifecycleError(400, "名称必须为1–200个字符，ID不能超过80个字符");
  const homeProject = (await readProjectRegistry(chatHome)).projects.find((project) => project.projectId === input.id);
  if (homeProject !== undefined && (homeProject.kind !== "agent"
    || resolve(homeProject.path) !== resolve(longAgentConfigRoot(await realpath(chatHome), input.id), "workspace"))) {
    throw new LongAgentLifecycleError(409, "该ID已被其他Project使用，请选择另一个助手ID");
  }
  if (input.nanoclawAgentGroupId === undefined) return provisionLongAgent({ ...input, name, chatHome });
  const groupId = input.nanoclawAgentGroupId;

  const created = await updateLongAgentRegistry(chatHome, async (registry) => {
    if (registry.agents.some((agent) => agent.id === input.id)) {
      throw new LongAgentLifecycleError(409, `Long Agent已存在: ${input.id}`);
    }
    if (registry.agents.some((agent) => agent.nanoclawAgentGroupId === input.nanoclawAgentGroupId)) {
      throw new LongAgentLifecycleError(409, `NanoClaw Agent Group已被其他Agent绑定: ${input.nanoclawAgentGroupId}`);
    }
    const instance = findInstanceOrThrow(registry, input.instanceId ?? registry.instances[0]?.id ?? "");
    const verify = input.verifyAgentGroup ?? (async (inst, groupId) => {
      await getNanoClawAgentGroup(inst, groupId);
    });
    await verify(instance, groupId);

    const agent: LongAgentConfig = {
      id: input.id,
      name,
      description: input.description?.trim() ?? "",
      avatar: { kind: "auto" },
      enabled: true,
      instanceId: instance.id,
      nanoclawAgentGroupId: groupId,
      defaultProjectId: agentHomeProjectId(input.id),
      status: "active",
      toolsManagedByDefault: true,
      definition: parseWorkflowAgentDefinition(buildDefaultLongAgentDefinition(input.id, name, input.description?.trim() ?? "")),
    };
    // Publish the identity only after its home is usable. Partial filesystem work is retryable.
    await ensureLongAgentResourceDirs(chatHome, agent.id);
    await ensureAgentHomeProject(agent.id, agent.name, chatHome);
    return {
      registry: { ...registry, agents: [...registry.agents, agent] },
      result: agent,
    };
  });

  try {
    // 预置两个日常任务（日终总结 / 晨间联系）。这一步是尽力而为：任务接口暂时不可用
    // 不应让 Agent 创建失败——启动时的幂等补齐会重试。
    const instance = findInstanceOrThrow(await readLongAgentRegistry(chatHome), created.instanceId);
    try {
      await ensureDefaultLongAgentTasks({ instance, agentGroupId: created.nanoclawAgentGroupId });
    } catch (error) {
      console.warn(`预置Long Agent任务失败（${created.id}）: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    await updateLongAgentRegistry(chatHome, (registry) => ({
      registry: { ...registry, agents: registry.agents.filter((agent) => agent.id !== created.id) },
      result: undefined,
    }));
    throw error;
  }

  await appendChatAuditEvent({
    action: "long-agent.create",
    target: { type: "long-agent", longAgentId: created.id },
    details: { instanceId: created.instanceId, nanoclawAgentGroupId: created.nanoclawAgentGroupId },
  }, chatHome);
  return created;
}

/** No new enable flag: creating the first Agent is the explicit opt-in. */
export async function enableLongAgents(chatHomeInput?: string): Promise<LongAgentConfig> {
  const chatHome = resolveChatHome(chatHomeInput);
  const registry = await readLongAgentRegistry(chatHome);
  if (registry.agents.length > 0) return registry.agents[0]!;
  return createLongAgent({ id: "nexus", name: "Nexus", description: "日常工作与生活助手", chatHome });
}

async function provisionLongAgent(input: CreateLongAgentInput & { readonly chatHome: string }): Promise<LongAgentConfig> {
  const receiptPath = resolve(input.chatHome, "runtime", "long-agent-provisioning", `${input.id}.json`);
  // Serialize first-use instance registration and Agent provisioning; regular reads remain available.
  return withFileLock(resolve(input.chatHome, "runtime", "long-agent-provisioning"), async () => {
    let registry = await readLongAgentRegistry(input.chatHome);
    await assertFileWithin(receiptPath, input.chatHome);
    if (registry.instances.length === 0) {
      const candidate = parseLongAgentRegistry({ schemaVersion: 1, agents: [], instances: [{
        id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
        gatewayBaseUrl: process.env.CHAT_NANOCLAW_GATEWAY_URL ?? "http://127.0.0.1:3000/webhook/chat-backend",
      }] });
      if (!await checkNanoClawGateway(candidate.instances[0]!)) {
        throw new LongAgentLifecycleError(503, "长期同事服务尚未就绪：请先启动 NanoClaw chat-pi Host，并配置双方相同的服务认证。完成后重试。");
      }
      await updateLongAgentRegistry(input.chatHome, (latest) => ({
        registry: latest.instances.length === 0 ? { ...latest, instances: candidate.instances } : latest,
        result: undefined,
      }));
      registry = await readLongAgentRegistry(input.chatHome);
    }
    const instance = findInstanceOrThrow(registry, input.instanceId ?? registry.instances[0]!.id);
    const existing = registry.agents.find((agent) => agent.id === input.id);
    let receipt: { schemaVersion: 1; requestId: string; instanceId: string; name: string; description: string; completed: boolean };
    try {
      const value: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
      if (typeof value !== "object" || value === null || !("schemaVersion" in value) || value.schemaVersion !== 1
        || Object.keys(value).some((key) => !["schemaVersion", "requestId", "instanceId", "name", "description", "completed"].includes(key))
        || !("requestId" in value) || typeof value.requestId !== "string"
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.requestId)
        || !("instanceId" in value) || typeof value.instanceId !== "string"
        || !("name" in value) || typeof value.name !== "string"
        || !("description" in value) || typeof value.description !== "string"
        || !("completed" in value) || typeof value.completed !== "boolean") {
        throw new LongAgentLifecycleError(500, "助手创建记录无效，请检查服务日志");
      }
      receipt = { schemaVersion: 1, requestId: value.requestId, instanceId: value.instanceId,
        name: value.name, description: value.description, completed: value.completed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      receipt = { schemaVersion: 1, requestId: randomUUID(), instanceId: instance.id,
        name: input.name, description: input.description?.trim() ?? "", completed: false };
    }
    if (existing !== undefined) {
      if (existing.nanoclawAgentGroupId === `ag-${receipt.requestId}` && existing.instanceId === instance.id
        && existing.name === input.name && existing.description === (input.description?.trim() ?? "")) {
        await ensureLongAgentResourceDirs(input.chatHome, existing.id);
        await ensureAgentHomeProject(existing.id, existing.name, input.chatHome);
        await atomicWriteJson(receiptPath, { ...receipt, completed: true });
        return existing;
      }
      throw new LongAgentLifecycleError(409, `Long Agent已存在: ${input.id}`);
    }
    // Deletion followed by explicit recreation gets a fresh Group, never old private Memory.
    if (receipt.completed) receipt = { ...receipt, requestId: randomUUID(), name: input.name,
      description: input.description?.trim() ?? "", instanceId: instance.id, completed: false };
    if (receipt.instanceId !== instance.id || receipt.name !== input.name
      || receipt.description !== (input.description?.trim() ?? "")) {
      throw new LongAgentLifecycleError(409, "该ID的创建尚未完成，请使用原名称和描述重试，或选择其他ID");
    }
    await atomicWriteJson(receiptPath, receipt);
    const group = await provisionNanoClawAgentGroup(instance, receipt.requestId, input.name);
    const agent = await createLongAgent({ ...input, instanceId: instance.id, nanoclawAgentGroupId: group.id });
    await atomicWriteJson(receiptPath, { ...receipt, completed: true });
    return agent;
  });
}

/** 归档：停止新工作，保留全部数据，可恢复。 */
export async function archiveLongAgent(longAgentId: string, chatHomeInput?: string): Promise<void> {
  const chatHome = resolveChatHome(chatHomeInput);
  await updateLongAgentRegistry(chatHome, (registry) => {
    const agent = registry.agents.find((candidate) => candidate.id === longAgentId);
    if (agent === undefined) throw new LongAgentLifecycleError(404, `找不到Long Agent: ${longAgentId}`);
    return {
      registry: {
        ...registry,
        agents: registry.agents.map((candidate) => (
          candidate.id === longAgentId ? { ...candidate, status: "archived" as const, enabled: false } : candidate
        )),
      },
      result: undefined,
    };
  });
  await appendChatAuditEvent({
    action: "long-agent.archive",
    target: { type: "long-agent", longAgentId },
    details: {},
  }, chatHome);
}

/** 恢复归档的 Agent。 */
export async function unarchiveLongAgent(longAgentId: string, chatHomeInput?: string): Promise<void> {
  const chatHome = resolveChatHome(chatHomeInput);
  await updateLongAgentRegistry(chatHome, (registry) => {
    const agent = registry.agents.find((candidate) => candidate.id === longAgentId);
    if (agent === undefined) throw new LongAgentLifecycleError(404, `找不到Long Agent: ${longAgentId}`);
    return {
      registry: {
        ...registry,
        agents: registry.agents.map((candidate) => (
          candidate.id === longAgentId ? { ...candidate, status: "active" as const } : candidate
        )),
      },
      result: undefined,
    };
  });
  await appendChatAuditEvent({
    action: "long-agent.unarchive",
    target: { type: "long-agent", longAgentId },
    details: {},
  }, chatHome);
}

/**
 * 两阶段删除：必须先归档。删除 Registry 绑定、配置根、头像资产与运行时缓存；
 * 不删除该 Agent 参与过的业务 Project 历史，也不删除其 Daily Workspace 文件
 * （只解除 Project 登记，数据留在磁盘可人工处理）。
 */
export async function deleteLongAgent(longAgentId: string, chatHomeInput?: string): Promise<void> {
  const chatHome = resolveChatHome(chatHomeInput);
  await updateLongAgentRegistry(chatHome, (registry) => {
    const agent = registry.agents.find((candidate) => candidate.id === longAgentId);
    if (agent === undefined) throw new LongAgentLifecycleError(404, `找不到Long Agent: ${longAgentId}`);
    if (agent.status !== "archived") {
      throw new LongAgentLifecycleError(409, `Long Agent必须先归档才能删除: ${longAgentId}`);
    }
    return {
      registry: { ...registry, agents: registry.agents.filter((candidate) => candidate.id !== longAgentId) },
      result: undefined,
    };
  });
  await removeLongAgentAvatarAssets(longAgentId, chatHome);
  await rm(longAgentConfigRoot(chatHome, longAgentId), { recursive: true, force: true });
  await rm(resolveRuntimeDir(chatHome, longAgentId), { recursive: true, force: true });
  await appendChatAuditEvent({
    action: "long-agent.delete",
    target: { type: "long-agent", longAgentId },
    details: {},
  }, chatHome);
}

function resolveRuntimeDir(chatHome: string, longAgentId: string): string {
  return resolve(getChatHomePaths(chatHome).longAgentsRuntimeDir, longAgentId);
}
