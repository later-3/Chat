import { listChatSystemTools } from "../tools/registry.js";
import type { AgentConfigSelection } from "./agent-config.js";
import { inspectWorkflowAgent } from "./agent-inspection.js";
import { getChatWorkflowDefinition } from "./registry.js";
import type {
  ChatWorkflowCallDescription,
  DescribeChatWorkflowInput,
  WorkflowCallAgentCapabilitySelection,
  WorkflowCallCapabilityDescription,
} from "./workflow-call-contract.js";

type AgentInspection = Awaited<ReturnType<typeof inspectWorkflowAgent>>;

interface InspectedAgentCapabilities {
  readonly agentId: string;
  readonly inspection: AgentInspection;
}

interface InspectedWorkflowCapabilities {
  readonly workflow: NonNullable<ReturnType<typeof getChatWorkflowDefinition>>;
  readonly agents: readonly InspectedAgentCapabilities[];
}

function requireCallableWorkflow(workflowId: string) {
  const workflow = getChatWorkflowDefinition(workflowId);
  if (workflow === undefined) throw new Error(`找不到目标Workflow: ${workflowId}`);
  if (!workflow.agentCallable) throw new Error(`Workflow不允许由Agent调用: ${workflow.id}`);
  return workflow;
}

function uniqueCapabilities(
  capabilities: readonly WorkflowCallCapabilityDescription[],
  subject: string,
): WorkflowCallCapabilityDescription[] {
  const byName = new Map<string, WorkflowCallCapabilityDescription>();
  for (const capability of capabilities) {
    const current = byName.get(capability.name);
    if (current !== undefined && current.address !== capability.address) {
      throw new Error(`${subject}包含重名能力，不能由父Agent安全选择: ${capability.name}`);
    }
    byName.set(capability.name, capability);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function inspectWorkflowCapabilities(
  input: DescribeChatWorkflowInput,
): Promise<InspectedWorkflowCapabilities> {
  const workflow = requireCallableWorkflow(input.targetWorkflowId);
  const systemToolAddresses = listChatSystemTools().map((tool) => tool.address);
  const agents = await Promise.all(workflow.agents.map(async (agent) => {
    const stageId = workflow.nodes.find((node) => node.kind === "agent" && node.agentId === agent.id)?.id
      ?? agent.id;
    const inspection = await inspectWorkflowAgent({
      projectId: input.projectId,
      chatHome: input.chatHome,
      cwd: input.cwd,
      workflowId: workflow.id,
      agentId: agent.id,
      stageId,
      defaultAgent: agent,
      ...(workflow.prepareAgentSession === undefined
        ? {}
        : { prepareAgentSession: workflow.prepareAgentSession }),
      selection: {
        tools: { mode: "pi-default", addresses: systemToolAddresses },
        resources: { mode: "inherit" },
      },
    });
    return { agentId: agent.id, inspection };
  }));
  return { workflow, agents };
}

/** Returns the exact names a parent Agent may select for one child invocation. */
export async function describeChatWorkflowCapabilities(
  input: DescribeChatWorkflowInput,
): Promise<ChatWorkflowCallDescription> {
  const inspected = await inspectWorkflowCapabilities(input);
  return {
    status: "described",
    workflowId: inspected.workflow.id,
    name: inspected.workflow.name,
    description: inspected.workflow.description,
    agents: inspected.agents.map(({ agentId, inspection }) => ({
      agentId,
      name: inspection.agent.name,
      description: inspection.agent.description,
      tools: uniqueCapabilities(inspection.tools.map((tool) => ({
        name: tool.name,
        address: tool.address,
        description: tool.description,
      })), `Workflow ${inspected.workflow.id} Agent ${agentId} Tool目录`),
      skills: uniqueCapabilities(inspection.skills.map((skill) => ({
        name: skill.name,
        address: skill.address,
        description: skill.description,
      })), `Workflow ${inspected.workflow.id} Agent ${agentId} Skill目录`),
    })),
  };
}

function requireUniqueName<T extends { readonly name: string }>(
  values: readonly T[],
  name: string,
  subject: string,
): T {
  const matches = values.filter((value) => value.name === name);
  if (matches.length === 0) throw new Error(`${subject}不存在: ${name}`);
  if (matches.length > 1) throw new Error(`${subject}名称不唯一: ${name}`);
  return matches[0] as T;
}

/**
 * Converts model-authored capability names into the existing Agent selection
 * contract. Paths and system Tool addresses are resolved only by Backend facts.
 */
export async function resolveWorkflowCallAgentConfigs(
  input: DescribeChatWorkflowInput,
  selections: readonly WorkflowCallAgentCapabilitySelection[],
): Promise<Readonly<Record<string, AgentConfigSelection>>> {
  if (!Array.isArray(selections)) throw new Error("父Agent必须提供Child Agent能力配置");
  const inspected = await inspectWorkflowCapabilities(input);
  const selectionByAgent = new Map<string, WorkflowCallAgentCapabilitySelection>();
  for (const selection of selections) {
    if (selectionByAgent.has(selection.agentId)) {
      throw new Error(`子Workflow能力配置包含重复Agent: ${selection.agentId}`);
    }
    selectionByAgent.set(selection.agentId, selection);
  }
  const expectedAgentIds = new Set(inspected.agents.map((agent) => agent.agentId));
  const unknownAgentIds = [...selectionByAgent.keys()].filter((agentId) => !expectedAgentIds.has(agentId));
  if (unknownAgentIds.length > 0) {
    throw new Error(`Workflow ${inspected.workflow.id}不存在Agent: ${unknownAgentIds.join(", ")}`);
  }
  const missingAgentIds = [...expectedAgentIds].filter((agentId) => !selectionByAgent.has(agentId));
  if (missingAgentIds.length > 0) {
    throw new Error(`父Agent必须为每个Child Agent明确选择能力，缺少: ${missingAgentIds.join(", ")}`);
  }

  const systemToolAddresses = new Set(listChatSystemTools().map((tool) => tool.address));
  const resolved: Record<string, AgentConfigSelection> = {};
  for (const { agentId, inspection } of inspected.agents) {
    const selection = selectionByAgent.get(agentId) as WorkflowCallAgentCapabilitySelection;
    const selectedToolNames = [...new Set(selection.tools)];
    const selectedSkillNames = [...new Set(selection.skills)];
    const toolNames: string[] = [];
    const toolAddresses: string[] = [];
    const extensionPaths = new Set<string>();
    for (const name of selectedToolNames) {
      const tool = requireUniqueName(inspection.tools, name, `Child Agent ${agentId}可委派Tool`);
      if (systemToolAddresses.has(tool.address)) toolAddresses.push(tool.address);
      else toolNames.push(tool.name);
      for (const extension of inspection.extensions) {
        if (extension.capabilities.tools.includes(tool.name)) extensionPaths.add(extension.resolvedPath);
      }
    }
    const skillPaths = selectedSkillNames.map((name) => (
      requireUniqueName(inspection.skills, name, `Child Agent ${agentId}可委派Skill`).filePath
    ));
    resolved[agentId] = {
      tools: selectedToolNames.length === 0
        ? { mode: "none" }
        : {
            mode: "explicit",
            names: toolNames,
            exclude: [],
            ...(toolAddresses.length === 0 ? {} : { addresses: toolAddresses }),
          },
      resources: {
        mode: "explicit",
        skillPaths,
        extensionPaths: [...extensionPaths],
        pluginSources: [],
      },
    };
  }
  return resolved;
}
