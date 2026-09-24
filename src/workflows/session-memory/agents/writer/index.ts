import definitionJson from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition, type WorkflowAgentDefinition } from "../../../agent-config.js";

export const SESSION_MEMORY_WRITER_AGENT_ID = "session-memory-writer";

/** Declarative Agent identity reused by the Workflow manifest, execution and inspection. */
export const SESSION_MEMORY_WRITER_AGENT: WorkflowAgentDefinition = parseWorkflowAgentDefinition(definitionJson);
