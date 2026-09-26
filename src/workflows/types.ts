import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentConfigSelection } from "./agent-config.js";

export interface ChatWorkflowInput {
  readonly projectId?: string;
  readonly chatHome?: string;
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
   * Backend-internal「会话记忆」switch for this round (node-level, resolved from the topic node by the
   * dispatching service — never from an HTTP client or model argument). When false the round runs as an
   * ordinary agent turn: no read Skill/tool is assembled and no writer stage runs.
   */
  readonly sessionMemoryEnabled?: boolean;
  /**
   * Backend-internal: the Workflow that OWNS this round's `remember` node. The writer implementation is
   * shared, but its stage/invocation provenance must stay that of the calling Workflow so execution,
   * inspection and the frontend all read the same identity. Only the tail sets it.
   */
  readonly sessionMemoryOwnerWorkflowId?: string;
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
