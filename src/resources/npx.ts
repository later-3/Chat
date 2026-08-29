import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Executes npx with an argument array so user input never passes through a shell. */
export async function runNpx(
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) {
  return execFileAsync("npx", [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    timeout: options.timeoutMs,
    maxBuffer: 2_000_000,
    env: options.env ?? process.env,
  });
}
