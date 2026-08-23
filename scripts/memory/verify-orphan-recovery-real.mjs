import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { describeProcess, findListenerPid, isEffectivelyAlive } from "../debug/lib.mjs";
import { resolveSharedFixedCacheRoot } from "../dev/app-runtime.mjs";
import {
  FIXED_MEMMY_COMMIT,
  fixedMemmyCacheRoot,
  fixedMemmyServerEntry,
  validateFixedMemmyCache,
} from "./fixed-memmy.mjs";
import {
  createMemorySidecarContract,
  isProcessGroupAlive,
  processGroupId,
  readMemoryProcessEvidence,
  reconcileManagedMemorySidecar,
  signalProcessGroup,
} from "./process-lifecycle.mjs";

const root = resolve(import.meta.dirname, "../..");
const port = 19_960;
const cacheRoot = resolveSharedFixedCacheRoot(root, process.env);
const environment = { ...process.env, CHAT_FIXED_SOURCE_CACHE_ROOT: cacheRoot };
if (!validateFixedMemmyCache(root, environment)) {
  throw new Error("真实孤儿回收门需要先准备固定memmy缓存");
}
if (findListenerPid(port) !== null) {
  throw new Error(`debug隔离端口${String(port)}已占用；真实门零signal退出`);
}

const testParent = join(root, ".data", "tests");
mkdirSync(testParent, { recursive: true });
const runRoot = mkdtempSync(join(testParent, "memory-orphan-recovery-"));
const serverEntry = fixedMemmyServerEntry(root, environment);
const contract = createMemorySidecarContract({
  root,
  provider: "memmy",
  runtimeInstance: "debug",
  sourceCommit: FIXED_MEMMY_COMMIT,
  port,
  runRoot,
  childCwd: fixedMemmyCacheRoot(root, environment),
  commandFragments: [
    serverEntry,
    "--port",
    String(port),
    "--db",
    join(runRoot, "memory.sqlite"),
    "--config",
    join(runRoot, "config.json"),
  ],
});

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitUntil(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`${label}超时`);
}

let wrapper;
let childPid;
try {
  wrapper = spawn(process.execPath, [join(root, "scripts/memory/start-fixed-memmy.mjs")], {
    cwd: root,
    stdio: "ignore",
    env: {
      ...environment,
      CHAT_REPO_ROOT: root,
      CHAT_RUNTIME_INSTANCE: "debug",
      CHAT_MEMMY_PORT: String(port),
      CHAT_MEMMY_RUN_ROOT: runRoot,
      CHAT_MEMMY_DB_PATH: join(runRoot, "memory.sqlite"),
    },
  });
  await waitUntil(() => {
    const evidence = readMemoryProcessEvidence(contract);
    if (evidence?.status !== "running") return false;
    childPid = evidence.childPid;
    return findListenerPid(port) === childPid;
  }, "固定memmy wrapper ready");

  wrapper.kill("SIGKILL");
  await new Promise((resolveExit) => wrapper.once("exit", resolveExit));
  assert.equal(isEffectivelyAlive(wrapper.pid), false);
  assert.equal(isEffectivelyAlive(childPid), true);
  assert.equal(processGroupId(childPid), childPid);
  assert.equal(findListenerPid(port), childPid);

  const result = reconcileManagedMemorySidecar(contract);
  assert.ok(["terminated", "killed"].includes(result.action));
  assert.equal(findListenerPid(port), null);
  assert.equal(isProcessGroupAlive(childPid), false);
  assert.equal(readMemoryProcessEvidence(contract).status, "stopped");
  console.log(
    `[memory-orphan-real] wrapper=SIGKILL childGroup=${String(childPid)} recovery=${result.action} port=${String(port)} free`,
  );
} finally {
  if (wrapper?.pid !== undefined && isEffectivelyAlive(wrapper.pid)) wrapper.kill("SIGKILL");
  if (
    Number.isInteger(childPid) &&
    processGroupId(childPid) === childPid &&
    describeProcess(childPid)?.command.includes(serverEntry)
  ) {
    try {
      signalProcessGroup(childPid, "SIGKILL");
    } catch {
      // 已退出。
    }
  }
  await delay(100);
  rmSync(runRoot, { recursive: true, force: true });
}
