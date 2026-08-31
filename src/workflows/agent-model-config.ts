import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parseModel, parseThinkingLevel, type AgentModelConfig } from "./agent-config.js";

const SCHEMA_VERSION = 1;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALLOWED_FIELDS = new Set(["schemaVersion", "model", "thinkingLevel"]);

/**
 * Chat-owned per-Agent model configuration, persisted per Project and read on
 * every Workflow run. Values are references only (provider/modelId); API keys
 * stay in the Personal Chat Home agent directory.
 */
export interface ChatAgentDurableModelConfig {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly model?: AgentModelConfig;
  readonly thinkingLevel?: ThinkingLevel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEntityId(value: string, field: string): void {
  if (!ENTITY_ID_PATTERN.test(value)) throw new Error(`${field}格式无效: ${value}`);
}

function parseDurableModelConfig(value: unknown, source: string): ChatAgentDurableModelConfig {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Agent模型配置必须使用schemaVersion 1: ${source}`);
  }
  const unknown = Object.keys(value).filter((field) => !ALLOWED_FIELDS.has(field));
  if (unknown.length > 0) throw new Error(`Agent模型配置包含未知字段: ${unknown.join(", ")}: ${source}`);
  const model = value.model === undefined ? undefined : parseModel(value.model);
  const thinkingLevel = value.thinkingLevel === undefined ? undefined : parseThinkingLevel(value.thinkingLevel);
  if (model === undefined && thinkingLevel === undefined) {
    throw new Error(`Agent模型配置至少需要model或thinkingLevel: ${source}`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

export function agentModelConfigPath(projectDataDir: string, workflowId: string, agentId: string): string {
  assertEntityId(workflowId, "workflowId");
  assertEntityId(agentId, "agentId");
  return resolve(projectDataDir, "workflows", workflowId, "agents", `${agentId}.json`);
}

export async function readAgentModelConfig(
  projectDataDir: string,
  workflowId: string,
  agentId: string,
): Promise<ChatAgentDurableModelConfig | undefined> {
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
  return parseDurableModelConfig(value, path);
}

export async function writeAgentModelConfig(
  projectDataDir: string,
  workflowId: string,
  agentId: string,
  value: unknown,
): Promise<ChatAgentDurableModelConfig> {
  const path = agentModelConfigPath(projectDataDir, workflowId, agentId);
  const config = parseDurableModelConfig(value, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
  return config;
}

export async function clearAgentModelConfig(
  projectDataDir: string,
  workflowId: string,
  agentId: string,
): Promise<boolean> {
  const path = agentModelConfigPath(projectDataDir, workflowId, agentId);
  try {
    await rm(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
