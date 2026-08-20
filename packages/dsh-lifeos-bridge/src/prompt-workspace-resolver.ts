import { realpath } from "node:fs/promises";
import type { PromptTurnSelectionInput } from "@chat/contracts/public";
import { z } from "zod";

const promptWorkspaceRootConfigSchema = z
  .array(
    z
      .object({
        rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
        displayName: z.string().min(1).max(160),
        canonicalPath: z.string().min(1).max(2_000),
        enabledAdapters: z.array(z.string().min(1)).min(1).max(20),
      })
      .strict(),
  )
  .max(20);

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
  return {
    schemaVersion: "prompt-turn-selection-input.v1",
    ...(workspaceRootId === undefined ? {} : { workspaceRootId }),
    regions: sameWorkspace ? selection.regions : [],
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
 * CHAT_PROJECT_ROOTS_JSON。resolver的公开结果刻意不包含DSH Workspace ID或路径。
 */
export async function createPromptWorkspaceResolver(
  registry: DshWorkspaceRegistryProjection,
  env: { readonly CHAT_PROJECT_ROOTS_JSON?: string | undefined },
): Promise<PromptWorkspaceResolver> {
  const raw = env.CHAT_PROJECT_ROOTS_JSON;
  if (raw === undefined || raw.trim() === "") {
    return { resolve: () => null };
  }
  let config: z.infer<typeof promptWorkspaceRootConfigSchema>;
  try {
    config = promptWorkspaceRootConfigSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("CHAT_PROJECT_ROOTS_JSON不符合Prompt Workspace映射合同");
  }
  const byPath = new Map<string, PromptWorkspaceContext>();
  const rootIds = new Set<string>();
  for (const item of config) {
    if (rootIds.has(item.rootId)) {
      throw new Error("CHAT_PROJECT_ROOTS_JSON包含重复rootId");
    }
    rootIds.add(item.rootId);
    const path = await realpath(item.canonicalPath);
    if (byPath.has(path)) {
      throw new Error("CHAT_PROJECT_ROOTS_JSON包含映射到同一目录的多个rootId");
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
