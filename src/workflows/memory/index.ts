import { MEMORY_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { MEMORY_AGENT } from "./agents/memory-agent/index.js";
import { prepareMemoryAgentSession } from "./agents/memory-agent/runtime.js";
import { memoryWorkflow } from "./workflow.js";
import { SESSION_MEMORY_WRITER_AGENT } from "../session-memory/agents/writer/index.js";
import { prepareSessionMemoryWriterSession } from "../session-memory/agents/writer/runtime.js";

/** Complete definition exposed to Chat's Workflow registry. */
export const memoryWorkflowDefinition = defineChatWorkflow({
  manifest: MEMORY_WORKFLOW_MANIFEST,
  agents: [MEMORY_AGENT, SESSION_MEMORY_WRITER_AGENT],
  prepareAgentSession: (context) => context.agentId === SESSION_MEMORY_WRITER_AGENT.id
    ? prepareSessionMemoryWriterSession(context)
    : prepareMemoryAgentSession(context),
  run: memoryWorkflow,
});

export { memoryWorkflow } from "./workflow.js";
export { runMemoryAgentStep } from "./step.js";
export { prepareMemoryAgentSession } from "./agents/memory-agent/runtime.js";
