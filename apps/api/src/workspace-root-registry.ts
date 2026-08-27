import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { readWorkspaceRootConfig } from "@chat/contracts";
import type { WorkspaceRootRegistryPort } from "@chat/application";

/** Workspace Registry只拥有rootId到本机受管目录的授权映射，不拥有任何产品事实。 */
export async function createWorkspaceRootRegistry(
  env: NodeJS.ProcessEnv,
): Promise<WorkspaceRootRegistryPort> {
  const config = readWorkspaceRootConfig(env);
  const ids = new Set<string>();
  const descriptors = await Promise.all(
    config.map(async (item) => {
      if (ids.has(item.rootId)) throw new Error(`Workspace Root重复:${item.rootId}`);
      ids.add(item.rootId);
      const canonicalPath = await realpath(item.canonicalPath);
      if (!(await stat(canonicalPath)).isDirectory()) {
        throw new Error(`Workspace Root不是目录:${item.rootId}`);
      }
      return {
        rootId: item.rootId,
        displayName: item.displayName,
        grantSha256: createHash("sha256")
          .update(JSON.stringify({ rootId: item.rootId, canonicalPath }))
          .digest("hex"),
      };
    }),
  );
  return { list: () => structuredClone(descriptors) };
}
