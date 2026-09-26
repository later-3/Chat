import { PLANNING_EXECUTION_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { PLANNER_AGENT } from "./agents/planner/index.js";
import { PLANNING_EXECUTION_AGENT } from "./agents/pi-coding-agent/index.js";
import { planningExecutionWorkflow } from "./workflow.js";
import { SESSION_MEMORY_WRITER_AGENT } from "../session-memory/agents/writer/index.js";
import { prepareSessionMemoryWriterSession } from "../session-memory/agents/writer/runtime.js";

/** Complete definition exposed to Chat's Workflow registry. */
export const planningExecutionWorkflowDefinition = defineChatWorkflow({
  manifest: PLANNING_EXECUTION_WORKFLOW_MANIFEST,
  agents: [PLANNER_AGENT, PLANNING_EXECUTION_AGENT, SESSION_MEMORY_WRITER_AGENT],
  prepareAgentSession: (context) => context.agentId === SESSION_MEMORY_WRITER_AGENT.id
    ? prepareSessionMemoryWriterSession(context)
    : {},
  run: planningExecutionWorkflow,
});

export {
  planningExecutionWorkflow,
} from "./workflow.js";
export { runPlanningExecutionStep, runPlanningStep } from "./steps.js";
