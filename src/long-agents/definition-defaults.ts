import { updateLongAgentRegistry } from "./storage.js";
import { buildDefaultLongAgentDefinition } from "./types.js";
import type { LongAgentConfig } from "./types.js";

/**
 * 默认能力补齐（方案 A）：只为“仍由默认托管”的 Agent（从未自定义工具集）把
 * 后来新增的默认系统 Tool 加进去（只增不减）。用户一旦在配置页自定义过工具，
 * toolsManagedByDefault 变为 false，补齐不再触碰它。
 *
 * 迁移说明：S1 拆分把 Agent 定义固化为文件，早于后来新增的默认能力（如
 * channel_send、task_manage）。这里让默认托管的 Agent 跟上。
 */
export async function reconcileDefaultLongAgentTools(chatHome: string): Promise<readonly string[]> {
  const updated: string[] = [];
  await updateLongAgentRegistry(chatHome, (registry) => {
    const agents = registry.agents.map((agent) => {
      if (agent.toolsManagedByDefault === false) return agent;
      const defaults = buildDefaultLongAgentDefinition(agent.id, agent.name, agent.description);
      const defaultAddresses = defaults.tools.mode === "pi-default" ? defaults.tools.addresses : [];
      const current = agent.definition.tools;
      if (current.mode !== "pi-default") return agent;
      const missing = defaultAddresses.filter((address) => !(current.addresses ?? []).includes(address));
      if (missing.length === 0) return agent;
      updated.push(agent.id);
      return {
        ...agent,
        toolsManagedByDefault: true,
        definition: {
          ...agent.definition,
          tools: { ...current, addresses: [...(current.addresses ?? []), ...missing] },
        },
      };
    });
    return { registry: { ...registry, agents }, result: undefined };
  });
  return updated;
}

/** 标记用户在配置页自定义过工具集后，默认补齐不再触碰。 */
export function toolsMatchDefault(agent: LongAgentConfig): boolean {
  const defaults = buildDefaultLongAgentDefinition(agent.id, agent.name, agent.description);
  const defaultAddresses = defaults.tools.mode === "pi-default" ? [...defaults.tools.addresses].sort() : [];
  const current = agent.definition.tools;
  const currentAddresses = current.mode === "none" ? [] : [...(current.addresses ?? [])].sort();
  return (
    current.mode === defaults.tools.mode
    && defaultAddresses.length === currentAddresses.length
    && defaultAddresses.every((address, index) => address === currentAddresses[index])
  );
}
