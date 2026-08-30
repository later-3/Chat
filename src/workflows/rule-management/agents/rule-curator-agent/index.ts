import config from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition } from "../../../agent-definition.js";

export const RULE_CURATOR_AGENT = parseWorkflowAgentDefinition(config);
