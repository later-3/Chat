import { openChatSession } from "../chat-session.js";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getChatHomePaths } from "../chat-home.js";
import { personalAgentSettings, resolvePersonalAgentDefinition } from "../agents/assembly-context.js";
import { readLongAgentRegistry } from "./storage.js";
import { readAssemblySnapshot } from "../agents/assembly-context.js";
import { listChatSystemTools } from "../tools/registry.js";
import { LongAgentScopeError, applyScopeToCapabilities, type LongAgentExcludedCapability, type LongAgentScope } from "./scope.js";

const FROZEN_TOOLS_ENTRY = "chat.agent-assembly-tools.v1";

/** Composer capabilities use the same explicit-definition → Personal defaults model resolver.
 * This read never opens/creates a Session or freezes a turn; acceptance checks the actual model again.
 */
export async function readLongAgentInputCapabilities(chatHome: string, longAgentId: string) {
  const agent = (await readLongAgentRegistry(chatHome)).agents.find(candidate => candidate.id === longAgentId);
  if (agent === undefined) throw new LongAgentScopeError("找不到 Friend");
  const { agentDir } = getChatHomePaths(chatHome);
  const definition = resolvePersonalAgentDefinition(agent.definition, personalAgentSettings(agentDir));
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const model = definition.model === undefined ? undefined : runtime.getModel(definition.model.provider, definition.model.modelId);
  return { schemaVersion: 1 as const, longAgentId, images: model?.input.includes("image") ?? false,
    manualCompaction: false, followUp: true };
}

export interface LongAgentTurnCapabilities {
  schemaVersion: 1;
  longAgentId: string;
  sessionId: string;
  turnId: string;
  /** null for direct/background turns that inherit the definition unchanged. */
  scope: LongAgentScope | null;
  /** Tools actually registered for this turn, read from the same frozen selection execution used. */
  registeredTools: string[];
  /** Everything the scope excluded, with the reason shown to the user. */
  excludedCapabilities: LongAgentExcludedCapability[];
}

function readFrozenToolNames(entries: readonly { type: string; customType?: string; data?: unknown }[], turnId: string): string[] {
  for (const entry of [...entries].toReversed()) {
    if (entry.type !== "custom" || entry.customType !== FROZEN_TOOLS_ENTRY) continue;
    if (entry.data === undefined) continue;
    const value: unknown = entry.data;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("工具快照损坏");
    if ((value as Record<string, unknown>).turnId !== turnId) continue;
    const tools = (value as Record<string, unknown>).tools;
    if (!Array.isArray(tools)) throw new Error("工具快照内容无效");
    return tools.map((tool) => {
      if (typeof tool !== "object" || tool === null || typeof (tool as Record<string, unknown>).name !== "string")
        throw new Error("工具快照条目无效");
      return String((tool as Record<string, unknown>).name);
    });
  }
  return [];
}

/** System Tool addresses → runtime tool names, from the real registry, so both sides use one source. */
function systemToolNamesByAddress(): Map<string, string> {
  return new Map(listChatSystemTools().map((tool) => [tool.address, tool.manifest.name]));
}

/**
 * Inspect what a finished turn was actually allowed to use. The check reads the frozen assembly
 * scope and the frozen tool selection produced by execution, and refuses to report a capability set
 * that execution did not match — inspection and execution cannot drift apart.
 */
export async function inspectLongAgentTurnCapabilities(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly sessionId: string;
  readonly turnId: string;
}): Promise<LongAgentTurnCapabilities> {
  const session = await openChatSession({ chatHome: input.chatHome, projectId: input.longAgentId, sessionId: input.sessionId });
  const snapshot = readAssemblySnapshot(session.manager, input.turnId);
  if (snapshot === undefined) throw new LongAgentScopeError("找不到该轮次的装配快照，无法检查能力");
  const registeredTools = readFrozenToolNames(session.manager.getEntries(), input.turnId);
  const scope = snapshot.scope;
  if (scope !== null && scope.allowedTools !== null) {
    const names = systemToolNamesByAddress();
    const granted = new Set<string>();
    for (const address of scope.allowedTools.systemToolAddresses) {
      const name = names.get(address);
      if (name === undefined) throw new LongAgentScopeError(`作用域授权了未注册的 Chat 系统 Tool：${address}`);
      granted.add(name);
    }
    for (const name of scope.allowedTools.nativeTools) granted.add(name);
    for (const name of scope.allowedTools.extensionTools) granted.add(name);
    const outside = registeredTools.filter((name) => !granted.has(name));
    if (outside.length > 0)
      throw new LongAgentScopeError(`能力检查与执行不一致：本轮注册了作用域未授权的 Tool（${[...new Set(outside)].join(", ")}）`);
  }
  return {
    schemaVersion: 1,
    longAgentId: input.longAgentId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    scope,
    registeredTools,
    excludedCapabilities: scope?.excludedCapabilities ?? [],
  };
}

export { applyScopeToCapabilities };
