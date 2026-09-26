import type { StartTopicSessionCreationInput } from "./topic-session-create/start.js";

/**
 * Narrow runtime boundary for review-gated topic creation.
 *
 * The Pi Tool must NOT statically import the Workflow registry graph (`start.js` → `start-chat-workflow`
 * → registry → agent-definition): that creates a module cycle the dev Step worker cannot initialize. The
 * Backend registers the real implementation once at startup, exactly like the workflow-call runtime.
 */
export interface TopicCreationRuntime {
  start(input: StartTopicSessionCreationInput): Promise<{
    readonly prepareSessionId: string;
    readonly requestId: string;
    readonly workflowInvocationId: string;
    readonly run: { readonly runId: string };
  }>;
}

interface TopicCreationRuntimeState { impl?: TopicCreationRuntime }
const RUNTIME_KEY = Symbol.for("chat.topic-creation-runtime.v1");

function state(): TopicCreationRuntimeState {
  const target = globalThis as typeof globalThis & { [RUNTIME_KEY]?: TopicCreationRuntimeState };
  target[RUNTIME_KEY] ??= {};
  return target[RUNTIME_KEY];
}

export function registerTopicCreationRuntime(impl: TopicCreationRuntime): void {
  state().impl = impl;
}

export function startTopicCreation(input: StartTopicSessionCreationInput) {
  const impl = state().impl;
  if (impl === undefined) throw new Error("主题创建运行时尚未初始化");
  return impl.start(input);
}
