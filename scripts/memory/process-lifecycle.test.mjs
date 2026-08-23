import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MEMORY_PROCESS_EVIDENCE_SCHEMA,
  createMemorySidecarContract,
  readMemoryProcessEvidence,
  reconcileManagedMemorySidecar,
  reconcileSelectedMemorySidecars,
  secureMemoryDataTree,
  writeMemoryRunningEvidence,
} from "./process-lifecycle.mjs";

const STARTED_AT = "2026-08-23T12:34:56.000Z";

function fixtureContract(runRoot = "/workspace/chat/.data/test-memory") {
  return createMemorySidecarContract({
    root: "/workspace/chat",
    provider: "memmy",
    runtimeInstance: "debug",
    sourceCommit: "a".repeat(40),
    port: 19_960,
    runRoot,
    childCwd: "/workspace/cache/memmy",
    commandFragments: ["/workspace/cache/memmy/server.js", "--port", "19960"],
  });
}

function runningEvidence(contract, overrides = {}) {
  return Object.freeze({
    schemaVersion: MEMORY_PROCESS_EVIDENCE_SCHEMA,
    provider: "memmy",
    status: "running",
    instanceId: "11111111-1111-4111-8111-111111111111",
    runtimeInstance: "debug",
    sourceCommit: "a".repeat(40),
    port: 19_960,
    runRoot: contract.runRoot,
    childCwd: contract.childCwd,
    wrapperPid: 70,
    childPid: 71,
    childProcessGroupId: 71,
    childStartedAt: STARTED_AT,
    ...overrides,
  });
}

function liveDependencies(contract, evidence, overrides = {}) {
  const state = {
    alive: true,
    groupAlive: true,
    listener: evidence.childPid,
    now: 0,
    current: evidence,
    signals: [],
  };
  return {
    state,
    options: {
      readEvidence: () => state.current,
      writeStopped: (_contract, instanceId) => {
        state.current = { status: "stopped", instanceId };
      },
      describe: () => ({
        startedAtMs: Date.parse(STARTED_AT),
        command: `${process.execPath} ${contract.commandFragments.join(" ")}`,
      }),
      workingDirectory: () => contract.childCwd,
      listener: () => state.listener,
      processGroup: () => evidence.childProcessGroupId,
      isAlive: () => state.alive,
      groupAlive: () => state.groupAlive,
      signalGroup: (_group, signal) => {
        state.signals.push(signal);
        state.alive = false;
        state.groupAlive = false;
        state.listener = null;
      },
      sleep: (milliseconds) => {
        state.now += milliseconds;
      },
      now: () => state.now,
      ...overrides,
    },
  };
}

test("v2 evidence原子发布并保留严格秒级child start time", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "chat-memory-process-"));
  try {
    const contract = fixtureContract(temporaryRoot);
    writeMemoryRunningEvidence(contract, {
      instanceId: "11111111-1111-4111-8111-111111111111",
      wrapperPid: 70,
      childPid: 71,
      childProcessGroupId: 71,
      childStartedAt: "2026-08-23T12:34:56.789Z",
    });
    const evidence = readMemoryProcessEvidence(contract);
    assert.equal(evidence.schemaVersion, MEMORY_PROCESS_EVIDENCE_SCHEMA);
    assert.equal(evidence.childStartedAt, STARTED_AT);
    assert.equal(evidence.childProcessGroupId, evidence.childPid);
    assert.equal(readFileSync(contract.evidencePath, "utf8").endsWith("\n"), true);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Memory数据树收紧为目录0700/文件0600且拒绝符号链接", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "chat-memory-private-"));
  const nested = join(temporaryRoot, "nested");
  const content = join(nested, "memory.sqlite");
  const outside = mkdtempSync(join(tmpdir(), "chat-memory-outside-"));
  try {
    mkdirSync(nested, { mode: 0o755 });
    writeFileSync(content, "private", { mode: 0o644 });
    chmodSync(temporaryRoot, 0o755);
    secureMemoryDataTree(temporaryRoot);
    assert.equal(statSync(temporaryRoot).mode & 0o777, 0o700);
    assert.equal(statSync(nested).mode & 0o777, 0o700);
    assert.equal(statSync(content).mode & 0o777, 0o600);

    symlinkSync(outside, join(nested, "escape"));
    assert.throws(() => secureMemoryDataTree(temporaryRoot), /不允许符号链接/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("损坏evidence失败关闭并原样保留，不会进入任何signal路径", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "chat-memory-process-corrupt-"));
  try {
    const contract = fixtureContract(temporaryRoot);
    writeFileSync(contract.evidencePath, "{broken", { encoding: "utf8", mode: 0o600 });
    assert.throws(() => readMemoryProcessEvidence(contract), /证据损坏/u);
    assert.equal(readFileSync(contract.evidencePath, "utf8"), "{broken");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("完整身份连续复核两次后只向独立child process group发送TERM", () => {
  const contract = fixtureContract();
  const evidence = runningEvidence(contract);
  const { state, options } = liveDependencies(contract, evidence);
  const result = reconcileManagedMemorySidecar(contract, options);
  assert.deepEqual(result, { provider: "memmy", action: "terminated" });
  assert.deepEqual(state.signals, ["SIGTERM"]);
  assert.equal(state.current.status, "stopped");
});

test("TERM未退出时在第三次身份复核后才升级同一组KILL", () => {
  const contract = fixtureContract();
  const evidence = runningEvidence(contract);
  const { state, options } = liveDependencies(contract, evidence, {
    signalGroup: (_group, signal) => {
      state.signals.push(signal);
      if (signal === "SIGKILL") {
        state.alive = false;
        state.groupAlive = false;
        state.listener = null;
      }
    },
  });
  const result = reconcileManagedMemorySidecar(contract, {
    ...options,
    termWaitMs: 1,
  });
  assert.deepEqual(result, { provider: "memmy", action: "killed" });
  assert.deepEqual(state.signals, ["SIGTERM", "SIGKILL"]);
});

test("listener/start秒/命令/cwd/实例/commit/process-group任一不符都零signal失败关闭", () => {
  const cases = [
    {
      name: "listener",
      evidence: {},
      dependencies: { listener: () => 999 },
    },
    {
      name: "start-second",
      evidence: {},
      dependencies: {
        describe: () => ({
          startedAtMs: Date.parse(STARTED_AT) + 1_000,
          command: "server.js --port 19960",
        }),
      },
    },
    {
      name: "command",
      evidence: {},
      dependencies: { describe: () => ({ startedAtMs: Date.parse(STARTED_AT), command: "other" }) },
    },
    { name: "cwd", evidence: {}, dependencies: { workingDirectory: () => "/other" } },
    { name: "instance", evidence: { runtimeInstance: "production" }, dependencies: {} },
    { name: "commit", evidence: { sourceCommit: "b".repeat(40) }, dependencies: {} },
    { name: "process-group", evidence: {}, dependencies: { processGroup: () => 88 } },
  ];
  for (const currentCase of cases) {
    const contract = fixtureContract();
    const evidence = runningEvidence(contract, currentCase.evidence);
    const { state, options } = liveDependencies(contract, evidence, currentCase.dependencies);
    assert.throws(
      () => reconcileManagedMemorySidecar(contract, options),
      /未发送信号|未发送后续信号/u,
      currentCase.name,
    );
    assert.deepEqual(state.signals, [], currentCase.name);
  }
});

test("第二次复读发现instance变化时零signal", () => {
  const contract = fixtureContract();
  const evidence = runningEvidence(contract);
  const { state, options } = liveDependencies(contract, evidence);
  let reads = 0;
  options.readEvidence = () => {
    reads += 1;
    return reads === 1
      ? evidence
      : runningEvidence(contract, {
          instanceId: "22222222-2222-4222-8222-222222222222",
        });
  };
  assert.throws(() => reconcileManagedMemorySidecar(contract, options), /evidence在TERM前变化/u);
  assert.deepEqual(state.signals, []);
});

test("child、listener和进程组都已退出时只收敛stale evidence而不发signal", () => {
  const contract = fixtureContract();
  const evidence = runningEvidence(contract);
  const { state, options } = liveDependencies(contract, evidence, {
    isAlive: () => false,
    groupAlive: () => false,
    listener: () => null,
  });
  const result = reconcileManagedMemorySidecar(contract, options);
  assert.deepEqual(result, { provider: "memmy", action: "stale-evidence" });
  assert.deepEqual(state.signals, []);
  assert.equal(state.current.status, "stopped");
});

test("starting evidence缺少child身份时零signal失败关闭", () => {
  const contract = fixtureContract();
  const signals = [];
  assert.throws(
    () =>
      reconcileManagedMemorySidecar(contract, {
        readEvidence: () => ({
          ...runningEvidence(contract),
          status: "starting",
          childPid: undefined,
          childProcessGroupId: undefined,
          childStartedAt: undefined,
        }),
        signalGroup: (...args) => signals.push(args),
      }),
    /缺少可安全回收/u,
  );
  assert.deepEqual(signals, []);
});

test("旧v1 running证据仅在wrapper、child和端口都确认退出后零signal迁移", () => {
  const contract = fixtureContract();
  const legacy = {
    status: "legacy-running",
    raw: {
      schemaVersion: "chat-fixed-memmy-process.v1",
      wrapperPid: 101,
      childPid: 102,
    },
  };
  const state = { current: legacy, writes: [], signals: [] };
  const result = reconcileManagedMemorySidecar(contract, {
    readEvidence: () => state.current,
    isAlive: () => false,
    listener: () => null,
    writeStopped: (_contract, _instanceId, extra) => {
      state.writes.push(extra);
      state.current = { status: "stopped" };
    },
    signalGroup: (...args) => state.signals.push(args),
  });
  assert.deepEqual(result, {
    provider: "memmy",
    action: "migrated-stale-legacy-running",
  });
  assert.deepEqual(state.signals, []);
  assert.deepEqual(state.writes, [
    {
      migratedFrom: "chat-fixed-memmy-process.v1",
      legacyProcessesConfirmedExited: true,
    },
  ]);
});

test("旧v1 running证据只要PID或端口仍活跃就零signal失败关闭", () => {
  const contract = fixtureContract();
  const legacy = {
    status: "legacy-running",
    raw: {
      schemaVersion: "chat-fixed-memmy-process.v1",
      wrapperPid: 101,
      childPid: 102,
    },
  };
  for (const currentCase of [
    { name: "wrapper alive", isAlive: (pid) => pid === 101, listener: () => null },
    { name: "child alive", isAlive: (pid) => pid === 102, listener: () => null },
    { name: "port occupied", isAlive: () => false, listener: () => 999 },
  ]) {
    const signals = [];
    assert.throws(
      () =>
        reconcileManagedMemorySidecar(contract, {
          readEvidence: () => legacy,
          isAlive: currentCase.isAlive,
          listener: currentCase.listener,
          signalGroup: (...args) => signals.push(args),
        }),
      /仍可能对应活动进程/u,
      currentCase.name,
    );
    assert.deepEqual(signals, [], currentCase.name);
  }
});

test("memory=off在合同枚举前返回且绝不读取evidence", () => {
  const result = reconcileSelectedMemorySidecars(
    {
      root: "/workspace/chat",
      runtime: {},
      memory: "off",
    },
    {
      createContracts: () => assert.fail("off不得推导路径或读取evidence"),
      reconcile: () => assert.fail("off不得进入reconciler"),
    },
  );
  assert.deepEqual(result, []);
});
