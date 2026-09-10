import { assertFileWithin, atomicWriteJson, expectRevision, withFileLock } from "../persistence/versioned-file.js";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  parseModel,
  parseThinkingLevel,
  parseWorkflowAgentToolPolicy,
  parseWorkflowAgentResources,
  type AgentModelConfig,
  type WorkflowAgentResources,
  type WorkflowAgentToolPolicy,
} from "./agent-config.js";

const SCHEMA_VERSION = 1;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALLOWED_FIELDS = new Set(["schemaVersion", "model", "thinkingLevel", "tools", "resources"]);

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
  if (model === undefined && thinkingLevel === undefined && tools === undefined && resources === undefined) {
    throw new Error(`Agent持久配置至少需要model、thinkingLevel、tools或resources: ${source}`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(tools === undefined ? {} : { tools }),
    ...(resources === undefined ? {} : { resources }),
  };
}

export function agentModelConfigPath(projectDataDir: string, workflowId: string, agentId: string): string {
  assertEntityId(workflowId, "workflowId");
  assertEntityId(agentId, "agentId");
  return resolve(projectDataDir, "workflows", workflowId, "agents", `${agentId}.json`);
}

export async function readAgentDurableConfig(
  projectDataDir: string,
  workflowId: string,
  agentId: string,
): Promise<ChatAgentDurableConfig | undefined> {
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
  },
): Promise<ChatAgentDurableConfig | undefined> {
  return mutateAgentDurableConfig(projectDataDir, workflowId, agentId, async (existing) => {
    const next = {
      schemaVersion: SCHEMA_VERSION,
      ...(existing?.model === undefined ? {} : { model: existing.model }),
      ...(existing?.thinkingLevel === undefined ? {} : { thinkingLevel: existing.thinkingLevel }),
      ...(existing?.tools === undefined ? {} : { tools: existing.tools }),
      ...(existing?.resources === undefined ? {} : { resources: existing.resources }),
      ...(patch.model === undefined ? {} : patch.model === null ? { model: undefined } : { model: patch.model }),
      ...(patch.thinkingLevel === undefined
        ? {}
        : patch.thinkingLevel === null ? { thinkingLevel: undefined } : { thinkingLevel: patch.thinkingLevel }),
      ...(patch.tools === undefined ? {} : patch.tools === null ? { tools: undefined } : { tools: patch.tools }),
      ...(patch.resources === undefined
        ? {}
        : patch.resources === null ? { resources: undefined } : { resources: patch.resources }),
    };
    const normalized = {
      schemaVersion: SCHEMA_VERSION,
      ...(next.model === undefined ? {} : { model: next.model }),
      ...(next.thinkingLevel === undefined ? {} : { thinkingLevel: next.thinkingLevel }),
      ...(next.tools === undefined ? {} : { tools: next.tools }),
      ...(next.resources === undefined ? {} : { resources: next.resources }),
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
