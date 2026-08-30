import { ensureChatHome } from "../../../../chat-home.js";
import type { WorkflowAgentSessionExtensions } from "../../../agent-definition.js";
import type { ChatWorkflowAgentSessionContext } from "../../../registry.js";
import { stripLegacyPlanningHandoffs } from "../../../planning-execution/context.js";
import { RULE_CURATOR_AGENT } from "./index.js";
import { ensureRuleLibrarySkill } from "./skill.js";
import { createRuleManagementTools } from "./tools/index.js";

export async function prepareRuleCuratorAgentSession(
  context: ChatWorkflowAgentSessionContext,
): Promise<WorkflowAgentSessionExtensions> {
  if (context.workflowId !== "rule-management" || context.agentId !== RULE_CURATOR_AGENT.id) {
    throw new Error(`Rule Management Workflow不能装配Agent: ${context.workflowId}/${context.agentId}`);
  }
  if (context.projectId === undefined) throw new Error("Rule Curator Agent需要已登记的projectId");
  const paths = await ensureChatHome(context.chatHome);
  return {
    additionalSkillPaths: [await ensureRuleLibrarySkill(paths.runtimeDir)],
    customTools: createRuleManagementTools({
      chatHome: paths.root,
      projectId: context.projectId,
      sessionManager: context.sessionManager,
      invocationId: context.workflowInvocationId,
      userPrompt: context.userPrompt,
      workflowId: context.workflowId,
      agentId: context.agentId,
    }),
    transformContext: stripLegacyPlanningHandoffs,
  };
}
