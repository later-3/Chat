import { z } from "zod";

/**
 * API与Pi Executor共享的服务端Workspace Root配置。绝对路径只存在于服务端，
 * 不进入公开Contract、产品事实、Trace或浏览器响应。
 */
export const workspaceRootConfigSchema = z
  .array(
    z
      .object({
        rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
        displayName: z.string().min(1).max(160),
        canonicalPath: z.string().min(1).max(2_000),
      })
      .strict(),
  )
  .max(20);

export type WorkspaceRootConfig = z.infer<typeof workspaceRootConfigSchema>[number];

export function readWorkspaceRootConfig(env: NodeJS.ProcessEnv): readonly WorkspaceRootConfig[] {
  const raw = env.CHAT_WORKSPACE_ROOTS_JSON?.trim();
  const retired = env.CHAT_PROJECT_ROOTS_JSON?.trim();
  if ((raw === undefined || raw === "") && retired !== undefined && retired !== "") {
    throw new Error(
      "CHAT_PROJECT_ROOTS_JSON已退役，请改用CHAT_WORKSPACE_ROOTS_JSON并删除Project Adapter字段",
    );
  }
  if (raw === undefined || raw === "") return [];
  return workspaceRootConfigSchema.parse(JSON.parse(raw));
}
