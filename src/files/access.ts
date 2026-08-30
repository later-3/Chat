import { listProjects } from "../projects/registry.js";
export {
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "./path-security.js";

const additionalRoots = new Set<string>();
let cached: { roots: Set<string>; expiresAt: number } | undefined;

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** 工作目录经过`/api/cwd/validate`验证后，才会加入浏览范围。 */
export function allowFileRoot(root: string): void {
  additionalRoots.add(normalizeSlashes(root));
  cached?.roots.add(normalizeSlashes(root));
}

export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.roots;
  const roots = new Set<string>([normalizeSlashes(process.cwd()), ...additionalRoots]);
  for (const project of await listProjects()) {
    if (project.available) roots.add(normalizeSlashes(project.path));
  }
  cached = { roots, expiresAt: now + 5_000 };
  return roots;
}
