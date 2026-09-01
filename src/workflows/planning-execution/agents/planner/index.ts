import config from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition } from "../../../agent-definition.js";

export const MAX_PLANNING_RESULT_CHARS = 50_000;

/** Planner has a dedicated identity plus narrowly scoped read-only context capabilities. */
export const PLANNER_AGENT = parseWorkflowAgentDefinition(config);
