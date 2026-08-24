import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const modes = Object.freeze({
  planning: { preflight: [], environment: undefined },
  workbench: { preflight: ["--workbench-only"], environment: "workbench-only" },
  pwa: { preflight: ["--pwa-only"], environment: "pwa-only" },
  trajectory: { preflight: ["--trajectory-only"], environment: "trajectory-only" },
  "prompt-studio": {
    preflight: ["--prompt-studio-only"],
    environment: "prompt-studio-only",
  },
  "prompt-three-gates": {
    preflight: ["--prompt-three-gates-only"],
    environment: "prompt-three-gates-only",
  },
  "project-bootstrap": {
    preflight: ["--project-bootstrap-only"],
    environment: "project-bootstrap-only",
  },
  "capability-governance": {
    preflight: ["--capability-governance-only"],
    environment: "capability-governance-only",
  },
});

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: repoRoot, env: environment, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}失败`);
}

const modeName = process.argv[2];
const mode = modes[modeName];
if (mode === undefined) throw new Error(`未知DSH Playwright mode：${String(modeName)}`);

run(process.execPath, [resolve(repoRoot, "scripts/e2e/preflight-dsh-real.mjs"), ...mode.preflight]);
run(
  "pnpm",
  [
    "--filter",
    "@chat/dsh-web",
    "exec",
    ...(mode.environment === undefined ? [] : ["env", `CHAT_DSH_E2E_MODE=${mode.environment}`]),
    "playwright",
    "test",
    "--config",
    "playwright.dsh-real.config.ts",
  ],
  process.env,
);
