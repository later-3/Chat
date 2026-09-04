import { PLANNER_ORCHESTRATOR_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { ORCHESTRATION_PLANNER_AGENT } from "./agents/planner/index.js";
import { WORKFLOW_COORDINATOR_AGENT } from "./agents/coordinator/index.js";
import { prepareWorkflowCoordinatorSession } from "./agents/coordinator/runtime.js";
import { plannerOrchestratorWorkflow } from "./workflow.js";

export const plannerOrchestratorWorkflowDefinition = defineChatWorkflow({
  manifest: PLANNER_ORCHESTRATOR_WORKFLOW_MANIFEST,
  agents: [ORCHESTRATION_PLANNER_AGENT, WORKFLOW_COORDINATOR_AGENT],
  prepareAgentSession: prepareWorkflowCoordinatorSession,
  run: plannerOrchestratorWorkflow,
});

export { plannerOrchestratorWorkflow } from "./workflow.js";
