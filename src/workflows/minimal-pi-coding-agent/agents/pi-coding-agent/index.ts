import config from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition } from "../../../agent-definition.js";

/** Pi Coding Agent with its normal Prompt, tools and project resources. */
export const PI_CODING_AGENT = parseWorkflowAgentDefinition(config);
