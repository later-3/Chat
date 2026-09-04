import type {
  CallChatWorkflowInput,
  ChatWorkflowCallDescription,
  ChatWorkflowCallRuntime,
  ChatWorkflowCallResult,
  ControlChatWorkflowCallInput,
  DescribeChatWorkflowInput,
} from "./workflow-call-contract.js";

interface WorkflowCallRuntimeState {
  runtime?: ChatWorkflowCallRuntime;
}

const RUNTIME_KEY = Symbol.for("chat.workflow-call-runtime.v1");

function runtimeState(): WorkflowCallRuntimeState {
  const target = globalThis as typeof globalThis & { [RUNTIME_KEY]?: WorkflowCallRuntimeState };
  target[RUNTIME_KEY] ??= {};
  return target[RUNTIME_KEY];
}

/** Registers Chat's single Backend-owned Workflow dispatch and control implementation. */
export function registerChatWorkflowCallRuntime(runtime: ChatWorkflowCallRuntime): void {
  runtimeState().runtime = runtime;
}

/** Narrow runtime boundary used by the Pi Tool without importing the Backend registry graph. */
export function startChatWorkflowCall(
  input: CallChatWorkflowInput,
): Promise<ChatWorkflowCallResult> {
  const runtime = runtimeState().runtime;
  if (runtime === undefined) throw new Error("Workflow调用运行时尚未初始化");
  return runtime.start(input);
}

export function describeChatWorkflowCallTarget(
  input: DescribeChatWorkflowInput,
): Promise<ChatWorkflowCallDescription> {
  const runtime = runtimeState().runtime;
  if (runtime === undefined) throw new Error("Workflow调用运行时尚未初始化");
  return runtime.describe(input);
}

export function waitChatWorkflowCall(
  input: ControlChatWorkflowCallInput,
): Promise<ChatWorkflowCallResult> {
  const runtime = runtimeState().runtime;
  if (runtime === undefined) throw new Error("Workflow调用运行时尚未初始化");
  return runtime.wait(input);
}

export function cancelChatWorkflowCall(
  input: ControlChatWorkflowCallInput,
): Promise<ChatWorkflowCallResult> {
  const runtime = runtimeState().runtime;
  if (runtime === undefined) throw new Error("Workflow调用运行时尚未初始化");
  return runtime.cancel(input);
}
