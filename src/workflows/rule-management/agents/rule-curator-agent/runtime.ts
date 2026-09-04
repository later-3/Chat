import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { ensureChatHome } from "../../../../chat-home.js";
import type { WorkflowAgentSessionExtensions } from "../../../agent-definition.js";
import type { ChatWorkflowAgentSessionContext } from "../../../registry.js";
import { stripLegacyPlanningHandoffs } from "../../../planning-execution/context.js";
import { injectInstructionBeforeLatestUser } from "../../../session-conversation.js";
import { RULE_CURATOR_AGENT } from "./index.js";
import { ensureRuleLibrarySkill } from "./skill.js";
import {
  createRuleManagementTools,
  type RuleManagementToolDependencies,
} from "./tools/index.js";

const INSPECTION_DEPENDENCIES: RuleManagementToolDependencies = {
  workflowAgentExists: () => false,
  loadStoredAgentConfigs: async () => undefined,
};

export async function prepareRuleCuratorAgentSession(
  context: ChatWorkflowAgentSessionContext,
  dependencies: RuleManagementToolDependencies = INSPECTION_DEPENDENCIES,
): Promise<WorkflowAgentSessionExtensions> {
  if (context.workflowId !== "rule-management" || context.agentId !== RULE_CURATOR_AGENT.id) {
    throw new Error(`Rule Management Workflow不能装配Agent: ${context.workflowId}/${context.agentId}`);
  }
  if (context.projectId === undefined) throw new Error("Rule Curator Agent需要已登记的projectId");
  const paths = await ensureChatHome(context.chatHome);
  const skillPath = await ensureRuleLibrarySkill(paths.runtimeDir);
  const skillBody = stripFrontmatter(await readFile(skillPath, "utf8")).trim();
  return {
    additionalSkillPaths: [skillPath],
    customTools: createRuleManagementTools({
      chatHome: paths.root,
      projectId: context.projectId,
      sessionManager: context.sessionManager,
      invocationId: context.workflowInvocationId,
      userPrompt: context.userPrompt,
      workflowId: context.workflowId,
      agentId: context.agentId,
    }, dependencies),
    transformContext: (messages) => injectInstructionBeforeLatestUser(
      stripLegacyPlanningHandoffs(messages),
      {
        customType: "chat.rule_library_skill_context",
        details: { workflowId: context.workflowId, invocationId: context.workflowInvocationId },
        content: [
          `<skill name="rule-library" location="${skillPath}">`,
          `References are relative to ${dirname(skillPath)}.`,
          "",
          skillBody,
          "</skill>",
        ].join("\n"),
      },
    ),
  };
}
