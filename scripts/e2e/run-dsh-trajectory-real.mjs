import { spawn } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: options.environment ?? process.env,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun();
      else
        rejectRun(new Error(`trajectory E2E failed exit=${String(code)} signal=${String(signal)}`));
    });
  });
}

await run(process.execPath, ["scripts/e2e/preflight-dsh-real.mjs", "--trajectory-only"]);
await run(
  pnpm,
  [
    "--filter",
    "@chat/dsh-web",
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.dsh-real.config.ts",
  ],
  { environment: { ...process.env, CHAT_DSH_E2E_MODE: "trajectory-only" } },
);
