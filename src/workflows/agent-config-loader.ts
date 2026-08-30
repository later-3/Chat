import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAllowedFileRoots, isFilePathAllowed } from "../files/access.js";
import { getPromptResourceStore } from "../prompt-resources/store.js";
import {
  promptResourceTargetKey,
  type PromptResourceRevision,
  type PromptResourceTarget,
} from "../prompt-resources/types.js";
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
const REMOTE_PLUGIN_PREFIXES = ["npm:", "git:", "github:", "http:", "https:", "ssh:"];

function promptResourceInstruction(
  target: PromptResourceTarget,
  resource: PromptResourceRevision,
): AgentInstruction {
  return {
    text: [
      `<chat_prompt_resource target="${promptResourceTargetKey(target)}" id="${resource.id}" revision="${resource.revision}" kind="${resource.kind}">`,
      `<title>${resource.title}</title>`,
      `<purpose>${resource.purpose}</purpose>`,
      resource.content,
      "</chat_prompt_resource>",
    ].join("\n"),
    promptResource: {
      id: resource.id,
      target,
      revision: resource.revision,
      kind: resource.kind,
      title: resource.title,
    },
  };
}

async function canonicalizePath(path: string): Promise<string> {
  let current = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(current), ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

async function resolveAuthorizedPath(path: string, allowedRoots: Set<string>): Promise<string> {
  const canonicalPath = await canonicalizePath(path);
  if (!isFilePathAllowed(canonicalPath, allowedRoots)) {
    throw new Error(`路径不在Chat授权目录内: ${canonicalPath}`);
  }
  return canonicalPath;
}

async function resolveAllowedRoots(options: {
  readonly cwd: string;
  readonly chatHome?: string;
}): Promise<Set<string>> {
  const roots = new Set(await getAllowedFileRoots(options.chatHome));
  roots.add(resolve(options.cwd));
  if (options.chatHome !== undefined) roots.add(resolve(options.chatHome, "agent"));
  return new Set(await Promise.all([...roots].map(canonicalizePath)));
}

async function readTextFile(
  path: string,
  allowedRoots: Set<string>,
): Promise<{ path: string; content: string }> {
  const canonicalPath = await resolveAuthorizedPath(path, allowedRoots);
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
  allowedRoots: Set<string>,
): Promise<WorkflowAgentSystemPrompt> {
  if (value.mode === "pi-default") return value;
  if (value.text !== undefined) return { mode: "replace", text: value.text };
  const file = await readTextFile(resolveReferencedPath(value.file as string, configPath), allowedRoots);
  if (file.content.trim() === "") throw new Error(`System Prompt文件不能为空: ${file.path}`);
  return { mode: "replace", text: file.content, sourcePath: file.path };
}

async function resolveInstructions(
  values: readonly RawInstruction[],
  configPath: string,
  allowedRoots: Set<string>,
): Promise<AgentInstruction[]> {
  const instructions: AgentInstruction[] = [];
  const seenFiles = new Set<string>();
  for (const value of values) {
    if (typeof value === "string") instructions.push({ text: value });
    else if ("text" in value) instructions.push({ text: value.text });
    else {
      const file = await readTextFile(resolveReferencedPath(value.file, configPath), allowedRoots);
      if (seenFiles.has(file.path)) continue;
      seenFiles.add(file.path);
      if (file.content.trim() === "") throw new Error(`提示词文件不能为空: ${file.path}`);
      instructions.push({ text: file.content, sourcePath: file.path });
    }
  }
  return instructions;
}

async function readAgentConfig(path: string, complete: boolean, allowedRoots: Set<string>) {
  const file = await readTextFile(path, allowedRoots);
  let value: unknown;
  try {
    value = JSON.parse(file.content);
  } catch (error) {
    throw new Error(`Agent配置不是有效JSON: ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: file.path, config: parseRawAgentConfig(value, complete) };
}

async function resolveResourcePaths(
  resources: WorkflowAgentResources,
  fromPath: string,
  allowedRoots: Set<string>,
): Promise<WorkflowAgentResources> {
  if (resources.mode === "inherit") return resources;
  const baseDir = dirname(fromPath);
  const resolveLocalPath = (path: string): string => isAbsolute(path) ? path : resolve(baseDir, path);
  const resolvePluginSource = async (source: string): Promise<string> => {
    if (REMOTE_PLUGIN_PREFIXES.some((prefix) => source.startsWith(prefix))) return source;
    const localPath = source.startsWith("file://") ? fileURLToPath(source) : resolveLocalPath(source);
    return resolveAuthorizedPath(localPath, allowedRoots);
  };
  return {
    mode: "explicit",
    skillPaths: await Promise.all(resources.skillPaths.map((path) => (
      resolveAuthorizedPath(resolveLocalPath(path), allowedRoots)
    ))),
    extensionPaths: await Promise.all(resources.extensionPaths.map((path) => (
      resolveAuthorizedPath(resolveLocalPath(path), allowedRoots)
    ))),
    pluginSources: await Promise.all(resources.pluginSources.map(resolvePluginSource)),
  };
}

async function materializeConfig(
  raw: RawAgentConfig,
  configPath: string,
  allowedRoots: Set<string>,
): Promise<Partial<WorkflowAgentDefinition>> {
  return {
    ...(raw.id === undefined ? {} : { id: raw.id }),
    ...(raw.name === undefined ? {} : { name: raw.name }),
    ...(raw.description === undefined ? {} : { description: raw.description }),
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(raw.thinkingLevel === undefined ? {} : { thinkingLevel: raw.thinkingLevel }),
    ...(raw.systemPrompt === undefined ? {} : {
      systemPrompt: await resolveSystemPrompt(raw.systemPrompt, configPath, allowedRoots),
    }),
    ...(raw.customInstructions === undefined ? {} : {
      customInstructions: await resolveInstructions(raw.customInstructions, configPath, allowedRoots),
    }),
    ...(raw.tools === undefined ? {} : { tools: raw.tools }),
    ...(raw.resources === undefined ? {} : {
      resources: await resolveResourcePaths(raw.resources, configPath, allowedRoots),
    }),
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
  readonly chatHome?: string;
}): Promise<ResolvedWorkflowAgentDefinition> {
  const appendPaths = options.selection?.append ?? [];
  const promptPaths = options.selection?.promptFiles ?? [];
  if (appendPaths.length + promptPaths.length + (options.selection?.primary === undefined ? 0 : 1) > MAX_AGENT_CONFIG_FILES) {
    throw new Error(`单个Agent最多加载${MAX_AGENT_CONFIG_FILES}个配置和提示词文件`);
  }

  const allowedRoots = await resolveAllowedRoots(options);

  let current = options.defaultAgent;
  const sources: AgentConfigSource[] = [{ kind: "workflow-default" }];
  if (options.selection?.primary !== undefined) {
    const primary = await readAgentConfig(resolve(options.cwd, options.selection.primary), true, allowedRoots);
    const materialized = await materializeConfig(primary.config, primary.path, allowedRoots);
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
    const addition = await readAgentConfig(resolve(options.cwd, path), false, allowedRoots);
    if (addition.config.id !== undefined || addition.config.name !== undefined || addition.config.description !== undefined) {
      throw new Error(`追加Agent配置不能修改id、name或description: ${addition.path}`);
    }
    current = mergeAgentConfig(current, await materializeConfig(addition.config, addition.path, allowedRoots));
    sources.push({ kind: "append", path: addition.path });
  }

  const promptInstructions: AgentInstruction[] = [];
  const seenPromptPaths = new Set(
    current.customInstructions.flatMap((instruction) => instruction.sourcePath === undefined ? [] : [instruction.sourcePath]),
  );
  for (const path of promptPaths) {
    const prompt = await readTextFile(resolve(options.cwd, path), allowedRoots);
    if (seenPromptPaths.has(prompt.path)) continue;
    seenPromptPaths.add(prompt.path);
    if (prompt.content.trim() === "") throw new Error(`提示词文件不能为空: ${prompt.path}`);
    promptInstructions.push({ text: prompt.content, sourcePath: prompt.path });
    sources.push({ kind: "prompt", path: prompt.path });
  }

  const promptResourceInstructions: AgentInstruction[] = [];
  for (const selected of options.selection?.promptResources ?? []) {
    const promptResourceStore = await getPromptResourceStore(selected.target, options.chatHome);
    const resource = selected.revision === undefined
      ? await promptResourceStore.get(selected.id)
      : await promptResourceStore.getRevision(selected.id, selected.revision);
    if (resource === undefined) {
      throw new Error(`找不到Prompt资源${selected.revision === undefined ? "" : `版本 ${selected.revision}`}: ${selected.id}`);
    }
    if (resource.status !== "active") throw new Error(`Prompt资源已归档: ${selected.id}`);
    promptResourceInstructions.push(promptResourceInstruction(selected.target, resource));
    sources.push({
      kind: "prompt-resource",
      resourceId: resource.id,
      resourceTarget: selected.target,
      revision: resource.revision,
    });
  }

  return {
    ...current,
    customInstructions: [
      ...current.customInstructions,
      ...promptInstructions,
      ...promptResourceInstructions,
    ],
    ...(options.selection?.resources === undefined
      ? {}
      : {
          resources: await resolveResourcePaths(
            options.selection.resources,
            resolve(options.cwd, ".agent-selection.json"),
            allowedRoots,
          ),
        }),
    sources,
  };
}
