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
  const defaultAgent = configuration.workflow.agents[0];
  if (defaultAgent === undefined) throw new Error("Workflow缺少执行Agent");
  const resolved = await resolveWorkflowAgentDefinition({ defaultAgent,
    cwd: configuration.project.cwd, chatHome,
    ...(configuration.defaults?.[defaultAgent.id] === undefined ? {} : { selection: configuration.defaults[defaultAgent.id] }),
    durableModelConfig: { projectDataDir: configuration.project.projectDataDir, workflowId: configuration.workflow.id, agentId: defaultAgent.id },
  });
  return { ...configuration, agent: resolved };
}
