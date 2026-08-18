import { execFileSync } from "node:child_process";
import { lstatSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export const DEBUG_BROWSER_PROFILE_RELATIVE_PATH = ".data/debug/browser-profile";

const BROWSER_EXECUTABLE_PREFIXES = Object.freeze([
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
  "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
  "/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary",
]);

const PROFILE_LOCK_NAMES = Object.freeze([
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "code.lock",
]);

export function debugBrowserProfileRoot(root) {
  return resolve(root, DEBUG_BROWSER_PROFILE_RELATIVE_PATH);
}

/**
 * 只承认“浏览器可执行文件 + 本worktree精确user-data-dir”这两个条件同时成立。
 * 路径仅出现在其他进程的普通参数或日志中时绝不视为Chat拥有的浏览器。
 */
export function isOwnedDebugBrowserCommand(command, profileRoot) {
  const trimmed = command.trimStart();
  if (
    !BROWSER_EXECUTABLE_PREFIXES.some(
      (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `),
    )
  ) {
    return false;
  }
  const profile = resolve(profileRoot);
  return [
    `--user-data-dir=${profile}`,
    `--user-data-dir="${profile}"`,
    `--user-data-dir='${profile}'`,
    `--user-data-dir ${profile}`,
    `--user-data-dir "${profile}"`,
    `--user-data-dir '${profile}'`,
  ].some((argument) => command.includes(argument));
}

export function ownedDebugBrowserPidsFromPsOutput(output, profileRoot) {
  const pids = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (match === null || !isOwnedDebugBrowserCommand(match[2], profileRoot)) continue;
    pids.push(Number.parseInt(match[1], 10));
  }
  return [...new Set(pids)];
}

export function findOwnedDebugBrowserPids(profileRoot) {
  const output = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return ownedDebugBrowserPidsFromPsOutput(output, profileRoot);
}

export function removeDebugBrowserLocks(profileRoot) {
  const removed = [];
  for (const name of PROFILE_LOCK_NAMES) {
    const path = join(profileRoot, name);
    try {
      // lstat能识别目标已经消失的SingletonLock/SingletonSocket悬空软链接。
      lstatSync(path);
      rmSync(path, { force: true });
      removed.push(name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}

async function waitForNoOwnedBrowser(findPids, timeoutMs, sleep) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = findPids();
    if (remaining.length === 0) return [];
    if (Date.now() >= deadline) return remaining;
    await sleep(100);
  }
}

/**
 * 收敛上一次js-debug遗留的Chat专属浏览器。日常Chrome没有本worktree的
 * user-data-dir参数，因此不会进入候选集；身份在SIGKILL前会通过findPids再次复核。
 */
export async function cleanupOwnedDebugBrowser(
  root,
  {
    profileRoot = debugBrowserProfileRoot(root),
    findPids,
    kill = (pid, signal) => process.kill(pid, signal),
    sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
  } = {},
) {
  const findOwned = findPids ?? (() => findOwnedDebugBrowserPids(profileRoot));
  const initialPids = findOwned();
  for (const pid of initialPids) {
    try {
      kill(pid, "SIGTERM");
    } catch {
      // 进程可能已经自行退出；后续仍以精确身份扫描为准。
    }
  }

  let remaining = await waitForNoOwnedBrowser(findOwned, 2_000, sleep);
  for (const pid of remaining) {
    // remaining来自最新精确身份扫描，避免PID复用后误杀其他进程。
    try {
      kill(pid, "SIGKILL");
    } catch {
      // 进程可能已经自行退出；最终扫描负责判定是否收敛。
    }
  }
  remaining = await waitForNoOwnedBrowser(findOwned, 1_500, sleep);
  if (remaining.length > 0) {
    throw new Error(`Chat专属调试浏览器无法停止（count=${remaining.length}）`);
  }

  const removedLocks = removeDebugBrowserLocks(profileRoot);
  return { terminatedPids: initialPids, removedLocks, profileRoot };
}
