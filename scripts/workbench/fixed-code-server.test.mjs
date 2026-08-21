import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIXED_CODE_SERVER_EVIDENCE_FILE,
  FIXED_CODE_SERVER_TAG_COMMIT,
  FIXED_CODE_SERVER_VERSION,
  DISABLED_EXTENSIONS_GALLERY,
  EXTENSIONS_GALLERY_HOOK_PATH,
  acquireCodeServerPrepareLease,
  acquirePrepareLock,
  codeServerPlatformKey,
  createShortCodeServerTemporaryRoot,
  createShortUserDataLink,
  downloadReleaseAsset,
  fixedCodeServerAsset,
  fixedCodeServerCacheRoot,
  readCodeServerProcessEvidence,
  mergeManagedCodeServerSettings,
  parseReportedCodeServerVersion,
  prepareIsolatedShellHome,
  releasePrepareLock,
  resolveCodeServerPrepareLeasePort,
  runtimeManifestSha256,
  runtimeSupportsManagedExtensionsGallery,
  sha256File,
  validateCodeServerCache,
  writeCodeServerStoppedTombstone,
} from "./fixed-code-server.mjs";
import { reconcileManagedWorkbench } from "./process-lifecycle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readPrepareLockOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return JSON.parse(readFileSync(resolve(lockPath, "owner.json"), "utf8"));
  }
}

function fakeRecoveryLease(events = []) {
  return async () => {
    events.push("lease-acquired");
    return {
      async release() {
        events.push("lease-released");
      },
    };
  };
}

describe("fixed code-server runtime contracts", () => {
  it("pins the official release asset for every supported platform", () => {
    assert.equal(codeServerPlatformKey("darwin", "arm64"), "darwin-arm64");
    const mac = fixedCodeServerAsset("darwin", "arm64");
    assert.equal(mac.name, `code-server-${FIXED_CODE_SERVER_VERSION}-macos-arm64.tar.gz`);
    assert.match(mac.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(mac.url.includes(`/v${FIXED_CODE_SERVER_VERSION}/`), true);
    assert.throws(() => fixedCodeServerAsset("win32", "x64"), /暂不支持平台/u);
  });

  it("keeps the cache version and platform addressed", () => {
    assert.equal(
      fixedCodeServerCacheRoot("/workspace/chat", "linux", "x64"),
      resolve(
        "/workspace/chat/.data/cache/code-server",
        `v${FIXED_CODE_SERVER_VERSION}`,
        "linux-x64",
      ),
    );
  });

  it("parses the exact version line after code-server startup logs", () => {
    assert.equal(
      parseReportedCodeServerVersion(
        `[2026-08-16T11:13:35.358Z] info code-server ${FIXED_CODE_SERVER_VERSION}\n${FIXED_CODE_SERVER_VERSION} 313bf03`,
      ),
      `${FIXED_CODE_SERVER_VERSION} 313bf03`,
    );
    assert.throws(() => parseReportedCodeServerVersion("[timestamp] info only"), /缺少固定版本行/u);
  });

  it("prepares an isolated zsh home without importing the host profile", () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-shell-home-"));
    try {
      const zshrc = prepareIsolatedShellHome(resolve(root, "home"));
      assert.equal(readFileSync(zshrc, "utf8").includes("do not source host profiles"), true);
      writeFileSync(zshrc, "user-controlled-isolated-profile\n");
      prepareIsolatedShellHome(resolve(root, "home"));
      assert.equal(readFileSync(zshrc, "utf8"), "user-controlled-isolated-profile\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically preserves user editor preferences while enforcing managed safety keys", () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-settings-"));
    try {
      const settingsPath = resolve(root, "User/settings.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        `${JSON.stringify({
          "editor.fontSize": 17,
          "workbench.colorTheme": "User Theme",
          "extensions.autoUpdate": true,
        })}\n`,
      );
      mergeManagedCodeServerSettings(settingsPath);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.equal(settings["editor.fontSize"], 17);
      assert.equal(settings["workbench.colorTheme"], "User Theme");
      assert.equal(settings["extensions.autoUpdate"], false);
      assert.equal(settings["remote.autoForwardPorts"], false);
      assert.equal(settings["telemetry.telemetryLevel"], "off");
      assert.equal(settings["telemetry.enableTelemetry"], false);
      assert.equal(settings["telemetry.enableCrashReporter"], false);
      assert.deepEqual(
        readdirSync(dirname(settingsPath)).filter((name) => name.includes(".tmp-")),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves malformed user settings and fails closed", () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-invalid-settings-"));
    try {
      const settingsPath = resolve(root, "User/settings.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, "{ invalid-json\n");
      assert.throws(() => mergeManagedCodeServerSettings(settingsPath), /已保留原文件/u);
      assert.equal(readFileSync(settingsPath, "utf8"), "{ invalid-json\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a private short temp root for VS Code Unix sockets", () => {
    const temporaryRoot = createShortCodeServerTemporaryRoot();
    try {
      assert.equal(Buffer.byteLength(resolve(temporaryRoot, "vscode-ipc-.sock")) <= 100, true);
      assert.equal(statSync(temporaryRoot).mode & 0o777, 0o700);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("exposes persistent user data through the short runtime root", () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-user-data-"));
    try {
      const shortTemporaryRoot = createShortCodeServerTemporaryRoot();
      const persistentRoot = resolve(root, "persistent-user-data");
      const shortUserDataRoot = createShortUserDataLink(shortTemporaryRoot, persistentRoot);
      writeFileSync(resolve(shortUserDataRoot, "state.json"), "persistent\n");
      assert.equal(readFileSync(resolve(persistentRoot, "state.json"), "utf8"), "persistent\n");
      rmSync(shortTemporaryRoot, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an exact fake cache and rejects archive or runtime drift", () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-fixed-code-server-"));
    try {
      const cacheRoot = resolve(root, "cache");
      const archivePath = resolve(cacheRoot, "release.tar.gz");
      const executable = resolve(cacheRoot, "runtime/bin/code-server");
      const galleryHook = resolve(cacheRoot, "runtime", EXTENSIONS_GALLERY_HOOK_PATH);
      mkdirSync(dirname(executable), { recursive: true });
      mkdirSync(dirname(galleryHook), { recursive: true });
      writeFileSync(archivePath, "fixed-release");
      writeFileSync(executable, "fixed-runtime");
      writeFileSync(
        galleryHook,
        "env.EXTENSIONS_GALLERY?JSON.parse(env.EXTENSIONS_GALLERY):product.extensionsGallery||{serviceUrl:'https://open-vsx.invalid'}",
      );
      const asset = {
        key: "test-arch",
        name: "fixed.tar.gz",
        size: readFileSync(archivePath).length,
        sha256: sha256File(archivePath),
      };
      const evidencePath = resolve(cacheRoot, FIXED_CODE_SERVER_EVIDENCE_FILE);
      const evidence = {
        schemaVersion: "chat-fixed-code-server-runtime.v1",
        version: FIXED_CODE_SERVER_VERSION,
        tagCommit: FIXED_CODE_SERVER_TAG_COMMIT,
        platform: asset.key,
        asset: asset.name,
        assetSha256: asset.sha256,
        runtimeManifestSha256: runtimeManifestSha256(resolve(cacheRoot, "runtime")),
      };
      writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
      assert.equal(validateCodeServerCache({ cacheRoot, asset }), true);
      assert.equal(runtimeSupportsManagedExtensionsGallery(resolve(cacheRoot, "runtime")), true);

      writeFileSync(
        galleryHook,
        "product.extensionsGallery={serviceUrl:'https://open-vsx.invalid'}",
      );
      evidence.runtimeManifestSha256 = runtimeManifestSha256(resolve(cacheRoot, "runtime"));
      writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
      assert.equal(
        validateCodeServerCache({ cacheRoot, asset }),
        false,
        "即使manifest evidence同步更新，缺少官方Gallery hook也必须失败关闭",
      );

      writeFileSync(
        galleryHook,
        "env.EXTENSIONS_GALLERY?JSON.parse(env.EXTENSIONS_GALLERY):product.extensionsGallery||{}",
      );
      evidence.runtimeManifestSha256 = runtimeManifestSha256(resolve(cacheRoot, "runtime"));
      writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
      assert.equal(validateCodeServerCache({ cacheRoot, asset }), true);
      writeFileSync(executable, "tampered-runtime");
      assert.equal(validateCodeServerCache({ cacheRoot, asset }), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("downloads fixed byte ranges in parallel without reordering the asset", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-ranges-"));
    try {
      const source = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
      const destination = resolve(root, "asset.bin");
      const ranges = [];
      await downloadReleaseAsset(
        "https://example.test/fixed",
        destination,
        source.length,
        async (_url, options) => {
          const range = options.headers.range;
          const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
          assert.ok(match);
          const start = Number(match[1]);
          const end = Number(match[2]);
          ranges.push([start, end]);
          return new Response(source.subarray(start, end + 1), {
            status: 206,
            headers: {
              "content-range": `bytes ${String(start)}-${String(end)}/${String(source.length)}`,
            },
          });
        },
      );
      assert.deepEqual(readFileSync(destination), source);
      assert.equal(ranges.length, 8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses an OS-released loopback lease as the preparation mutex", async () => {
    const first = await acquireCodeServerPrepareLease(0);
    await assert.rejects(acquireCodeServerPrepareLease(first.port), /准备租约端口 .* 已被占用/u);
    await first.release();

    const replacement = await acquireCodeServerPrepareLease(first.port);
    assert.equal(replacement.port, first.port);
    await replacement.release();
  });

  it("keeps production lease fixed and allows isolated debug/E2E lease injection", () => {
    assert.equal(resolveCodeServerPrepareLeasePort({}), 43_119);
    assert.equal(
      resolveCodeServerPrepareLeasePort({ CHAT_CODE_WORKBENCH_LEASE_PORT: "45319" }),
      45_319,
    );
    assert.throws(
      () => resolveCodeServerPrepareLeasePort({ CHAT_CODE_WORKBENCH_LEASE_PORT: "not-a-port" }),
      /有效TCP端口/u,
    );
    assert.throws(
      () => resolveCodeServerPrepareLeasePort({ CHAT_CODE_WORKBENCH_LEASE_PORT: "70000" }),
      /1024\.\.65535/u,
    );
  });

  it("recovers an abandoned preparation lock but refuses a live owner", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-lock-"));
    const lease = await acquireCodeServerPrepareLease(0);
    try {
      const lockPath = resolve(root, "runtime.prepare-lock");
      mkdirSync(lockPath);
      writeFileSync(resolve(lockPath, "owner.json"), JSON.stringify({ pid: 999_999_999 }));
      acquirePrepareLock(lockPath, lease);
      const current = readPrepareLockOwner(lockPath);
      assert.equal(current.pid, process.pid);
      assert.equal(Number.isFinite(current.processStartedAtMs), true);
      assert.match(current.token, /^[0-9a-f-]{36}$/u);
      assert.throws(() => acquirePrepareLock(lockPath, lease), /正在运行/u);
      releasePrepareLock(lockPath);
      const staleName = readdirSync(root).find((name) => name.includes(".stale-"));
      assert.ok(staleName);
      assert.equal(
        readFileSync(resolve(root, staleName, "owner.json"), "utf8").includes("999999999"),
        true,
      );
    } finally {
      await lease.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat a reused PID or a fresh incomplete owner as the same lock", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-lock-identity-"));
    const lease = await acquireCodeServerPrepareLease(0);
    try {
      const reusedPidLock = resolve(root, "reused.prepare-lock");
      mkdirSync(reusedPidLock);
      writeFileSync(
        resolve(reusedPidLock, "owner.json"),
        JSON.stringify({ pid: process.pid, processStartedAtMs: 0, token: "old-owner" }),
      );
      acquirePrepareLock(reusedPidLock, lease);
      const replacement = readPrepareLockOwner(reusedPidLock);
      assert.notEqual(replacement.token, "old-owner");
      releasePrepareLock(reusedPidLock);

      const incompleteLock = resolve(root, "incomplete.prepare-lock");
      mkdirSync(incompleteLock);
      assert.throws(() => acquirePrepareLock(incompleteLock, lease), /仍在初始化/u);
      assert.equal(readdirSync(incompleteLock).length, 0);
    } finally {
      await lease.release();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the service wrapper never spreads the parent environment to code-server", () => {
    const wrapperSource = readFileSync(
      resolve(repoRoot, "scripts/workbench/start-fixed-code-server.mjs"),
      "utf8",
    );
    const runtimeSource = readFileSync(
      resolve(repoRoot, "scripts/workbench/fixed-code-server.mjs"),
      "utf8",
    );
    assert.match(wrapperSource, /createSafeChildProcessEnvironment/u);
    assert.doesNotMatch(wrapperSource, /env:\s*\{\s*\.\.\.process\.env/u);
    assert.match(runtimeSource, /"chat\.disableAIFeatures": true/u);
    assert.match(runtimeSource, /"remote\.autoForwardPorts": false/u);
    assert.match(runtimeSource, /"telemetry\.telemetryLevel": "off"/u);
    assert.match(runtimeSource, /"telemetry\.enableTelemetry": false/u);
    assert.match(runtimeSource, /"telemetry\.enableCrashReporter": false/u);
    assert.match(wrapperSource, /"--disable-proxy"/u);
    assert.match(wrapperSource, /detached: true/u);
    assert.match(wrapperSource, /process\.kill\(-child\.pid/u);
    assert.match(wrapperSource, /Terminal后代/u);
    assert.equal(DISABLED_EXTENSIONS_GALLERY, "{}");
    assert.match(wrapperSource, /EXTENSIONS_GALLERY:\s*DISABLED_EXTENSIONS_GALLERY/u);
    assert.doesNotMatch(wrapperSource, /EXTENSIONS_GALLERY:\s*process\.env/u);
    assert.doesNotMatch(wrapperSource, /--disable-workspace-trust/u);
    assert.match(wrapperSource, /const instanceId = randomUUID\(\)/u);
    assert.ok(
      wrapperSource.indexOf("writeCodeServerStoppedTombstone") <
        wrapperSource.lastIndexOf("await serviceLease.release()"),
      "wrapper必须先发布stopped tombstone再释放43119",
    );
    assert.doesNotMatch(wrapperSource, /process\.once\("exit", cleanupTemporaryRoot\)/u);
  });

  it("uses only a private Unix socket and maps exactly CHAT_REPO_ROOT", () => {
    const source = readFileSync(
      resolve(repoRoot, "scripts/workbench/start-fixed-code-server.mjs"),
      "utf8",
    );
    assert.match(source, /"--socket",\s*socketPath/u);
    assert.match(source, /"--socket-mode",\s*"0600"/u);
    assert.doesNotMatch(source, /--bind-addr|43113/u);
    assert.match(source, /workspaceRoot !== managedRepoRoot/u);
    assert.doesNotMatch(source, /0\.0\.0\.0|--proxy-domain/u);
  });

  it("atomically migrates a v1 stopped tombstone without inspecting historical PIDs", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-v1-stopped-"));
    const runRoot = resolve(root, ".data/workbench/code-server");
    const evidencePath = resolve(runRoot, "service-process.json");
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(
      evidencePath,
      `${JSON.stringify({
        schemaVersion: "chat-code-server-process.v1",
        wrapperPid: 999_999_991,
        childPid: 999_999_992,
        port: 43_113,
        workspaceRoot: realpathSync(root),
        stoppedAt: "2026-08-17T00:00:00.000Z",
      })}\n`,
    );
    try {
      const result = await reconcileManagedWorkbench(root, {
        readEvidence: () =>
          readCodeServerProcessEvidence(root, { CHAT_CODE_WORKBENCH_RUN_ROOT: runRoot }),
        acquireLease: fakeRecoveryLease(),
        isAlive: () => {
          throw new Error("stopped tombstone不得检查历史PID");
        },
      });
      assert.equal(result.action, "migrated-legacy-stopped");
      assert.deepEqual(JSON.parse(readFileSync(evidencePath, "utf8")), {
        schemaVersion: "chat-code-server-process.v2",
        status: "stopped",
        workspaceRoot: realpathSync(root),
        stoppedAt: "2026-08-17T00:00:00.000Z",
        migratedFrom: "chat-code-server-process.v1",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers a v1 running wrapper and child only after exact legacy identity checks", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-v1-running-"));
    const evidencePath = resolve(root, "service-process.json");
    const startedAt = "2026-08-17T00:00:00.000Z";
    const alive = new Set([41, 42]);
    const terminations = [];
    const cacheRoot = resolve(root, "cache/code-server");
    try {
      const result = await reconcileManagedWorkbench(root, {
        readEvidence: () => ({
          schemaVersion: "chat-code-server-process.v1",
          status: "legacy-running",
          wrapperPid: 41,
          childPid: 42,
          startedAt,
          cacheRoot,
          workspaceRoot: root,
          evidencePath,
        }),
        isAlive: (pid) => alive.has(pid),
        describe: (pid) => ({
          startedAtMs: Date.parse(startedAt),
          command:
            pid === 41
              ? `node ${root}/scripts/workbench/start-fixed-code-server.mjs`
              : `${resolve(cacheRoot, "runtime/lib/node")} ${resolve(cacheRoot, "runtime")} --bind-addr 127.0.0.1:43113`,
        }),
        workingDirectory: () => root,
        findGitCommonDir: () => resolve(root, ".git"),
        acquireLease: fakeRecoveryLease(),
        terminate: (entry) => {
          terminations.push({ pid: entry.pid, scope: entry.killScope });
          alive.delete(entry.pid);
          return { action: "terminated" };
        },
      });
      assert.equal(result.action, "child-terminated");
      assert.deepEqual(terminations, [
        { pid: 41, scope: "process" },
        { pid: 42, scope: "group" },
      ]);
      assert.equal(JSON.parse(readFileSync(evidencePath, "utf8")).status, "stopped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers starting evidence without ever probing null as a PID", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-starting-"));
    const privateRoot = mkdtempSync(resolve(tmpdir(), "chat-cs-"));
    const evidencePath = resolve(root, "service-process.json");
    const startedAt = "2026-08-17T00:00:00.000Z";
    let wrapperAlive = true;
    try {
      const events = [];
      const result = await reconcileManagedWorkbench(root, {
        readEvidence: () => ({
          schemaVersion: "chat-code-server-process.v2",
          status: "starting",
          instanceId: "11111111-1111-4111-8111-111111111111",
          wrapperPid: 51,
          childPid: null,
          privateRoot,
          socketPath: resolve(privateRoot, "workbench.sock"),
          cacheRoot: resolve(root, "cache/code-server"),
          wrapperStartedAt: startedAt,
          workspaceRoot: root,
          evidencePath,
        }),
        isAlive: (pid) => {
          assert.equal(Number.isInteger(pid), true, "null不得进入PID存活检查");
          return pid === 51 && wrapperAlive;
        },
        describe: () => ({
          startedAtMs: Date.parse(startedAt),
          command: `node ${root}/scripts/workbench/start-fixed-code-server.mjs`,
        }),
        workingDirectory: () => root,
        findGitCommonDir: () => resolve(root, ".git"),
        terminate: () => {
          events.push("wrapper-terminated");
          wrapperAlive = false;
          return { action: "terminated" };
        },
        acquireLease: async () => {
          events.push("lease-acquired");
          return {
            async release() {
              assert.equal(existsSync(privateRoot), false, "release前必须先清理privateRoot");
              assert.equal(
                JSON.parse(readFileSync(evidencePath, "utf8")).status,
                "stopped",
                "release前必须先原子发布tombstone",
              );
              events.push("lease-released");
            },
          };
        },
      });
      assert.equal(result.action, "wrapper-terminated");
      assert.deepEqual(events, ["wrapper-terminated", "lease-acquired", "lease-released"]);
      assert.equal(existsSync(privateRoot), false);
      assert.equal(JSON.parse(readFileSync(evidencePath, "utf8")).status, "stopped");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(privateRoot, { recursive: true, force: true });
    }
  });

  it("writes a readable minimal stopped tombstone without historical process identity", () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-stopped-v2-"));
    const runRoot = resolve(root, ".data/workbench/code-server");
    const evidencePath = resolve(runRoot, "service-process.json");
    const instanceId = "22222222-2222-4222-8222-222222222222";
    mkdirSync(runRoot, { recursive: true });
    try {
      writeCodeServerStoppedTombstone(evidencePath, {
        workspaceRoot: realpathSync(root),
        instanceId,
        stoppedAt: "2026-08-17T01:00:00.000Z",
      });
      const evidence = readCodeServerProcessEvidence(root, {
        CHAT_CODE_WORKBENCH_RUN_ROOT: runRoot,
      });
      assert.deepEqual(
        {
          status: evidence.status,
          instanceId: evidence.instanceId,
          wrapperPid: evidence.wrapperPid,
          childPid: evidence.childPid,
          privateRoot: evidence.privateRoot,
          socketPath: evidence.socketPath,
          cacheRoot: evidence.cacheRoot,
        },
        {
          status: "stopped",
          instanceId,
          wrapperPid: undefined,
          childPid: undefined,
          privateRoot: undefined,
          socketPath: undefined,
          cacheRoot: undefined,
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a stale reconciler after a new instance takes over the evidence", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "chat-code-server-handoff-"));
    const privateRoot = mkdtempSync(resolve(tmpdir(), "chat-cs-"));
    const evidencePath = resolve(root, "service-process.json");
    const startedAt = "2026-08-17T02:00:00.000Z";
    const cacheRoot = resolve(root, "cache/code-server");
    const oldEvidence = {
      schemaVersion: "chat-code-server-process.v2",
      status: "running",
      instanceId: "33333333-3333-4333-8333-333333333333",
      wrapperPid: 61,
      childPid: 62,
      privateRoot,
      socketPath: resolve(privateRoot, "workbench.sock"),
      cacheRoot,
      wrapperStartedAt: startedAt,
      childStartedAt: startedAt,
      workspaceRoot: root,
      evidencePath,
    };
    const newEvidence = {
      ...oldEvidence,
      instanceId: "44444444-4444-4444-8444-444444444444",
      wrapperPid: 71,
      childPid: 72,
      privateRoot: resolve(tmpdir(), "chat-cs-new-instance"),
      socketPath: resolve(tmpdir(), "chat-cs-new-instance/workbench.sock"),
    };
    const alive = new Set([61, 62]);
    const events = [];
    let currentEvidence = oldEvidence;
    try {
      writeFileSync(evidencePath, `${JSON.stringify(oldEvidence)}\n`);
      await assert.rejects(
        reconcileManagedWorkbench(root, {
          readEvidence: () => currentEvidence,
          isAlive: (pid) => alive.has(pid),
          describe: (pid) => ({
            startedAtMs: Date.parse(startedAt),
            command:
              pid === 61
                ? `node ${root}/scripts/workbench/start-fixed-code-server.mjs`
                : `${resolve(cacheRoot, "runtime/lib/node")} ${resolve(cacheRoot, "runtime")} --socket ${oldEvidence.socketPath}`,
          }),
          workingDirectory: () => root,
          findGitCommonDir: () => resolve(root, ".git"),
          terminate: (entry) => {
            events.push(`terminated-${String(entry.pid)}`);
            alive.delete(entry.pid);
            return { action: "terminated" };
          },
          acquireLease: async () => {
            events.push("lease-acquired");
            currentEvidence = newEvidence;
            writeFileSync(evidencePath, `${JSON.stringify(newEvidence)}\n`);
            return {
              async release() {
                events.push("lease-released");
              },
            };
          },
        }),
        /另一instance接管/u,
      );
      assert.deepEqual(events, [
        "terminated-61",
        "terminated-62",
        "lease-acquired",
        "lease-released",
      ]);
      assert.equal(existsSync(privateRoot), true, "旧reconciler不得在generation不匹配时删目录");
      assert.equal(
        JSON.parse(readFileSync(evidencePath, "utf8")).instanceId,
        newEvidence.instanceId,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(privateRoot, { recursive: true, force: true });
    }
  });
});
