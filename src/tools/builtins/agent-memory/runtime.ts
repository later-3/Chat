import type { ChatToolRuntimeContext } from "../../framework.js";
import { resolveLongAgentNanoTarget } from "../../../long-agents/agent-group-service.js";

export interface AgentMemoryToolRuntimeContext extends ChatToolRuntimeContext {
  readonly longAgentId?: string;
}

export function bindAgentMemoryToolRuntime(context: ChatToolRuntimeContext): AgentMemoryToolRuntimeContext {
  if (context.purpose === "execution" && context.longAgentId === undefined) {
    throw new Error("Agent Memory Tool只能由Long Agent使用");
  }
  return context;
}

export async function resolveAgentMemoryToolTarget(context: AgentMemoryToolRuntimeContext) {
  // longAgentId is host-injected into ChatToolRuntimeContext. Neither Tool
  // schema nor model input can select or forge an Agent Group.
  if (context.longAgentId === undefined) throw new Error("Agent Memory Tool缺少Host绑定的Long Agent身份");
  return resolveLongAgentNanoTarget(context.longAgentId, context.chatHome);
}

export function throwIfAgentMemoryToolAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Agent Memory操作已取消");
}
