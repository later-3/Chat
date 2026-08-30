import manifestJson from "./workflow.json" with { type: "json" };
import { defineChatWorkflow, parseChatWorkflowManifest } from "../framework.js";
import { PI_CODING_AGENT } from "./agents/pi-coding-agent/index.js";
import { minimalPiCodingAgentWorkflow } from "./workflow.js";

// `POST /run` uses this Prompt when the VS Code debug request has no body.
export const MINIMAL_PI_CODING_AGENT_PROMPT = `
回复你好。
`.trim();

/** Complete definition exposed to Chat's Workflow registry. */
export const minimalPiCodingAgentWorkflowDefinition = defineChatWorkflow({
  manifest: parseChatWorkflowManifest(manifestJson, "minimal-pi-coding-agent"),
  agents: [PI_CODING_AGENT],
  run: minimalPiCodingAgentWorkflow,
});

export { minimalPiCodingAgentWorkflow } from "./workflow.js";
export { runPiCodingAgentPromptStep } from "./step.js";
