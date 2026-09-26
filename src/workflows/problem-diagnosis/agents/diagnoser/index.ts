import definitionJson from "./agent.json" with { type: "json" };
import { parseWorkflowAgentDefinition, type WorkflowAgentDefinition } from "../../../agent-config.js";

export const PROBLEM_DIAGNOSER_AGENT_ID = "problem-diagnoser";
export const PROBLEM_DIAGNOSER_AGENT: WorkflowAgentDefinition = parseWorkflowAgentDefinition(definitionJson);
