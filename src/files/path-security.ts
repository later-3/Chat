import { realpathSync } from "node:fs";
import path from "node:path";

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

export function isFilePathAllowed(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    const windows = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = windows ? path.win32 : path;
    const separator = windows ? "\\" : path.sep;
    const normalizedTarget = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparableTarget = windows ? normalizedTarget.toLowerCase() : normalizedTarget;
    const comparableRoot = windows ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootPrefix = comparableRoot.endsWith(separator) ? comparableRoot : `${comparableRoot}${separator}`;
    if (comparableTarget === comparableRoot || comparableTarget.startsWith(rootPrefix)) return true;
  }
  return false;
}

export function isExistingFilePathAllowed(target: string, roots: Set<string>): boolean {
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    return false;
  }
  const realRoots = new Set<string>();
  for (const root of roots) {
    try {
      realRoots.add(realpathSync(root));
    } catch {
      // 已被删除的Session工作目录不再提供文件访问权限。
    }
  }
  return isFilePathAllowed(realTarget, realRoots);
}
