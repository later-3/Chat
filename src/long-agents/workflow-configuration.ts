import { DEFAULT_CHAT_WORKFLOW_ID } from "../workflows/registry.js";
import { ensureAgentHomeProject } from "../projects/registry.js";
import { resolveWorkflowAgentDefinition } from "../workflows/agent-config-loader.js";
import type { LongAgentConfig } from "./types.js";

/** Same configuration owner/resolver as project Sessions; the execution project is a separate context. */
export async function longAgentWorkflowConfiguration(agent: LongAgentConfig, chatHome: string, selected?: string) {
  const project = await ensureAgentHomeProject(agent.id, agent.name, chatHome);
  const { resolveChatConfig, getStoredAgentConfigs } = await import("../chat-config.js");
  const { getChatWorkflowDefinition } = await import("../workflows/registry.js");
  const config = (await resolveChatConfig(project.projectId, chatHome)).effective;
  const workflow = getChatWorkflowDefinition(selected ?? config.defaultWorkflowId);
  if (workflow === undefined) throw new Error(`找不到Workflow: ${selected}`);
  const defaults = getStoredAgentConfigs(config, workflow.id);
  return { project, workflow, defaults };
}

export async function resolveLongAgentWorkflowAgent(agent: LongAgentConfig, chatHome: string, selected?: string) {
  const configuration = await longAgentWorkflowConfiguration(agent, chatHome, selected);
  // P3-U2：默认工作流（chat-direct）不定义 Agent——执行主体是 Long Agent 自身（返回其定义）。
  const defaultAgent = configuration.workflow.agents[0];
  if (defaultAgent === undefined) {
    if (configuration.workflow.id === DEFAULT_CHAT_WORKFLOW_ID) {
      // 默认工作流不定义 Agent：能力来源就是 Long Agent 定义本身的 model/thinkingLevel（或 Chat 默认）。
      return { ...configuration, agent: { ...agent.definition,
        modelSource: agent.definition.model === undefined ? "chat-default" as const : "definition" as const,
        thinkingSource: agent.definition.thinkingLevel === undefined ? "chat-default" as const : "definition" as const,
        generationSource: null } };
    }
    throw new Error("Workflow缺少执行Agent");
  }
  const resolved = await resolveWorkflowAgentDefinition({ defaultAgent,
    cwd: configuration.project.cwd, chatHome,
    ...(configuration.defaults?.[defaultAgent.id] === undefined ? {} : { selection: configuration.defaults[defaultAgent.id] }),
    durableModelConfig: { projectDataDir: configuration.project.projectDataDir, workflowId: configuration.workflow.id, agentId: defaultAgent.id },
  });
  return { ...configuration, agent: resolved };
}
