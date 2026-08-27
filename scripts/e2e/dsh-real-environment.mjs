import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { dshWebEnvironment } from "../dsh/profile-runtime.mjs";
import { resolveCodeServerTemporaryParent } from "../workbench/fixed-code-server.mjs";

export const DSH_BROWSER_FORBIDDEN_ENV_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "CHAT_DEBUG_PI_KEY_READER",
  "CHAT_DEBUG_PI_PROVIDER_CONFIG",
  "CHAT_MEMMY_TOKEN",
  "CHAT_PROJECT_MODEL_API_KEY_ENV",
  "CHAT_PROJECT_MODEL_BASE_URL",
  "CHAT_TENCENT_MEMORYCORE_TOKEN",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "GEMINI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "SSH_AUTH_SOCK",
]);

const DSH_BROWSER_HOST_ENV_NAMES = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SHELL",
  "TERM",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "COREPACK_HOME",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "npm_config_store_dir",
]);

/** 确定性Browser子进程从空对象开始，不继承宿主账号、Provider或外部写开关。 */
export function deterministicBrowserProcessEnvironment(environment = process.env) {
  const safe = Object.fromEntries(
    DSH_BROWSER_HOST_ENV_NAMES.flatMap((name) => {
      const value = environment[name];
      return typeof value === "string" && value !== "" ? [[name, value]] : [];
    }),
  );
  return {
    ...safe,
    CI: "true",
    CHAT_ALLOW_EXTERNAL_WRITES: "0",
    CHAT_ALLOW_PAID_TESTS: "0",
    CHAT_ALLOW_UNKNOWN_EXTERNAL_SERVICES: "0",
    CHAT_CODE_WORKBENCH_ENABLED: "0",
    CHAT_MEMORY_ENABLED: "0",
    CHAT_MEMORY_REAL_TEST: "0",
  };
}

export function assertDeterministicBrowserEnvironment(environment) {
  const visible = DSH_BROWSER_FORBIDDEN_ENV_NAMES.filter(
    (name) => typeof environment[name] === "string" && environment[name].trim() !== "",
  );
  if (visible.length > 0)
    throw new Error(`确定性Browser子进程看到了禁止环境：${visible.join(",")}`);
  for (const [name, expected] of [
    ["CHAT_ALLOW_EXTERNAL_WRITES", "0"],
    ["CHAT_ALLOW_PAID_TESTS", "0"],
    ["CHAT_CODE_WORKBENCH_ENABLED", "0"],
    ["CHAT_MEMORY_ENABLED", "0"],
  ]) {
    if (environment[name] !== expected)
      throw new Error(`确定性Browser环境未冻结${name}=${expected}`);
  }
}

/**
 * 真实浏览器门拥有独立的45xxx端口族，绝不借用LaunchAgent production的431xx，
 * 也不与VS Code/CLI debug的441xx竞争。不同E2E Profile再按百位分组，允许失败关闭。
 */
export const DSH_PROMPT_STUDIO_E2E_PORTS = Object.freeze({
  web: 45_110,
  api: 45_111,
  workflowPlaceholder: 45_112,
  webInternal: 45_114,
  piExecutor: 45_115,
});

export const DSH_PROMPT_THREE_GATES_E2E_PORTS = Object.freeze({
  web: 45_210,
  api: 45_211,
  workflow: 45_212,
  webInternal: 45_214,
  piExecutor: 45_215,
});

/** Capability治理门：真实Workflow/API/Pi/DSH，仅Provider为进程内Faux。 */
export const DSH_CAPABILITY_GOVERNANCE_E2E_PORTS = Object.freeze({
  web: 45_510,
  api: 45_511,
  workflow: 45_512,
  webInternal: 45_514,
  piExecutor: 45_515,
  piControl: 45_516,
});

/** Planning浏览器门：真实API/Product Store/Workflow/pi loop，仅模型流为进程内Faux。 */
export const DSH_PLANNING_FAUX_E2E_PORTS = Object.freeze({
  web: 45_610,
  api: 45_611,
  workflow: 45_612,
  webInternal: 45_614,
  piExecutor: 45_615,
});

export const DSH_REAL_E2E_PORTS = Object.freeze({
  web: 45_310,
  api: 45_311,
  workflow: 45_312,
  webInternal: 45_314,
  piExecutor: 45_315,
  workbenchLease: 45_319,
});

export function resolveDshRealDataRoot(root, environment = process.env) {
  const repoRoot = resolve(root);
  const configured = environment.CHAT_DSH_E2E_DATA_ROOT?.trim();
  const dataRoot = resolve(repoRoot, configured || ".data/e2e/dsh-real");
  const allowed = new Set([
    resolve(repoRoot, ".data/e2e/dsh-real"),
    resolve(repoRoot, ".data/e2e/dsh-prompt-three-gates-real"),
    resolve(repoRoot, ".data/e2e/dsh-capability-governance-real"),
    resolve(repoRoot, ".data/e2e/dsh-planning-faux-real"),
  ]);
  if (!allowed.has(dataRoot)) {
    throw new Error("CHAT_DSH_E2E_DATA_ROOT只能指向受管的DSH E2E数据目录");
  }
  return dataRoot;
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
    CHAT_CODE_WORKBENCH_LEASE_PORT: String(DSH_REAL_E2E_PORTS.workbenchLease),
  };
}

/**
 * E2E只改变受管DSH投影的位置，环境来源仍统一经过正式dshWebEnvironment白名单。
 * Workflow/API保留Provider配置；DSH Host及其插件只能看到基础工具链和桥接地址。
 */
export function dshRealWebEnvironment(root, environment = process.env) {
  const repoRoot = resolve(root);
  const dataRoot = resolveDshRealDataRoot(repoRoot, environment);
  const dshHome = join(dataRoot, "dsh-home");
  const safe = dshWebEnvironment(repoRoot, {
    ...environment,
    CHAT_API_BASE_URL:
      environment.CHAT_API_BASE_URL?.trim() || `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.api)}`,
    CHAT_PUBLIC_WEB_PORT:
      environment.CHAT_PUBLIC_WEB_PORT?.trim() || String(DSH_REAL_E2E_PORTS.web),
    CHAT_DSH_INTERNAL_WEB_PORT:
      environment.CHAT_DSH_INTERNAL_WEB_PORT?.trim() || String(DSH_REAL_E2E_PORTS.webInternal),
    CHAT_DSH_STATE_PATH: join(dataRoot, "bridge", "state.json"),
  });
  const hostHome = join(dshHome, "host-home");
  const configuredTemporary = environment.CHAT_DSH_E2E_TEMP_ROOT?.trim();
  const temporary =
    configuredTemporary === undefined || configuredTemporary === ""
      ? join(dshHome, "tmp")
      : resolve(repoRoot, configuredTemporary);
  if (
    configuredTemporary !== undefined &&
    configuredTemporary !== "" &&
    ![
      resolve(repoRoot, ".data/e2e/dsh-t3-tmp"),
      resolve(repoRoot, ".data/e2e/dsh-cap-tmp"),
    ].includes(temporary) &&
    !managedDshE2eTemporaryRoot(temporary, environment.CHAT_DSH_E2E_TEMP_PARENT?.trim() || tmpdir())
  ) {
    throw new Error("CHAT_DSH_E2E_TEMP_ROOT只能指向受管的DSH E2E短临时目录");
  }
  return {
    ...safe,
    // 子进程启动器会再次执行同一受管目录校验；必须把已经校验过的根显式传下去，
    // 否则三闸门模式会退回默认 dsh-real，并与下方 DSH_HOME 产生假冲突。
    CHAT_DSH_E2E_DATA_ROOT: dataRoot,
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
    ...(configuredTemporary === undefined || configuredTemporary === ""
      ? {}
      : {
          CHAT_DSH_E2E_TEMP_ROOT: temporary,
          // 嵌套监督器会再次调用本函数；父目录证明必须与临时根一起传递，
          // 不能让node:os.tmpdir()在已重写TMPDIR后把根自身误当成父目录。
          CHAT_DSH_E2E_TEMP_PARENT: dirname(temporary),
        }),
  };
}

/**
 * Browser lane进程使用系统短临时根，避免长worktree路径令tsx的Unix socket
 * 超过平台上限。目录名与直接父目录都必须精确受管，防止清理逃逸。
 */
export function managedDshE2eTemporaryRoot(path, temporaryParent = tmpdir()) {
  const resolved = resolve(path);
  const parent = resolve(temporaryParent);
  return (
    resolved.startsWith(`${parent}/chat-dsh-e2e-`) &&
    !resolved.slice(parent.length + 1).includes("/")
  );
}

/** @deprecated 仅保留给旧调用方；新Browser lane统一使用通用名称。 */
export const planningE2eTemporaryRoot = managedDshE2eTemporaryRoot;
