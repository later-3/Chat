import config from "./planner.json" with { type: "json" };
import { parseWorkflowAgentDefinition } from "../../agent-definition.js";

export const MAX_PLANNING_RESULT_CHARS = 50_000;

/** Planner has a dedicated identity and currently uses no tools. */
export const PLANNER_AGENT = parseWorkflowAgentDefinition(config);

export function buildPlanningPrompt(userPrompt: string): string {
  return [
    "请为下面的用户请求制定计划。只输出计划，不要直接回答用户：",
    "<user_request>",
    userPrompt,
    "</user_request>",
  ].join("\n");
}
