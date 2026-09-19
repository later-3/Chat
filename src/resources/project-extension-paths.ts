import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Convention directories are optional; explicit Settings/Agent paths remain Pi-validated. */
export async function projectExtensionPaths(configDir: string): Promise<string[]> {
  const path = resolve(configDir, "extensions");
  try {
    const info = await stat(path);
    // Pi treats an explicit empty directory as a module path. Convention roots
    // are created eagerly for Friends, so do not feed empty roots to that path.
    if (info.isDirectory() && (await readdir(path)).length === 0) return [];
    return [path];
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
