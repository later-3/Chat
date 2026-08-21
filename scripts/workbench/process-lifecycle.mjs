import { rmSync } from "node:fs";
import { resolve } from "node:path";

import {
  ROLE_COMMAND_FRAGMENTS,
  describeProcess,
  gitCommonDirForPath,
  identityMatches,
  isEffectivelyAlive,
  processWorkingDirectory,
  terminateEntry,
} from "../debug/lib.mjs";
import {
  acquireCodeServerPrepareLease,
  readCodeServerProcessEvidence,
  resolveCodeServerPrepareLeasePort,
  writeCodeServerStoppedTombstone,
} from "./fixed-code-server.mjs";

function sameEvidenceInstance(expected, current) {
  if (expected === undefined || current === undefined) return false;
  if (typeof expected.instanceId === "string") {
    return current.instanceId === expected.instanceId;
  }
  // v1没有instanceId，只能使用其冻结的wrapper/child/workspace组合完成一次迁移。
  return (
    expected.schemaVersion === "chat-code-server-process.v1" &&
    current.schemaVersion === expected.schemaVersion &&
    current.workspaceRoot === expected.workspaceRoot &&
    current.wrapperPid === expected.wrapperPid &&
    current.childPid === expected.childPid
  );
}

function writeStoppedTombstone(evidence, extra = {}) {
  return writeCodeServerStoppedTombstone(evidence.evidencePath, {
    workspaceRoot: evidence.workspaceRoot,
    ...(typeof evidence.instanceId === "string" ? { instanceId: evidence.instanceId } : {}),
    stoppedAt: evidence.stoppedAt ?? new Date().toISOString(),
    ...extra,
  });
}

async function withRecoveryLease({ expected, root, readEvidence, acquireLease, operation }) {
  const lease = await acquireLease();
  try {
    const current = readEvidence(root);
    if (!sameEvidenceInstance(expected, current)) {
      throw new Error(
        "code-server evidence已由另一instance接管；旧reconciler已拒绝清理目录或覆盖tombstone",
      );
    }
    return await operation(current);
  } finally {
    await lease.release();
  }
}

/**
 * Unix socket无法靠固定服务端口反查。这里用受管evidence、PID启动时间、完整命令、
 * cwd与Git Common Directory共同证明旧wrapper/child身份；任一不符都保留证据并失败关闭。
 *
 * 恢复者只能在旧进程退出后取得当前实例自己的租约端口，并在租约内复读同一instance；这样新wrapper
 * 即使紧邻旧wrapper退出启动，也不会被旧恢复者删除socket或覆盖evidence。
 */
export async function reconcileManagedWorkbench(root, options = {}) {
  const {
    readEvidence = readCodeServerProcessEvidence,
    environment = process.env,
    isAlive = isEffectivelyAlive,
    describe = describeProcess,
    workingDirectory = processWorkingDirectory,
    findGitCommonDir = gitCommonDirForPath,
    terminate = terminateEntry,
  } = options;
  const acquireLease =
    options.acquireLease ??
    (() => acquireCodeServerPrepareLease(resolveCodeServerPrepareLeasePort(environment)));
  const evidence = readEvidence(root);
  if (evidence === undefined) return { action: "no-evidence" };
  if (evidence.status === "legacy-stopped") {
    return withRecoveryLease({
      expected: evidence,
      root,
      readEvidence,
      acquireLease,
      operation(current) {
        writeStoppedTombstone(current, { migratedFrom: "chat-code-server-process.v1" });
        return { action: "migrated-legacy-stopped" };
      },
    });
  }
  if (evidence.status === "stopped" && evidence.privateRoot === undefined) {
    // 最小tombstone不携带可复用PID或可删除路径，读取它永远不得触碰历史进程。
    return { action: "already-stopped" };
  }

  const rootCommonDirectory = findGitCommonDir(root);
  if (rootCommonDirectory === null) {
    throw new Error("无法复核旧code-server所属Git仓库；已保留进程证据并拒绝启动");
  }
  const assertIdentity = (pid, kind) => {
    const description = describe(pid);
    const cwd = workingDirectory(pid);
    const expectedFragments =
      kind === "wrapper"
        ? ROLE_COMMAND_FRAGMENTS.workbench
        : evidence.status === "legacy-running"
          ? [resolve(evidence.cacheRoot, "runtime"), "--bind-addr", "127.0.0.1:43113"]
          : [resolve(evidence.cacheRoot, "runtime"), "--socket", evidence.socketPath];
    const entry = {
      role: "workbench",
      pid,
      killScope: kind === "wrapper" ? "process" : "group",
      startedAt:
        evidence.status === "legacy-running"
          ? evidence.startedAt
          : kind === "wrapper"
            ? evidence.wrapperStartedAt
            : evidence.childStartedAt,
      commandFragments: expectedFragments,
    };
    if (
      cwd !== evidence.workspaceRoot ||
      findGitCommonDir(cwd) !== rootCommonDirectory ||
      !identityMatches(entry, description)
    ) {
      throw new Error(
        `旧code-server ${kind}身份不匹配；已保留进程证据且未向pid=${String(pid)}发送信号`,
      );
    }
    return entry;
  };

  let action = `stale-${evidence.status}-evidence`;
  if (evidence.status !== "stopped" && isAlive(evidence.wrapperPid)) {
    const result = terminate(assertIdentity(evidence.wrapperPid, "wrapper"));
    if (!["terminated", "killed", "already-exited"].includes(result.action)) {
      throw new Error(`旧code-server wrapper未能安全回收：${result.action}`);
    }
    action = `wrapper-${result.action}`;
  }
  if (Number.isInteger(evidence.childPid) && isAlive(evidence.childPid)) {
    let entry;
    try {
      entry = assertIdentity(evidence.childPid, "child");
    } catch (error) {
      if (evidence.status === "stopped") {
        return { action: "stopped-historical-identity-mismatch" };
      }
      throw error;
    }
    const result = terminate(entry);
    if (!["terminated", "killed", "already-exited"].includes(result.action)) {
      throw new Error(`旧code-server child未能安全回收：${result.action}`);
    }
    action =
      evidence.status === "stopped" ? `stopped-orphan-${result.action}` : `child-${result.action}`;
  }
  if (
    (evidence.status !== "stopped" && isAlive(evidence.wrapperPid)) ||
    (Number.isInteger(evidence.childPid) && isAlive(evidence.childPid))
  ) {
    throw new Error("旧code-server回收后仍有受管进程存活；拒绝启动第二套服务");
  }

  return withRecoveryLease({
    expected: evidence,
    root,
    readEvidence,
    acquireLease,
    operation(current) {
      // 正常wrapper已在释放lease前完成清理并发布同instance的最小tombstone。
      if (current.status === "stopped" && current.privateRoot === undefined) return { action };
      if (current.privateRoot !== undefined) {
        rmSync(current.privateRoot, { recursive: true, force: true });
      }
      writeStoppedTombstone(current, {
        recoveredAt: new Date().toISOString(),
        ...(current.status === "legacy-running"
          ? { migratedFrom: "chat-code-server-process.v1" }
          : {}),
      });
      return { action };
    },
  });
}
