import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  deterministicBrowserProcessEnvironment,
  managedDshE2eTemporaryRoot,
} from "./dsh-real-environment.mjs";

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
  "capability-governance": {
    preflight: ["--capability-governance-only"],
    environment: "capability-governance-only",
  },
  "planning-faux": {
    preflight: ["--planning-faux-only"],
    environment: "planning-faux-only",
  },
});
const modeDataRoots = Object.freeze({
  "prompt-three-gates": ".data/e2e/dsh-prompt-three-gates-real",
  "capability-governance": ".data/e2e/dsh-capability-governance-real",
  "planning-faux": ".data/e2e/dsh-planning-faux-real",
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
const paidMode = modeName === "planning" || modeName === "prompt-three-gates";
const dataRoot = resolve(repoRoot, modeDataRoots[modeName] ?? ".data/e2e/dsh-real");
const browserTempMarker = resolve(dataRoot, "browser-temp-root.txt");
const browserTemporary =
  !paidMode && existsSync(browserTempMarker)
    ? readFileSync(browserTempMarker, "utf8").trim()
    : undefined;
if (!paidMode && browserTemporary === undefined) {
  throw new Error("确定性Browser E2E缺少受管短临时目录标记");
}
if (browserTemporary !== undefined && !managedDshE2eTemporaryRoot(browserTemporary)) {
  throw new Error("Browser E2E临时目录标记不在受管系统临时根");
}
try {
  const toolHome = process.env.HOME?.trim();
  if (!paidMode && (toolHome === undefined || toolHome === "")) {
    throw new Error("确定性Browser父进程缺少本地工具链HOME");
  }
  // Playwright会把webServer.env与自己的环境合并。因此确定性门必须连Playwright
  // 父进程也从白名单启动；否则SSH/Provider变量会在配置看似安全时重新渗入child。
  const playwrightEnvironment = paidMode
    ? process.env
    : {
        ...deterministicBrowserProcessEnvironment(process.env),
        HOME: resolve(dataRoot, "process-home"),
        USERPROFILE: resolve(dataRoot, "process-home"),
        TMPDIR: browserTemporary ?? resolve(dataRoot, "process-tmp"),
        TMP: browserTemporary ?? resolve(dataRoot, "process-tmp"),
        TEMP: browserTemporary ?? resolve(dataRoot, "process-tmp"),
        COREPACK_HOME:
          process.env.COREPACK_HOME?.trim() || resolve(toolHome, ".cache/node/corepack"),
        npm_config_store_dir:
          process.env.npm_config_store_dir?.trim() ||
          (process.platform === "darwin"
            ? resolve(toolHome, "Library/pnpm/store/v10")
            : resolve(toolHome, ".local/share/pnpm/store/v10")),
        PLAYWRIGHT_BROWSERS_PATH:
          process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ||
          (process.platform === "darwin"
            ? resolve(toolHome, "Library/Caches/ms-playwright")
            : resolve(toolHome, ".cache/ms-playwright")),
        ...(mode.environment === undefined ? {} : { CHAT_DSH_E2E_MODE: mode.environment }),
        ...(browserTemporary === undefined
          ? {}
          : {
              CHAT_DSH_E2E_TEMP_ROOT: browserTemporary,
              CHAT_DSH_E2E_TEMP_PARENT: dirname(browserTemporary),
            }),
      };
  run(
    process.execPath,
    [
      resolve(repoRoot, "apps/dsh-web/node_modules/@playwright/test/cli.js"),
      "test",
      "--config",
      resolve(repoRoot, "apps/dsh-web/playwright.dsh-real.config.ts"),
    ],
    playwrightEnvironment,
  );
} finally {
  if (browserTemporary !== undefined) {
    rmSync(browserTemporary, { recursive: true, force: true });
    rmSync(browserTempMarker, { force: true });
  }
}
