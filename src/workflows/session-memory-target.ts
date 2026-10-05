import { readChatSessionRunBinding } from "./session-run-registry.js";

/**
 * The session whose session memory a Workflow's internal agents write to. It is backend-owned
 * provenance: derived from the dispatching agent's trusted tool context, inherited unchanged through
 * nested workflow calls, and never accepted from an HTTP client or a model argument.
 */
export interface WorkflowSessionMemoryTarget {
  readonly storageProjectId: string;
  readonly sessionId: string;
  /** Long Agent owner of the target session's storage; omitted for non-agent (shared) targets. */
  readonly ownerLongAgentId?: string;
}

/**
 * Derive the target for a workflow dispatched from an agent's tool context. An already-present target
 * wins (a nested call must keep the original); otherwise only a session that lives in its own agent
 * home qualifies — an ordinary project session never gains agent-home memory access.
 */
export function sessionMemoryTargetForToolContext(context: {
  readonly sessionMemoryTarget?: WorkflowSessionMemoryTarget | undefined;
  readonly longAgentId?: string | undefined;
  readonly projectId: string;
  readonly sessionId: string;
}): WorkflowSessionMemoryTarget | undefined {
  if (context.sessionMemoryTarget !== undefined) return context.sessionMemoryTarget;
  if (context.longAgentId === undefined || context.projectId !== context.longAgentId) return undefined;
  // Agent Workspace（projectId === agent id）也按 owner 记录，指向 per-agent 项目树。
  return { storageProjectId: context.projectId, sessionId: context.sessionId, ownerLongAgentId: context.longAgentId };
}

/**
 * A workflow agent inherits the dispatching session's target from the durable run binding when its own
 * tool context carries none; an explicit target always wins.
 */
export async function inheritSessionMemoryTarget(input: {
  readonly toolContextTarget?: WorkflowSessionMemoryTarget | undefined;
  readonly projectDataDir: string | undefined;
  readonly workflowInvocationId: string | undefined;
}): Promise<WorkflowSessionMemoryTarget | undefined> {
  if (input.toolContextTarget !== undefined) return input.toolContextTarget;
  if (input.projectDataDir === undefined || input.workflowInvocationId === undefined) return undefined;
  // readChatSessionRunBinding already maps "file missing" to undefined; a corrupted binding must
  // propagate instead of being silently treated as "no target" (the agent would then write memory to
  // the wrong session). The durable binding is only a fallback — Steps pass the trusted input target.
  const binding = await readChatSessionRunBinding(input.projectDataDir, input.workflowInvocationId);
  return binding?.sessionMemoryTarget;
}
