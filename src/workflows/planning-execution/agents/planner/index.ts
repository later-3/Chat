import config from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition } from "../../../agent-definition.js";

export const MAX_PLANNING_RESULT_CHARS = 50_000;

/** Planner has a dedicated identity and currently uses no tools. */
export const PLANNER_AGENT = parseWorkflowAgentDefinition(config);
