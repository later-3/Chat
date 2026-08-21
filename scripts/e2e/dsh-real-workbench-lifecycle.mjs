import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { isEffectivelyAlive } from "../debug/lib.mjs";
import { readCodeServerProcessEvidence } from "../workbench/fixed-code-server.mjs";
import { reconcileManagedWorkbench } from "../workbench/process-lifecycle.mjs";
import {
  DSH_REAL_E2E_PORTS,
  dshRealWorkbenchEnvironment,
  resolveDshRealWorkbenchFixtureRoot,
} from "./dsh-real-environment.mjs";
import {
  assertDshRealTerminalCanaryAlive,
  assertDshRealTerminalCanaryStopped,
  readDshRealTerminalCanaryEvidence,
} from "./dsh-real-terminal-canary.mjs";

export const DSH_REAL_RELEASED_PORTS = Object.freeze([
  DSH_REAL_E2E_PORTS.web,
  DSH_REAL_E2E_PORTS.api,
  DSH_REAL_E2E_PORTS.workflow,
  DSH_REAL_E2E_PORTS.webInternal,
  DSH_REAL_E2E_PORTS.piExecutor,
  DSH_REAL_E2E_PORTS.workbenchLease,
]);

async function canBindPort(port) {
  const server = createServer();
  return await new Promise((resolveListen) => {
    server.once("error", () => resolveListen(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => resolveListen(error === undefined));
    });
  });
}

async function assertLeasePortReleased() {
  if (!(await canBindPort(DSH_REAL_E2E_PORTS.workbenchLease))) {
    throw new Error(
      `Workbench E2E清理后${String(DSH_REAL_E2E_PORTS.workbenchLease)}租约仍不可绑定`,
    );
  }
}

/** Playwright子进程完全退出后调用；此时Gateway与内部DSH也必须已经释放。 */
export async function waitForDshRealPortsReleased({
  timeoutMs = 10_000,
  ports = DSH_REAL_RELEASED_PORTS,
  probe = canBindPort,
  pause = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let occupied = [...ports];
  while (Date.now() < deadline) {
    occupied = [];
    for (const port of ports) {
      if (!(await probe(port))) occupied.push(port);
    }
    if (occupied.length === 0) return ports;
    await pause(100);
  }
  throw new Error(`Workbench E2E结束后固定端口仍不可绑定：${occupied.join(",")}`);
}

/**
 * Playwright强退时webServer的wrapper可能先死而PTY child仍存活。清理必须在删除
 * `.data/e2e/dsh-real`前读取受管evidence，并把调用方冻结的run/temp/cache合同显式
 * 传给reader；绝不能从evidence反向信任路径，也不能直接按残留PID发送信号。
 */
export async function cleanupDshRealWorkbench(root, { environment = process.env } = {}) {
  const repoRoot = resolve(root);
  const fixtureRoot = resolveDshRealWorkbenchFixtureRoot(repoRoot);
  const workbenchEnvironment = dshRealWorkbenchEnvironment(repoRoot, environment);
  const readEvidence = (workspaceRoot) =>
    readCodeServerProcessEvidence(workspaceRoot, workbenchEnvironment);
  const before = readEvidence(fixtureRoot);
  const terminalBefore = readDshRealTerminalCanaryEvidence(repoRoot);
  if (terminalBefore !== undefined && isEffectivelyAlive(terminalBefore.pid)) {
    assertDshRealTerminalCanaryAlive(repoRoot, {
      environment,
      requireRunningWorkbench: before?.status === "running",
    });
  }
  const result = await reconcileManagedWorkbench(fixtureRoot, {
    readEvidence,
    environment: workbenchEnvironment,
  });

  if (
    result.action === "stopped-historical-identity-mismatch" ||
    result.action.endsWith("identity-mismatch")
  ) {
    throw new Error(`Workbench E2E受管进程身份无法证明，拒绝伪装清理成功：${result.action}`);
  }
  if (before?.privateRoot !== undefined && existsSync(before.privateRoot)) {
    throw new Error("Workbench E2E清理后privateRoot仍存在");
  }
  if (before?.socketPath !== undefined && existsSync(before.socketPath)) {
    throw new Error("Workbench E2E清理后Unix socket仍存在");
  }
  if (["starting", "running", "legacy-running"].includes(before?.status)) {
    for (const pid of [before.wrapperPid, before.childPid]) {
      if (Number.isInteger(pid) && isEffectivelyAlive(pid)) {
        throw new Error(`Workbench E2E清理后受管进程pid=${String(pid)}仍存活`);
      }
    }
  }

  const after = readEvidence(fixtureRoot);
  if (after !== undefined && after.status !== "stopped") {
    throw new Error(`Workbench E2E清理后evidence未进入v2 stopped：${after.status}`);
  }
  const terminalAfter = assertDshRealTerminalCanaryStopped(repoRoot);
  await assertLeasePortReleased();
  return Object.freeze({ action: result.action, before, after, terminalBefore, terminalAfter });
}

export default async function dshRealGlobalTeardown() {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const result = await cleanupDshRealWorkbench(repoRoot);
  console.log(`[e2e-cleanup] Workbench受管进程已收敛：${result.action}`);
}
