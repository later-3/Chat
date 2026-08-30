import config from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition } from "../../../agent-definition.js";

/** Dedicated Agent with only Chat-owned Memory tools and Skill. */
export const MEMORY_AGENT = parseWorkflowAgentDefinition(config);
