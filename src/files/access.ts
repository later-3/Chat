import { listProjects } from "../projects/registry.js";
export {
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "./path-security.js";

const additionalRoots = new Set<string>();
const cachedByChatHome = new Map<string, { roots: Set<string>; expiresAt: number }>();

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** 工作目录经过`/api/cwd/validate`验证后，才会加入浏览范围。 */
export function allowFileRoot(root: string): void {
  additionalRoots.add(normalizeSlashes(root));
  for (const cached of cachedByChatHome.values()) cached.roots.add(normalizeSlashes(root));
}

export async function getAllowedFileRoots(chatHome?: string): Promise<Set<string>> {
  const cacheKey = chatHome ?? "<default>";
  const now = Date.now();
  const cached = cachedByChatHome.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.roots;
  const roots = new Set<string>([normalizeSlashes(process.cwd()), ...additionalRoots]);
  for (const project of await listProjects(chatHome)) {
    if (project.available) roots.add(normalizeSlashes(project.path));
  }
  cachedByChatHome.set(cacheKey, { roots, expiresAt: now + 5_000 });
  return roots;
}
