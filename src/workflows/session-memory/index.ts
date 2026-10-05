import { SESSION_MEMORY_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { SESSION_MEMORY_WRITER_AGENT } from "./agents/writer/index.js";
import { prepareSessionMemoryWriterSession } from "./agents/writer/runtime.js";
import { sessionMemoryWorkflow } from "./workflow.js";

/** Complete definition exposed to Chat's Workflow registry. */
export const sessionMemoryWorkflowDefinition = defineChatWorkflow({
  manifest: SESSION_MEMORY_WORKFLOW_MANIFEST,
  agents: [SESSION_MEMORY_WRITER_AGENT],
  prepareAgentSession: (context) => prepareSessionMemoryWriterSession(context),
  run: sessionMemoryWorkflow,
});

export { sessionMemoryWorkflow } from "./workflow.js";
export { runSessionMemoryRoundStep } from "./step.js";
