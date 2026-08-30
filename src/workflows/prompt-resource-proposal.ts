import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  parseAgentConfigSelection,
  type AgentPromptResourceSelection,
} from "./agent-config.js";

export const CHAT_PROMPT_RESOURCE_PROPOSAL_CUSTOM_TYPE = "chat.prompt_resource_proposal";
export const CHAT_PROMPT_RESOURCE_PROPOSAL_RESOLUTION_CUSTOM_TYPE = "chat.prompt_resource_proposal_resolution";
export const CHAT_PROMPT_RESOURCE_PROPOSAL_SCHEMA_VERSION = 1;

export interface ChatPromptResourceProposalData {
  readonly schemaVersion: typeof CHAT_PROMPT_RESOURCE_PROPOSAL_SCHEMA_VERSION;
  readonly invocationId: string;
  readonly sourceWorkflowId: string;
  readonly sourceAgentId: string;
  readonly targetWorkflowId: string;
  readonly targetAgentId: string;
  readonly promptResources: readonly AgentPromptResourceSelection[];
  readonly summary: string;
  readonly createdAt: string;
}

export interface ChatPromptResourceProposal extends ChatPromptResourceProposalData {
  readonly id: string;
  readonly resolution?: {
    readonly status: "applied" | "dismissed";
    readonly resolvedAt: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isIsoTime(value: unknown): value is string {
  return isString(value) && !Number.isNaN(Date.parse(value));
}

export function appendChatPromptResourceProposal(
  sessionManager: SessionManager,
  data: Omit<ChatPromptResourceProposalData, "schemaVersion" | "createdAt">,
): string {
  for (const [field, value] of Object.entries({
    invocationId: data.invocationId,
    sourceWorkflowId: data.sourceWorkflowId,
    sourceAgentId: data.sourceAgentId,
    targetWorkflowId: data.targetWorkflowId,
    targetAgentId: data.targetAgentId,
    summary: data.summary,
  })) {
    if (!isString(value)) throw new Error(`${field}必须是非空字符串`);
  }
  const promptResources = parseAgentConfigSelection({ promptResources: data.promptResources }).promptResources ?? [];
  if (promptResources.length === 0) throw new Error("规则建议至少包含一个Prompt资源");
  const id = sessionManager.appendCustomEntry(CHAT_PROMPT_RESOURCE_PROPOSAL_CUSTOM_TYPE, {
    schemaVersion: CHAT_PROMPT_RESOURCE_PROPOSAL_SCHEMA_VERSION,
    ...data,
    promptResources,
    createdAt: new Date().toISOString(),
  } satisfies ChatPromptResourceProposalData);
  sessionManager.flush();
  return id;
}

export function resolveChatPromptResourceProposal(
  sessionManager: SessionManager,
  proposalId: string,
  status: "applied" | "dismissed",
): void {
  sessionManager.appendCustomEntry(CHAT_PROMPT_RESOURCE_PROPOSAL_RESOLUTION_CUSTOM_TYPE, {
    schemaVersion: CHAT_PROMPT_RESOURCE_PROPOSAL_SCHEMA_VERSION,
    proposalId,
    status,
    resolvedAt: new Date().toISOString(),
  });
  sessionManager.flush();
}

/** Collects proposals and applies the last valid resolution for each proposal. */
export function collectChatPromptResourceProposals(entries: readonly unknown[]): ChatPromptResourceProposal[] {
  const proposals = new Map<string, ChatPromptResourceProposal>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || !isString(entry.id) || !isRecord(entry.data)) continue;
    const data = entry.data;
    if (entry.customType === CHAT_PROMPT_RESOURCE_PROPOSAL_CUSTOM_TYPE) {
      const parsed = (() => {
        try {
          return parseAgentConfigSelection({ promptResources: data.promptResources }).promptResources;
        } catch {
          return undefined;
        }
      })();
      if (
        data.schemaVersion !== CHAT_PROMPT_RESOURCE_PROPOSAL_SCHEMA_VERSION
        || !isString(data.invocationId)
        || !isString(data.sourceWorkflowId)
        || !isString(data.sourceAgentId)
        || !isString(data.targetWorkflowId)
        || !isString(data.targetAgentId)
        || !isString(data.summary)
        || !isIsoTime(data.createdAt)
        || parsed === undefined
      ) {
        continue;
      }
      proposals.set(entry.id, {
        id: entry.id,
        schemaVersion: CHAT_PROMPT_RESOURCE_PROPOSAL_SCHEMA_VERSION,
        invocationId: data.invocationId,
        sourceWorkflowId: data.sourceWorkflowId,
        sourceAgentId: data.sourceAgentId,
        targetWorkflowId: data.targetWorkflowId,
        targetAgentId: data.targetAgentId,
        promptResources: parsed,
        summary: data.summary,
        createdAt: data.createdAt,
      });
    } else if (
      entry.customType === CHAT_PROMPT_RESOURCE_PROPOSAL_RESOLUTION_CUSTOM_TYPE
      && data.schemaVersion === CHAT_PROMPT_RESOURCE_PROPOSAL_SCHEMA_VERSION
      && isString(data.proposalId)
      && (data.status === "applied" || data.status === "dismissed")
      && isIsoTime(data.resolvedAt)
    ) {
      const proposal = proposals.get(data.proposalId);
      if (proposal !== undefined) {
        proposals.set(data.proposalId, {
          ...proposal,
          resolution: { status: data.status, resolvedAt: data.resolvedAt },
        });
      }
    }
  }
  return [...proposals.values()];
}
