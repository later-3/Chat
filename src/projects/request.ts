import { openProject, resolveProjectContext } from "./registry.js";
import type { ChatProjectContext } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves Project identity once at the HTTP boundary; cwd-only input is migration compatibility. */
export async function resolveRequestProject(
  body: unknown,
  defaultProjectRoot: string,
): Promise<ChatProjectContext> {
  const value = isRecord(body) ? body : {};
  if (typeof value.projectId === "string" && value.projectId.trim() !== "") {
    const context = await resolveProjectContext(value.projectId.trim());
    if (typeof value.cwd === "string" && value.cwd.trim() !== "" && value.cwd !== context.cwd) {
      throw new Error(`Project ${context.projectId}与cwd不一致`);
    }
    return context;
  }
  const path = typeof value.cwd === "string" && value.cwd.trim() !== ""
    ? value.cwd
    : defaultProjectRoot;
  return openProject({ path });
}
