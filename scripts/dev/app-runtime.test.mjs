import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AppSupervisor,
  createServiceDefinitions,
  parseDevArgs,
  runPreparationCommand,
  sharedCacheRootFromGitCommonDir,
  waitForServiceReady,
} from "./app-runtime.mjs";
import {
  cleanupOwnedDebugBrowser,
  debugBrowserProfileRoot,
  isOwnedDebugBrowserCommand,
  ownedDebugBrowserPidsFromPsOutput,
} from "./browser-lifecycle.mjs";

const ROOT = "/workspace/chat";

test("参数默认启动两套Memory，debug模式显式开启", () => {
  assert.deepEqual(parseDevArgs([]), { debug: false, help: false, memory: "all" });
  assert.deepEqual(parseDevArgs(["--debug", "--memory=memmy"]), {
    debug: true,
    help: false,
    memory: "memmy",
  });
  assert.throws(() => parseDevArgs(["--memory=unknown"]), /只支持/u);
});

test("服务图按Memory -> Workflow -> API -> Web排序", () => {
  const all = createServiceDefinitions({ root: ROOT, memory: "all", environment: {} });
  assert.deepEqual(
    all.map((service) => service.id),
    ["memmy", "memorycore", "workflow", "api", "web"],
  );
  const memmy = createServiceDefinitions({ root: ROOT, memory: "memmy", environment: {} });
  assert.deepEqual(
    memmy.map((service) => service.id),
    ["memmy", "workflow", "api", "web"],
  );
});

test("debug只为Chat拥有的API与Workflow开放Inspector", () => {
  const services = createServiceDefinitions({
    root: ROOT,
    debug: true,
    memory: "all",
    environment: {},
  });
  const args = Object.fromEntries(services.map((service) => [service.id, service.args.join(" ")]));
  assert.match(args.workflow, /--inspect=127\.0\.0\.1:43121/u);
  assert.match(args.api, /--inspect=127\.0\.0\.1:43120/u);
  assert.doesNotMatch(args.memmy, /--inspect/u);
  assert.doesNotMatch(args.memorycore, /--inspect/u);
  assert.doesNotMatch(args.web, /--inspect/u);
});

test("同一Git仓库的worktree共享固定源码缓存", () => {
  assert.equal(
    sharedCacheRootFromGitCommonDir("/workspace/chat-feature", "/workspace/chat-main/.git"),
    "/workspace/chat-main/.data/cache",
  );
});

test("准备命令不继承VS Code自动附加环境", async () => {
  let receivedEnvironment;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  await runPreparationCommand({
    root: ROOT,
    environment: {
      NODE_OPTIONS: "--require /vscode/bootloader.js",
      VSCODE_INSPECTOR_OPTIONS: "attach-options",
    },
    spawnImpl(_command, _args, options) {
      receivedEnvironment = options.env;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.equal(receivedEnvironment.VSCODE_INSPECTOR_OPTIONS, undefined);
  assert.equal(receivedEnvironment.NODE_OPTIONS, undefined);
  assert.equal(receivedEnvironment.CHAT_REPO_ROOT, ROOT);
});

test("浏览器身份必须同时命中可执行文件与worktree专属profile", () => {
  const profile = debugBrowserProfileRoot(ROOT);
  const owned =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome " +
    `--user-data-dir=${profile} --remote-debugging-pipe`;
  assert.equal(isOwnedDebugBrowserCommand(owned, profile), true);
  assert.equal(
    isOwnedDebugBrowserCommand(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default",
      profile,
    ),
    false,
  );
  assert.equal(
    isOwnedDebugBrowserCommand(`node inspect.mjs --user-data-dir=${profile}`, profile),
    false,
  );
  assert.deepEqual(ownedDebugBrowserPidsFromPsOutput(`  42 ${owned}\n`, profile), [42]);
});

test("浏览器清理先收敛精确进程再删除悬空锁", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-debug-browser-"));
  try {
    const profile = debugBrowserProfileRoot(root);
    mkdirSync(profile, { recursive: true });
    symlinkSync("stale-host-123", join(profile, "SingletonLock"));
    writeFileSync(join(profile, "code.lock"), "123\n");
    let alive = [42];
    const signals = [];
    const result = await cleanupOwnedDebugBrowser(root, {
      findPids: () => alive,
      kill(pid, signal) {
        signals.push([pid, signal]);
        alive = [];
      },
      sleep: async () => {},
    });
    assert.deepEqual(signals, [[42, "SIGTERM"]]);
    assert.deepEqual(result.terminatedPids, [42]);
    assert.deepEqual(result.removedLocks.sort(), ["SingletonLock", "code.lock"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("就绪期限从服务自己的启动时刻计算", async () => {
  let now = 5_000;
  let attempts = 0;
  const elapsed = await waitForServiceReady({
    definition: { id: "service", readyUrl: "http://service/health", timeoutMs: 1_000 },
    state: {},
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("not ready");
      return { ok: true };
    },
  });
  assert.equal(elapsed, 500);
});

test("停止顺序与启动顺序相反", async () => {
  const stopped = [];
  const supervisor = new AppSupervisor([], { removePid: () => {} });
  supervisor.states = ["memory", "workflow", "api", "web"].map((id) => {
    const state = {
      definition: { id, role: id, stopTimeoutMs: 10 },
      child: undefined,
      expectedExit: false,
      exited: undefined,
      exitPromise: undefined,
      resolveExit: undefined,
    };
    state.child = {
      kill(signal) {
        stopped.push(`${id}:${signal}`);
        state.exited = { code: 0, signal };
        state.resolveExit();
      },
    };
    state.exitPromise = new Promise((resolveStateExit) => {
      state.resolveExit = resolveStateExit;
    });
    return state;
  });
  await supervisor.stop();
  assert.deepEqual(stopped, ["web:SIGTERM", "api:SIGTERM", "workflow:SIGTERM", "memory:SIGTERM"]);
});
