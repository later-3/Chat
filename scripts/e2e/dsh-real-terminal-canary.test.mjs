import assert from "node:assert/strict";
import test from "node:test";

import { assertDshRealTerminalCanaryProcessIdentity } from "./dsh-real-terminal-canary.mjs";
import {
  DSH_REAL_RELEASED_PORTS,
  waitForDshRealPortsReleased,
} from "./dsh-real-workbench-lifecycle.mjs";

const startedAt = "2026-08-17T01:02:03.000Z";
const canary = "chat-dsh-workbench-terminal-12345678-1234-1234-1234-123456789abc";
const evidence = Object.freeze({
  schemaVersion: "chat-dsh-terminal-canary.v1",
  pid: 300,
  startedAt,
  command: `/usr/bin/node -e script ${canary}`,
  commandFragments: [canary],
  canary,
  cwd: "/fixture",
  workspaceRoot: "/fixture",
  codeServerChildPid: 200,
  codeServerInstanceId: "12345678-1234-1234-1234-123456789abc",
  recordedAt: startedAt,
  evidencePath: "/fixture/.data/code-server/terminal-process.json",
});

function dependencies(overrides = {}) {
  return {
    isAlive: () => true,
    describe: () => ({ startedAtMs: Date.parse(startedAt), command: evidence.command }),
    workingDirectory: () => "/fixture",
    findGitCommonDir: () => "/fixture/.git",
    findParentPid: (pid) => (pid === 300 ? 200 : 1),
    ...overrides,
  };
}

test("Terminal canary同时复核argv、精确启动时间、cwd/Git与code-server后代链", () => {
  assert.equal(assertDshRealTerminalCanaryProcessIdentity(evidence, dependencies()), evidence);
});

test("Terminal canary对PID复用和任一身份偏差失败关闭", () => {
  assert.throws(
    () =>
      assertDshRealTerminalCanaryProcessIdentity(evidence, dependencies({ isAlive: () => false })),
    /提前退出/u,
  );
  assert.throws(
    () =>
      assertDshRealTerminalCanaryProcessIdentity(
        evidence,
        dependencies({
          describe: () => ({
            startedAtMs: Date.parse(startedAt),
            command: `${evidence.command} --pid-reused`,
          }),
        }),
      ),
    /PID\/命令\/启动时间/u,
  );
  // 只偏差1秒仍落在共享debug helper的宽容差内；E2E证据要求精确OS启动秒。
  assert.throws(
    () =>
      assertDshRealTerminalCanaryProcessIdentity(
        evidence,
        dependencies({
          describe: () => ({
            startedAtMs: Date.parse(startedAt) + 1_000,
            command: evidence.command,
          }),
        }),
      ),
    /PID\/命令\/启动时间/u,
  );
  assert.throws(
    () =>
      assertDshRealTerminalCanaryProcessIdentity(
        evidence,
        dependencies({ workingDirectory: () => "/other" }),
      ),
    /cwd\/Git/u,
  );
  assert.throws(
    () =>
      assertDshRealTerminalCanaryProcessIdentity(
        evidence,
        dependencies({ findParentPid: () => 1 }),
      ),
    /不是已记录code-server child后代/u,
  );
});

test("Playwright外层完成门固定复核Gateway、退役端口、内部DSH与Workbench租约", async () => {
  assert.deepEqual(DSH_REAL_RELEASED_PORTS, [43_110, 43_113, 43_114, 43_119]);
  let firstPortAttempts = 0;
  const result = await waitForDshRealPortsReleased({
    timeoutMs: 1_000,
    ports: [1, 2],
    probe: async (port) => {
      if (port !== 1) return true;
      firstPortAttempts += 1;
      return firstPortAttempts >= 2;
    },
    pause: async () => undefined,
  });
  assert.deepEqual(result, [1, 2]);
  assert.equal(firstPortAttempts, 2);

  await assert.rejects(
    waitForDshRealPortsReleased({
      timeoutMs: 0,
      ports: [9],
      probe: async () => false,
      pause: async () => undefined,
    }),
    /固定端口仍不可绑定：9/u,
  );
});
