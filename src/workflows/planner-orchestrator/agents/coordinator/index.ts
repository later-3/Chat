import config from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition } from "../../../agent-definition.js";

export const WORKFLOW_COORDINATOR_AGENT = parseWorkflowAgentDefinition(config);
