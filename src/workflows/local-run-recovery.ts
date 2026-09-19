import { getWorld } from "workflow/runtime";

// Nitro creates a new worker on reload. Only the local, single-instance World
// can establish that a Step started before this worker has lost its executor.
const workerStartedAt = Date.now();
let recovery: Promise<void> | undefined;

export async function failInterruptedLocalRuns(
  world: ReturnType<typeof getWorld>,
  startedAt: number,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const runs = await world.runs.list({ status: "running", resolveData: "none", pagination: { ...(cursor === undefined ? {} : { cursor }), limit: 100 } });
    for (const run of runs.data) {
      let stepCursor: string | undefined;
      let interrupted = false;
      do {
        const steps = await world.steps.list({ runId: run.runId, resolveData: "none", pagination: { ...(stepCursor === undefined ? {} : { cursor: stepCursor }), limit: 100 } });
        interrupted = steps.data.some((step) => step.status === "running"
          && step.startedAt !== undefined && step.startedAt.getTime() < startedAt
          && step.updatedAt.getTime() < startedAt);
        stepCursor = steps.hasMore ? steps.cursor ?? undefined : undefined;
      } while (!interrupted && stepCursor !== undefined);
      // Durable review/hooks and queued Steps have no running executor to lose.
      if (!interrupted) continue;
      try {
        await world.events.create(run.runId, {
          eventType: "run_failed",
          eventData: {
            error: { message: "Backend重启或热重建中断了正在执行的任务。已保留已有消息与工具结果；请检查后继续，任务未自动重试。" },
            errorCode: "CHAT_LOCAL_EXECUTION_INTERRUPTED",
          },
        });
      } catch (error) {
        const current = await world.runs.get(run.runId, { resolveData: "none" });
        if (!["completed", "failed", "cancelled"].includes(current.status)) throw error;
      }
    }
    cursor = runs.hasMore ? runs.cursor ?? undefined : undefined;
  } while (cursor !== undefined);
}

/** Use the World event API and its atomic terminal guards, never edit runtime JSON. */
export function recoverInterruptedLocalRuns(): Promise<void> {
  const target = process.env.WORKFLOW_TARGET_WORLD;
  if ((target !== undefined && target !== "local") || process.env.VERCEL_DEPLOYMENT_ID) return Promise.resolve();
  recovery ??= failInterruptedLocalRuns(getWorld(), workerStartedAt).catch((error: unknown) => {
    recovery = undefined;
    throw error;
  });
  return recovery;
}
