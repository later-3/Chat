import { realpath, stat } from "node:fs/promises";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../files/access.js";

export class ResourceAccessError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

/** Resolves a browser-provided working directory and checks Chat's file roots. */
export async function resolveResourceCwd(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ResourceAccessError(400, "cwd必须是非空字符串");
  }
  let cwd: string;
  try {
    cwd = await realpath(value);
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd不是目录");
  } catch (error) {
    throw new ResourceAccessError(400, error instanceof Error ? error.message : String(error));
  }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
    throw new ResourceAccessError(403, "Access denied");
  }
  return cwd;
}
