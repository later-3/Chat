import { RULE_MANAGEMENT_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { RULE_CURATOR_AGENT } from "./agents/rule-curator-agent/index.js";
import { prepareRuleCuratorAgentSession } from "./agents/rule-curator-agent/runtime.js";
import { ruleManagementWorkflow } from "./workflow.js";
import { SESSION_MEMORY_WRITER_AGENT } from "../session-memory/agents/writer/index.js";
import { prepareSessionMemoryWriterSession } from "../session-memory/agents/writer/runtime.js";

export const ruleManagementWorkflowDefinition = defineChatWorkflow({
  manifest: RULE_MANAGEMENT_WORKFLOW_MANIFEST,
  agents: [RULE_CURATOR_AGENT, SESSION_MEMORY_WRITER_AGENT],
  prepareAgentSession: (context) => context.agentId === SESSION_MEMORY_WRITER_AGENT.id
    ? prepareSessionMemoryWriterSession(context)
    : prepareRuleCuratorAgentSession(context),
  run: ruleManagementWorkflow,
});

export { RULE_CURATOR_AGENT } from "./agents/rule-curator-agent/index.js";
export { prepareRuleCuratorAgentSession } from "./agents/rule-curator-agent/runtime.js";
export { ruleManagementWorkflow } from "./workflow.js";
