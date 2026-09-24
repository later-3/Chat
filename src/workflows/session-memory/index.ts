import { SESSION_MEMORY_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { SESSION_MEMORY_WORKER_AGENT } from "./agents/worker/index.js";
import { prepareSessionMemoryWorkerSession } from "./agents/worker/runtime.js";
import { SESSION_MEMORY_WRITER_AGENT } from "./agents/writer/index.js";
import { prepareSessionMemoryWriterSession } from "./agents/writer/runtime.js";
import { sessionMemoryWorkflow } from "./workflow.js";

/** Complete definition exposed to Chat's Workflow registry. */
export const sessionMemoryWorkflowDefinition = defineChatWorkflow({
  manifest: SESSION_MEMORY_WORKFLOW_MANIFEST,
  agents: [SESSION_MEMORY_WORKER_AGENT, SESSION_MEMORY_WRITER_AGENT],
  prepareAgentSession: (context) => context.agentId === SESSION_MEMORY_WORKER_AGENT.id
    ? prepareSessionMemoryWorkerSession(context)
    : prepareSessionMemoryWriterSession(context),
  run: sessionMemoryWorkflow,
});

export { sessionMemoryWorkflow } from "./workflow.js";
export { runSessionMemoryRememberStep, runSessionMemoryWorkStep } from "./step.js";
