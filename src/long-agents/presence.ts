import { busyLongAgentIds } from "../session-operation-lock.js";
import { readLongAgentRegistry } from "./storage.js";

/** Current execution availability, independent of the NanoClaw channel connection. */
export async function readLongAgentPresence(chatHome?: string) {
  const registry = await readLongAgentRegistry(chatHome);
  const busy = busyLongAgentIds();
  return {
    schemaVersion: 1 as const,
    observedAt: new Date().toISOString(),
    agents: registry.agents.map(agent => ({
      id: agent.id,
      // Disabling does not cancel a turn already in progress.
      status: busy.has(agent.id) ? "working" as const : agent.enabled ? "ready" as const : "disabled" as const,
    })),
  };
}
