import { resolve } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveProjectContext } from "../projects/registry.js";
import { listChatSystemTools } from "../tools/registry.js";
import { readAgentDurableConfig } from "../workflows/agent-model-config.js";
import type { WorkflowAgentToolPolicy } from "../workflows/agent-config.js";
import { CHAT_WORKFLOW_DEFINITIONS } from "../workflows/registry.js";
import { describeResourceVersion, qualifiedResourceAddress } from "./version.js";

export interface ChatToolConsumer {
  readonly workflowId: string;
  readonly agentId: string;
  readonly source: "workflow-default" | "project-config";
  readonly enabled: boolean;
}

function policyUsesTool(policy: WorkflowAgentToolPolicy, address: string, name: string): boolean {
  if (policy.mode === "none") return false;
  if (policy.addresses?.includes(address)) return true;
  return policy.mode === "explicit" && policy.names.includes(name) && !policy.exclude.includes(name);
}

/** Builds the Project-visible managed Tool catalog without constructing a model-facing AgentSession. */
export async function listChatTools(projectId: string, chatHome?: string) {
  const project = await resolveProjectContext(projectId, chatHome);
  const settingsManager = SettingsManager.create(project.cwd, project.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: project.cwd,
    agentDir: project.agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalProjectExtensionPaths: [resolve(project.projectConfigDir, "extensions")],
  });
  await resourceLoader.reload();
  const extensionResult = resourceLoader.getExtensions();
  const tools = [
    ...listChatSystemTools().map((tool) => ({
      name: tool.manifest.name,
      label: tool.manifest.label,
      description: tool.manifest.description,
      parameters: {},
      promptGuidelines: [],
      sourceInfo: tool.sourceInfo,
      address: tool.address,
      version: null,
      toolVersion: tool.version,
      risk: tool.manifest.risk,
      permissions: tool.manifest.permissions,
      active: false,
    })),
    ...await Promise.all(extensionResult.extensions.flatMap((extension) => (
      [...extension.tools.values()].map(async (registered) => {
        const definition = registered.definition;
        const sourceInfo = registered.sourceInfo ?? extension.sourceInfo;
        return {
          name: definition.name,
          label: definition.label,
          description: definition.description,
          parameters: definition.parameters,
          promptGuidelines: definition.promptGuidelines ?? [],
          sourceInfo,
          address: qualifiedResourceAddress({
            kind: "tool",
            id: definition.name,
            scope: sourceInfo.scope,
            projectId: project.projectId,
          }),
          version: await describeResourceVersion(extension.resolvedPath),
          permissions: [],
          active: false,
        };
      })
    ))),
  ];
  const consumersByTool = new Map(tools.map((tool) => [tool.address, [] as ChatToolConsumer[]]));

  for (const workflow of CHAT_WORKFLOW_DEFINITIONS) {
    for (const agent of workflow.agents) {
      for (const tool of tools) {
        if (policyUsesTool(agent.tools, tool.address, tool.name)) {
          consumersByTool.get(tool.address)?.push({
            workflowId: workflow.id,
            agentId: agent.id,
            source: "workflow-default",
            enabled: true,
          });
        }
      }
      const durable = await readAgentDurableConfig(project.projectDataDir, workflow.id, agent.id);
      if (durable?.tools === undefined) continue;
      for (const tool of tools) {
        consumersByTool.get(tool.address)?.push({
          workflowId: workflow.id,
          agentId: agent.id,
          source: "project-config",
          enabled: policyUsesTool(durable.tools, tool.address, tool.name),
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    projectId: project.projectId,
    tools: tools.map((tool) => ({ ...tool, consumers: consumersByTool.get(tool.address) ?? [] })),
    diagnostics: extensionResult.errors.map((error) => ({
      resource: "extension",
      type: "error",
      path: error.path,
      message: error.error,
    })),
  };
}
