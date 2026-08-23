import { hashCanonical } from "./canonical-hash.js";

/**
 * 服务端Workspace Root授权指纹。canonicalPath本身永不进入Product Store、协议或日志；
 * API与Executor只比较同一算法生成的SHA，防止rootId在Run创建后被重映射。
 */
export function computeWorkspaceGrantSha256(canonicalPath: string): string {
  return hashCanonical("workspace-root-grant.v1", { canonicalPath });
}
