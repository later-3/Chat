import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * 调试脚本黑盒测试（任务书§8完成门）。
 *
 * 通过真实子进程运行scripts/debug下的CLI，验证：
 * - preclean只清理已记录进程，连续运行幂等；
 * - 未知应用占用端口时安全失败且不杀该进程；
 * - wait-ready成功/超时语义。
 */

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
const scriptsDir = join(repoRoot, "scripts", "debug");

const TEST_PORTS = "44110,44111,44112,44120,44121,44122,44123";

function makeEnv(debugDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CHAT_REPO_ROOT: repoRoot,
    CHAT_DEBUG_DIR: debugDir,
    CHAT_DEBUG_PORTS: TEST_PORTS,
  };
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("node", [join(scriptsDir, script), ...args], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

/** 异步版本：测试进程内启动的服务器需要事件循环保持运行。 */
function runScriptAsync(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("node", [join(scriptsDir, script), ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", rejectRun);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function tempDebugDir(): string {
  return mkdtempSync(join(tmpdir(), "chat-debug-test-"));
}

function writePidsFile(debugDir: string, entries: unknown[]) {
  mkdirSync(debugDir, { recursive: true });
  writeFileSync(
    join(debugDir, "pids.json"),
    JSON.stringify({ schemaVersion: 1, processes: entries }),
    "utf8",
  );
}

function writeProviderFixture(
  configPath: string,
  readerPath: string,
  baseUrl: string,
  readerSource = 'process.stdout.write(process.env.FAKE_READER_VALUE ?? "")',
) {
  writeFileSync(
    configPath,
    JSON.stringify({ providers: [{ id: "dashscope", base_url: baseUrl }] }),
    "utf8",
  );
  writeFileSync(readerPath, readerSource, "utf8");
}

function runProviderPreload(env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      join(scriptsDir, "load-provider-env.mjs"),
      "-e",
      [
        "if (process.env.DASHSCOPE_API_KEY !== process.env.EXPECTED_KEY) process.exit(4);",
        "if (process.env.DASHSCOPE_BASE_URL !== process.env.EXPECTED_BASE_URL) process.exit(5);",
        'process.stdout.write("PROVIDER_READY\\n");',
      ].join(" "),
    ],
    { env, encoding: "utf8", timeout: 15_000 },
  );
}

function runMemoryCoreDebugPreload(env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      join(scriptsDir, "load-memorycore-debug-env.mjs"),
      "-e",
      [
        'if (process.env.CHAT_TENCENT_MEMORYCORE_BASE_URL !== "http://127.0.0.1:18970") process.exit(4);',
        'if (process.env.CHAT_TENCENT_MEMORYCORE_SERVICE_ID !== "chat-local-debug-service") process.exit(5);',
        'if (!/^chat-debug-[0-9a-f]{32}$/.test(process.env.CHAT_TENCENT_MEMORYCORE_TOKEN ?? "")) process.exit(6);',
        'process.stdout.write("MEMORYCORE_DEBUG_READY\\n");',
      ].join(" "),
    ],
    { env, encoding: "utf8", timeout: 15_000 },
  );
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

describe("wait-ready", () => {
  it("服务就绪时退出码0", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    cleanup.push(() => server.close());
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const result = await runScriptAsync(
      "wait-ready.mjs",
      ["test", `http://127.0.0.1:${port}/`, "5000"],
      makeEnv(tempDebugDir()),
    );
    expect(result.status).toBe(0);
  });

  it("超时退出码1", () => {
    const result = runScript(
      "wait-ready.mjs",
      ["test", "http://127.0.0.1:44999/", "600"],
      makeEnv(tempDebugDir()),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("超时");
  });
});

describe("Chat本地Workflow Provider preload", () => {
  it("普通启动脚本不包含个人绝对路径或隐式pi配置依赖", () => {
    const source = readFileSync(join(scriptsDir, "load-provider-env.mjs"), "utf8");
    expect(source).not.toMatch(/\/Users\/xulater/u);
    expect(source).not.toMatch(/backend\/config\.json/u);
    expect(source).toContain("CHAT_DEBUG_PI_KEY_READER");
    expect(source).toContain("CHAT_DEBUG_PI_PROVIDER_CONFIG");
  });

  it("陌生机器没有Key或pi本地配置时仍可启动为Provider not ready", () => {
    const fixtureDir = tempDebugDir();
    const result = runProviderPreload({
      ...makeEnv(fixtureDir),
      CHAT_DEBUG_PI_KEY_READER: "",
      CHAT_DEBUG_PI_PROVIDER_CONFIG: "",
      DASHSCOPE_API_KEY: "",
      DASHSCOPE_BASE_URL: "",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PROVIDER_READY");
    expect(result.stderr).toBe("");
  });

  it("环境/.env中的Provider配置优先，且stdout/stderr不泄漏Key", () => {
    const fixtureDir = tempDebugDir();
    const configPath = join(fixtureDir, "pi-config.json");
    const readerPath = join(fixtureDir, "reader.mjs");
    const existingKey = "ENV_KEY_MUST_NOT_APPEAR_1";
    const existingBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    writeProviderFixture(
      configPath,
      readerPath,
      "https://invalid.example.test/v1",
      'throw new Error("reader must not run")',
    );

    const result = runProviderPreload({
      ...makeEnv(fixtureDir),
      CHAT_DEBUG_PI_KEY_READER: readerPath,
      CHAT_DEBUG_PI_PROVIDER_CONFIG: configPath,
      DASHSCOPE_API_KEY: existingKey,
      DASHSCOPE_BASE_URL: existingBaseUrl,
      EXPECTED_KEY: existingKey,
      EXPECTED_BASE_URL: existingBaseUrl,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PROVIDER_READY");
    expect(result.stdout).not.toContain(existingKey);
    expect(result.stderr).not.toContain(existingKey);
  });

  it("缺失环境配置时仅在进程内复用注入的pi配置", () => {
    const fixtureDir = tempDebugDir();
    const configPath = join(fixtureDir, "pi-config.json");
    const readerPath = join(fixtureDir, "reader.mjs");
    const fallbackKey = "PI_KEY_MUST_NOT_APPEAR_2";
    const fallbackBaseUrl = "https://workspace.dashscope.aliyuncs.com/compatible-mode/v1";
    writeProviderFixture(configPath, readerPath, fallbackBaseUrl);

    const result = runProviderPreload({
      ...makeEnv(fixtureDir),
      CHAT_DEBUG_PI_KEY_READER: readerPath,
      CHAT_DEBUG_PI_PROVIDER_CONFIG: configPath,
      DASHSCOPE_API_KEY: "",
      DASHSCOPE_BASE_URL: "",
      FAKE_READER_VALUE: fallbackKey,
      EXPECTED_KEY: fallbackKey,
      EXPECTED_BASE_URL: fallbackBaseUrl,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PROVIDER_READY");
    expect(result.stdout).not.toContain(fallbackKey);
    expect(result.stderr).not.toContain(fallbackKey);
  });

  it("pi Base URL非HTTPS百炼域名时失败关闭且不泄漏Key", () => {
    const fixtureDir = tempDebugDir();
    const configPath = join(fixtureDir, "pi-config.json");
    const readerPath = join(fixtureDir, "reader.mjs");
    const fallbackKey = "PI_KEY_MUST_NOT_APPEAR_3";
    writeProviderFixture(configPath, readerPath, "http://not-dashscope.example.test/v1");

    const result = runProviderPreload({
      ...makeEnv(fixtureDir),
      CHAT_DEBUG_PI_KEY_READER: readerPath,
      CHAT_DEBUG_PI_PROVIDER_CONFIG: configPath,
      DASHSCOPE_API_KEY: "",
      DASHSCOPE_BASE_URL: "",
      FAKE_READER_VALUE: fallbackKey,
      EXPECTED_KEY: fallbackKey,
      EXPECTED_BASE_URL: "https://unused.dashscope.aliyuncs.com/v1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Base URL");
    expect(result.stdout).not.toContain(fallbackKey);
    expect(result.stderr).not.toContain(fallbackKey);
  });

  it("本地pi复用只配置一条路径时失败关闭", () => {
    const fixtureDir = tempDebugDir();
    const result = runProviderPreload({
      ...makeEnv(fixtureDir),
      CHAT_DEBUG_PI_KEY_READER: join(fixtureDir, "reader.mjs"),
      CHAT_DEBUG_PI_PROVIDER_CONFIG: "",
      DASHSCOPE_API_KEY: "",
      DASHSCOPE_BASE_URL: "",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("必须同时配置");
  });
});

describe("VS Code MemoryCore preload", () => {
  it("强制三个调试进程使用同一loopback身份且不输出配置", () => {
    const hostileToken = "REMOTE_TOKEN_MUST_NOT_APPEAR_7";
    const result = runMemoryCoreDebugPreload({
      ...makeEnv(tempDebugDir()),
      CHAT_TENCENT_MEMORYCORE_BASE_URL: "https://remote.example.test",
      CHAT_TENCENT_MEMORYCORE_TOKEN: hostileToken,
      CHAT_TENCENT_MEMORYCORE_SERVICE_ID: "remote-private-service",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("MEMORYCORE_DEBUG_READY\n");
    expect(result.stdout).not.toContain(hostileToken);
    expect(result.stderr).not.toContain(hostileToken);
  });
});

describe("preclean", () => {
  it("固定memmy与MemoryCore端口纳入统一未知占用保护", () => {
    const debugLibrary = readFileSync(join(scriptsDir, "lib.mjs"), "utf8");
    const runtimeInstances = readFileSync(join(scriptsDir, "../dev/runtime-instance.mjs"), "utf8");
    expect(runtimeInstances).toMatch(/memory:\s*18960/u);
    expect(runtimeInstances).toMatch(/memoryCore:\s*18970/u);
    expect(runtimeInstances).toMatch(/apiInspector:\s*43120/u);
    expect(runtimeInstances).toMatch(/workflowInspector:\s*43121/u);
    expect(runtimeInstances).toMatch(/piExecutor:\s*43115/u);
    expect(runtimeInstances).toMatch(/piExecutorInspector:\s*43122/u);
    expect(runtimeInstances).toMatch(/memory:\s*19960/u);
    expect(runtimeInstances).toMatch(/memoryCore:\s*19970/u);
    expect(runtimeInstances).toMatch(/apiInspector:\s*44120/u);
    expect(runtimeInstances).toMatch(/workflowInspector:\s*44121/u);
    expect(runtimeInstances).toMatch(/piExecutor:\s*44115/u);
    expect(runtimeInstances).toMatch(/piExecutorInspector:\s*44122/u);
    expect(debugLibrary).not.toMatch(/memoryCoreInspector/u);
    // 下方“未知应用占用端口”黑盒用例通过CHAT_DEBUG_PORTS复用同一preclean逻辑，
    // 证明冻结端口（包括18960）遇到未登记监听者均只报告、不终止。
  });

  it("memory包装进程有足够时间转发停止信号，其他角色保留默认上限", () => {
    const debugLibrary = readFileSync(join(scriptsDir, "lib.mjs"), "utf8");
    expect(debugLibrary).toContain("MEMORY_WRAPPER_TERM_WAIT_MS = 7_000");
    expect(debugLibrary).toContain('entry.role === "memory" || entry.role === "memoryCore"');
  });

  it("清理已记录进程并释放，连续两次运行均成功且幂等", async () => {
    const debugDir = tempDebugDir();
    const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
      detached: false,
      stdio: "ignore",
    });
    cleanup.push(() => {
      try {
        process.kill(child.pid ?? 0, "SIGKILL");
      } catch {
        // 已被preclean清理
      }
    });
    writePidsFile(debugDir, [
      {
        role: "test-sleeper",
        pid: child.pid,
        port: 0,
        killScope: "process",
        startedAt: new Date().toISOString(),
        commandFragments: ["setInterval"],
      },
    ]);

    const first = runScript("preclean.mjs", [], makeEnv(debugDir));
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("terminated");
    // spawnSync阻塞了事件循环，exit事件在其返回后才派发
    await new Promise<void>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error("子进程未被终止")), 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    expect(child.signalCode).toBe("SIGTERM");

    // 第二次运行：无记录、端口空闲，仍成功（不残留、不改变端口语义）
    const second = runScript("preclean.mjs", [], makeEnv(debugDir));
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("全部可用");
  });

  it("身份不匹配时不终止该进程", () => {
    const debugDir = tempDebugDir();
    const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
      detached: false,
      stdio: "ignore",
    });
    cleanup.push(() => {
      try {
        process.kill(child.pid ?? 0, "SIGKILL");
      } catch {
        // 已退出
      }
    });
    // 记录一个与真实进程命令不符的片段，模拟PID复用
    writePidsFile(debugDir, [
      {
        role: "stale",
        pid: child.pid,
        port: 0,
        killScope: "process",
        startedAt: new Date().toISOString(),
        commandFragments: ["definitely-not-this-process"],
      },
    ]);
    const result = runScript("preclean.mjs", [], makeEnv(debugDir));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped-identity-mismatch");
    // 进程必须仍然存活
    expect(() => process.kill(child.pid ?? 0, 0)).not.toThrow();
  });

  it("未知应用占用端口时安全失败，不杀该进程", async () => {
    const debugDir = tempDebugDir();
    const blocker: Server = createServer((_req, res) => res.end("busy"));
    await new Promise<void>((resolveListen) => blocker.listen(44110, "127.0.0.1", resolveListen));
    cleanup.push(() => blocker.close());

    const result = runScript("preclean.mjs", [], makeEnv(debugDir));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("44110");
    expect(result.stderr).toContain("拒绝清理");

    // 占用者（本测试进程自己）必须存活且端口仍被监听
    await new Promise<void>((resolveCheck, rejectCheck) => {
      const probe = createServer();
      probe.once("error", (error) => {
        expect((error as NodeJS.ErrnoException).code).toBe("EADDRINUSE");
        resolveCheck();
      });
      probe.once("listening", () => {
        probe.close(() => rejectCheck(new Error("端口应仍被占用")));
      });
      probe.listen(44110, "127.0.0.1");
    });
  });

  it("携带秘密参数的未知占用进程：拒绝启动、不杀进程、不泄漏argv", async () => {
    const debugDir = tempDebugDir();
    const SECRET = "TRACE_SECRET_ARG_NEVER_SHOWN_9f8e7d";
    // 无关应用：命令行携带合成秘密参数（模拟其他应用把Token放在argv中）
    const blocker = spawn(
      "node",
      [
        "-e",
        "require('node:http').createServer((q,r)=>r.end('x')).listen(44112,'127.0.0.1')",
        SECRET,
      ],
      { stdio: "ignore" },
    );
    cleanup.push(() => {
      try {
        process.kill(blocker.pid ?? 0, "SIGKILL");
      } catch {
        // 已退出
      }
    });
    // 等待监听生效
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        await fetch("http://127.0.0.1:44112/", { signal: AbortSignal.timeout(500) });
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error("占用进程未在8s内开始监听");
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    }

    const result = runScript("preclean.mjs", [], makeEnv(debugDir));
    // 拒绝启动
    expect(result.status).toBe(1);
    // 报告端口、PID与安全进程名
    expect(result.stderr).toContain("44112");
    expect(result.stderr).toContain(`pid=${blocker.pid}`);
    expect(result.stderr).toContain("node");
    // 不泄漏完整argv中的秘密参数
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
    // 不杀该进程
    expect(() => process.kill(blocker.pid ?? 0, 0)).not.toThrow();
  }, 15_000);

  it("已登记的旧Workflow被preclean清理，端口随后不再Ready（Compound统一preclean门场景）", async () => {
    const debugDir = tempDebugDir();
    const child = spawn("node", [join(scriptsDir, "workflow-stub.mjs")], {
      env: { ...process.env, WORKFLOW_PORT: "44112" },
      stdio: "ignore",
    });
    cleanup.push(() => {
      try {
        process.kill(child.pid ?? 0, "SIGKILL");
      } catch {
        // 已退出
      }
    });
    // 等待旧Workflow Ready
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        await fetch("http://127.0.0.1:44112/healthz", { signal: AbortSignal.timeout(500) });
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error("旧Workflow未在8s内就绪");
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    }
    // 模拟上一轮会话的登记记录
    writePidsFile(debugDir, [
      {
        role: "workflow",
        pid: child.pid,
        port: 44112,
        killScope: "process",
        startedAt: new Date().toISOString(),
        commandFragments: ["workflow-stub.mjs"],
      },
    ]);

    // Compound统一preclean门：先清理旧进程，wait-workflow才可能通过
    const preclean = runScript("preclean.mjs", [], makeEnv(debugDir));
    expect(preclean.status).toBe(0);
    await new Promise<void>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error("旧Workflow未被终止")), 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    // 旧Workflow不再Ready：wait-workflow在新实例启动前不会误判成功
    const wait = runScript(
      "wait-ready.mjs",
      ["workflow", "http://127.0.0.1:44112/healthz", "600"],
      makeEnv(debugDir),
    );
    expect(wait.status).toBe(1);
  });

  it("进程登记失败时服务终止启动（不产生无法清理的未登记服务）", () => {
    // CHAT_DEBUG_DIR指向一个普通文件：登记写盘必然失败
    const blocker = join(tempDebugDir(), "not-a-dir");
    writeFileSync(blocker, "occupied", "utf8");
    const result = spawnSync(
      "node",
      [
        "--import",
        join(scriptsDir, "register-process.mjs"),
        "-e",
        "console.log('SERVICE_STARTED')",
      ],
      {
        env: {
          ...process.env,
          CHAT_REPO_ROOT: repoRoot,
          CHAT_DEBUG_ROLE: "api",
          CHAT_DEBUG_PORT: "43111",
          CHAT_DEBUG_DIR: blocker,
        },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("进程登记失败");
    expect(result.stdout).not.toContain("SERVICE_STARTED");
  });

  it("memory登记的旧包装进程由stop精准释放", async () => {
    const debugDir = tempDebugDir();
    const child = spawn(
      "node",
      [
        "--import",
        join(scriptsDir, "register-process.mjs"),
        "-e",
        "setInterval(() => {}, 1000)",
        "start-fixed-memmy.mjs",
      ],
      {
        env: {
          ...makeEnv(debugDir),
          CHAT_DEBUG_ROLE: "memory",
          CHAT_DEBUG_PORT: "18960",
        },
        stdio: "ignore",
      },
    );
    cleanup.push(() => {
      try {
        process.kill(child.pid ?? 0, "SIGKILL");
      } catch {
        // 已被stop清理
      }
    });

    const pidsFile = join(debugDir, "pids.json");
    const deadline = Date.now() + 3_000;
    while (!existsSync(pidsFile) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    expect(existsSync(pidsFile)).toBe(true);
    expect(readFileSync(pidsFile, "utf8")).toContain('"role": "memory"');

    const result = runScript("stop.mjs", [], makeEnv(debugDir));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("memory");
    expect(result.stdout).toContain("terminated");
    await new Promise<void>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error("memory包装进程未被精准释放")), 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("memoryCore登记的旧包装进程由stop精准释放", async () => {
    const debugDir = tempDebugDir();
    const child = spawn(
      "node",
      [
        "--import",
        join(scriptsDir, "register-process.mjs"),
        "-e",
        "setInterval(() => {}, 1000)",
        "start-fixed-memorycore.mjs",
      ],
      {
        env: {
          ...makeEnv(debugDir),
          CHAT_DEBUG_ROLE: "memoryCore",
          CHAT_DEBUG_PORT: "18970",
        },
        stdio: "ignore",
      },
    );
    cleanup.push(() => {
      try {
        process.kill(child.pid ?? 0, "SIGKILL");
      } catch {
        // 已被stop清理
      }
    });

    const pidsFile = join(debugDir, "pids.json");
    const deadline = Date.now() + 3_000;
    while (!existsSync(pidsFile) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    expect(existsSync(pidsFile)).toBe(true);
    expect(readFileSync(pidsFile, "utf8")).toContain('"role": "memoryCore"');

    const result = runScript("stop.mjs", [], makeEnv(debugDir));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("memoryCore");
    expect(result.stdout).toContain("terminated");
    await new Promise<void>((resolveExit, rejectExit) => {
      const timer = setTimeout(
        () => rejectExit(new Error("memoryCore包装进程未被精准释放")),
        3_000,
      );
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("pids.json损坏时保留现场并继续按空记录执行，端口检查仍生效", async () => {
    const debugDir = tempDebugDir();
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(join(debugDir, "pids.json"), "{corrupt", "utf8");
    const blocker: Server = createServer((_req, res) => res.end("busy"));
    await new Promise<void>((resolveListen) => blocker.listen(44111, "127.0.0.1", resolveListen));
    cleanup.push(() => blocker.close());

    const result = runScript("preclean.mjs", [], makeEnv(debugDir));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pids.json损坏");
    expect(result.stderr).toContain("44111");
  });
});

describe("stop", () => {
  it("无记录进程时安全退出0", () => {
    const result = runScript("stop.mjs", [], makeEnv(tempDebugDir()));
    expect(result.status).toBe(0);
  });
});
