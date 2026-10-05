import { TOPIC_SESSION_CREATE_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { TOPIC_COLLECTOR_AGENT } from "./agents/collector/index.js";
import { TOPIC_CREATOR_AGENT } from "./agents/creator/index.js";
import { topicSessionCreateWorkflow } from "./workflow.js";

/** Complete definition exposed to Chat's Workflow registry. */
export const topicSessionCreateWorkflowDefinition = defineChatWorkflow({
  manifest: TOPIC_SESSION_CREATE_WORKFLOW_MANIFEST,
  agents: [TOPIC_COLLECTOR_AGENT, TOPIC_CREATOR_AGENT],
  run: topicSessionCreateWorkflow,
});

export { topicSessionCreateWorkflow } from "./workflow.js";
export { TOPIC_SESSION_CREATE_WORKFLOW_ID } from "./steps.js";
