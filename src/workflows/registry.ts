import {
  minimalPiCodingAgentWorkflowDefinition,
} from "./minimal-pi-coding-agent/index.js";
import {
  planningExecutionWorkflowDefinition,
} from "./planning-execution/index.js";
import type { WorkflowAgentDefinition } from "./agent-definition.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "./types.js";

export interface ChatWorkflowStageDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly agentId: string;
}

export interface ChatWorkflowDefinition<Id extends string = string> {
  readonly id: Id;
  readonly name: string;
  readonly description: string;
  readonly stages: readonly ChatWorkflowStageDefinition[];
  readonly agents: readonly WorkflowAgentDefinition[];
  readonly run: (input: ChatWorkflowInput) => Promise<ChatWorkflowResult>;
}

export const CHAT_WORKFLOW_DEFINITIONS = [
  minimalPiCodingAgentWorkflowDefinition,
  planningExecutionWorkflowDefinition,
] as const;

export type ChatWorkflowId = (typeof CHAT_WORKFLOW_DEFINITIONS)[number]["id"];

export const CHAT_WORKFLOW_IDS = CHAT_WORKFLOW_DEFINITIONS.map(
  (definition) => definition.id,
) as readonly ChatWorkflowId[];

export const DEFAULT_CHAT_WORKFLOW_ID: ChatWorkflowId = "minimal-pi-coding-agent";

export function getChatWorkflowDefinition(id: string): ChatWorkflowDefinition | undefined {
  return CHAT_WORKFLOW_DEFINITIONS.find((definition) => definition.id === id);
}

/** Returns only browser-safe Workflow metadata, never executable functions. */
export function listChatWorkflowDefinitions() {
  return CHAT_WORKFLOW_DEFINITIONS.map(({ run: _run, ...definition }) => definition);
}
