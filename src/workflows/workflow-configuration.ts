import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { getPromptResourceStore } from "../prompt-resources/store.js";
import {
  parseAgentConfigSelection,
  type AgentConfigSelection,
  type AgentPromptResourceSelection,
  type ResolvedWorkflowAgentDefinition,
  type WorkflowAgentDefinition,
} from "./agent-definition.js";
import { resolveWorkflowAgentDefinition } from "./agent-config-loader.js";

export const CHAT_WORKFLOW_CONFIGURATION_CUSTOM_TYPE = "chat.workflow_configuration";
export const CHAT_WORKFLOW_TURN_CONFIGURATION_CUSTOM_TYPE = "chat.workflow_turn_configuration";
export const CHAT_WORKFLOW_CONFIGURATION_SCHEMA_VERSION = 1;

export type WorkflowConfigurationActor = "system" | "user" | "agent";

export interface ChatWorkflowConfigurationData {
  readonly schemaVersion: typeof CHAT_WORKFLOW_CONFIGURATION_SCHEMA_VERSION;
  readonly workflowId: string;
  readonly agentConfigs: Readonly<Record<string, AgentConfigSelection>>;
  readonly actor: WorkflowConfigurationActor;
  readonly agentId?: string;
}

export interface ChatWorkflowTurnConfigurationData {
  readonly schemaVersion: typeof CHAT_WORKFLOW_CONFIGURATION_SCHEMA_VERSION;
  readonly invocationId: string;
  readonly workflowId: string;
  readonly agentConfigs: Readonly<Record<string, AgentConfigSelection>>;
}

export interface PreparedChatWorkflowTurnConfiguration {
  readonly agentConfigs: Readonly<Record<string, AgentConfigSelection>>;
  readonly agents: Readonly<Record<string, ResolvedWorkflowAgentDefinition>>;
}

export interface PrepareChatWorkflowTurnConfigurationInput {
  readonly invocationId: string;
  readonly workflowId: string;
  readonly agents: readonly WorkflowAgentDefinition[];
  readonly cwd: string;
  readonly chatHome?: string;
  /** Project data directory; enables the per-Agent durable model configuration layer. */
  readonly projectDataDir?: string;
  readonly defaults?: Readonly<Record<string, AgentConfigSelection>>;
  /** Only Agents present in this object are changed. An empty selection restores that Agent's default. */
  readonly adjustments?: Readonly<Record<string, AgentConfigSelection>>;
  readonly actor?: WorkflowConfigurationActor;
  readonly actorAgentId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isEmptySelection(selection: AgentConfigSelection): boolean {
  return selection.primary === undefined
    && selection.append === undefined
    && selection.promptFiles === undefined
    && selection.promptResources === undefined
    && selection.tools === undefined
    && selection.resources === undefined;
}

function cloneSelection(selection: AgentConfigSelection): AgentConfigSelection {
  return structuredClone(selection);
}

function persistentSelection(selection: AgentConfigSelection): AgentConfigSelection {
  return {
    ...cloneSelection(selection),
    ...(selection.promptResources === undefined
      ? {}
      : {
          promptResources: selection.promptResources.map(({ revision: _revision, ...resource }) => resource),
        }),
  };
}

function knownSelections(
  selections: Readonly<Record<string, AgentConfigSelection>> | undefined,
  knownAgentIds: ReadonlySet<string>,
  field: string,
): Record<string, AgentConfigSelection> {
  const result: Record<string, AgentConfigSelection> = {};
  for (const [agentId, selection] of Object.entries(selections ?? {})) {
    if (!knownAgentIds.has(agentId)) throw new Error(`${field}包含Workflow中不存在的Agent: ${agentId}`);
    const parsed = persistentSelection(parseAgentConfigSelection(selection));
    if (!isEmptySelection(parsed)) result[agentId] = parsed;
  }
  return result;
}

function sessionSelections(
  selections: Readonly<Record<string, AgentConfigSelection>> | undefined,
  knownAgentIds: ReadonlySet<string>,
): Record<string, AgentConfigSelection> {
  return Object.fromEntries(
    Object.entries(selections ?? {})
      .filter(([agentId]) => knownAgentIds.has(agentId))
      .map(([agentId, selection]) => [agentId, persistentSelection(selection)]),
  );
}

async function freezeAgentConfigs(
  agentConfigs: Readonly<Record<string, AgentConfigSelection>>,
  chatHome?: string,
): Promise<Record<string, AgentConfigSelection>> {
  const frozen: Record<string, AgentConfigSelection> = {};
  for (const [agentId, selection] of Object.entries(agentConfigs)) {
    if (selection.promptResources === undefined) {
      frozen[agentId] = cloneSelection(selection);
      continue;
    }
    const promptResources = await Promise.all(selection.promptResources.map(async (selected) => {
      const store = await getPromptResourceStore(selected.target, chatHome);
      const resource = await store.get(selected.id);
      if (resource === undefined) throw new Error(`找不到Prompt资源: ${selected.id}`);
      if (resource.status !== "active") throw new Error(`Prompt资源已归档: ${selected.id}`);
      return { ...selected, revision: resource.revision };
    }));
    frozen[agentId] = { ...cloneSelection(selection), promptResources };
  }
  return frozen;
}

function parseAgentConfigs(value: unknown): Record<string, AgentConfigSelection> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, AgentConfigSelection> = {};
  try {
    for (const [agentId, selection] of Object.entries(value)) {
      if (!isNonEmptyString(agentId)) return undefined;
      const parsed = parseAgentConfigSelection(selection);
      if (!isEmptySelection(parsed)) result[agentId] = parsed;
    }
  } catch {
    return undefined;
  }
  return result;
}

function equalAgentConfigs(
  left: Readonly<Record<string, AgentConfigSelection>>,
  right: Readonly<Record<string, AgentConfigSelection>>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendWorkflowConfiguration(
  sessionManager: SessionManager,
  data: Omit<ChatWorkflowConfigurationData, "schemaVersion">,
): void {
  sessionManager.appendCustomEntry(CHAT_WORKFLOW_CONFIGURATION_CUSTOM_TYPE, {
    schemaVersion: CHAT_WORKFLOW_CONFIGURATION_SCHEMA_VERSION,
    ...data,
    agentConfigs: structuredClone(data.agentConfigs),
  } satisfies ChatWorkflowConfigurationData);
}

/** Replaces one Agent's selected Prompt resources while preserving its other configuration. */
export function setChatWorkflowAgentPromptResources(
  sessionManager: SessionManager,
  input: {
    readonly workflowId: string;
    readonly agentId: string;
    readonly promptResources: readonly AgentPromptResourceSelection[];
    readonly defaults?: Readonly<Record<string, AgentConfigSelection>>;
    readonly actorAgentId: string;
  },
): Readonly<Record<string, AgentConfigSelection>> {
  const latest = collectLatestChatWorkflowConfigurations(sessionManager.getEntries());
  const base = Object.hasOwn(latest, input.workflowId) ? latest[input.workflowId] : input.defaults;
  const next = structuredClone(base ?? {});
  const currentAgent = next[input.agentId] ?? {};
  const parsed = parseAgentConfigSelection({ promptResources: input.promptResources });
  const { promptResources: _previous, ...withoutPromptResources } = currentAgent;
  const nextAgent = parsed.promptResources?.length
    ? { ...withoutPromptResources, promptResources: parsed.promptResources }
    : withoutPromptResources;
  if (isEmptySelection(nextAgent)) delete next[input.agentId];
  else next[input.agentId] = nextAgent;

  if (!equalAgentConfigs(base ?? {}, next)) {
    appendWorkflowConfiguration(sessionManager, {
      workflowId: input.workflowId,
      agentConfigs: next,
      actor: "agent",
      agentId: input.actorAgentId,
    });
    sessionManager.flush();
  }
  return next;
}

/** Returns the last valid persisted configuration for every Workflow in a Session. */
export function collectLatestChatWorkflowConfigurations(
  entries: readonly unknown[],
): Record<string, Record<string, AgentConfigSelection>> {
  const latest: Record<string, Record<string, AgentConfigSelection>> = {};
  for (const entry of entries) {
    const data = parseWorkflowConfigurationEntry(entry);
    if (data !== undefined) latest[data.workflowId] = data.agentConfigs;
  }
  return latest;
}

function parseWorkflowConfigurationEntry(entry: unknown): ChatWorkflowConfigurationData | undefined {
  if (
    !isRecord(entry)
    || entry.type !== "custom"
    || entry.customType !== CHAT_WORKFLOW_CONFIGURATION_CUSTOM_TYPE
    || !isRecord(entry.data)
  ) {
    return undefined;
  }
  const data = entry.data;
  const agentConfigs = parseAgentConfigs(data.agentConfigs);
  if (
    data.schemaVersion !== CHAT_WORKFLOW_CONFIGURATION_SCHEMA_VERSION
    || !isNonEmptyString(data.workflowId)
    || (data.actor !== "system" && data.actor !== "user" && data.actor !== "agent")
    || (data.actor === "agent" && !isNonEmptyString(data.agentId))
    || agentConfigs === undefined
  ) {
    return undefined;
  }
  return {
    schemaVersion: CHAT_WORKFLOW_CONFIGURATION_SCHEMA_VERSION,
    workflowId: data.workflowId,
    agentConfigs,
    actor: data.actor,
    ...(data.actor === "agent" ? { agentId: data.agentId as string } : {}),
  };
}

function findLatestKnownWorkflowConfiguration(
  entries: readonly unknown[],
  workflowId: string,
  knownAgentIds: ReadonlySet<string>,
): Record<string, AgentConfigSelection> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const data = parseWorkflowConfigurationEntry(entries[index]);
    if (data?.workflowId !== workflowId) continue;
    if (Object.keys(data.agentConfigs).every((agentId) => knownAgentIds.has(agentId))) {
      return data.agentConfigs;
    }
  }
  return undefined;
}

/** Reads immutable per-turn configuration snapshots used for diagnosis and history rendering. */
export function collectChatWorkflowTurnConfigurations(
  entries: readonly unknown[],
): ChatWorkflowTurnConfigurationData[] {
  const snapshots: ChatWorkflowTurnConfigurationData[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry)
      || entry.type !== "custom"
      || entry.customType !== CHAT_WORKFLOW_TURN_CONFIGURATION_CUSTOM_TYPE
      || !isRecord(entry.data)
    ) {
      continue;
    }
    const data = entry.data;
    const agentConfigs = parseAgentConfigs(data.agentConfigs);
    if (
      data.schemaVersion !== CHAT_WORKFLOW_CONFIGURATION_SCHEMA_VERSION
      || !isNonEmptyString(data.invocationId)
      || !isNonEmptyString(data.workflowId)
      || agentConfigs === undefined
    ) {
      continue;
    }
    snapshots.push({
      schemaVersion: CHAT_WORKFLOW_CONFIGURATION_SCHEMA_VERSION,
      invocationId: data.invocationId,
      workflowId: data.workflowId,
      agentConfigs,
    });
  }
  return snapshots;
}

/**
 * Resolves all Agents before persisting anything, then records one immutable
 * snapshot reused by every Stage in this Workflow run.
 */
export async function prepareChatWorkflowTurnConfiguration(
  sessionManager: SessionManager,
  input: PrepareChatWorkflowTurnConfigurationInput,
): Promise<PreparedChatWorkflowTurnConfiguration> {
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const knownAgentIds = new Set(agentsById.keys());
  const defaults = knownSelections(input.defaults, knownAgentIds, "Workflow默认配置");
  const latest = findLatestKnownWorkflowConfiguration(
    sessionManager.getEntries(),
    input.workflowId,
    knownAgentIds,
  );
  const rawLatest = collectLatestChatWorkflowConfigurations(sessionManager.getEntries())[input.workflowId];
  const hasLatest = latest !== undefined;
  const latestForWorkflow = latest ?? {};
  const needsSanitize = rawLatest !== undefined && !equalAgentConfigs(rawLatest, latestForWorkflow);
  const next: Record<string, AgentConfigSelection> = structuredClone(
    hasLatest ? sessionSelections(latestForWorkflow, knownAgentIds) : defaults,
  );

  for (const [agentId, rawSelection] of Object.entries(input.adjustments ?? {})) {
    if (!knownAgentIds.has(agentId)) throw new Error(`Workflow ${input.workflowId}不存在Agent: ${agentId}`);
    const selection = persistentSelection(parseAgentConfigSelection(rawSelection));
    if (isEmptySelection(selection)) {
      const fallback = defaults[agentId];
      if (fallback === undefined) delete next[agentId];
      else next[agentId] = cloneSelection(fallback);
    } else {
      next[agentId] = selection;
    }
  }

  const frozen = await freezeAgentConfigs(next, input.chatHome);
  const resolvedEntries = await Promise.all(input.agents.map(async (defaultAgent) => {
    const selection = frozen[defaultAgent.id];
    const resolved = await resolveWorkflowAgentDefinition({
      defaultAgent,
      cwd: input.cwd,
      ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }),
      ...(input.projectDataDir === undefined
        ? {}
        : {
            durableModelConfig: {
              projectDataDir: input.projectDataDir,
              workflowId: input.workflowId,
              agentId: defaultAgent.id,
            },
          }),
      ...(selection === undefined ? {} : { selection }),
    });
    return [defaultAgent.id, resolved] as const;
  }));

  if (!hasLatest || needsSanitize || !equalAgentConfigs(latestForWorkflow, next)) {
    appendWorkflowConfiguration(sessionManager, {
      workflowId: input.workflowId,
      agentConfigs: structuredClone(next),
      actor: input.actor ?? (input.adjustments === undefined ? "system" : "user"),
      ...(input.actorAgentId === undefined ? {} : { agentId: input.actorAgentId }),
    });
  }
  sessionManager.appendCustomEntry(CHAT_WORKFLOW_TURN_CONFIGURATION_CUSTOM_TYPE, {
    schemaVersion: CHAT_WORKFLOW_CONFIGURATION_SCHEMA_VERSION,
    invocationId: input.invocationId,
    workflowId: input.workflowId,
    agentConfigs: structuredClone(frozen),
  } satisfies ChatWorkflowTurnConfigurationData);
  sessionManager.flush();

  return { agentConfigs: frozen, agents: Object.fromEntries(resolvedEntries) };
}
