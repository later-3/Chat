import manifestJson from "./workflow.json" with { type: "json" };
import { defineChatWorkflow, parseChatWorkflowManifest } from "../framework.js";
import { MEMORY_AGENT } from "./agents/memory-agent/index.js";
import { prepareMemoryAgentSession } from "./agents/memory-agent/runtime.js";
import { memoryWorkflow } from "./workflow.js";

/** Complete definition exposed to Chat's Workflow registry. */
export const memoryWorkflowDefinition = defineChatWorkflow({
  manifest: parseChatWorkflowManifest(manifestJson, "memory"),
  agents: [MEMORY_AGENT],
  prepareAgentSession: prepareMemoryAgentSession,
  run: memoryWorkflow,
});

export { memoryWorkflow } from "./workflow.js";
export { runMemoryAgentStep } from "./step.js";
export { prepareMemoryAgentSession } from "./agents/memory-agent/runtime.js";
