import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { assertChatDataPath, createSafeChildProcessEnvironment } from "../memory/fixed-memmy.mjs";
import { describeProcess } from "../debug/lib.mjs";
import {
  CODE_SERVER_PROCESS_EVIDENCE_SCHEMA,
  CODE_SERVER_SOCKET_NAME,
  DISABLED_EXTENSIONS_GALLERY,
  FIXED_CODE_SERVER_VERSION,
  acquireCodeServerPrepareLease,
  chatRepoRoot,
  codeServerProcessEvidencePath,
  codeServerRunRoot,
  createShortCodeServerTemporaryRoot,
  createShortUserDataLink,
  fixedCodeServerCacheRoot,
  fixedCodeServerExecutable,
  mergeManagedCodeServerSettings,
  prepareIsolatedShellHome,
  resolveCodeServerTemporaryParent,
  validateFixedCodeServerCache,
  writeCodeServerStoppedTombstone,
} from "./fixed-code-server.mjs";

const repoRoot = chatRepoRoot();
const managedRepoRoot = realpathSync(repoRoot);
const configuredWorkspace = resolve(process.env.CHAT_CODE_WORKBENCH_ROOT ?? repoRoot);
if (!existsSync(configuredWorkspace) || !statSync(configuredWorkspace).isDirectory()) {
  throw new Error("CHAT_CODE_WORKBENCH_ROOT 必须指向服务端已存在的目录");
}
const workspaceRoot = realpathSync(configuredWorkspace);
if (workspaceRoot !== managedRepoRoot) {
  throw new Error("code-server Workspace必须精确等于CHAT_REPO_ROOT，拒绝映射其他目录");
}
process.chdir(workspaceRoot);

if (!validateFixedCodeServerCache(repoRoot)) {
  throw new Error(
    "固定 code-server 缓存未准备或证据损坏；请先运行 pnpm workbench:prepare:code-server",
  );
}

// 43119只是一把由内核回收的进程租约：收到任何TCP连接都会立即断开，绝不提供HTTP、
// health或Workbench内容。它防止两个随机socket wrapper并发覆盖同一份evidence。
const serviceLease = await acquireCodeServerPrepareLease();

const runRoot = assertChatDataPath(codeServerRunRoot(repoRoot), repoRoot, "code-server运行目录");
const userDataRoot = resolve(runRoot, "user-data");
const extensionsRoot = resolve(runRoot, "extensions");
const environmentRoot = resolve(runRoot, "child-environment");
const settingsPath = resolve(userDataRoot, "User/settings.json");
mkdirSync(extensionsRoot, { recursive: true });
mergeManagedCodeServerSettings(settingsPath);

const shortTemporaryRoot = createShortCodeServerTemporaryRoot(
  resolveCodeServerTemporaryParent(process.env),
);
const socketPath = resolve(shortTemporaryRoot, CODE_SERVER_SOCKET_NAME);
const processEvidencePath = codeServerProcessEvidencePath(repoRoot);
const instanceId = randomUUID();
const cacheRoot = fixedCodeServerCacheRoot(repoRoot);
const wrapperStartedAt = new Date(
  describeProcess(process.pid)?.startedAtMs ?? Date.now(),
).toISOString();
let temporaryRootCleaned = false;
function cleanupTemporaryRoot() {
  if (temporaryRootCleaned) return;
  rmSync(shortTemporaryRoot, { recursive: true, force: true });
  temporaryRootCleaned = true;
}
function writeProcessEvidence(evidence) {
  const temporary = `${processEvidencePath}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, processEvidencePath);
}

let child;
let childStartedAt;
let stopping = false;
let hardStop;
let finalized = false;
process.once("SIGTERM", () => forward("SIGTERM"));
process.once("SIGINT", () => forward("SIGINT"));
writeProcessEvidence({
  schemaVersion: CODE_SERVER_PROCESS_EVIDENCE_SCHEMA,
  status: "starting",
  instanceId,
  wrapperPid: process.pid,
  childPid: null,
  privateRoot: shortTemporaryRoot,
  socketPath,
  version: FIXED_CODE_SERVER_VERSION,
  cacheRoot,
  workspaceRoot,
  wrapperStartedAt,
});
const shortUserDataRoot = createShortUserDataLink(shortTemporaryRoot, userDataRoot);
const childEnvironment = createSafeChildProcessEnvironment(
  environmentRoot,
  {
    SHELL: process.env.SHELL ?? "/bin/sh",
    TERM: process.env.TERM ?? "xterm-256color",
    TEMP: shortTemporaryRoot,
    TMP: shortTemporaryRoot,
    TMPDIR: shortTemporaryRoot,
    // 固定4.132.0会从product回退到Open VSX；空对象必须由Chat硬编码，不能继承parent。
    EXTENSIONS_GALLERY: DISABLED_EXTENSIONS_GALLERY,
  },
  process.env,
);
prepareIsolatedShellHome(childEnvironment.HOME);
const executable = fixedCodeServerExecutable(repoRoot);
child = spawn(
  executable,
  [
    "--socket",
    socketPath,
    "--socket-mode",
    "0600",
    "--auth",
    "none",
    "--disable-telemetry",
    "--disable-update-check",
    "--disable-getting-started-override",
    "--disable-proxy",
    "--ignore-last-opened",
    "--user-data-dir",
    shortUserDataRoot,
    "--extensions-dir",
    extensionsRoot,
    workspaceRoot,
  ],
  {
    cwd: workspaceRoot,
    env: childEnvironment,
    // 单独进程组让Terminal/Extension Host等后代可以随受管服务整体回收。
    // 这只是本地进程生命周期边界，不是文件系统或OS安全沙箱。
    detached: true,
    stdio: "inherit",
  },
);
if (child.pid === undefined) {
  await finalize(null, null, new Error("code-server 子进程没有可登记 PID"));
}
childStartedAt = new Date(describeProcess(child.pid)?.startedAtMs ?? Date.now()).toISOString();
writeProcessEvidence({
  schemaVersion: CODE_SERVER_PROCESS_EVIDENCE_SCHEMA,
  status: "running",
  instanceId,
  wrapperPid: process.pid,
  childPid: child.pid,
  privateRoot: shortTemporaryRoot,
  socketPath,
  version: FIXED_CODE_SERVER_VERSION,
  cacheRoot,
  workspaceRoot,
  wrapperStartedAt,
  childStartedAt,
});

function childProcessGroupIsAlive() {
  if (child?.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalChildProcessGroup(signal) {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

async function waitForChildProcessGroupExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && childProcessGroupIsAlive()) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return !childProcessGroupIsAlive();
}

function forward(signal) {
  if (stopping) return;
  stopping = true;
  if (child?.pid === undefined) {
    void finalize(null, signal, undefined);
    return;
  }
  signalChildProcessGroup(signal);
  hardStop = setTimeout(() => {
    signalChildProcessGroup("SIGKILL");
  }, 5_000);
}

async function finalize(code, signal, spawnError) {
  if (finalized) return;
  finalized = true;
  // launcher无论正常、受信号还是意外退出，都不等于PTY/Terminal后代已经退出。
  // 先等待，再按本轮独占process group升级SIGKILL；确认后才删除socket并写stopped，
  // 否则下次会把历史tombstone误当成“已安全回收”。
  const clean = await waitForChildProcessGroupExit(750);
  if (!clean) {
    signalChildProcessGroup("SIGKILL");
    await waitForChildProcessGroupExit(1_500);
  }
  if (hardStop !== undefined) clearTimeout(hardStop);
  const groupStillAlive = childProcessGroupIsAlive();
  let shutdownError;
  if (!groupStillAlive) {
    try {
      cleanupTemporaryRoot();
      if (existsSync(socketPath)) throw new Error("Unix socket清理后仍存在");
      // tombstone必须在线性化租约仍由本wrapper持有时发布；发布完成后新实例才可接管。
      writeCodeServerStoppedTombstone(processEvidencePath, {
        workspaceRoot,
        instanceId,
      });
    } catch (error) {
      shutdownError = error;
    }
  }
  await serviceLease.release();
  if (spawnError !== undefined) {
    console.error(`[code-server] 子进程启动失败：${spawnError.message}`);
  }
  if (!stopping && code !== 0) {
    console.error(`[code-server] 固定服务异常退出：${code === null ? signal : String(code)}`);
  }
  if (groupStillAlive) {
    console.error("[code-server] 受管进程组未完全退出；已保留完整running evidence供恢复");
  }
  if (shutdownError !== undefined) {
    console.error(
      `[code-server] stopped tombstone发布失败：${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`,
    );
  }
  process.exit(
    groupStillAlive || spawnError !== undefined || shutdownError !== undefined
      ? 1
      : (code ?? (stopping ? 0 : 1)),
  );
}

child.once("error", (error) => {
  void finalize(null, null, error);
});
child.once("close", (code, signal) => {
  void finalize(code, signal, undefined);
});
