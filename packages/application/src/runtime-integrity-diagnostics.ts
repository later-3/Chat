import type { ProductSnapshot, WorkflowRuntimeTerminalOutcome } from "@chat/contracts";

export type SafeRuntimeRunEvidence =
  | { readonly state: "active" }
  | { readonly state: "terminal"; readonly outcome: WorkflowRuntimeTerminalOutcome }
  | { readonly state: "unknown" };

export interface RuntimeIntegrityFinding {
  readonly productRunId: string;
  readonly outboxId: string;
  readonly productStatus: string;
  readonly outboxStatus: string;
  readonly runtimeRun: SafeRuntimeRunEvidence;
  readonly recommendation:
    "none" | "inspect_dispatch" | "settle_failed" | "settle_cancelled" | "settle_outcome_unknown";
}

function terminalProductStatus(status: string): boolean {
  return ["succeeded", "failed", "cancelled", "outcome_unknown"].includes(status);
}

/**
 * 只读完整性扫描：输入是已提交快照和安全Runtime投影，函数没有Store/文件写Port。
 * 输出不含Message、Prompt、错误Payload或Runtime私有ID，可直接用于人工诊断报告。
 */
export async function scanRuntimeIntegrity(
  snapshot: ProductSnapshot,
  readRuntimeRun: (productRunId: string) => Promise<SafeRuntimeRunEvidence>,
): Promise<readonly RuntimeIntegrityFinding[]> {
  const starts = Object.values(snapshot.outbox)
    .filter((entry) => entry.kind === "workflow_start")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const findings: RuntimeIntegrityFinding[] = [];
  for (const entry of starts) {
    if (entry.kind !== "workflow_start") continue;
    const run = snapshot.entities.runs[entry.productRunId];
    if (run === undefined) continue;
    const runtimeRun =
      entry.status === "acknowledged"
        ? await readRuntimeRun(entry.productRunId)
        : ({ state: "unknown" } as const);
    const recommendation = terminalProductStatus(run.status)
      ? ("none" as const)
      : entry.status !== "acknowledged"
        ? ("inspect_dispatch" as const)
        : runtimeRun.state === "active"
          ? ("none" as const)
          : runtimeRun.state === "unknown" ||
              runtimeRun.outcome === "succeeded" ||
              runtimeRun.outcome === "outcome_unknown"
            ? ("settle_outcome_unknown" as const)
            : runtimeRun.outcome === "failed"
              ? ("settle_failed" as const)
              : ("settle_cancelled" as const);
    findings.push({
      productRunId: entry.productRunId,
      outboxId: entry.outboxId,
      productStatus: run.status,
      outboxStatus: entry.status,
      runtimeRun,
      recommendation,
    });
  }
  return findings;
}
