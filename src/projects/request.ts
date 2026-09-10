import { listProjects, openProject, resolveProjectContext } from "./registry.js";
import type { ChatProjectContext } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves Project identity once at the HTTP boundary; cwd-only input is migration compatibility. */
export async function resolveRequestProject(
  body: unknown,
  _defaultProjectRoot: string,
): Promise<ChatProjectContext> {
  const value = isRecord(body) ? body : {};
  if (typeof value.projectId === "string" && value.projectId.trim() !== "") {
    const context = await resolveProjectContext(value.projectId.trim());
    if (typeof value.cwd === "string" && value.cwd.trim() !== "" && value.cwd !== context.cwd) {
      throw new Error(`Project ${context.projectId}与cwd不一致`);
    }
    return context;
  }
  if (typeof value.cwd === "string" && value.cwd.trim() !== "") {
    return openProject({ path: value.cwd });
  }
  // 普通会话必须属于用户自己的项目：没有显式项目时落到最近使用的用户项目。
  const userProjects = (await listProjects())
    .filter((project) => project.kind === "project" && project.available)
    .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
  const fallback = userProjects[0];
  if (fallback === undefined) {
    throw new Error("请先选择或创建一个Project：普通会话必须属于用户自己的项目");
  }
  return resolveProjectContext(fallback.projectId);
}
