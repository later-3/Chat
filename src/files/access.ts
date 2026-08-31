import { listProjects } from "../projects/registry.js";
export {
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "./path-security.js";

const additionalRoots = new Set<string>();

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** Project经过`/api/projects/open`登记后，其根目录才会加入浏览范围。 */
export function allowFileRoot(root: string): void {
  additionalRoots.add(normalizeSlashes(root));
}

export async function getAllowedFileRoots(chatHome?: string): Promise<Set<string>> {
  const roots = new Set<string>(additionalRoots);
  for (const project of await listProjects(chatHome)) {
    if (project.available) roots.add(normalizeSlashes(project.path));
  }
  return roots;
}
