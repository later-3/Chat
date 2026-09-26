/**
 * The workflow-owned LAST node of every interactive Workflow. It is part of the Workflow's own contract
 * (the `remember` node), NOT a child capability a parent Agent may pick, and it is never caller-owned.
 * Kept dependency-free so the catalog can filter it without pulling an Agent definition into the graph.
 */
export const SESSION_MEMORY_TAIL_AGENT_ID = "session-memory-writer";

export function isSessionMemoryTailAgent(agentId: string): boolean {
  return agentId === SESSION_MEMORY_TAIL_AGENT_ID;
}
