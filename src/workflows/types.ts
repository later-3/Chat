import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentConfigSelection } from "./agent-config.js";

export interface ChatWorkflowInput {
  /** Backend-only reference to a durable accepted Friend/node request. Never parsed from HTTP. */
  readonly acceptedLongAgentTurn?: { readonly longAgentId: string; readonly turnId: string };
  readonly projectId?: string;
  readonly chatHome?: string;
  /** Backend-internal storage owner for Long Agent sessions; never parsed from HTTP. */
  readonly ownerLongAgentId?: string;
  readonly cwd: string;
  readonly prompt: string;
  /** Optional image attachments consumed by image-capable Agent steps. */
  readonly images?: readonly ImageContent[];
  readonly sessionId?: string;
  readonly workflowInvocationId: string;
  readonly defaultAgentConfigs?: Readonly<Record<string, AgentConfigSelection>>;
  readonly agentConfigs?: Readonly<Record<string, AgentConfigSelection>>;
  /** Present only for workflow_call; makes this turn's Agent capabilities caller-owned. */
  readonly delegatedByAgentId?: string;
  /**
   * Backend-internal: the session whose session memory a Workflow's internal agents write to
   * (inherited through nested workflow calls; never accepted from an HTTP client or model argument).
   */
  readonly sessionMemoryTarget?: { readonly storageProjectId: string; readonly sessionId: string };
  /**
   * Backend-internal「完整 Prompt 记录」switch for this round (node-level, resolved at the HTTP
   * acceptance boundary — never from an HTTP client of nested calls). When true every final
   * provider payload of the round's agent sessions is captured to gzip sidecars.
   */
  readonly promptCaptureEnabled?: boolean;
  /**
   * Backend-internal trusted binding for the review-gated topic creation Workflow. Resolved from the
   * trusted dispatch context (initiating Long Agent, source session/turn, request identity, fork anchor)
   * and serialized into the Run input; NEVER accepted from an HTTP client or a model argument.
   */
  readonly topicCreation?: {
    readonly longAgentId: string;
    readonly requestId: string;
    readonly sourceSessionId: string;
    readonly sourceTurnId: string | null;
    readonly parents: readonly { readonly nodeId: string; readonly anchorEntryId: string; readonly anchorSequence: number }[];
  };
}

export interface ChatWorkflowResult {
  readonly text: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
  } | null;
}
