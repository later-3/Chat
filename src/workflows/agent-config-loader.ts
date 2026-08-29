import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  MAX_AGENT_CONFIG_FILES,
  parseRawAgentConfig,
  type AgentConfigSelection,
  type AgentConfigSource,
  type AgentInstruction,
  type RawAgentConfig,
  type RawInstruction,
  type RawSystemPrompt,
  type ResolvedWorkflowAgentDefinition,
  type WorkflowAgentDefinition,
  type WorkflowAgentResources,
  type WorkflowAgentSystemPrompt,
} from "./agent-config.js";

const MAX_CONFIG_BYTES = 1_000_000;

async function readTextFile(path: string): Promise<{ path: string; content: string }> {
  const canonicalPath = await realpath(path);
  const file = await stat(canonicalPath);
  if (!file.isFile()) throw new Error(`路径不是文件: ${canonicalPath}`);
  if (file.size > MAX_CONFIG_BYTES) throw new Error(`文件不能超过${MAX_CONFIG_BYTES}字节: ${canonicalPath}`);
  return { path: canonicalPath, content: await readFile(canonicalPath, "utf8") };
}

function resolveReferencedPath(path: string, configPath: string): string {
  return isAbsolute(path) ? path : resolve(dirname(configPath), path);
}

async function resolveSystemPrompt(
  value: RawSystemPrompt,
  configPath: string,
): Promise<WorkflowAgentSystemPrompt> {
  if (value.mode === "pi-default") return value;
  if (value.text !== undefined) return { mode: "replace", text: value.text };
  const file = await readTextFile(resolveReferencedPath(value.file as string, configPath));
  if (file.content.trim() === "") throw new Error(`System Prompt文件不能为空: ${file.path}`);
  return { mode: "replace", text: file.content, sourcePath: file.path };
}

async function resolveInstructions(
  values: readonly RawInstruction[],
  configPath: string,
): Promise<AgentInstruction[]> {
  const instructions: AgentInstruction[] = [];
  const seenFiles = new Set<string>();
  for (const value of values) {
    if (typeof value === "string") instructions.push({ text: value });
    else if ("text" in value) instructions.push({ text: value.text });
    else {
      const file = await readTextFile(resolveReferencedPath(value.file, configPath));
      if (seenFiles.has(file.path)) continue;
      seenFiles.add(file.path);
      if (file.content.trim() === "") throw new Error(`提示词文件不能为空: ${file.path}`);
      instructions.push({ text: file.content, sourcePath: file.path });
    }
  }
  return instructions;
}

async function readAgentConfig(path: string, complete: boolean) {
  const file = await readTextFile(path);
  let value: unknown;
  try {
    value = JSON.parse(file.content);
  } catch (error) {
    throw new Error(`Agent配置不是有效JSON: ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: file.path, config: parseRawAgentConfig(value, complete) };
}

function resolveResourcePaths(resources: WorkflowAgentResources, fromPath: string): WorkflowAgentResources {
  if (resources.mode === "inherit") return resources;
  const baseDir = dirname(fromPath);
  const resolveLocalPath = (path: string): string => isAbsolute(path) ? path : resolve(baseDir, path);
  const resolvePluginSource = (source: string): string => (
    source.startsWith("./") || source.startsWith("../") ? resolve(baseDir, source) : source
  );
  return {
    mode: "explicit",
    skillPaths: resources.skillPaths.map(resolveLocalPath),
    extensionPaths: resources.extensionPaths.map(resolveLocalPath),
    pluginSources: resources.pluginSources.map(resolvePluginSource),
  };
}

async function materializeConfig(raw: RawAgentConfig, configPath: string): Promise<Partial<WorkflowAgentDefinition>> {
  return {
    ...(raw.id === undefined ? {} : { id: raw.id }),
    ...(raw.name === undefined ? {} : { name: raw.name }),
    ...(raw.description === undefined ? {} : { description: raw.description }),
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(raw.thinkingLevel === undefined ? {} : { thinkingLevel: raw.thinkingLevel }),
    ...(raw.systemPrompt === undefined ? {} : { systemPrompt: await resolveSystemPrompt(raw.systemPrompt, configPath) }),
    ...(raw.customInstructions === undefined ? {} : { customInstructions: await resolveInstructions(raw.customInstructions, configPath) }),
    ...(raw.tools === undefined ? {} : { tools: raw.tools }),
    ...(raw.resources === undefined ? {} : { resources: resolveResourcePaths(raw.resources, configPath) }),
  };
}

function mergeAgentConfig(
  current: WorkflowAgentDefinition,
  patch: Partial<WorkflowAgentDefinition>,
): WorkflowAgentDefinition {
  const instructions = [...current.customInstructions];
  const keys = new Set(instructions.map((instruction) => (
    instruction.sourcePath === undefined ? `text:${instruction.text}` : `file:${instruction.sourcePath}`
  )));
  for (const instruction of patch.customInstructions ?? []) {
    const key = instruction.sourcePath === undefined ? `text:${instruction.text}` : `file:${instruction.sourcePath}`;
    if (!keys.has(key)) {
      keys.add(key);
      instructions.push(instruction);
    }
  }
  return { ...current, ...patch, schemaVersion: 1, customInstructions: instructions };
}

/** Loads one Agent's selected configuration files in their declared order. */
export async function resolveWorkflowAgentDefinition(options: {
  readonly defaultAgent: WorkflowAgentDefinition;
  readonly selection?: AgentConfigSelection;
  readonly cwd: string;
}): Promise<ResolvedWorkflowAgentDefinition> {
  const appendPaths = options.selection?.append ?? [];
  const promptPaths = options.selection?.promptFiles ?? [];
  if (appendPaths.length + promptPaths.length + (options.selection?.primary === undefined ? 0 : 1) > MAX_AGENT_CONFIG_FILES) {
    throw new Error(`单个Agent最多加载${MAX_AGENT_CONFIG_FILES}个配置和提示词文件`);
  }

  let current = options.defaultAgent;
  const sources: AgentConfigSource[] = [{ kind: "workflow-default" }];
  if (options.selection?.primary !== undefined) {
    const primary = await readAgentConfig(resolve(options.cwd, options.selection.primary), true);
    const materialized = await materializeConfig(primary.config, primary.path);
    if (materialized.id !== options.defaultAgent.id) {
      throw new Error(`Agent配置id必须是${options.defaultAgent.id}: ${primary.path}`);
    }
    current = {
      schemaVersion: 1,
      id: materialized.id,
      name: materialized.name as string,
      description: materialized.description as string,
      ...(materialized.model === undefined ? {} : { model: materialized.model }),
      ...(materialized.thinkingLevel === undefined ? {} : { thinkingLevel: materialized.thinkingLevel }),
      systemPrompt: materialized.systemPrompt ?? { mode: "pi-default" },
      customInstructions: materialized.customInstructions ?? [],
      tools: materialized.tools ?? { mode: "pi-default" },
      resources: materialized.resources ?? { mode: "inherit" },
    };
    sources.splice(0, sources.length, { kind: "primary", path: primary.path });
  }

  for (const path of appendPaths) {
    const addition = await readAgentConfig(resolve(options.cwd, path), false);
    if (addition.config.id !== undefined || addition.config.name !== undefined || addition.config.description !== undefined) {
      throw new Error(`追加Agent配置不能修改id、name或description: ${addition.path}`);
    }
    current = mergeAgentConfig(current, await materializeConfig(addition.config, addition.path));
    sources.push({ kind: "append", path: addition.path });
  }

  const promptInstructions: AgentInstruction[] = [];
  const seenPromptPaths = new Set(
    current.customInstructions.flatMap((instruction) => instruction.sourcePath === undefined ? [] : [instruction.sourcePath]),
  );
  for (const path of promptPaths) {
    const prompt = await readTextFile(resolve(options.cwd, path));
    if (seenPromptPaths.has(prompt.path)) continue;
    seenPromptPaths.add(prompt.path);
    if (prompt.content.trim() === "") throw new Error(`提示词文件不能为空: ${prompt.path}`);
    promptInstructions.push({ text: prompt.content, sourcePath: prompt.path });
    sources.push({ kind: "prompt", path: prompt.path });
  }

  return {
    ...current,
    customInstructions: [...current.customInstructions, ...promptInstructions],
    ...(options.selection?.resources === undefined
      ? {}
      : { resources: resolveResourcePaths(options.selection.resources, resolve(options.cwd, ".agent-selection.json")) }),
    sources,
  };
}
