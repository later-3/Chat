import definitionJson from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition, type WorkflowAgentDefinition } from "../../../agent-config.js";

export const SESSION_MEMORY_WORKER_AGENT_ID = "session-memory-worker";
export const SESSION_MEMORY_WORKER_AGENT: WorkflowAgentDefinition = parseWorkflowAgentDefinition(definitionJson);
