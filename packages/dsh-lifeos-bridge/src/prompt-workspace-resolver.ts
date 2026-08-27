import { realpath } from "node:fs/promises";
import type { PromptTurnSelectionInput } from "@chat/contracts/public";
import { readWorkspaceRootConfig } from "@chat/contracts/workspace-root-config";

export interface PromptWorkspaceContext {
  readonly rootId: string;
  readonly title: string;
}

export interface PromptWorkspaceResolver {
  resolve(dshSessionId: string): PromptWorkspaceContext | null;
}

/** Workspace变化或旧草稿不匹配时清空显式选择，避免把A项目组件带进B项目。 */
export function promptSelectionForWorkspace(
  selection: PromptTurnSelectionInput | undefined,
  workspace: PromptWorkspaceContext | null,
): PromptTurnSelectionInput {
  const workspaceRootId = workspace?.rootId;
  const sameWorkspace = selection !== undefined && selection.workspaceRootId === workspaceRootId;
  if (selection?.schemaVersion === "prompt-turn-selection-input.v2") {
    return {
      schemaVersion: "prompt-turn-selection-input.v2",
      ...(workspaceRootId === undefined ? {} : { workspaceRootId }),
      workflowDefinitionRevisionId: selection.workflowDefinitionRevisionId,
      regions: sameWorkspace
        ? selection.regions.filter((region) => region.regionKey !== "agent_identity")
        : [],
      nodeSelections: [],
    };
  }
  return {
    schemaVersion: "prompt-turn-selection-input.v1",
    ...(workspaceRootId === undefined ? {} : { workspaceRootId }),
    regions: sameWorkspace
      ? selection.regions.filter((region) => region.regionKey !== "agent_identity")
      : [],
  };
}

/** Workflow切换只保留会话上下文；Agent Prompt由Agent Profile拥有。 */
export function promptSelectionForWorkflow(
  selection: PromptTurnSelectionInput,
  workflow: {
    readonly workflowDefinitionRevisionId: string;
    readonly promptNodeIds: readonly string[];
  },
): PromptTurnSelectionInput {
  return {
    schemaVersion: "prompt-turn-selection-input.v2",
    ...(selection.workspaceRootId === undefined
      ? {}
      : { workspaceRootId: selection.workspaceRootId }),
    workflowDefinitionRevisionId: workflow.workflowDefinitionRevisionId as never,
    regions: selection.regions.filter((region) => region.regionKey !== "agent_identity"),
    nodeSelections: [],
  };
}

export interface DshWorkspaceProjection {
  readonly path: string;
  readonly sessionIds: readonly (string & {})[];
}

export interface DshWorkspaceRegistryProjection {
  list(): readonly DshWorkspaceProjection[];
}

/**
 * DSH Workspace只负责把Session定位到canonical path；Chat rootId仍来自服务端
 * CHAT_WORKSPACE_ROOTS_JSON。resolver的公开结果刻意不包含DSH Workspace ID或路径。
 */
export async function createPromptWorkspaceResolver(
  registry: DshWorkspaceRegistryProjection,
  env: NodeJS.ProcessEnv,
): Promise<PromptWorkspaceResolver> {
  let config;
  try {
    config = readWorkspaceRootConfig(env);
  } catch {
    throw new Error("CHAT_WORKSPACE_ROOTS_JSON不符合Prompt Workspace映射合同");
  }
  if (config.length === 0) {
    return {
      resolve: () => null,
    };
  }
  const byPath = new Map<string, PromptWorkspaceContext>();
  const rootIds = new Set<string>();
  for (const item of config) {
    if (rootIds.has(item.rootId)) {
      throw new Error("CHAT_WORKSPACE_ROOTS_JSON包含重复rootId");
    }
    rootIds.add(item.rootId);
    const path = await realpath(item.canonicalPath);
    if (byPath.has(path)) {
      throw new Error("CHAT_WORKSPACE_ROOTS_JSON包含映射到同一目录的多个rootId");
    }
    byPath.set(path, { rootId: item.rootId, title: item.displayName });
  }
  return {
    resolve(dshSessionId) {
      const owning = registry
        .list()
        .filter((workspace) => workspace.sessionIds.some((id) => String(id) === dshSessionId));
      if (owning.length > 1) {
        throw new Error("DSH Session同时属于多个Workspace，无法解析Prompt作用域");
      }
      const workspace = owning[0];
      if (workspace === undefined) return null;
      const mapped = byPath.get(workspace.path);
      return mapped === undefined ? null : structuredClone(mapped);
    },
  };
}
