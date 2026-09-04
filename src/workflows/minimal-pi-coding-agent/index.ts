import { MINIMAL_PI_CODING_AGENT_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { PI_CODING_AGENT } from "./agents/pi-coding-agent/index.js";
import { minimalPiCodingAgentWorkflow } from "./workflow.js";

// `POST /run` uses this Prompt when the VS Code debug request has no body.
export const MINIMAL_PI_CODING_AGENT_PROMPT = `
回复你好。
`.trim();

/** Complete definition exposed to Chat's Workflow registry. */
export const minimalPiCodingAgentWorkflowDefinition = defineChatWorkflow({
  manifest: MINIMAL_PI_CODING_AGENT_WORKFLOW_MANIFEST,
  agents: [PI_CODING_AGENT],
  run: minimalPiCodingAgentWorkflow,
});

export { minimalPiCodingAgentWorkflow } from "./workflow.js";
export { runPiCodingAgentPromptStep } from "./step.js";
