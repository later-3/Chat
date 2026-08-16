import { pathToFileURL } from "node:url";

import {
  checkPorts,
  formatRetiredPortStatus,
  isEffectivelyAlive,
  loadPidEntries,
  probeRetiredPorts,
  repoRoot,
} from "../debug/lib.mjs";
import {
  probeCodeServerSocketReady,
  readCodeServerProcessEvidence,
} from "../workbench/fixed-code-server.mjs";
import { resolveLocalWorkbenchRuntimeContract } from "./app-runtime.mjs";

const ACTIVE_OR_UNCERTAIN_WORKBENCH_STATUSES = new Set(["starting", "running", "legacy-running"]);
const STOPPED_WORKBENCH_STATUSES = new Set(["stopped", "legacy-stopped"]);

/**
 * status与launcher分别运行，必须从同一repo/env重建受信run/temp/cache合同；evidence只提供
 * 被校验的数据，绝不能反向决定status信任哪个目录或缓存。
 */
export async function collectLocalRuntimeStatus({
  root = repoRoot(),
  environment = process.env,
  loadEntries = loadPidEntries,
  check = checkPorts,
  probeRetired = probeRetiredPorts,
  readWorkbenchEvidence = readCodeServerProcessEvidence,
  probeWorkbench = probeCodeServerSocketReady,
  isAlive = isEffectivelyAlive,
  resolveWorkbenchContract = resolveLocalWorkbenchRuntimeContract,
} = {}) {
  const entries = loadEntries();
  const occupied = check();
  const retiredPortResults = await probeRetired();
  let retiredDiagnostics = [];
  try {
    retiredDiagnostics = check(retiredPortResults.map((result) => result.port));
  } catch {
    // PID工具只补诊断；状态始终来自Node独占bind探针。
  }
  const lines = retiredPortResults.map((result) =>
    formatRetiredPortStatus(
      result,
      retiredDiagnostics.find((item) => item.port === result.port),
    ),
  );
  const retiredPortsAreFree = retiredPortResults.every((result) => result.state === "free");
  const workbenchContract = resolveWorkbenchContract(root, environment);
  const workbenchEvidence = readWorkbenchEvidence(root, workbenchContract);
  const workbenchIsActiveOrUncertain = ACTIVE_OR_UNCERTAIN_WORKBENCH_STATUSES.has(
    workbenchEvidence?.status,
  );
  const workbenchIsExplicitlyStopped = STOPPED_WORKBENCH_STATUSES.has(workbenchEvidence?.status);
  let workbenchSocketReady = false;
  if (workbenchEvidence?.status === "running") {
    try {
      await probeWorkbench(root, { environment: workbenchContract });
      workbenchSocketReady = true;
    } catch {
      workbenchSocketReady = false;
    }
  }

  if (workbenchEvidence !== undefined) {
    if (workbenchEvidence.status === "running") {
      lines.push(
        `[chat] ${workbenchSocketReady ? "healthy" : "unhealthy"} workbench transport=unix-socket instanceId=${String(workbenchEvidence.instanceId)} wrapperPid=${String(workbenchEvidence.wrapperPid)} childPid=${String(workbenchEvidence.childPid)}`,
      );
    } else if (workbenchIsActiveOrUncertain) {
      lines.push(
        `[chat] uncertain(${workbenchEvidence.status}) workbench transport=unix-socket instanceId=${String(workbenchEvidence.instanceId ?? "legacy")} wrapperPid=${String(workbenchEvidence.wrapperPid)} childPid=${String(workbenchEvidence.childPid)}`,
      );
    } else {
      lines.push(
        `[chat] 已停止 workbench transport=unix-socket instanceId=${String(workbenchEvidence.instanceId ?? "legacy")}`,
      );
    }
  }

  if (
    entries.length === 0 &&
    occupied.length === 0 &&
    retiredPortsAreFree &&
    (workbenchEvidence === undefined || workbenchIsExplicitlyStopped) &&
    !workbenchSocketReady
  ) {
    lines.push("[chat] 本地开发环境未运行，固定端口全部空闲。");
    return Object.freeze(lines);
  }

  for (const entry of entries) {
    if (entry.role === "workbench") continue;
    const state = isAlive(entry.pid) ? "运行中" : "已退出待清理";
    lines.push(`[chat] ${state} ${entry.role} pid=${String(entry.pid)} port=${String(entry.port)}`);
  }
  for (const item of occupied) {
    lines.push(
      `[chat] 监听 ${String(item.port)} pid=${String(item.pid)} process=${item.processName}`,
    );
  }
  return Object.freeze(lines);
}

export async function main() {
  for (const line of await collectLocalRuntimeStatus()) console.log(line);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(`[chat] 状态检查失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
