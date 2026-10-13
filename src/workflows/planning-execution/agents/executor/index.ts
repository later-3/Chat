import config from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition } from "../../../agent-definition.js";

/** Pi Coding Agent configured for the execution Stage of this Workflow. */
export const PLANNING_EXECUTION_AGENT = parseWorkflowAgentDefinition(config);
