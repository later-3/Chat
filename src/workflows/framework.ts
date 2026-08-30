import type {
  WorkflowAgentDefinition,
  WorkflowAgentSessionExtensions,
} from "./agent-definition.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatWorkflowInput, ChatWorkflowResult } from "./types.js";

export interface ChatWorkflowAgentNodeDefinition {
  readonly kind: "agent";
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly agentId: string;
}

export interface ChatWorkflowTaskNodeDefinition {
  readonly kind: "task";
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export type ChatWorkflowNodeDefinition =
  | ChatWorkflowAgentNodeDefinition
  | ChatWorkflowTaskNodeDefinition;

export interface ChatWorkflowAgentReference {
  readonly id: string;
  readonly config: string;
}

export interface ChatWorkflowManifest<Id extends string = string> {
  readonly schemaVersion: 1;
  readonly id: Id;
  readonly name: string;
  readonly description: string;
  readonly nodes: readonly ChatWorkflowNodeDefinition[];
  readonly agents: readonly ChatWorkflowAgentReference[];
}

export interface ChatWorkflowAgentSessionContext {
  readonly purpose: "execution" | "inspection";
  readonly projectId?: string;
  readonly chatHome?: string;
  readonly cwd: string;
  readonly workflowId: string;
  readonly agentId: string;
  readonly sessionManager: SessionManager;
  readonly sessionId: string;
  readonly workflowInvocationId: string;
  readonly userPrompt: string;
}

export type PrepareChatWorkflowAgentSession = (
  context: ChatWorkflowAgentSessionContext,
) => Promise<WorkflowAgentSessionExtensions> | WorkflowAgentSessionExtensions;

export interface ChatWorkflowDefinition<Id extends string = string> {
  readonly id: Id;
  readonly name: string;
  readonly description: string;
  readonly nodes: readonly ChatWorkflowNodeDefinition[];
  readonly agents: readonly WorkflowAgentDefinition[];
  readonly agentConfigPaths: Readonly<Record<string, string>>;
  readonly prepareAgentSession?: PrepareChatWorkflowAgentSession;
  readonly run: (input: ChatWorkflowInput) => Promise<ChatWorkflowResult>;
}

interface DefineChatWorkflowOptions<Id extends string> {
  readonly manifest: ChatWorkflowManifest<Id>;
  readonly agents: readonly WorkflowAgentDefinition[];
  readonly prepareAgentSession?: PrepareChatWorkflowAgentSession;
  readonly run: (input: ChatWorkflowInput) => Promise<ChatWorkflowResult>;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim() === "") throw new Error(`${field}不能为空`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownFields(value: Record<string, unknown>, fields: readonly string[], subject: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new Error(`${subject}包含未知字段: ${unknown.join(", ")}`);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}必须是非空字符串`);
  return value;
}

/** Strictly parses the declarative workflow.json boundary. */
export function parseChatWorkflowManifest<Id extends string>(
  value: unknown,
  expectedId: Id,
): ChatWorkflowManifest<Id> {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Workflow配置必须使用schemaVersion 1");
  }
  assertKnownFields(value, ["schemaVersion", "id", "name", "description", "nodes", "agents"], "Workflow配置");
  const id = readString(value.id, "Workflow id");
  if (id !== expectedId) throw new Error(`Workflow配置id必须是${expectedId}`);
  if (!Array.isArray(value.nodes)) throw new Error(`Workflow ${id} nodes必须是数组`);
  if (!Array.isArray(value.agents)) throw new Error(`Workflow ${id} agents必须是数组`);

  const nodes = value.nodes.map((node, index): ChatWorkflowNodeDefinition => {
    if (!isRecord(node)) throw new Error(`Workflow ${id} nodes[${index}]必须是对象`);
    if (node.kind === "agent") {
      assertKnownFields(node, ["kind", "id", "name", "description", "agentId"], `Workflow ${id} Agent Node`);
      return {
        kind: "agent",
        id: readString(node.id, `Workflow ${id} nodes[${index}].id`),
        name: readString(node.name, `Workflow ${id} nodes[${index}].name`),
        description: typeof node.description === "string" ? node.description : "",
        agentId: readString(node.agentId, `Workflow ${id} nodes[${index}].agentId`),
      };
    }
    if (node.kind === "task") {
      assertKnownFields(node, ["kind", "id", "name", "description"], `Workflow ${id} Task Node`);
      return {
        kind: "task",
        id: readString(node.id, `Workflow ${id} nodes[${index}].id`),
        name: readString(node.name, `Workflow ${id} nodes[${index}].name`),
        description: typeof node.description === "string" ? node.description : "",
      };
    }
    throw new Error(`Workflow ${id} nodes[${index}].kind无效`);
  });

  const agents = value.agents.map((agent, index): ChatWorkflowAgentReference => {
    if (!isRecord(agent)) throw new Error(`Workflow ${id} agents[${index}]必须是对象`);
    assertKnownFields(agent, ["id", "config"], `Workflow ${id} Agent引用`);
    return {
      id: readString(agent.id, `Workflow ${id} agents[${index}].id`),
      config: readString(agent.config, `Workflow ${id} agents[${index}].config`),
    };
  });

  return {
    schemaVersion: 1,
    id: expectedId,
    name: readString(value.name, `Workflow ${id} name`),
    description: typeof value.description === "string" ? value.description : "",
    nodes,
    agents,
  };
}

/**
 * Creates one validated Workflow definition without introducing another
 * execution engine. Vercel Workflow still runs `run`; Pi still owns AgentSession.
 */
export function defineChatWorkflow<Id extends string>(
  options: DefineChatWorkflowOptions<Id>,
): ChatWorkflowDefinition<Id> {
  const { manifest } = options;
  if (manifest.schemaVersion !== 1) throw new Error("Workflow配置必须使用schemaVersion 1");
  requireNonEmpty(manifest.id, "Workflow id");
  requireNonEmpty(manifest.name, `Workflow ${manifest.id} name`);

  const agentsById = new Map<string, WorkflowAgentDefinition>();
  for (const agent of options.agents) {
    requireNonEmpty(agent.id, `Workflow ${manifest.id} Agent id`);
    if (agentsById.has(agent.id)) throw new Error(`Workflow ${manifest.id}包含重复Agent: ${agent.id}`);
    agentsById.set(agent.id, agent);
  }

  const agentConfigPaths: Record<string, string> = {};
  const orderedAgents: WorkflowAgentDefinition[] = [];
  for (const reference of manifest.agents) {
    requireNonEmpty(reference.id, `Workflow ${manifest.id} Agent引用id`);
    requireNonEmpty(reference.config, `Workflow ${manifest.id} Agent ${reference.id} config`);
    if (reference.id in agentConfigPaths) {
      throw new Error(`Workflow ${manifest.id}配置重复引用Agent: ${reference.id}`);
    }
    const agent = agentsById.get(reference.id);
    if (agent === undefined) throw new Error(`Workflow ${manifest.id}没有加载Agent: ${reference.id}`);
    agentConfigPaths[reference.id] = reference.config;
    orderedAgents.push(agent);
  }
  for (const agentId of agentsById.keys()) {
    if (!(agentId in agentConfigPaths)) {
      throw new Error(`Workflow ${manifest.id}加载了未声明Agent: ${agentId}`);
    }
  }

  const nodeIds = new Set<string>();
  const referencedAgentIds = new Set<string>();
  for (const node of manifest.nodes) {
    requireNonEmpty(node.id, `Workflow ${manifest.id} Node id`);
    requireNonEmpty(node.name, `Workflow ${manifest.id} Node ${node.id} name`);
    if (nodeIds.has(node.id)) throw new Error(`Workflow ${manifest.id}包含重复Node: ${node.id}`);
    nodeIds.add(node.id);
    if (node.kind === "agent") {
      if (!agentsById.has(node.agentId)) {
        throw new Error(`Workflow ${manifest.id} Node ${node.id}引用不存在的Agent: ${node.agentId}`);
      }
      referencedAgentIds.add(node.agentId);
    } else if (node.kind !== "task") {
      throw new Error(`Workflow ${manifest.id}包含无效Node类型`);
    }
  }
  for (const agentId of agentsById.keys()) {
    if (!referencedAgentIds.has(agentId)) {
      throw new Error(`Workflow ${manifest.id}的Agent没有对应Node: ${agentId}`);
    }
  }

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    nodes: manifest.nodes,
    agents: orderedAgents,
    agentConfigPaths,
    ...(options.prepareAgentSession === undefined
      ? {}
      : { prepareAgentSession: options.prepareAgentSession }),
    run: options.run,
  };
}

/** Projects only declarative, browser-safe Workflow data. */
export function browserSafeWorkflowDefinition(definition: ChatWorkflowDefinition) {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    nodes: definition.nodes,
    agents: definition.agents.map((agent) => ({
      ...agent,
      configPath: definition.agentConfigPaths[agent.id],
    })),
  };
}
