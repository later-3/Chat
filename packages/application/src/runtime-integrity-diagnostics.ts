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
    | "none"
    | "inspect_dispatch"
    | "missing_product_run"
    | "settle_failed"
    | "settle_cancelled"
    | "settle_outcome_unknown";
}

/** acknowledged Start连续查询未知时复用Outbox既有错误时间戳，不改变持久格式。 */
export const WORKFLOW_RUNTIME_QUERY_UNKNOWN_ERROR_CODE = "workflow.runtime_query_unknown";
export const WORKFLOW_RUNTIME_UNKNOWN_GRACE_MS = 30_000;

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
  options: {
    readonly observedAt: string;
    readonly unknownGraceMs?: number;
  },
): Promise<readonly RuntimeIntegrityFinding[]> {
  const starts = Object.values(snapshot.outbox)
    .filter((entry) => entry.kind === "workflow_start")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const findings: RuntimeIntegrityFinding[] = [];
  for (const entry of starts) {
    if (entry.kind !== "workflow_start") continue;
    const run = snapshot.entities.runs[entry.productRunId];
    if (run === undefined) {
      findings.push({
        productRunId: entry.productRunId,
        outboxId: entry.outboxId,
        productStatus: "missing",
        outboxStatus: entry.status,
        runtimeRun: { state: "unknown" },
        recommendation: "missing_product_run",
      });
      continue;
    }
    const runtimeRun =
      entry.status === "acknowledged"
        ? await readRuntimeRun(entry.productRunId)
        : ({ state: "unknown" } as const);
    const unknownPersistedLongEnough =
      entry.lastErrorCode === WORKFLOW_RUNTIME_QUERY_UNKNOWN_ERROR_CODE &&
      Date.parse(options.observedAt) - Date.parse(entry.updatedAt) >=
        (options.unknownGraceMs ?? WORKFLOW_RUNTIME_UNKNOWN_GRACE_MS);
    const recommendation = terminalProductStatus(run.status)
      ? ("none" as const)
      : entry.status !== "acknowledged"
        ? ("inspect_dispatch" as const)
        : runtimeRun.state === "active"
          ? ("none" as const)
          : runtimeRun.state === "unknown"
            ? unknownPersistedLongEnough
              ? ("settle_outcome_unknown" as const)
              : ("inspect_dispatch" as const)
            : runtimeRun.outcome === "succeeded" || runtimeRun.outcome === "outcome_unknown"
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
