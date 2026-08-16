import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

import { dshWebEnvironment } from "../dsh/profile-runtime.mjs";
import { resolveCodeServerTemporaryParent } from "../workbench/fixed-code-server.mjs";

export function resolveDshRealDataRoot(root) {
  return resolve(root, ".data/e2e/dsh-real");
}

export function resolveDshRealWorkbenchFixtureRoot(root) {
  return join(resolveDshRealDataRoot(root), "workbench-fixture");
}

export function resolveDshRealWorkbenchRunRoot(root) {
  return join(resolveDshRealWorkbenchFixtureRoot(root), ".data/code-server");
}

/** Worktree共享固定发行缓存，但Workspace与运行状态严格留在本轮隔离fixture。 */
export function resolveDshRealSharedCacheRoot(root) {
  const repoRoot = resolve(root);
  try {
    const common = execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commonDirectory = resolve(repoRoot, common);
    if (!commonDirectory.endsWith("/.git")) throw new Error("unexpected git common dir");
    return join(resolve(commonDirectory, ".."), ".data/cache");
  } catch {
    return join(repoRoot, ".data/cache");
  }
}

/** 在DSH重写TMPDIR前冻结wrapper与reader共同信任的宿主临时目录。 */
export function resolveDshRealWorkbenchTempParent(environment = process.env) {
  return resolveCodeServerTemporaryParent(environment);
}

/** code-server wrapper不接收Provider、GitHub、SSH或DSH私有环境。 */
export function dshRealWorkbenchEnvironment(root, environment = process.env) {
  const fixtureRoot = resolveDshRealWorkbenchFixtureRoot(root);
  const safe = {};
  for (const name of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SHELL",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
  ]) {
    const value = environment[name];
    if (typeof value === "string" && value !== "") safe[name] = value;
  }
  return {
    ...safe,
    CHAT_REPO_ROOT: fixtureRoot,
    CHAT_CODE_WORKBENCH_ROOT: fixtureRoot,
    CHAT_CODE_WORKBENCH_RUN_ROOT: resolveDshRealWorkbenchRunRoot(root),
    CHAT_FIXED_SOURCE_CACHE_ROOT: resolveDshRealSharedCacheRoot(root),
    CHAT_CODE_WORKBENCH_TEMP_PARENT: resolveDshRealWorkbenchTempParent(environment),
  };
}

/**
 * E2E只改变受管DSH投影的位置，环境来源仍统一经过正式dshWebEnvironment白名单。
 * Workflow/API保留Provider配置；DSH Host及其插件只能看到基础工具链和桥接地址。
 */
export function dshRealWebEnvironment(root, environment = process.env) {
  const repoRoot = resolve(root);
  const dataRoot = resolveDshRealDataRoot(repoRoot);
  const dshHome = join(dataRoot, "dsh-home");
  const safe = dshWebEnvironment(repoRoot, {
    ...environment,
    CHAT_API_BASE_URL: "http://127.0.0.1:43111",
    CHAT_DSH_STATE_PATH: join(dataRoot, "bridge", "state.json"),
  });
  const hostHome = join(dshHome, "host-home");
  const temporary = join(dshHome, "tmp");
  return {
    ...safe,
    HOME: hostHome,
    USERPROFILE: hostHome,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: join(dshHome, "xdg-config"),
    XDG_CACHE_HOME: join(dshHome, "xdg-cache"),
    DSH_HOME: dshHome,
    CHAT_CODE_WORKBENCH_TEMP_PARENT: resolveDshRealWorkbenchTempParent(environment),
    CHAT_FIXED_SOURCE_CACHE_ROOT: resolveDshRealSharedCacheRoot(root),
  };
}
