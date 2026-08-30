import manifestJson from "./workflow.json" with { type: "json" };
import { defineChatWorkflow, parseChatWorkflowManifest } from "../framework.js";
import { RULE_CURATOR_AGENT } from "./agents/rule-curator-agent/index.js";
import { prepareRuleCuratorAgentSession } from "./agents/rule-curator-agent/runtime.js";
import { ruleManagementWorkflow } from "./workflow.js";

export const ruleManagementWorkflowDefinition = defineChatWorkflow({
  manifest: parseChatWorkflowManifest(manifestJson, "rule-management"),
  agents: [RULE_CURATOR_AGENT],
  prepareAgentSession: prepareRuleCuratorAgentSession,
  run: ruleManagementWorkflow,
});

export { RULE_CURATOR_AGENT } from "./agents/rule-curator-agent/index.js";
export { prepareRuleCuratorAgentSession } from "./agents/rule-curator-agent/runtime.js";
export { ruleManagementWorkflow } from "./workflow.js";
export { runRuleManagementStep } from "./step.js";
