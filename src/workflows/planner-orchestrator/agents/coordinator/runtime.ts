import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { ensureChatHome } from "../../../../chat-home.js";
import type { WorkflowAgentSessionExtensions } from "../../../agent-definition.js";
import type { ChatWorkflowAgentSessionContext } from "../../../registry.js";
import { stripLegacyPlanningHandoffs } from "../../../planning-execution/context.js";
import { injectInstructionBeforeLatestUser } from "../../../session-conversation.js";
import { WORKFLOW_COORDINATOR_AGENT } from "./index.js";
import { ensureWorkflowDelegationSkill } from "./skill.js";

export async function prepareWorkflowCoordinatorSession(
  context: ChatWorkflowAgentSessionContext,
): Promise<WorkflowAgentSessionExtensions> {
  if (context.workflowId !== "planner-orchestrator" || context.agentId !== WORKFLOW_COORDINATOR_AGENT.id) {
    return {};
  }
  const paths = await ensureChatHome(context.chatHome);
  const skillPath = await ensureWorkflowDelegationSkill(paths.runtimeDir);
  const skillBody = stripFrontmatter(await readFile(skillPath, "utf8")).trim();
  return {
    additionalSkillPaths: [skillPath],
    transformContext: (messages) => injectInstructionBeforeLatestUser(
      stripLegacyPlanningHandoffs(messages),
      {
        customType: "chat.workflow_delegation_skill_context",
        details: { workflowId: context.workflowId, invocationId: context.workflowInvocationId },
        content: [
          `<skill name="workflow-delegation" location="${skillPath}">`,
          `References are relative to ${dirname(skillPath)}.`,
          "",
          skillBody,
          "</skill>",
        ].join("\n"),
      },
    ),
  };
}
