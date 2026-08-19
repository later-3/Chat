import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AppSupervisor,
  assertLocalSetupIdle,
  assertLocalSetupPrerequisites,
  createServiceDefinitions,
  parseDevArgs,
  preflightLocalRuntime,
  reclaimOwnedPortOccupants,
  resolveLocalWorkbenchRuntimeContract,
  runDshPreparationCommand,
  runPreparationCommand,
  runVersionRecoveryCommand,
  sharedCacheRootFromGitCommonDir,
  setupUsage,
  waitForServiceReady,
} from "./app-runtime.mjs";
import {
  RETIRED_MUST_BE_EMPTY_PORTS,
  assertRetiredPortsEmpty,
  findOwnedChatPortProcesses,
  findOwnedChatProcessForPort,
  formatRetiredPortStatus,
  frozenPortList,
  probeRetiredPort,
  roleForFrozenPort,
  sharedDebugDirFromGitCommonDir,
  termWaitMsForEntry,
} from "../debug/lib.mjs";
import {
  cleanupOwnedDebugBrowser,
  debugBrowserProfileRoot,
  isOwnedDebugBrowserCommand,
  ownedDebugBrowserPidsFromPsOutput,
} from "./browser-lifecycle.mjs";
import { collectLocalRuntimeStatus } from "./status.mjs";
import { DEBUG_RUNTIME_PORTS, resolveRuntimeInstance } from "./runtime-instance.mjs";

const ROOT = "/workspace/chat";

test("统一启动器固定关闭Memory且拒绝重新启用", () => {
  assert.deepEqual(parseDevArgs([]), {
    debug: false,
    help: false,
    instance: "production",
    memory: "off",
    workbench: "code-server",
  });
  assert.deepEqual(
    parseDevArgs(["--debug", "--instance=debug", "--memory=off", "--workbench=off"]),
    {
      debug: true,
      help: false,
      instance: "debug",
      memory: "off",
      workbench: "off",
    },
  );
  assert.deepEqual(parseDevArgs(["--instance=debug"]), {
    debug: false,
    help: false,
    instance: "debug",
    memory: "off",
    workbench: "off",
  });
  assert.throws(() => parseDevArgs(["--debug"]), /必须配合--instance=debug/u);
  assert.throws(
    () => parseDevArgs(["--instance=debug", "--workbench=code-server"]),
    /debug实例当前只支持/u,
  );
  assert.throws(() => parseDevArgs(["--memory=memmy"]), /冻结关闭/u);
  assert.throws(() => parseDevArgs(["--memory=all"]), /冻结关闭/u);
  assert.throws(() => parseDevArgs(["--workbench=unknown"]), /只支持/u);
});

test("本地setup在写入运行缓存前锁定平台、Node、pnpm与系统工具", () => {
  const calls = [];
  const evidence = assertLocalSetupPrerequisites({
    platform: "linux",
    arch: "x64",
    nodeVersion: "24.8.0",
    nodeModuleAbi: "137",
    libc: "glibc-2.35",
    commandVersion(command, args) {
      calls.push([command, args]);
      return command === "pnpm" ? "10.13.1" : `${command} available`;
    },
  });
  assert.deepEqual(evidence, {
    platform: "linux",
    arch: "x64",
    libc: "glibc-2.35",
    nodeVersion: "24.8.0",
    nodeModuleAbi: "137",
    pnpmVersion: "10.13.1",
  });
  assert.deepEqual(
    calls.map(([command]) => command),
    ["pnpm", "git", "tar", "npm"],
  );
  assert.match(setupUsage(), /pnpm run setup/u);

  assert.throws(
    () =>
      assertLocalSetupPrerequisites({
        platform: "win32",
        arch: "x64",
        nodeVersion: "24.8.0",
        nodeModuleAbi: "137",
        commandVersion: () => "10.13.1",
      }),
    /暂不支持/u,
  );
  assert.throws(
    () =>
      assertLocalSetupPrerequisites({
        platform: "linux",
        arch: "x64",
        nodeVersion: "22.18.0",
        nodeModuleAbi: "127",
        libc: "glibc-2.35",
        commandVersion: () => "10.13.1",
      }),
    /Node 24.*ABI 137/u,
  );
  assert.throws(
    () =>
      assertLocalSetupPrerequisites({
        platform: "linux",
        arch: "x64",
        libc: "glibc-2.28",
        nodeVersion: "24.8.0",
        nodeModuleAbi: "137",
        commandVersion: () => "10.13.1",
      }),
    /glibc>=2\.29/u,
  );
  assert.throws(
    () =>
      assertLocalSetupPrerequisites({
        platform: "darwin",
        arch: "arm64",
        nodeVersion: "24.8.0",
        nodeModuleAbi: "137",
        commandVersion: (command) => (command === "pnpm" ? "10.14.0" : "available"),
      }),
    /pnpm版本不匹配/u,
  );
});

test("本地setup只读检查活动运行，任何占用都失败且不调用回收逻辑", async () => {
  const probed = [];
  let evidenceEnvironment;
  await assert.doesNotReject(
    assertLocalSetupIdle(ROOT, {
      environment: { CHAT_FIXED_SOURCE_CACHE_ROOT: "/workspace/shared-cache" },
      async probePort(port) {
        probed.push(port);
        return { port, state: "free" };
      },
      readWorkbenchEvidence(_root, environment) {
        evidenceEnvironment = environment;
        return { status: "stopped" };
      },
    }),
  );
  assert.deepEqual(probed, frozenPortList());
  assert.equal(evidenceEnvironment.CHAT_FIXED_SOURCE_CACHE_ROOT, "/workspace/shared-cache");

  let evidenceRead = false;
  await assert.rejects(
    assertLocalSetupIdle(ROOT, {
      probePort: async (port) =>
        port === 43110
          ? { port, state: "occupied", errorCode: "EADDRINUSE" }
          : { port, state: "free" },
      readWorkbenchEvidence() {
        evidenceRead = true;
      },
    }),
    /setup不会自动停止.*pnpm dev:stop/u,
  );
  assert.equal(evidenceRead, false);

  await assert.rejects(
    assertLocalSetupIdle(ROOT, {
      instance: "debug",
      probePort: async (port) =>
        port === 44115
          ? { port, state: "occupied", errorCode: "EADDRINUSE" }
          : { port, state: "free" },
      readWorkbenchEvidence: () => undefined,
    }),
    /44115.*pnpm dev:debug:stop/u,
  );

  await assert.rejects(
    assertLocalSetupIdle(ROOT, {
      probePort: async (port) => ({ port, state: "free" }),
      readWorkbenchEvidence: () => ({ status: "running" }),
    }),
    /Workbench仍处于running.*不会回收/u,
  );
  const setupSource = readFileSync(join(import.meta.dirname, "setup.mjs"), "utf8");
  assert.match(setupSource, /prepareLocalArtifacts/u);
  assert.match(setupSource, /assertLocalSetupIdle/u);
  assert.doesNotMatch(setupSource, /prepareLocalRuntime|preflightLocalRuntime/u);
});

test("服务图永远不启动或装配Memory", () => {
  const disabled = createServiceDefinitions({ root: ROOT, environment: {} });
  assert.deepEqual(
    disabled.map((service) => service.id),
    ["piExecutor", "workflow", "api", "workbench", "web"],
  );
  const disabledById = Object.fromEntries(disabled.map((service) => [service.id, service]));
  assert.equal(disabledById.workflow.env.CHAT_MEMORY_ENABLED, "0");
  assert.equal(disabledById.api.env.CHAT_MEMORY_ENABLED, "0");
  assert.doesNotMatch(disabledById.workflow.args.join(" "), /load-memorycore-debug-env/u);
  assert.doesNotMatch(disabledById.api.args.join(" "), /load-memorycore-debug-env/u);

  assert.throws(
    () => createServiceDefinitions({ root: ROOT, memory: "all", environment: {} }),
    /未知Memory Profile/u,
  );
});

test("Workbench只接收显式安全环境并把唯一仓库根映射给code-server", () => {
  const services = createServiceDefinitions({
    root: ROOT,
    environment: {
      PATH: "/usr/bin",
      DASHSCOPE_API_KEY: "must-not-leak",
      CHAT_CODE_WORKBENCH_ROOT: "/private/other-workspace",
      CHAT_FIXED_SOURCE_CACHE_ROOT: "/workspace/cache",
    },
  });
  const workbench = services.find((service) => service.id === "workbench");
  assert.equal(workbench.env.PATH, "/usr/bin");
  assert.equal(workbench.env.CHAT_REPO_ROOT, ROOT);
  assert.equal(workbench.env.CHAT_CODE_WORKBENCH_ROOT, ROOT);
  assert.equal(workbench.env.CHAT_FIXED_SOURCE_CACHE_ROOT, "/workspace/cache");
  assert.equal(
    workbench.env.CHAT_CODE_WORKBENCH_RUN_ROOT,
    "/workspace/chat/.data/workbench/code-server",
  );
  assert.equal(workbench.env.DASHSCOPE_API_KEY, undefined);
  assert.equal(workbench.readyUrl, undefined);
  assert.equal(workbench.readyDescription, "受管0600 Unix socket /healthz");
  assert.equal(typeof workbench.readyProbe, "function");
  assert.equal(workbench.port, undefined);
});

test("launcher与独立status从同一输入重建Workbench run/temp/cache合同", () => {
  const environment = {
    CHAT_CODE_WORKBENCH_RUN_ROOT: "/workspace/run/code-server",
    CHAT_CODE_WORKBENCH_TEMP_PARENT: "/tmp",
    CHAT_FIXED_SOURCE_CACHE_ROOT: "/workspace/shared-cache",
  };
  const contract = resolveLocalWorkbenchRuntimeContract(ROOT, environment);
  assert.deepEqual(contract, {
    CHAT_CODE_WORKBENCH_RUN_ROOT: "/workspace/run/code-server",
    CHAT_CODE_WORKBENCH_TEMP_PARENT: realpathSync("/tmp"),
    CHAT_FIXED_SOURCE_CACHE_ROOT: "/workspace/shared-cache",
  });
  const workbench = createServiceDefinitions({
    root: ROOT,
    environment,
  }).find((service) => service.id === "workbench");
  assert.deepEqual(
    Object.fromEntries(Object.keys(contract).map((name) => [name, workbench.env[name]])),
    contract,
  );
});

test("running status复用严格合同并显示Unix transport、instance、PID与healthy", async () => {
  const contract = Object.freeze({
    CHAT_CODE_WORKBENCH_RUN_ROOT: "/workspace/run/code-server",
    CHAT_CODE_WORKBENCH_TEMP_PARENT: realpathSync("/tmp"),
    CHAT_FIXED_SOURCE_CACHE_ROOT: "/workspace/shared-cache",
  });
  const evidence = Object.freeze({
    status: "running",
    instanceId: "55555555-5555-4555-8555-555555555555",
    wrapperPid: 501,
    childPid: 502,
  });
  const lines = await collectLocalRuntimeStatus({
    root: ROOT,
    environment: {},
    loadEntries: () => [],
    check: () => [],
    probeRetired: async () => [{ port: 43113, state: "free" }],
    resolveWorkbenchContract: () => contract,
    readWorkbenchEvidence(root, environment) {
      assert.equal(root, ROOT);
      assert.equal(environment, contract);
      return evidence;
    },
    async probeWorkbench(root, options) {
      assert.equal(root, ROOT);
      assert.equal(options.environment, contract);
    },
  });
  assert.deepEqual(lines, [
    "[chat] 退役端口 43113 free",
    "[chat] healthy workbench transport=unix-socket instanceId=55555555-5555-4555-8555-555555555555 wrapperPid=501 childPid=502",
  ]);
});

test("running probe失败且无其他entry时显示unhealthy但绝不声称本地未运行", async () => {
  const lines = await collectLocalRuntimeStatus({
    root: ROOT,
    loadEntries: () => [],
    check: () => [],
    probeRetired: async () => [{ port: 43113, state: "free" }],
    resolveWorkbenchContract: () => ({}),
    readWorkbenchEvidence: () => ({
      status: "running",
      instanceId: "77777777-7777-4777-8777-777777777777",
      wrapperPid: 701,
      childPid: 702,
    }),
    probeWorkbench: async () => {
      throw new Error("socket probe failed");
    },
  });
  assert.deepEqual(lines, [
    "[chat] 退役端口 43113 free",
    "[chat] unhealthy workbench transport=unix-socket instanceId=77777777-7777-4777-8777-777777777777 wrapperPid=701 childPid=702",
  ]);
  assert.equal(
    lines.some((line) => line.includes("本地开发环境未运行")),
    false,
  );
});

test("starting evidence显示uncertain且不被误报为已停止或本地未运行", async () => {
  let probeCalled = false;
  const lines = await collectLocalRuntimeStatus({
    root: ROOT,
    loadEntries: () => [],
    check: () => [],
    probeRetired: async () => [{ port: 43113, state: "free" }],
    resolveWorkbenchContract: () => ({}),
    readWorkbenchEvidence: () => ({
      status: "starting",
      instanceId: "88888888-8888-4888-8888-888888888888",
      wrapperPid: 801,
      childPid: null,
    }),
    probeWorkbench: async () => {
      probeCalled = true;
    },
  });
  assert.equal(probeCalled, false);
  assert.deepEqual(lines, [
    "[chat] 退役端口 43113 free",
    "[chat] uncertain(starting) workbench transport=unix-socket instanceId=88888888-8888-4888-8888-888888888888 wrapperPid=801 childPid=null",
  ]);
});

test("legacy-running evidence显示uncertain且不被误报为已停止或本地未运行", async () => {
  const lines = await collectLocalRuntimeStatus({
    root: ROOT,
    loadEntries: () => [],
    check: () => [],
    probeRetired: async () => [{ port: 43113, state: "free" }],
    resolveWorkbenchContract: () => ({}),
    readWorkbenchEvidence: () => ({
      status: "legacy-running",
      wrapperPid: 901,
      childPid: 902,
    }),
    probeWorkbench: async () => {
      throw new Error("legacy-running不得冒充v2 socket ready probe");
    },
  });
  assert.deepEqual(lines, [
    "[chat] 退役端口 43113 free",
    "[chat] uncertain(legacy-running) workbench transport=unix-socket instanceId=legacy wrapperPid=901 childPid=902",
  ]);
});

test("status对corrupt或合同不匹配的running evidence保持失败关闭", async () => {
  for (const message of ["进程证据损坏", "进程证据不符合受管Unix socket合同"]) {
    await assert.rejects(
      collectLocalRuntimeStatus({
        root: ROOT,
        loadEntries: () => [],
        check: () => [],
        probeRetired: async () => [{ port: 43113, state: "free" }],
        resolveWorkbenchContract: () => ({
          CHAT_CODE_WORKBENCH_RUN_ROOT: "/workspace/run/code-server",
          CHAT_CODE_WORKBENCH_TEMP_PARENT: realpathSync("/tmp"),
          CHAT_FIXED_SOURCE_CACHE_ROOT: "/workspace/shared-cache",
        }),
        readWorkbenchEvidence() {
          throw new Error(message);
        },
      }),
      new RegExp(message, "u"),
    );
  }
});

test("stopped status仍读取同一合同并明确显示停止状态", async () => {
  let probeCalled = false;
  const lines = await collectLocalRuntimeStatus({
    root: ROOT,
    loadEntries: () => [],
    check: () => [],
    probeRetired: async () => [{ port: 43113, state: "free" }],
    resolveWorkbenchContract: () => ({}),
    readWorkbenchEvidence: () => ({
      status: "stopped",
      instanceId: "66666666-6666-4666-8666-666666666666",
    }),
    probeWorkbench: async () => {
      probeCalled = true;
    },
  });
  assert.equal(probeCalled, false);
  assert.deepEqual(lines, [
    "[chat] 退役端口 43113 free",
    "[chat] 已停止 workbench transport=unix-socket instanceId=66666666-6666-4666-8666-666666666666",
    "[chat] 本地开发环境未运行，固定端口全部空闲。",
  ]);
});

test("debug只为Chat拥有的API、Workflow、Pi Executor与DSH Host开放Inspector", () => {
  const services = createServiceDefinitions({
    root: ROOT,
    debug: true,
    instance: "debug",
    workbench: "off",
    environment: {
      VSCODE_INSPECTOR_OPTIONS: "private-attach-options",
      NODE_OPTIONS: "--require /vscode/bootloader.js",
    },
  });
  const args = Object.fromEntries(services.map((service) => [service.id, service.args.join(" ")]));
  const web = services.find((service) => service.id === "web");
  assert.match(args.workflow, /--inspect=127\.0\.0\.1:44121/u);
  assert.match(args.piExecutor, /--inspect=127\.0\.0\.1:44122/u);
  assert.match(args.api, /--inspect=127\.0\.0\.1:44120/u);
  assert.match(args.web, /--inspect=127\.0\.0\.1:44123/u);
  for (const id of ["workflow", "piExecutor", "api", "web"]) {
    assert.match(args[id], /--enable-source-maps/u);
  }
  assert.equal(web.env.VSCODE_INSPECTOR_OPTIONS, "private-attach-options");
  assert.equal(web.env.NODE_OPTIONS, "--require /vscode/bootloader.js");
  assert.equal(args.memmy, undefined);
  assert.equal(args.memorycore, undefined);
  assert.equal(args.workbench, undefined);
});

test("debug实例同时隔离端口、产品事实、Workflow、Runtime、Trace与DSH投影", () => {
  const runtime = resolveRuntimeInstance(ROOT, "debug", {
    CHAT_PUBLIC_WEB_HOSTNAME: "chat.example.com",
    CHAT_PRODUCT_STORE_PATH: "/private/production-store.json",
  });
  assert.deepEqual(runtime.ports, DEBUG_RUNTIME_PORTS);
  assert.equal(runtime.dataRoot, "/workspace/chat/.data/instances/vscode-debug");
  assert.equal(runtime.environment.CHAT_PUBLIC_WEB_HOSTNAME, "");
  assert.equal(runtime.environment.CHAT_WEB_AUTH_REQUIRED, "0");
  assert.equal(
    runtime.environment.CHAT_PRODUCT_STORE_PATH,
    "/workspace/chat/.data/instances/vscode-debug/product/chat-product-store.v1.json",
  );
  assert.equal(
    runtime.environment.CHAT_WORKFLOW_DATA_DIR,
    "/workspace/chat/.data/instances/vscode-debug/workflow",
  );
  assert.equal(
    runtime.environment.CHAT_PI_EXECUTOR_DATA_DIR,
    "/workspace/chat/.data/instances/vscode-debug/pi-executor",
  );
  assert.equal(
    runtime.environment.CHAT_WORKFLOW_BUNDLE_DIR,
    "/workspace/chat/packages/workflows/.debug/.workflow-bundle",
  );
  assert.equal(
    runtime.environment.CHAT_RUNTIME_CREDENTIAL_PATH,
    "/workspace/chat/.data/instances/vscode-debug/runtime/runtime-key",
  );
  assert.equal(
    runtime.environment.CHAT_DSH_HOME,
    "/workspace/chat/.data/instances/vscode-debug/dsh-home",
  );
  assert.equal(
    runtime.browserProfile,
    "/workspace/chat/.data/instances/vscode-debug/browser-profile",
  );
  assert.equal(runtime.debugDir, "/workspace/chat/.data/instances/vscode-debug/processes");

  const services = createServiceDefinitions({
    root: ROOT,
    debug: true,
    instance: "debug",
    workbench: "off",
    environment: { CHAT_PUBLIC_WEB_HOSTNAME: "chat.example.com" },
  });
  const byId = Object.fromEntries(services.map((service) => [service.id, service]));
  assert.deepEqual(
    services.map((service) => service.id),
    ["piExecutor", "workflow", "api", "web"],
  );
  assert.equal(byId.piExecutor.port, 44115);
  assert.equal(
    byId.piExecutor.env.CHAT_PI_EXECUTOR_DATA_DIR,
    "/workspace/chat/.data/instances/vscode-debug/pi-executor",
  );
  assert.equal(byId.piExecutor.env.CHAT_API_INTERNAL_BASE_URL, "http://127.0.0.1:44111");
  assert.equal(byId.workflow.port, 44112);
  assert.equal(byId.workflow.env.CHAT_API_INTERNAL_BASE_URL, "http://127.0.0.1:44111");
  assert.equal(byId.workflow.env.CHAT_PI_EXECUTOR_INTERNAL_BASE_URL, "http://127.0.0.1:44115");
  assert.equal(byId.api.port, 44111);
  assert.equal(byId.api.env.CHAT_WORKFLOW_BASE_URL, "http://127.0.0.1:44112");
  assert.equal(byId.web.port, 44110);
  assert.equal(byId.web.env.DSH_WEB_PORT, "44114");
  assert.equal(byId.web.env.CHAT_PUBLIC_WEB_PORT, "44110");
  assert.equal(byId.web.env.CHAT_PUBLIC_WEB_HOSTNAME, "");
  assert.match(byId.web.args.join(" "), /--inspect=127\.0\.0\.1:44123/u);
  for (const id of ["workflow", "piExecutor", "api", "web"]) {
    assert.ok(byId[id].args.includes("--enable-source-maps"));
  }
  assert.equal(byId.web.readyUrl, "http://127.0.0.1:44110/healthz");
});

test("Web角色使用受管DSH Node Host且私有Bridge状态不进入命令与探针", () => {
  const services = createServiceDefinitions({
    root: ROOT,
    environment: {
      CHAT_DSH_STATE_PATH: "/private/state.json",
      VSCODE_INSPECTOR_OPTIONS: "private-attach-options",
      NODE_OPTIONS: "--require /vscode/bootloader.js",
    },
  });
  const web = services.find((service) => service.id === "web");
  assert.equal(web.command, process.execPath);
  assert.deepEqual(web.args, [
    "--import",
    "/workspace/chat/scripts/load-env.mjs",
    "/workspace/chat/scripts/dsh/start-web.mjs",
  ]);
  assert.equal(web.cwd, ROOT);
  assert.equal(web.env.DSH_HOME, "/workspace/chat/.data/dsh-home");
  assert.equal(web.env.DSH_WEB_PORT, "43114");
  assert.equal(web.readyUrl, "http://127.0.0.1:43110/healthz");
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

test("code-server不占固定TCP端口但wrapper仍获得完整退出时间", () => {
  assert.equal(roleForFrozenPort(43113), null);
  assert.equal(roleForFrozenPort(43119), "workbench");
  assert.equal(roleForFrozenPort(44110), "web");
  assert.equal(roleForFrozenPort(44111), "api");
  assert.equal(roleForFrozenPort(44112), "workflow");
  assert.equal(roleForFrozenPort(44115), "piExecutor");
  assert.equal(roleForFrozenPort(44122), "piExecutor");
  assert.equal(roleForFrozenPort(44123), "web");
  assert.deepEqual(RETIRED_MUST_BE_EMPTY_PORTS, [43113]);
  assert.equal(termWaitMsForEntry({ role: "workbench" }, 3_000), 7_000);
});

test("退役43113对未知或旧受管监听者都只拒绝且先于任何preflight清理", async () => {
  const simulateProbeError = async (code) => {
    const failedServer = new EventEmitter();
    failedServer.listening = false;
    failedServer.listen = () => {
      queueMicrotask(() =>
        failedServer.emit("error", Object.assign(new Error(`simulated ${code}`), { code })),
      );
    };
    failedServer.close = () => {
      throw new Error("bind失败时不应把未监听server误报为已成功close");
    };
    return probeRetiredPort(43113, { createServer: () => failedServer });
  };
  const occupiedProbe = await simulateProbeError("EADDRINUSE");
  const unknownProbe = await simulateProbeError("EACCES");
  assert.deepEqual(occupiedProbe, {
    port: 43113,
    state: "occupied",
    errorCode: "EADDRINUSE",
  });
  assert.deepEqual(unknownProbe, { port: 43113, state: "unknown", errorCode: "EACCES" });

  await assert.rejects(
    assertRetiredPortsEmpty({
      probePorts: async ({ ports }) => {
        assert.deepEqual(ports, [43113]);
        return [occupiedProbe];
      },
      // 模拟lsof/ss都不可用或无法解析PID；Node bind结果仍必须拒绝。
      diagnose: () => [],
    }),
    /不会自动终止.*43113 occupied.*EADDRINUSE/u,
  );

  await assert.rejects(
    assertRetiredPortsEmpty({
      probePorts: async () => [unknownProbe],
      diagnose: () => [],
    }),
    /43113 unknown.*EACCES/u,
  );

  const server = new EventEmitter();
  server.listening = false;
  let closeCount = 0;
  let acceptedSocketDestroyCount = 0;
  let acceptConnection;
  const acceptedSocket = new EventEmitter();
  acceptedSocket.destroy = () => {
    acceptedSocketDestroyCount += 1;
    // 模拟客户端不主动结束，也不发close；probe仍必须主动destroy且不能被其阻塞。
  };
  server.listen = (options) => {
    assert.deepEqual(options, { host: "127.0.0.1", port: 43113, exclusive: true });
    server.listening = true;
    queueMicrotask(() => {
      server.emit("listening");
      acceptConnection(acceptedSocket);
    });
  };
  server.close = (callback) => {
    closeCount += 1;
    assert.ok(acceptedSocketDestroyCount > 0, "close前必须先destroy已accept socket");
    server.listening = false;
    queueMicrotask(() => callback());
  };
  assert.deepEqual(
    await probeRetiredPort(43113, {
      createServer: (connectionHandler) => {
        acceptConnection = connectionHandler;
        return server;
      },
    }),
    { port: 43113, state: "free" },
  );
  assert.equal(closeCount, 1, "free必须在成功close后才能返回");
  assert.ok(acceptedSocketDestroyCount >= 1);

  const hangingCloseServer = new EventEmitter();
  hangingCloseServer.listening = false;
  hangingCloseServer.listen = () => {
    hangingCloseServer.listening = true;
    queueMicrotask(() => hangingCloseServer.emit("listening"));
  };
  hangingCloseServer.close = () => {
    hangingCloseServer.listening = false;
    // 故意永不调用callback；注入timer必须让production路径有界返回unknown。
  };
  let scheduledTimeoutMs;
  let timeoutCancelled = false;
  const closeTimeoutProbe = await probeRetiredPort(43113, {
    createServer: () => hangingCloseServer,
    scheduleTimeout(callback, timeoutMs) {
      scheduledTimeoutMs = timeoutMs;
      queueMicrotask(callback);
      return Symbol("test-close-timeout");
    },
    cancelTimeout() {
      timeoutCancelled = true;
    },
  });
  assert.deepEqual(closeTimeoutProbe, {
    port: 43113,
    state: "unknown",
    errorCode: "CLOSE_TIMEOUT",
  });
  assert.equal(scheduledTimeoutMs, 1_000);
  assert.equal(timeoutCancelled, true);
  await assert.rejects(
    assertRetiredPortsEmpty({
      probePorts: async () => [closeTimeoutProbe],
      diagnose: () => [],
    }),
    /43113 unknown.*CLOSE_TIMEOUT/u,
  );

  await assert.rejects(
    preflightLocalRuntime(
      ROOT,
      { workbench: "off" },
      {
        retiredPortGuard() {
          throw new Error("retired-port-blocked-before-cleanup");
        },
      },
    ),
    /retired-port-blocked-before-cleanup/u,
  );
  const source = preflightLocalRuntime.toString();
  assert.ok(source.indexOf("await retiredPortGuard();") < source.indexOf("loadPidEntries()"));
  assert.ok(
    source.indexOf("await retiredPortGuard();") < source.indexOf("reconcileManagedWorkbench"),
  );
  const dshPreflightSource = readFileSync(
    new URL("../e2e/preflight-dsh-real.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    dshPreflightSource.indexOf("await assertRetiredPortsEmpty();") <
      dshPreflightSource.indexOf("await cleanupDshRealWorkbench"),
  );
  const debugPrecleanSource = readFileSync(
    new URL("../debug/preclean.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    debugPrecleanSource.indexOf("await assertRetiredPortsEmpty();") <
      debugPrecleanSource.indexOf("loadPidEntries()"),
  );

  assert.equal(
    formatRetiredPortStatus({ port: 43113, state: "free" }),
    "[chat] 退役端口 43113 free",
  );
  assert.match(
    formatRetiredPortStatus(
      { port: 43113, state: "occupied", errorCode: "EADDRINUSE" },
      { port: 43113, pid: 91, processName: "node" },
    ),
    /43113 occupied pid=91 process=node error=EADDRINUSE/u,
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
  assert.equal(roleForFrozenPort(43114), "web");
  const unknownInternal = findOwnedChatProcessForPort(
    ROOT,
    { port: 43114, pid: 90 },
    {
      describe: () => ({
        startedAtMs: Date.parse("2026-08-09T08:00:00.000Z"),
        command: "node unrelated-internal-server.mjs",
      }),
      workingDirectory: () => ROOT,
      findParentPid: () => 1,
      findGitCommonDir: () => "/workspace/chat-main/.git",
    },
  );
  assert.equal(unknownInternal, null);
});

test("DSH Gateway与内部Host由同一wrapper监听时只回收一次", () => {
  const dependencies = {
    describe: () => ({
      startedAtMs: 1_000,
      command: "node /workspace/chat/scripts/dsh/start-web.mjs",
    }),
    workingDirectory: () => ROOT,
    findParentPid: () => 1,
    findGitCommonDir: () => "/workspace/chat-main/.git",
  };
  const entries = findOwnedChatPortProcesses(
    ROOT,
    [
      { port: 43110, pid: 91 },
      { port: 43114, pid: 91 },
    ],
    dependencies,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.role, "web");
  assert.equal(entries[0]?.pid, 91);
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
