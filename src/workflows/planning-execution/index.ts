import manifestJson from "./workflow.json" with { type: "json" };
import { defineChatWorkflow, parseChatWorkflowManifest } from "../framework.js";
import { PLANNER_AGENT } from "./agents/planner/index.js";
import { PLANNING_EXECUTION_AGENT } from "./agents/pi-coding-agent/index.js";
import { planningExecutionWorkflow } from "./workflow.js";

/** Complete definition exposed to Chat's Workflow registry. */
export const planningExecutionWorkflowDefinition = defineChatWorkflow({
  manifest: parseChatWorkflowManifest(manifestJson, "planning-execution"),
  agents: [PLANNER_AGENT, PLANNING_EXECUTION_AGENT],
  run: planningExecutionWorkflow,
});

export {
  planningExecutionWorkflow,
} from "./workflow.js";
export { runPlanningExecutionStep, runPlanningStep } from "./steps.js";
