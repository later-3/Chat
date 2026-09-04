import { RULE_MANAGEMENT_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { RULE_CURATOR_AGENT } from "./agents/rule-curator-agent/index.js";
import { prepareRuleCuratorAgentSession } from "./agents/rule-curator-agent/runtime.js";
import { ruleManagementWorkflow } from "./workflow.js";

export const ruleManagementWorkflowDefinition = defineChatWorkflow({
  manifest: RULE_MANAGEMENT_WORKFLOW_MANIFEST,
  agents: [RULE_CURATOR_AGENT],
  prepareAgentSession: prepareRuleCuratorAgentSession,
  run: ruleManagementWorkflow,
});

export { RULE_CURATOR_AGENT } from "./agents/rule-curator-agent/index.js";
export { prepareRuleCuratorAgentSession } from "./agents/rule-curator-agent/runtime.js";
export { ruleManagementWorkflow } from "./workflow.js";
