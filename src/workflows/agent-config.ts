import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const MAX_AGENT_CONFIG_FILES = 32;
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

export interface AgentModelConfig {
  readonly provider: string;
  readonly modelId: string;
}

export type WorkflowAgentSystemPrompt =
  | { readonly mode: "pi-default" }
  | { readonly mode: "replace"; readonly text: string; readonly sourcePath?: string };

export type WorkflowAgentToolPolicy =
  | { readonly mode: "pi-default" }
  | { readonly mode: "none" }
  | { readonly mode: "explicit"; readonly names: readonly string[]; readonly exclude: readonly string[] };

export type WorkflowAgentResources =
  | { readonly mode: "inherit" }
  | {
      readonly mode: "explicit";
      readonly skillPaths: readonly string[];
      readonly extensionPaths: readonly string[];
      readonly pluginSources: readonly string[];
    };

export interface AgentInstruction {
  readonly text: string;
  readonly sourcePath?: string;
}

export interface WorkflowAgentDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly model?: AgentModelConfig;
  readonly thinkingLevel?: ThinkingLevel;
  readonly systemPrompt: WorkflowAgentSystemPrompt;
  readonly customInstructions: readonly AgentInstruction[];
  readonly tools: WorkflowAgentToolPolicy;
  readonly resources: WorkflowAgentResources;
}

export interface AgentConfigSelection {
  readonly primary?: string;
  readonly append?: readonly string[];
  readonly promptFiles?: readonly string[];
  readonly resources?: WorkflowAgentResources;
}

export interface AgentConfigSource {
  readonly kind: "workflow-default" | "primary" | "append" | "prompt";
  readonly path?: string;
}

export interface ResolvedWorkflowAgentDefinition extends WorkflowAgentDefinition {
  readonly sources: readonly AgentConfigSource[];
}

export type RawSystemPrompt =
  | { readonly mode: "pi-default" }
  | { readonly mode: "replace"; readonly text?: string; readonly file?: string };

export type RawInstruction = string | { readonly text: string } | { readonly file: string };

export interface RawAgentConfig {
  readonly schemaVersion: 1;
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly model?: AgentModelConfig;
  readonly thinkingLevel?: ThinkingLevel;
  readonly systemPrompt?: RawSystemPrompt;
  readonly customInstructions?: readonly RawInstruction[];
  readonly tools?: WorkflowAgentToolPolicy;
  readonly resources?: WorkflowAgentResources;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}必须是非空字符串`);
  return value;
}

function readStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field}必须是字符串数组`);
  return [...new Set(value.map((item, index) => readNonEmptyString(item, `${field}[${index}]`)))];
}

function assertKnownFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new Error(`Agent配置包含未知字段: ${unknown.join(", ")}`);
}

function parseSystemPrompt(value: unknown): RawSystemPrompt {
  if (!isRecord(value)) throw new Error("systemPrompt必须是对象");
  assertKnownFields(value, ["mode", "text", "file"]);
  if (value.mode === "pi-default") {
    if (value.text !== undefined || value.file !== undefined) throw new Error("pi-default systemPrompt不能包含text或file");
    return { mode: "pi-default" };
  }
  if (value.mode !== "replace") throw new Error("systemPrompt.mode无效");
  const hasText = value.text !== undefined;
  const hasFile = value.file !== undefined;
  if (hasText === hasFile) throw new Error("replace systemPrompt必须且只能提供text或file");
  return hasText
    ? { mode: "replace", text: readNonEmptyString(value.text, "systemPrompt.text") }
    : { mode: "replace", file: readNonEmptyString(value.file, "systemPrompt.file") };
}

function parseInstructions(value: unknown): RawInstruction[] {
  if (!Array.isArray(value)) throw new Error("customInstructions必须是数组");
  return value.map((instruction, index) => {
    if (typeof instruction === "string") return readNonEmptyString(instruction, `customInstructions[${index}]`);
    if (!isRecord(instruction)) throw new Error(`customInstructions[${index}]无效`);
    assertKnownFields(instruction, ["text", "file"]);
    const hasText = instruction.text !== undefined;
    const hasFile = instruction.file !== undefined;
    if (hasText === hasFile) throw new Error(`customInstructions[${index}]必须且只能提供text或file`);
    return hasText
      ? { text: readNonEmptyString(instruction.text, `customInstructions[${index}].text`) }
      : { file: readNonEmptyString(instruction.file, `customInstructions[${index}].file`) };
  });
}

function parseTools(value: unknown): WorkflowAgentToolPolicy {
  if (!isRecord(value)) throw new Error("tools必须是对象");
  assertKnownFields(value, ["mode", "names", "exclude"]);
  if (value.mode === "pi-default" || value.mode === "none") {
    if (value.names !== undefined || value.exclude !== undefined) throw new Error(`${value.mode} tools不能包含names或exclude`);
    return { mode: value.mode };
  }
  if (value.mode !== "explicit") throw new Error("tools.mode无效");
  return {
    mode: "explicit",
    names: value.names === undefined ? [] : readStringList(value.names, "tools.names"),
    exclude: value.exclude === undefined ? [] : readStringList(value.exclude, "tools.exclude"),
  };
}

function parseResources(value: unknown): WorkflowAgentResources {
  if (!isRecord(value)) throw new Error("resources必须是对象");
  assertKnownFields(value, ["mode", "skillPaths", "extensionPaths", "pluginSources"]);
  if (value.mode === "inherit") {
    if (value.skillPaths !== undefined || value.extensionPaths !== undefined || value.pluginSources !== undefined) {
      throw new Error("inherit resources不能包含资源选择");
    }
    return { mode: "inherit" };
  }
  if (value.mode !== "explicit") throw new Error("resources.mode无效");
  return {
    mode: "explicit",
    skillPaths: value.skillPaths === undefined ? [] : readStringList(value.skillPaths, "resources.skillPaths"),
    extensionPaths: value.extensionPaths === undefined ? [] : readStringList(value.extensionPaths, "resources.extensionPaths"),
    pluginSources: value.pluginSources === undefined ? [] : readStringList(value.pluginSources, "resources.pluginSources"),
  };
}

function parseModel(value: unknown): AgentModelConfig {
  if (!isRecord(value)) throw new Error("model必须是对象");
  assertKnownFields(value, ["provider", "modelId"]);
  return {
    provider: readNonEmptyString(value.provider, "model.provider"),
    modelId: readNonEmptyString(value.modelId, "model.modelId"),
  };
}

export function parseRawAgentConfig(value: unknown, complete: boolean): RawAgentConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Agent配置必须使用schemaVersion 1");
  assertKnownFields(value, [
    "schemaVersion", "id", "name", "description", "model", "thinkingLevel",
    "systemPrompt", "customInstructions", "tools", "resources",
  ]);
  const id = value.id === undefined ? undefined : readNonEmptyString(value.id, "id");
  const name = value.name === undefined ? undefined : readNonEmptyString(value.name, "name");
  const description = value.description === undefined ? undefined : readNonEmptyString(value.description, "description");
  if (complete && (id === undefined || name === undefined || description === undefined)) {
    throw new Error("完整Agent配置必须包含id、name和description");
  }
  const thinkingLevel = value.thinkingLevel === undefined
    ? undefined
    : readNonEmptyString(value.thinkingLevel, "thinkingLevel") as ThinkingLevel;
  if (thinkingLevel !== undefined && !THINKING_LEVELS.has(thinkingLevel)) throw new Error(`thinkingLevel无效: ${thinkingLevel}`);
  return {
    schemaVersion: 1,
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(value.model === undefined ? {} : { model: parseModel(value.model) }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(value.systemPrompt === undefined ? {} : { systemPrompt: parseSystemPrompt(value.systemPrompt) }),
    ...(value.customInstructions === undefined ? {} : { customInstructions: parseInstructions(value.customInstructions) }),
    ...(value.tools === undefined ? {} : { tools: parseTools(value.tools) }),
    ...(value.resources === undefined ? {} : { resources: parseResources(value.resources) }),
  };
}

export function parseAgentConfigSelection(value: unknown): AgentConfigSelection {
  if (!isRecord(value)) throw new Error("Agent配置选择必须是对象");
  assertKnownFields(value, ["primary", "append", "promptFiles", "resources"]);
  const primary = value.primary === undefined ? undefined : readNonEmptyString(value.primary, "primary");
  const append = value.append === undefined ? undefined : readStringList(value.append, "append");
  const promptFiles = value.promptFiles === undefined ? undefined : readStringList(value.promptFiles, "promptFiles");
  const resources = value.resources === undefined ? undefined : parseResources(value.resources);
  const count = (primary === undefined ? 0 : 1) + (append?.length ?? 0) + (promptFiles?.length ?? 0);
  if (count > MAX_AGENT_CONFIG_FILES) throw new Error(`单个Agent最多加载${MAX_AGENT_CONFIG_FILES}个配置和提示词文件`);
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(append === undefined ? {} : { append }),
    ...(promptFiles === undefined ? {} : { promptFiles }),
    ...(resources === undefined ? {} : { resources }),
  };
}

/** Parses the inline Agent definition owned by one Workflow. */
export function parseWorkflowAgentDefinition(value: unknown): WorkflowAgentDefinition {
  const raw = parseRawAgentConfig(value, true);
  if (raw.systemPrompt === undefined || raw.customInstructions === undefined || raw.tools === undefined) {
    throw new Error("完整Agent配置必须包含systemPrompt、customInstructions和tools");
  }
  if (raw.systemPrompt.mode === "replace" && raw.systemPrompt.text === undefined) {
    throw new Error("内置Agent配置的System Prompt必须使用内联text");
  }
  const customInstructions = raw.customInstructions.map((instruction) => {
    if (typeof instruction === "string") return { text: instruction };
    if ("text" in instruction) return { text: instruction.text };
    throw new Error("内置Agent配置的customInstructions必须使用内联text");
  });
  return {
    schemaVersion: 1,
    id: raw.id as string,
    name: raw.name as string,
    description: raw.description as string,
    ...(raw.model === undefined ? {} : { model: raw.model }),
    ...(raw.thinkingLevel === undefined ? {} : { thinkingLevel: raw.thinkingLevel }),
    systemPrompt: raw.systemPrompt.mode === "pi-default"
      ? { mode: "pi-default" }
      : { mode: "replace", text: raw.systemPrompt.text as string },
    customInstructions,
    tools: raw.tools,
    resources: raw.resources ?? { mode: "inherit" },
  };
}
