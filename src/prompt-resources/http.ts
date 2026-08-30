import { PROJECT_ID_PATTERN } from "../projects/types.js";
import { resolveProjectContext } from "../projects/registry.js";
import {
  PromptResourceConflictError,
  PromptResourceNotFoundError,
} from "./store.js";
import type { PromptResourceTarget } from "./types.js";

export function queryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined;
}

export async function requirePromptResourceProjectId(query: Record<string, unknown>): Promise<string> {
  const projectId = queryString(query.projectId);
  if (projectId === undefined || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error("projectId必须是已登记Project的有效ID");
  }
  await resolveProjectContext(projectId);
  return projectId;
}

export function promptResourceTargetsFromQuery(
  query: Record<string, unknown>,
  currentProjectId: string,
  requireExact = false,
): PromptResourceTarget[] {
  const scope = queryString(query.target);
  const targetProjectId = queryString(query.targetProjectId);
  if (scope === undefined) {
    if (requireExact) throw new Error("target必须是personal或project");
    return [{ type: "personal" }, { type: "project", projectId: currentProjectId }];
  }
  if (scope === "personal") {
    if (targetProjectId !== undefined) throw new Error("Personal Target不能包含targetProjectId");
    return [{ type: "personal" }];
  }
  if (scope !== "project") throw new Error("target必须是personal或project");
  const projectId = targetProjectId ?? currentProjectId;
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("targetProjectId无效");
  return [{ type: "project", projectId }];
}

export function promptResourceHttpError(error: unknown): {
  readonly statusCode: number;
  readonly statusMessage: string;
} {
  if (error instanceof PromptResourceNotFoundError) {
    return { statusCode: 404, statusMessage: error.message };
  }
  if (error instanceof Error && error.message.startsWith("找不到")) {
    return { statusCode: 404, statusMessage: error.message };
  }
  if (error instanceof PromptResourceConflictError) {
    return { statusCode: 409, statusMessage: error.message };
  }
  if (error instanceof Error && (
    error.message.includes("必须")
    || error.message.includes("无效")
    || error.message.includes("格式")
    || error.message.includes("不能")
    || error.message.includes("尚未登记")
  )) {
    return { statusCode: 400, statusMessage: error.message };
  }
  return {
    statusCode: 500,
    statusMessage: error instanceof Error ? error.message : String(error),
  };
}
