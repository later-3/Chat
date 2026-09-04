import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { ensureChatHome } from "../../../../chat-home.js";
import { getMemoryStoreManager } from "../../../../memory/manager-runtime.js";
import type { WorkflowAgentSessionExtensions } from "../../../agent-definition.js";
import type { ChatWorkflowAgentSessionContext } from "../../../registry.js";
import { stripLegacyPlanningHandoffs } from "../../../planning-execution/context.js";
import { injectInstructionBeforeLatestUser } from "../../../session-conversation.js";
import { MEMORY_AGENT } from "./index.js";
import { ensureMemorySkill } from "./skill.js";
import { createMemoryManagementTools } from "./tools/index.js";

const inspectionMemoryManager = {
  search(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
  list(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
  get(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
  create(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
  update(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
  delete(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
  createMany(): never { throw new Error("Memory Tool不能在Agent检查期间执行"); },
};

/** The single runtime assembly path used by Memory execution and inspection. */
export async function prepareMemoryAgentSession(
  context: ChatWorkflowAgentSessionContext,
): Promise<WorkflowAgentSessionExtensions> {
  if (context.workflowId !== "memory" || context.agentId !== MEMORY_AGENT.id) {
    throw new Error(`Memory Workflow不能装配Agent: ${context.workflowId}/${context.agentId}`);
  }
  const paths = await ensureChatHome(context.chatHome);
  const skillPath = await ensureMemorySkill(paths.runtimeDir);
  const skillBody = stripFrontmatter(await readFile(skillPath, "utf8")).trim();
  const projectId = context.projectId ?? context.cwd;
  const callerControlsCapabilities = context.capabilitySource === "workflow_call";
  const selectedResources = context.capabilitySelection?.resources;
  const memorySkillSelected = !callerControlsCapabilities
    || selectedResources?.mode === "inherit"
    || selectedResources?.skillPaths.includes(skillPath) === true;
  const baseContextTransform = stripLegacyPlanningHandoffs;
  return {
    ...(memorySkillSelected ? { additionalSkillPaths: [skillPath] } : {}),
    customTools: createMemoryManagementTools({
      manager: context.purpose === "execution"
        ? getMemoryStoreManager(paths.root)
        : inspectionMemoryManager,
      projectId,
      sessionId: context.sessionId,
      workflowId: context.workflowId,
      workflowInvocationId: context.workflowInvocationId,
      stageId: "manage",
      agentId: MEMORY_AGENT.id,
    }),
    transformContext: memorySkillSelected
      ? (messages) => injectInstructionBeforeLatestUser(
          baseContextTransform(messages),
          {
            customType: "chat.memory_skill_context",
            details: { workflowId: context.workflowId, invocationId: context.workflowInvocationId },
            content: [
              `<skill name="memory" location="${skillPath}">`,
              `References are relative to ${dirname(skillPath)}.`,
              "",
              skillBody,
              "</skill>",
            ].join("\n"),
          },
        )
      : baseContextTransform,
  };
}
