import type { ProjectBootstrapSessionProjection, RunDto } from "@chat/contracts/public";
import { isProjectBootstrapWorkflowSelection, type SessionBinding } from "./state-store.ts";

export type ProjectBootstrapLifecycleTerminalStatus = "ready" | "rejected" | "failed_terminal";

const TERMINAL_RUN_STATUSES = new Set<RunDto["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

/**
 * Candidate出现后以建项产品事实为准；Candidate尚未出现时，专用Direct Run的终态
 * 仍必须消费一次性能力，否则下一条普通消息会继续误走bootstrap入口。
 */
export async function resolveProjectBootstrapLifecycleTerminalStatus(input: {
  readonly binding: SessionBinding | undefined;
  readonly projectBootstrap: ProjectBootstrapSessionProjection | null;
  readonly readRun: (productRunId: string) => Promise<RunDto>;
}): Promise<ProjectBootstrapLifecycleTerminalStatus | undefined> {
  if (input.binding?.projectBootstrapLifecycle?.status !== "active") return undefined;
  if (input.projectBootstrap !== null) {
    return input.projectBootstrap.candidate.status === "rejected"
      ? "rejected"
      : input.projectBootstrap.operation?.status === "ready"
        ? "ready"
        : input.projectBootstrap.operation?.status === "failed"
          ? "failed_terminal"
          : undefined;
  }

  const current =
    input.binding.currentRequestKey === undefined
      ? undefined
      : input.binding.requests[input.binding.currentRequestKey];
  const request = [current, ...Object.values(input.binding.requests).toReversed()].find(
    (candidate) =>
      candidate?.productRunId !== undefined &&
      isProjectBootstrapWorkflowSelection(candidate.workflowSelection),
  );
  if (request?.productRunId === undefined) return undefined;
  const run = await input.readRun(request.productRunId);
  return TERMINAL_RUN_STATUSES.has(run.status) ? "failed_terminal" : undefined;
}
