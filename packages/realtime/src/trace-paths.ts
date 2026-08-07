import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Trace文件位置约定（任务书§7.2）：
 *   <repoRoot>/.data/traces/chat-trace-YYYY-MM-DD.jsonl
 * .data/已在.gitignore中排除，不进入Git。
 */

/** 从startDir向上查找包含pnpm-workspace.yaml的仓库根。 */
export function findRepoRoot(startDir: string): string {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`无法从 ${startDir} 向上找到仓库根（pnpm-workspace.yaml）`);
    }
    current = parent;
  }
}

/** Trace目录：优先显式参数，其次CHAT_TRACE_DIR，最后仓库根下的.data/traces。 */
export function resolveTraceDir(options?: { dir?: string; cwd?: string }): string {
  if (options?.dir) return resolve(options.dir);
  if (process.env.CHAT_TRACE_DIR) return resolve(process.env.CHAT_TRACE_DIR);
  return join(findRepoRoot(options?.cwd ?? process.cwd()), ".data", "traces");
}

/** 按UTC日期生成Trace文件名。 */
export function traceFileName(date: Date): string {
  return `chat-trace-${date.toISOString().slice(0, 10)}.jsonl`;
}

export const TRACE_FILE_PATTERN = /^chat-trace-\d{4}-\d{2}-\d{2}\.jsonl$/;
