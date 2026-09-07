import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createCodingTools,
  createReadOnlyTools,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { appendChatAuditEvent } from "../audit-log.js";
import { ensureChatHome, resolveChatHome } from "../chat-home.js";
import { resolveProjectContext } from "../projects/registry.js";
import { listChatTools } from "../resources/tools.js";
import { listChatSystemTools } from "../tools/registry.js";
import {
  parseWorkflowAgentDefinition,
  type WorkflowAgentDefinition,
} from "../workflows/agent-config.js";
import { readLongAgentRegistry, updateLongAgentRegistry } from "./storage.js";
import {
  LONG_AGENT_ID_PATTERN,
  type LongAgentConfig,
  type LongAgentInstanceConfig,
} from "./types.js";

export interface LongAgentConfigurationDocument {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly enabled: boolean;
    readonly defaultProjectId: string;
    readonly definition: {
      readonly schemaVersion: 1;
      readonly id: string;
      readonly name: string;
      readonly description: string;
      readonly model: WorkflowAgentDefinition["model"] | null;
      readonly thinkingLevel: WorkflowAgentDefinition["thinkingLevel"] | null;
      readonly systemPrompt: WorkflowAgentDefinition["systemPrompt"];
      readonly customInstructions: readonly string[];
      readonly tools: WorkflowAgentDefinition["tools"];
      readonly resources: WorkflowAgentDefinition["resources"];
    };
  };
  readonly channel: {
    readonly type: string;
    readonly instance: string;
    readonly host: {
      readonly id: string;
      readonly name: string;
      readonly executionMode: "chat-pi";
    };
  };
}

export class LongAgentConfigurationInvalidError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LongAgentConfigurationInvalidError";
  }
}

export class LongAgentConfigurationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LongAgentConfigurationNotFoundError";
  }
}

export class LongAgentConfigurationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LongAgentConfigurationConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  const fields = new Set(allowed);
  const unknown = Object.keys(value).filter((field) => !fields.has(field));
  if (unknown.length > 0) {
    throw new LongAgentConfigurationInvalidError(`${subject}包含未知字段: ${unknown.join(", ")}`);
  }
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LongAgentConfigurationInvalidError(`${field}必须是非空字符串`);
  }
  return value.trim();
}

function parseLongAgentId(value: unknown): string {
  const id = readNonEmptyString(value, "Long Agent ID");
  if (!LONG_AGENT_ID_PATTERN.test(id)) {
    throw new LongAgentConfigurationInvalidError("Long Agent ID格式无效");
  }
  return id;
}

function revisionOf(agent: LongAgentConfig): string {
  return createHash("sha256").update(JSON.stringify(agent)).digest("hex");
}

function findInstance(instances: readonly LongAgentInstanceConfig[], instanceId: string): LongAgentInstanceConfig {
  const instance = instances.find((candidate) => candidate.id === instanceId);
  if (instance === undefined) throw new Error(`LongAgent引用未知Instance: ${instanceId}`);
  return instance;
}

function documentOf(agent: LongAgentConfig, instance: LongAgentInstanceConfig): LongAgentConfigurationDocument {
  return {
    schemaVersion: 1,
    revision: revisionOf(agent),
    agent: {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      enabled: agent.enabled,
      defaultProjectId: agent.defaultProjectId,
      definition: {
        schemaVersion: 1,
        id: agent.definition.id,
        name: agent.definition.name,
        description: agent.definition.description,
        model: agent.definition.model ?? null,
        thinkingLevel: agent.definition.thinkingLevel ?? null,
        systemPrompt: agent.definition.systemPrompt,
        customInstructions: agent.definition.customInstructions.map((instruction) => instruction.text),
        tools: agent.definition.tools,
        resources: agent.definition.resources,
      },
    },
    channel: {
      type: agent.inbox.channelType,
      instance: agent.inbox.instance,
      host: {
        id: instance.id,
        name: instance.name,
        executionMode: instance.executionMode,
      },
    },
  };
}

export async function readLongAgentConfiguration(
  longAgentId: string,
  chatHome = resolveChatHome(),
): Promise<LongAgentConfigurationDocument> {
  const id = parseLongAgentId(longAgentId);
  const registry = await readLongAgentRegistry(chatHome);
  const agent = registry.agents.find((candidate) => candidate.id === id);
  if (agent === undefined) throw new LongAgentConfigurationNotFoundError(`找不到Long Agent: ${id}`);
  return documentOf(agent, findInstance(registry.instances, agent.instanceId));
}

interface ParsedUpdate {
  readonly expectedRevision: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly defaultProjectId: string;
  readonly definition: WorkflowAgentDefinition;
}

function parseUpdate(value: unknown, longAgentId: string): ParsedUpdate {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new LongAgentConfigurationInvalidError("Long Agent配置必须使用schemaVersion 1");
  }
  exactFields(value, [
    "schemaVersion", "expectedRevision", "name", "description", "enabled", "defaultProjectId", "definition",
  ], "Long Agent配置");
  const expectedRevision = readNonEmptyString(value.expectedRevision, "expectedRevision");
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new LongAgentConfigurationInvalidError("expectedRevision格式无效");
  }
  const name = readNonEmptyString(value.name, "name");
  const description = readNonEmptyString(value.description, "description");
  if (typeof value.enabled !== "boolean") {
    throw new LongAgentConfigurationInvalidError("enabled必须是布尔值");
  }
  const defaultProjectId = readNonEmptyString(value.defaultProjectId, "defaultProjectId");
  if (!isRecord(value.definition)) throw new LongAgentConfigurationInvalidError("definition必须是对象");
  let definition: WorkflowAgentDefinition;
  try {
    definition = parseWorkflowAgentDefinition(value.definition);
  } catch (error) {
    throw new LongAgentConfigurationInvalidError(
      error instanceof Error ? error.message : "definition无效",
      { cause: error },
    );
  }
  if (definition.id !== longAgentId || definition.name !== name || definition.description !== description) {
    throw new LongAgentConfigurationInvalidError("definition的id、name和description必须与Long Agent身份一致");
  }
  return { expectedRevision, name, description, enabled: value.enabled, defaultProjectId, definition };
}

async function validateModel(definition: WorkflowAgentDefinition, chatHome: string): Promise<void> {
  if (definition.model === undefined) return;
  const home = await ensureChatHome(chatHome);
  const runtime = await ModelRuntime.create({
    authPath: join(home.agentDir, "auth.json"),
    modelsPath: join(home.agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const model = runtime.getModel(definition.model.provider, definition.model.modelId);
  if (model === undefined) {
    throw new LongAgentConfigurationInvalidError(
      `找不到Model: ${definition.model.provider}/${definition.model.modelId}`,
    );
  }
  if (!runtime.hasConfiguredAuth(model.provider)) {
    throw new LongAgentConfigurationInvalidError(`Provider没有认证: ${model.provider}`);
  }
}

async function validateTools(
  definition: WorkflowAgentDefinition,
  projectId: string,
  chatHome: string,
): Promise<void> {
  const addresses = definition.tools.mode === "none" ? [] : definition.tools.addresses ?? [];
  const knownAddresses = new Set(listChatSystemTools().map((tool) => tool.address));
  for (const address of addresses) {
    if (!knownAddresses.has(address)) {
      throw new LongAgentConfigurationInvalidError(`找不到可配置的Chat系统Tool: ${address}`);
    }
  }
  if (definition.tools.mode !== "explicit") return;

  const project = await resolveProjectContext(projectId, chatHome);
  const catalog = await listChatTools(projectId, chatHome);
  const knownNames = new Set([
    ...createCodingTools(project.cwd),
    ...createReadOnlyTools(project.cwd),
  ].map((tool) => tool.name));
  for (const tool of catalog.tools) knownNames.add(tool.name);
  const unknown = [...definition.tools.names, ...definition.tools.exclude]
    .filter((name) => !knownNames.has(name));
  if (unknown.length > 0) {
    throw new LongAgentConfigurationInvalidError(
      `找不到可配置的Tool: ${[...new Set(unknown)].join(", ")}`,
    );
  }
}

export async function updateLongAgentConfiguration(
  longAgentId: string,
  value: unknown,
  chatHome = resolveChatHome(),
): Promise<LongAgentConfigurationDocument> {
  const root = resolveChatHome(chatHome);
  const id = parseLongAgentId(longAgentId);
  const update = parseUpdate(value, id);
  try {
    await resolveProjectContext(update.defaultProjectId, root);
  } catch (error) {
    throw new LongAgentConfigurationInvalidError(
      `defaultProjectId不可用: ${update.defaultProjectId}`,
      { cause: error },
    );
  }
  await validateModel(update.definition, root);
  await validateTools(update.definition, update.defaultProjectId, root);

  const document = await updateLongAgentRegistry(root, (registry) => {
    const index = registry.agents.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new LongAgentConfigurationNotFoundError(`找不到Long Agent: ${id}`);
    const previous = registry.agents[index];
    if (previous === undefined) throw new LongAgentConfigurationNotFoundError(`找不到Long Agent: ${id}`);
    if (revisionOf(previous) !== update.expectedRevision) {
      throw new LongAgentConfigurationConflictError("Long Agent配置已被其他操作更新，请重新加载后再保存");
    }
    const next: LongAgentConfig = {
      ...previous,
      name: update.name,
      description: update.description,
      enabled: update.enabled,
      defaultProjectId: update.defaultProjectId,
      definition: update.definition,
    };
    const agents = [...registry.agents];
    agents[index] = next;
    return {
      registry: { ...registry, agents },
      result: documentOf(next, findInstance(registry.instances, next.instanceId)),
    };
  });

  await appendChatAuditEvent({
    action: "long-agent.config.update",
    target: { type: "long-agent", longAgentId: id },
    details: {
      enabled: document.agent.enabled,
      defaultProjectId: document.agent.defaultProjectId,
      model: document.agent.definition.model ?? null,
      thinkingLevel: document.agent.definition.thinkingLevel ?? null,
      toolMode: document.agent.definition.tools.mode,
      resourceMode: document.agent.definition.resources.mode,
    },
  }, root);
  return document;
}
