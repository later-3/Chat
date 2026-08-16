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
  reclaimOwnedPortOccupants,
  runDshPreparationCommand,
  runPreparationCommand,
  runVersionRecoveryCommand,
  sharedCacheRootFromGitCommonDir,
  waitForServiceReady,
} from "./app-runtime.mjs";
import {
  findOwnedChatPortProcesses,
  findOwnedChatProcessForPort,
  roleForFrozenPort,
  sharedDebugDirFromGitCommonDir,
} from "../debug/lib.mjs";
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

test("Web角色使用受管DSH Node Host且私有Bridge状态不进入命令与探针", () => {
  const services = createServiceDefinitions({
    root: ROOT,
    memory: "all",
    environment: {
      CHAT_DSH_STATE_PATH: "/private/state.json",
      VSCODE_INSPECTOR_OPTIONS: "private-attach-options",
      NODE_OPTIONS: "--require /vscode/bootloader.js",
    },
  });
  const web = services.find((service) => service.id === "web");
  assert.equal(web.command, process.execPath);
  assert.deepEqual(web.args, ["/workspace/chat/scripts/dsh/start-web.mjs"]);
  assert.equal(web.cwd, ROOT);
  assert.equal(web.env.DSH_HOME, "/workspace/chat/.data/dsh-home");
  assert.equal(web.env.DSH_WEB_PORT, "43110");
  assert.equal(web.env.CHAT_API_BASE_URL, "http://127.0.0.1:43111");
  assert.equal(web.env.CHAT_DSH_STATE_PATH, "/private/state.json");
  assert.equal(web.stopTimeoutMs, 7_000);
  assert.equal(web.env.VSCODE_INSPECTOR_OPTIONS, undefined);
  assert.equal(web.env.NODE_OPTIONS, undefined);
  assert.doesNotMatch(`${web.args.join(" ")} ${web.readyUrl}`, /private|state\.json|43111/u);
});

test("同一Git仓库的worktree共享固定源码缓存", () => {
  assert.equal(
    sharedCacheRootFromGitCommonDir("/workspace/chat-feature", "/workspace/chat-main/.git"),
    "/workspace/chat-main/.data/cache",
  );
});

test("同一Git仓库的worktree共享固定端口PID登记", () => {
  assert.equal(
    sharedDebugDirFromGitCommonDir("/workspace/chat-feature", "/workspace/chat-main/.git"),
    "/workspace/chat-main/.data/debug",
  );
});

test("登记丢失时只识别同仓库且命令与固定端口角色匹配的Chat进程", () => {
  const descriptions = new Map([
    [
      52,
      {
        startedAtMs: Date.parse("2026-08-09T08:00:00.000Z"),
        command: "node /workspace/chat-feature/node_modules/tsx/loader.mjs src/index.ts",
      },
    ],
  ]);
  const dependencies = {
    describe: (pid) => descriptions.get(pid) ?? null,
    workingDirectory: () => "/workspace/chat-feature/apps/api",
    findParentPid: () => 1,
    findGitCommonDir: (path) =>
      path.startsWith("/workspace/chat") ? "/workspace/chat-main/.git" : null,
  };
  const owned = findOwnedChatProcessForPort(
    "/workspace/chat-main",
    { port: 43111, pid: 52 },
    dependencies,
  );
  assert.deepEqual(
    { role: owned?.role, pid: owned?.pid, killScope: owned?.killScope },
    { role: "api", pid: 52, killScope: "process" },
  );

  const foreign = findOwnedChatProcessForPort(
    "/workspace/chat-main",
    { port: 43111, pid: 52 },
    {
      ...dependencies,
      findGitCommonDir: (path) =>
        path === "/workspace/chat-main" ? "/workspace/chat-main/.git" : "/workspace/other/.git",
    },
  );
  assert.equal(foreign, null);

  const wrongCommand = findOwnedChatProcessForPort(
    "/workspace/chat-main",
    { port: 43111, pid: 52 },
    {
      ...dependencies,
      describe: () => ({
        startedAtMs: Date.parse("2026-08-09T08:00:00.000Z"),
        command: "node another-server.js",
      }),
    },
  );
  assert.equal(wrongCommand, null);
});

test("未知端口即使命中DSH wrapper签名也不参与自动回收", () => {
  assert.equal(roleForFrozenPort(43999), null);
  const owned = findOwnedChatProcessForPort(
    ROOT,
    { port: 43999, pid: 88 },
    {
      describe: () => ({
        startedAtMs: Date.parse("2026-08-09T08:00:00.000Z"),
        command: "node /workspace/chat/scripts/dsh/start-web.mjs",
      }),
      workingDirectory: () => ROOT,
      findParentPid: () => 1,
      findGitCommonDir: () => "/workspace/chat-main/.git",
    },
  );
  assert.equal(owned, null);
});

test("登记丢失时DSH Node Host仍可按固定Web端口与仓库归属识别", () => {
  const owned = findOwnedChatProcessForPort(
    ROOT,
    { port: 43110, pid: 89 },
    {
      describe: () => ({
        startedAtMs: Date.parse("2026-08-09T08:00:00.000Z"),
        command: "node /workspace/chat/scripts/dsh/start-web.mjs",
      }),
      workingDirectory: () => ROOT,
      findParentPid: () => 1,
      findGitCommonDir: () => "/workspace/chat-main/.git",
    },
  );
  assert.equal(owned?.role, "web");
  assert.equal(owned?.pid, 89);
});

test("监听子进程没有角色签名时可回溯到同仓库Memory包装器", () => {
  const owned = findOwnedChatProcessForPort(
    "/workspace/chat-main",
    { port: 18960, pid: 62 },
    {
      describe: (pid) =>
        pid === 62
          ? { startedAtMs: 1_000, command: "node memory-server.js" }
          : {
              startedAtMs: 900,
              command: "node /workspace/chat-feature/scripts/memory/start-fixed-memmy.mjs",
            },
      workingDirectory: (pid) =>
        pid === 62 ? "/workspace/chat-main/.data/cache/memmy" : "/workspace/chat-feature",
      findParentPid: (pid) => (pid === 62 ? 61 : 1),
      findGitCommonDir: () => "/workspace/chat-main/.git",
    },
  );
  assert.equal(owned?.pid, 61);
  assert.equal(owned?.role, "memory");
});

test("同一进程同时监听服务端口与Inspector时只回收一次", () => {
  const descriptions = {
    describe: () => ({
      startedAtMs: 1_000,
      command: "node --import tsx/dist/loader.mjs src/index.ts",
    }),
    workingDirectory: () => "/workspace/chat-feature/apps/api",
    findParentPid: () => 1,
    findGitCommonDir: () => "/workspace/chat-main/.git",
  };
  const entries = findOwnedChatPortProcesses(
    "/workspace/chat-main",
    [
      { port: 43111, pid: 72 },
      { port: 43120, pid: 72 },
    ],
    descriptions,
  );
  assert.equal(entries.length, 1);

  const terminated = [];
  const results = reclaimOwnedPortOccupants(
    "/workspace/chat-main",
    [
      { port: 43111, pid: 72 },
      { port: 43120, pid: 72 },
    ],
    {
      findOwned: () => entries,
      terminate: (entry) => {
        terminated.push(entry.pid);
        return { role: entry.role, pid: entry.pid, action: "terminated" };
      },
    },
  );
  assert.deepEqual(terminated, [72]);
  assert.deepEqual(results, [{ role: "api", pid: 72, action: "terminated" }]);
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

test("版本恢复检查复用仓库入口且不继承VS Code自动附加环境", async () => {
  let receivedArgs;
  let receivedEnvironment;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  await runVersionRecoveryCommand({
    root: ROOT,
    environment: {
      NODE_OPTIONS: "--require /vscode/bootloader.js",
      VSCODE_INSPECTOR_OPTIONS: "attach-options",
    },
    spawnImpl(_command, args, options) {
      receivedArgs = args;
      receivedEnvironment = options.env;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.deepEqual(receivedArgs, [
    "--filter",
    "@chat/api",
    "exec",
    "tsx",
    "../../scripts/dev/settle-incompatible-workflows.ts",
  ]);
  assert.equal(receivedEnvironment.VSCODE_INSPECTOR_OPTIONS, undefined);
  assert.equal(receivedEnvironment.NODE_OPTIONS, undefined);
  assert.equal(receivedEnvironment.CHAT_REPO_ROOT, ROOT);
});

test("DSH准备命令复用workspace入口并固定worktree私有Home", async () => {
  let receivedArgs;
  let receivedEnvironment;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  await runDshPreparationCommand({
    root: ROOT,
    environment: {
      DSH_HOME: "/Users/example/.dsh",
      NODE_OPTIONS: "--require /vscode/bootloader.js",
      VSCODE_INSPECTOR_OPTIONS: "attach-options",
    },
    spawnImpl(_command, args, options) {
      receivedArgs = args;
      receivedEnvironment = options.env;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.deepEqual(receivedArgs, ["--filter", "@chat/dsh-web", "prepare:profile"]);
  assert.equal(receivedEnvironment.DSH_HOME, "/workspace/chat/.data/dsh-home");
  assert.equal(
    receivedEnvironment.CHAT_DSH_STATE_PATH,
    "/workspace/chat/.data/dsh-lifeos-bridge/state.json",
  );
  assert.equal(receivedEnvironment.VSCODE_INSPECTOR_OPTIONS, undefined);
  assert.equal(receivedEnvironment.NODE_OPTIONS, undefined);
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
