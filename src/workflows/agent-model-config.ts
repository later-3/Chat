import { assertFileWithin, atomicWriteJson, expectRevision, withFileLock } from "../persistence/versioned-file.js";
import { DEFAULT_CHAT_WORKFLOW_ID } from "./ids.js";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  parseGeneration,
  parseModel,
  parseThinkingLevel,
  parseWorkflowAgentToolPolicy,
  parseWorkflowAgentResources,
  type AgentGenerationConfig,
  type AgentModelConfig,
  type WorkflowAgentResources,
  type WorkflowAgentToolPolicy,
} from "./agent-config.js";

const SCHEMA_VERSION = 1;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALLOWED_FIELDS = new Set(["schemaVersion", "model", "thinkingLevel", "tools", "resources", "generation"]);

/**
 * Chat-owned per-Agent model configuration, persisted per Project and read on
 * every Workflow run. Values are references only (provider/modelId); API keys
 * stay in the Personal Chat Home agent directory.
 */
export interface ChatAgentDurableConfig {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly model?: AgentModelConfig;
  readonly thinkingLevel?: ThinkingLevel;
  readonly tools?: WorkflowAgentToolPolicy;
  readonly resources?: WorkflowAgentResources;
  readonly generation?: AgentGenerationConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEntityId(value: string, field: string): void {
  if (!ENTITY_ID_PATTERN.test(value)) throw new Error(`${field}格式无效: ${value}`);
}

export function parseDurableConfig(value: unknown, source: string): ChatAgentDurableConfig {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Agent模型配置必须使用schemaVersion 1: ${source}`);
  }
  const unknown = Object.keys(value).filter((field) => !ALLOWED_FIELDS.has(field));
  if (unknown.length > 0) throw new Error(`Agent模型配置包含未知字段: ${unknown.join(", ")}: ${source}`);
  const model = value.model === undefined ? undefined : parseModel(value.model);
  const thinkingLevel = value.thinkingLevel === undefined ? undefined : parseThinkingLevel(value.thinkingLevel);
  const tools = value.tools === undefined ? undefined : parseWorkflowAgentToolPolicy(value.tools);
  const resources = value.resources === undefined ? undefined : parseWorkflowAgentResources(value.resources);
  const generation = value.generation === undefined ? undefined : parseGeneration(value.generation);
  if (model === undefined && thinkingLevel === undefined && tools === undefined && resources === undefined
    && generation === undefined) {
    throw new Error(`Agent持久配置至少需要model、thinkingLevel、generation、tools或resources: ${source}`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(tools === undefined ? {} : { tools }),
    ...(resources === undefined ? {} : { resources }),
    ...(generation === undefined ? {} : { generation }),
  };
}

export function agentModelConfigPath(projectDataDir: string, workflowId: string, agentId: string): string {
  assertEntityId(workflowId, "workflowId");
  assertEntityId(agentId, "agentId");
  // P3-U2：**默认工作流的能力配置是 Long Agent 单键**（没有 workflow / 内置角色维度）——
  // 所有调用方（读取/写入/检查）都经由这里，因此"一份配置"在路径层就成立，
  // 不需要每个调用方各写一遍。其他工作流（真正编排多 Agent）保持工作流维度。
  if (workflowId === DEFAULT_CHAT_WORKFLOW_ID) return resolve(projectDataDir, "capability-config.json");
  return resolve(projectDataDir, "workflows", workflowId, "agents", `${agentId}.json`);
}

export async function readAgentDurableConfig(
  projectDataDir: string,
  workflowId: string,
  agentId: string,
): Promise<ChatAgentDurableConfig | undefined> {
  // 默认工作流：**Long Agent 单键**（旧键 → 新键一次性惰性迁移；两者都在同一个 Long Agent 根下）。
  if (workflowId === DEFAULT_CHAT_WORKFLOW_ID) {
    const path = agentModelConfigPath(projectDataDir, workflowId, agentId);
    const existing = await readConfigFileIfPresent(path);
    if (existing !== undefined) return existing;
    const legacyPath = resolve(projectDataDir, "workflows", workflowId, "agents", `${agentId}.json`);
    const legacyValue = await readConfigFileIfPresent(legacyPath);
    if (legacyValue === undefined) return undefined;
    await withFileLock(path, async () => {
      await atomicWriteJson(path, legacyValue);
      await atomicWriteJson(resolve(projectDataDir, "runtime", "migrations", "long-agent-capability-unify", "legacy-config.json"), legacyValue);
      await rm(resolve(projectDataDir, "workflows"), { recursive: true, force: true }).catch(() => undefined);
      await atomicWriteJson(resolve(projectDataDir, "runtime", "migrations", "long-agent-capability-unify", "done.json"),
        { schemaVersion: 1, from: legacyPath, to: path, at: new Date().toISOString() });
    });
    return legacyValue;
  }
  const path = agentModelConfigPath(projectDataDir, workflowId, agentId);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Agent模型配置不是有效JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseDurableConfig(value, path);
}

export async function writeAgentDurableConfig(
  projectDataDir: string,
  workflowId: string,
  agentId: string,
  value: unknown,
): Promise<ChatAgentDurableConfig> {
  const parsed = parseDurableConfig(value, "Agent durable config");
  const path = agentModelConfigPath(projectDataDir, workflowId, agentId);
  return withFileLock(path, async () => {
    await assertFileWithin(path, projectDataDir);
    await atomicWriteJson(path, parsed);
    return parsed;
  });
}

export async function mutateAgentDurableConfig(
  projectDataDir: string,
  workflowId: string,
  agentId: string,
  transform: (current: ChatAgentDurableConfig | undefined) => unknown | Promise<unknown>,
  options: { readonly expectedRevision?: string; readonly validateOnly?: boolean } = {},
): Promise<ChatAgentDurableConfig | undefined> {
  const path = agentModelConfigPath(projectDataDir, workflowId, agentId);
  return withFileLock(path, async () => {
    await assertFileWithin(path, projectDataDir);
    if (options.expectedRevision !== undefined) await expectRevision(path, options.expectedRevision);
    const value = await transform(await readAgentDurableConfig(projectDataDir, workflowId, agentId));
    const config = value === undefined ? undefined : parseDurableConfig(value, path);
    if (options.validateOnly === true) return config;
    if (config === undefined) {
      await rm(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    } else await atomicWriteJson(path, config);
    return config;
  });
}

export async function updateAgentDurableConfig(
  projectDataDir: string,
  workflowId: string,
  agentId: string,
  patch: {
    readonly model?: AgentModelConfig | null;
    readonly thinkingLevel?: ThinkingLevel | null;
    readonly tools?: WorkflowAgentToolPolicy | null;
    readonly resources?: WorkflowAgentResources | null;
    readonly generation?: AgentGenerationConfig | null;
  },
): Promise<ChatAgentDurableConfig | undefined> {
  return mutateAgentDurableConfig(projectDataDir, workflowId, agentId, async (existing) => {
    const next = {
      schemaVersion: SCHEMA_VERSION,
      ...(existing?.model === undefined ? {} : { model: existing.model }),
      ...(existing?.thinkingLevel === undefined ? {} : { thinkingLevel: existing.thinkingLevel }),
      ...(existing?.tools === undefined ? {} : { tools: existing.tools }),
      ...(existing?.resources === undefined ? {} : { resources: existing.resources }),
      ...(existing?.generation === undefined ? {} : { generation: existing.generation }),
      ...(patch.model === undefined ? {} : patch.model === null ? { model: undefined } : { model: patch.model }),
      ...(patch.thinkingLevel === undefined
        ? {}
        : patch.thinkingLevel === null ? { thinkingLevel: undefined } : { thinkingLevel: patch.thinkingLevel }),
      ...(patch.tools === undefined ? {} : patch.tools === null ? { tools: undefined } : { tools: patch.tools }),
      ...(patch.resources === undefined
        ? {}
        : patch.resources === null ? { resources: undefined } : { resources: patch.resources }),
      ...(patch.generation === undefined
        ? {}
        : patch.generation === null ? { generation: undefined } : { generation: patch.generation }),
    };
    const normalized = {
      schemaVersion: SCHEMA_VERSION,
      ...(next.model === undefined ? {} : { model: next.model }),
      ...(next.thinkingLevel === undefined ? {} : { thinkingLevel: next.thinkingLevel }),
      ...(next.tools === undefined ? {} : { tools: next.tools }),
      ...(next.resources === undefined ? {} : { resources: next.resources }),
      ...(next.generation === undefined ? {} : { generation: next.generation }),
    };
    return Object.keys(normalized).length === 1 ? undefined : normalized;
  });
}

/** Compatibility entry point for the existing model route and callers. */
export const readAgentModelConfig = readAgentDurableConfig;

/** Compatibility entry point; callers that need to preserve other fields must use updateAgentDurableConfig. */
export const writeAgentModelConfig = writeAgentDurableConfig;

export async function clearAgentModelConfig(
  projectDataDir: string,
  workflowId: string,
  agentId: string,
): Promise<boolean> {
  const existing = await readAgentDurableConfig(projectDataDir, workflowId, agentId);
  if (existing?.model === undefined && existing?.thinkingLevel === undefined) return false;
  await updateAgentDurableConfig(projectDataDir, workflowId, agentId, { model: null, thinkingLevel: null });
  return true;
}

export async function clearAgentToolConfig(
  projectDataDir: string,
  workflowId: string,
  agentId: string,
): Promise<boolean> {
  const existing = await readAgentDurableConfig(projectDataDir, workflowId, agentId);
  if (existing?.tools === undefined) return false;
  await updateAgentDurableConfig(projectDataDir, workflowId, agentId, { tools: null });
  return true;
}

// ---------------------------------------------------------------------------
// P3-U2：Long Agent 能力配置（**单键**，无 workflow / 内置角色维度）
//
// 用户 2026-10-13 定界 + 判断方法（不背包袱）：
//   新键：<ChatHome>/long-agents/<longAgentId>/capability-config.json
//   旧键：<ChatHome>/long-agents/<id>/workflows/<workflowId>/agents/<agentId>.json（历史形态）
//   迁移：读时惰性 —— 写新键 + **删旧键** + 写迁移标记；回退 = 删新键与标记（旧键已删，但从迁移标记可追溯来源）。
// ---------------------------------------------------------------------------

/** Long Agent 能力配置的唯一路径（单键）。 */
export function longAgentCapabilityConfigPath(chatHome: string, longAgentId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(longAgentId)) throw new Error(`longAgentId格式无效: ${longAgentId}`);
  return resolve(chatHome, "long-agents", longAgentId, "capability-config.json");
}

/** 历史形态：默认工作流下按内置角色命名的能力配置（迁移源，迁移后删除）。 */
export function legacyWorkflowAgentConfigPath(chatHome: string, longAgentId: string, workflowId: string, agentId: string): string {
  assertEntityId(workflowId, "workflowId");
  assertEntityId(agentId, "agentId");
  return resolve(chatHome, "long-agents", longAgentId, "workflows", workflowId, "agents", `${agentId}.json`);
}

export interface CapabilityMigrationSource {
  readonly workflowId: string;
  readonly agentId: string;
}

async function readConfigFileIfPresent(path: string): Promise<ChatAgentDurableConfig | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Agent模型配置不是有效JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseDurableConfig(value, path);
}

/**
 * 读 Long Agent 能力配置。新键没有、且给了旧键来源时，执行**一次性惰性迁移**：
 * 新键 ← 旧键内容；**删除旧键文件与空目录**；写迁移标记（`runtime/migrations/long-agent-capability-unify/done.json`）。
 * 迁移幂等（新键已存在即直接返回），失败可重试。
 */
export async function readLongAgentCapabilityConfig(
  chatHome: string,
  longAgentId: string,
  legacy?: CapabilityMigrationSource,
): Promise<ChatAgentDurableConfig | undefined> {
  const path = longAgentCapabilityConfigPath(chatHome, longAgentId);
  const existing = await readConfigFileIfPresent(path);
  if (existing !== undefined || legacy === undefined) return existing;
  const legacyPath = legacyWorkflowAgentConfigPath(chatHome, longAgentId, legacy.workflowId, legacy.agentId);
  const legacyValue = await readConfigFileIfPresent(legacyPath);
  if (legacyValue === undefined) return undefined;
  return withFileLock(path, async () => {
    await atomicWriteJson(path, legacyValue);
    // 回退依据：把旧键原样备份到**有归属**的迁移目录（不留无归属备份文件）。
    const backupPath = resolve(chatHome, "long-agents", longAgentId, "runtime", "migrations", "long-agent-capability-unify", "legacy-config.json");
    await atomicWriteJson(backupPath, legacyValue);
    await rm(legacyPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await rm(resolve(chatHome, "long-agents", longAgentId, "workflows", legacy.workflowId, "agents"), { recursive: true, force: true }).catch(() => undefined);
    await rm(resolve(chatHome, "long-agents", longAgentId, "workflows", legacy.workflowId), { recursive: true, force: true }).catch(() => undefined);
    await rm(resolve(chatHome, "long-agents", longAgentId, "workflows"), { recursive: true, force: true }).catch(() => undefined);
    await atomicWriteJson(
      resolve(chatHome, "long-agents", longAgentId, "runtime", "migrations", "long-agent-capability-unify", "done.json"),
      { schemaVersion: 1, from: legacyPath, to: path, backup: backupPath, at: new Date().toISOString() },
    );
    return legacyValue;
  });
}

/** 改 Long Agent 能力配置（单键）。语义与 `mutateAgentDurableConfig` 一致（revision 乐观并发、可校验不写）。 */
export async function mutateLongAgentCapabilityConfig(
  chatHome: string,
  longAgentId: string,
  transform: (current: ChatAgentDurableConfig | undefined) => unknown | Promise<unknown>,
  options: { readonly expectedRevision?: string; readonly validateOnly?: boolean; readonly legacy?: CapabilityMigrationSource } = {},
): Promise<ChatAgentDurableConfig | undefined> {
  const path = longAgentCapabilityConfigPath(chatHome, longAgentId);
  await readLongAgentCapabilityConfig(chatHome, longAgentId, options.legacy);
  return withFileLock(path, async () => {
    await assertFileWithin(path, chatHome);
    if (options.expectedRevision !== undefined) await expectRevision(path, options.expectedRevision);
    const value = await transform(await readConfigFileIfPresent(path));
    const config = value === undefined ? undefined : parseDurableConfig(value, path);
    if (options.validateOnly === true) return config;
    if (config === undefined) {
      await rm(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    } else await atomicWriteJson(path, config);
    return config;
  });
}
