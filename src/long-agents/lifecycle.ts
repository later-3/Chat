import { appendChatAuditEvent } from "../audit-log.js";
import { resolveChatHome } from "../chat-home.js";
import { agentHomeProjectId, ensureAgentHomeProject } from "../projects/registry.js";
import { getNanoClawAgentGroup } from "./nanoclaw-client.js";
import { removeLongAgentAvatarAssets } from "./avatars.js";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { getChatHomePaths } from "../chat-home.js";
import { ensureDefaultLongAgentTasks } from "./agent-tasks.js";
import { ensureLongAgentResourceDirs, longAgentConfigRoot, readLongAgentRegistry, updateLongAgentRegistry } from "./storage.js";
import {
  LONG_AGENT_ID_PATTERN,
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
  readonly instanceId: string;
  readonly nanoclawAgentGroupId: string;
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
 * 和 Registry 索引；任一步失败整体回滚，不留半注册实体。Channel 绑定（inbox）
 * 可以之后补；NanoClaw Agent Group 必须已经存在并经管理 API 可读。
 */
export async function createLongAgent(input: CreateLongAgentInput): Promise<LongAgentConfig> {
  const chatHome = resolveChatHome(input.chatHome);
  if (!LONG_AGENT_ID_PATTERN.test(input.id)) {
    throw new LongAgentLifecycleError(400, `longAgentId格式无效: ${input.id}`);
  }
  const name = input.name.trim();
  if (name === "") throw new LongAgentLifecycleError(400, "name必须是非空字符串");

  const created = await updateLongAgentRegistry(chatHome, async (registry) => {
    if (registry.agents.some((agent) => agent.id === input.id)) {
      throw new LongAgentLifecycleError(409, `Long Agent已存在: ${input.id}`);
    }
    if (registry.agents.some((agent) => agent.nanoclawAgentGroupId === input.nanoclawAgentGroupId)) {
      throw new LongAgentLifecycleError(409, `NanoClaw Agent Group已被其他Agent绑定: ${input.nanoclawAgentGroupId}`);
    }
    const instance = findInstanceOrThrow(registry, input.instanceId);
    const verify = input.verifyAgentGroup ?? (async (inst, groupId) => {
      await getNanoClawAgentGroup(inst, groupId);
    });
    await verify(instance, input.nanoclawAgentGroupId);

    const agent: LongAgentConfig = {
      id: input.id,
      name,
      description: input.description?.trim() ?? "",
      avatar: { kind: "auto" },
      enabled: true,
      instanceId: input.instanceId,
      nanoclawAgentGroupId: input.nanoclawAgentGroupId,
      defaultProjectId: agentHomeProjectId(input.id),
      status: "active",
      definition: {
        schemaVersion: 1,
        id: input.id,
        name,
        // definition.description 必填非空；与 types.ts 默认定义的语义保持一致。
        description: (input.description?.trim() ?? "") === "" ? "Chat Long Agent" : input.description!.trim(),
        systemPrompt: { mode: "pi-default" },
        customInstructions: [],
        tools: { mode: "pi-default" },
        resources: { mode: "inherit" },
      },
    };
    return {
      registry: { ...registry, agents: [...registry.agents, agent] },
      result: agent,
    };
  });

  try {
    await ensureLongAgentResourceDirs(chatHome, created.id);
    await ensureAgentHomeProject(created.id, created.name, chatHome);
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
