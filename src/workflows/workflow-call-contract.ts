import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkflowCallProgress } from "./workflow-call-progress.js";

export const DEFAULT_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS = 30_000;
export const MAX_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS = 300_000;

interface ChatWorkflowCallParentInput {
  readonly parentSessionManager: SessionManager;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkflowCallProgress) => void;
}

export interface WorkflowCallAgentCapabilitySelection {
  readonly agentId: string;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
}

export interface WorkflowCallCapabilityDescription {
  readonly name: string;
  readonly address: string;
  readonly description: string;
}

export interface WorkflowCallAgentDescription {
  readonly agentId: string;
  readonly name: string;
  readonly description: string;
  readonly tools: readonly WorkflowCallCapabilityDescription[];
  readonly skills: readonly WorkflowCallCapabilityDescription[];
}

export interface ChatWorkflowCallDescription {
  readonly status: "described";
  readonly workflowId: string;
  readonly name: string;
  readonly description: string;
  readonly agents: readonly WorkflowCallAgentDescription[];
}

export interface DescribeChatWorkflowInput {
  readonly projectId: string;
  readonly chatHome: string;
  readonly cwd: string;
  readonly targetWorkflowId: string;
}

/** Complete trusted input assembled by Chat around the model-authored Tool arguments. */
export interface CallChatWorkflowInput extends ChatWorkflowCallParentInput {
  readonly projectId: string;
  readonly chatHome: string;
  readonly cwd: string;
  readonly parentWorkflowId: string;
  readonly parentWorkflowInvocationId: string;
  readonly parentStageId: string;
  readonly parentAgentId: string;
  readonly toolCallId: string;
  readonly targetWorkflowId: string;
  readonly prompt: string;
  readonly agents: readonly WorkflowCallAgentCapabilitySelection[];
  readonly waitTimeoutMs?: number;
}

/** Trusted input for controlling a call already owned by the current parent Session. */
export interface ControlChatWorkflowCallInput extends ChatWorkflowCallParentInput {
  readonly callId: string;
  readonly waitTimeoutMs?: number;
}

interface ChatWorkflowCallResultBase {
  readonly callId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly workflowInvocationId: string;
  readonly sessionId: string;
  readonly startedAt: string;
}

/** The wait window elapsed; the child keeps running and can be waited on again or cancelled. */
export interface ChatWorkflowCallRunningResult extends ChatWorkflowCallResultBase {
  readonly status: "running";
  readonly observedAt: string;
  readonly elapsedMs: number;
  readonly waitTimeoutMs: number;
}

/** Terminal success returned to Pi; failures remain ordinary Tool errors. */
export interface ChatWorkflowCallCompletedResult extends ChatWorkflowCallResultBase {
  readonly status: "completed";
  readonly completedAt: string;
  readonly durationMs: number;
  readonly text: string;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
  } | null;
}

/** Terminal cancellation acknowledged by the Workflow Runtime. */
export interface ChatWorkflowCallCancelledResult extends ChatWorkflowCallResultBase {
  readonly status: "cancelled";
  readonly cancelledAt: string;
  readonly durationMs: number;
}

export type ChatWorkflowCallResult =
  | ChatWorkflowCallRunningResult
  | ChatWorkflowCallCompletedResult
  | ChatWorkflowCallCancelledResult;

export interface ChatWorkflowCallRuntime {
  readonly describe: (input: DescribeChatWorkflowInput) => Promise<ChatWorkflowCallDescription>;
  readonly start: (input: CallChatWorkflowInput) => Promise<ChatWorkflowCallResult>;
  readonly wait: (input: ControlChatWorkflowCallInput) => Promise<ChatWorkflowCallResult>;
  readonly cancel: (input: ControlChatWorkflowCallInput) => Promise<ChatWorkflowCallResult>;
}
