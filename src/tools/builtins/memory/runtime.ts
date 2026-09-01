import { getMemoryStoreManager } from "../../../memory/manager-runtime.js";
import type { MemoryStoreManager } from "../../../memory/manager.js";
import type { MemorySource, MemoryTarget } from "../../../memory/types.js";
import type { ChatToolRuntimeContext } from "../../framework.js";

export interface MemoryToolRuntimeContext extends ChatToolRuntimeContext {
  readonly manager: Pick<MemoryStoreManager, "search" | "list" | "get" | "createMany" | "update" | "delete">;
  readonly toolAddress: string;
  readonly toolVersion: string;
}

export function bindMemoryToolRuntime(
  context: ChatToolRuntimeContext,
  toolAddress: string,
  toolVersion: string,
): MemoryToolRuntimeContext {
  return {
    ...context,
    manager: getMemoryStoreManager(context.chatHome),
    toolAddress,
    toolVersion,
  };
}

export function defaultProjectTarget(context: MemoryToolRuntimeContext): MemoryTarget {
  return { type: "project", projectId: context.projectId };
}

export function visibleTargets(context: MemoryToolRuntimeContext): readonly MemoryTarget[] {
  return [{ type: "personal" }, defaultProjectTarget(context)];
}

export function memoryToolSource(
  context: MemoryToolRuntimeContext,
  toolCallId: string,
): MemorySource {
  return {
    projectId: context.projectId,
    sessionId: context.sessionId,
    workflowId: context.workflowId,
    workflowInvocationId: context.workflowInvocationId,
    stageId: context.stageId,
    agentId: context.agentId,
    toolCallId,
    toolAddress: context.toolAddress,
    toolVersion: context.toolVersion,
  };
}
