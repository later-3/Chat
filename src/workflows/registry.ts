import {
  minimalPiCodingAgentWorkflowDefinition,
} from "./minimal-pi-coding-agent/index.js";
import { memoryWorkflowDefinition } from "./memory/index.js";
import {
  planningExecutionWorkflowDefinition,
} from "./planning-execution/index.js";
import { ruleManagementWorkflowDefinition } from "./rule-management/index.js";
import { browserSafeWorkflowDefinition } from "./framework.js";
import type { ChatWorkflowDefinition } from "./framework.js";

export type {
  ChatWorkflowAgentSessionContext,
  ChatWorkflowDefinition,
  ChatWorkflowNodeDefinition,
  PrepareChatWorkflowAgentSession,
} from "./framework.js";

export const CHAT_WORKFLOW_DEFINITIONS = [
  minimalPiCodingAgentWorkflowDefinition,
  planningExecutionWorkflowDefinition,
  memoryWorkflowDefinition,
  ruleManagementWorkflowDefinition,
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
  return CHAT_WORKFLOW_DEFINITIONS.map(browserSafeWorkflowDefinition);
}
