import type { ChatWorkflowDefinition } from "../registry.js";
import { PLANNER_AGENT } from "./agents/planner.js";
import { PLANNING_EXECUTION_AGENT } from "./agents/pi-coding-agent.js";
import { planningExecutionWorkflow } from "./workflow.js";

/** Complete definition exposed to Chat's Workflow registry. */
export const planningExecutionWorkflowDefinition = {
  id: "planning-execution",
  name: "规划执行",
  description: "Planner先制定计划，随后由Pi Coding Agent执行。",
  stages: [
    {
      id: "plan",
      name: "规划",
      description: "Planner根据Session历史和用户请求生成计划。",
      agentId: PLANNER_AGENT.id,
    },
    {
      id: "execute",
      name: "执行",
      description: "Pi Coding Agent结合用户请求和计划完成任务。",
      agentId: PLANNING_EXECUTION_AGENT.id,
    },
  ],
  agents: [PLANNER_AGENT, PLANNING_EXECUTION_AGENT],
  run: planningExecutionWorkflow,
} as const satisfies ChatWorkflowDefinition<"planning-execution">;

export {
  planningExecutionWorkflow,
} from "./workflow.js";
export { runPlanningExecutionStep, runPlanningStep } from "./steps.js";
