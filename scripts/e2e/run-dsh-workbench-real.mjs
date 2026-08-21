import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  cleanupDshRealWorkbench,
  waitForDshRealPortsReleased,
} from "./dsh-real-workbench-lifecycle.mjs";
import { assertDshRealTerminalCanaryStopped } from "./dsh-real-terminal-canary.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
let activeChild;
let forwardedSignal;

function run(command, args, { environment = process.env, label }) {
  return new Promise((resolveRun, rejectRun) => {
    if (forwardedSignal !== undefined) {
      rejectRun(new Error(`${label}未启动：已收到${forwardedSignal}`));
      return;
    }
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: environment,
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", (error) => {
      activeChild = undefined;
      rejectRun(new Error(`${label}无法启动：${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      activeChild = undefined;
      if (code === 0) resolveRun();
      else {
        rejectRun(
          new Error(
            `${label}失败：exit=${String(code)} signal=${String(signal ?? forwardedSignal ?? "none")}`,
          ),
        );
      }
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    forwardedSignal = signal;
    activeChild?.kill(signal);
  });
}

let primaryFailure;
try {
  await run(process.execPath, ["scripts/e2e/preflight-dsh-real.mjs", "--workbench-only"], {
    label: "Workbench-only preflight",
  });
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
    {
      label: "Workbench-only Playwright",
      environment: { ...process.env, CHAT_DSH_E2E_MODE: "workbench-only" },
    },
  );
} catch (error) {
  primaryFailure = error;
} finally {
  let cleanupFailure;
  try {
    // Playwright CLI退出意味着全部webServer监督器已经停止。再次调用正式reconcile是
    // 必要的幂等收口，不以globalTeardown是否有机会运行作为假设。
    const cleanup = await cleanupDshRealWorkbench(repoRoot, { environment: process.env });
    const terminal = assertDshRealTerminalCanaryStopped(repoRoot);
    const ports = await waitForDshRealPortsReleased();
    console.log(
      `[e2e-finally] Workbench=${cleanup.action} Terminal=${terminal?.pid ?? "none"} stopped ports=${ports.join(",")} free`,
    );
  } catch (error) {
    cleanupFailure = error;
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([primaryFailure, cleanupFailure], "Workbench E2E与正式清理均失败");
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

if (primaryFailure !== undefined) throw primaryFailure;
if (forwardedSignal !== undefined) {
  throw new Error(`Workbench E2E收到${forwardedSignal}并已完成受管清理`);
}
