import { TOPIC_SESSION_CREATE_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { TOPIC_COLLECTOR_AGENT } from "./agents/collector/index.js";
import { TOPIC_CREATOR_AGENT } from "./agents/creator/index.js";
import { topicSessionCreateWorkflow } from "./workflow.js";
import { SESSION_MEMORY_WRITER_AGENT } from "../session-memory/agents/writer/index.js";
import { prepareSessionMemoryWriterSession } from "../session-memory/agents/writer/runtime.js";

/** Complete definition exposed to Chat's Workflow registry. */
export const topicSessionCreateWorkflowDefinition = defineChatWorkflow({
  manifest: TOPIC_SESSION_CREATE_WORKFLOW_MANIFEST,
  agents: [TOPIC_COLLECTOR_AGENT, TOPIC_CREATOR_AGENT, SESSION_MEMORY_WRITER_AGENT],
  prepareAgentSession: (context) => context.agentId === SESSION_MEMORY_WRITER_AGENT.id
    ? prepareSessionMemoryWriterSession(context)
    : {},
  run: topicSessionCreateWorkflow,
});

export { topicSessionCreateWorkflow } from "./workflow.js";
export { TOPIC_SESSION_CREATE_WORKFLOW_ID } from "./steps.js";
