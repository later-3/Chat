import { PROBLEM_DIAGNOSIS_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { PROBLEM_DIAGNOSER_AGENT } from "./agents/diagnoser/index.js";
import { problemDiagnosisWorkflow } from "./workflow.js";

/** Complete definition exposed to Chat's Workflow registry. */
export const problemDiagnosisWorkflowDefinition = defineChatWorkflow({
  manifest: PROBLEM_DIAGNOSIS_WORKFLOW_MANIFEST,
  agents: [PROBLEM_DIAGNOSER_AGENT],
  run: problemDiagnosisWorkflow,
});

export { problemDiagnosisWorkflow } from "./workflow.js";
export { runProblemDiagnosisStep } from "./step.js";
export { PROBLEM_DIAGNOSER_AGENT } from "./agents/diagnoser/index.js";
