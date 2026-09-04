import memoryManifestJson from "./memory/workflow.json" with { type: "json" };
import minimalPiCodingAgentManifestJson from "./minimal-pi-coding-agent/workflow.json" with { type: "json" };
import plannerOrchestratorManifestJson from "./planner-orchestrator/workflow.json" with { type: "json" };
import planningExecutionManifestJson from "./planning-execution/workflow.json" with { type: "json" };
import ruleManagementManifestJson from "./rule-management/workflow.json" with { type: "json" };
import { parseChatWorkflowManifest } from "./framework.js";

export const MINIMAL_PI_CODING_AGENT_WORKFLOW_MANIFEST = parseChatWorkflowManifest(
  minimalPiCodingAgentManifestJson,
  "minimal-pi-coding-agent",
);
export const PLANNING_EXECUTION_WORKFLOW_MANIFEST = parseChatWorkflowManifest(
  planningExecutionManifestJson,
  "planning-execution",
);
export const PLANNER_ORCHESTRATOR_WORKFLOW_MANIFEST = parseChatWorkflowManifest(
  plannerOrchestratorManifestJson,
  "planner-orchestrator",
);
export const MEMORY_WORKFLOW_MANIFEST = parseChatWorkflowManifest(
  memoryManifestJson,
  "memory",
);
export const RULE_MANAGEMENT_WORKFLOW_MANIFEST = parseChatWorkflowManifest(
  ruleManagementManifestJson,
  "rule-management",
);

/** Declarative Workflow facts that can be consumed without loading executable Workflow modules. */
export const CHAT_WORKFLOW_MANIFESTS = [
  MINIMAL_PI_CODING_AGENT_WORKFLOW_MANIFEST,
  PLANNING_EXECUTION_WORKFLOW_MANIFEST,
  PLANNER_ORCHESTRATOR_WORKFLOW_MANIFEST,
  MEMORY_WORKFLOW_MANIFEST,
  RULE_MANAGEMENT_WORKFLOW_MANIFEST,
] as const;

export interface AgentCallableWorkflowTarget {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly agentIds: readonly string[];
}

/** Applies the same static eligibility rules that workflow_call enforces at execution time. */
export function listAgentCallableWorkflowTargets(): readonly AgentCallableWorkflowTarget[] {
  return CHAT_WORKFLOW_MANIFESTS
    .filter((workflow) => workflow.agentCallable)
    .map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      agentIds: workflow.agents.map((agent) => agent.id),
    }));
}
