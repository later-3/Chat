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
  const projectId = context.contextProjectId === undefined ? context.projectId : context.contextProjectId;
  if (projectId === null) throw new Error("本轮没有项目上下文，请为Project Memory明确指定目标");
  return { type: "project", projectId };
}

export function visibleTargets(context: MemoryToolRuntimeContext): readonly MemoryTarget[] {
  return [{ type: "personal" }, ...(context.contextProjectId === null ? [] : [defaultProjectTarget(context)])];
}

export function memoryToolSource(
  context: MemoryToolRuntimeContext,
  toolCallId: string,
): MemorySource {
  return {
    projectId: context.projectId,
    sessionId: context.sessionId,
    ...(context.workflowId === undefined ? {} : { workflowId: context.workflowId }),
    ...(context.workflowInvocationId === undefined ? {} : { workflowInvocationId: context.workflowInvocationId }),
    ...(context.stageId === undefined ? {} : { stageId: context.stageId }),
    agentId: context.agentId,
    ...(context.longAgentTurnId === undefined ? {} : { turnId: context.longAgentTurnId }),
    toolCallId,
    toolAddress: context.toolAddress,
    toolVersion: context.toolVersion,
  };
}
