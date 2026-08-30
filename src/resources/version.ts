import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export interface FileResourceVersion {
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly modifiedAt: string;
  readonly contentHash?: string;
}

export async function describeResourceVersion(path: string): Promise<FileResourceVersion | null> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      return { kind: "directory", size: info.size, modifiedAt: info.mtime.toISOString() };
    }
    if (!info.isFile()) return null;
    const content = await readFile(path);
    return {
      kind: "file",
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function qualifiedResourceAddress(options: {
  readonly kind: "skill" | "extension" | "prompt" | "tool";
  readonly id: string;
  readonly scope: string;
  readonly projectId?: string;
  readonly workflowId?: string;
  readonly agentId?: string;
}): string {
  const owner = options.scope === "user" || options.scope === "global"
    ? "personal"
    : options.scope === "project" && options.projectId !== undefined
      ? `project/${options.projectId}`
      : options.workflowId !== undefined && options.agentId !== undefined
        ? `workflow/${options.workflowId}/${options.agentId}`
        : "runtime";
  return `${owner}:${options.kind}/${encodeURIComponent(options.id)}`;
}
