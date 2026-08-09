import { hashCanonical } from "@chat/domain";
import type { CommandId, ProductRunId } from "@chat/contracts";
import type { ApplicationDeps } from "./deps.js";
import { notFound, revisionConflict } from "./errors.js";
import { emitProductRunTransition, settleRunWithoutSuccess } from "./run-settlement.js";

export interface UpdateOutboxStatusCommand {
  readonly commandId: CommandId;
  readonly outboxId: string;
  /** pending仅用于对账后的安全重排队。 */
  readonly status:
    "pending" | "dispatched" | "acknowledged" | "outcome_unknown" | "failed_terminal";
  readonly errorCode?: string;
  readonly incrementDispatchAttempts?: boolean;
}

export async function updateOutboxStatus(
  deps: ApplicationDeps,
  input: UpdateOutboxStatusCommand,
): Promise<void> {
  const now = deps.now();
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const existingEntry = snapshot.outbox[input.outboxId];
  if (existingEntry === undefined) throw notFound("Outbox Entry不存在");
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "UpdateOutboxStatus",
    requestSha256: hashCanonical("command.update-outbox-status.v1", input),
    ...(existingEntry.kind === "workflow_start" || existingEntry.kind === "workflow_resume"
      ? { traceContext: { productRunId: existingEntry.productRunId } }
      : {}),
    mutate: (draft) => {
      const entry = draft.outbox[input.outboxId];
      if (entry === undefined) throw notFound("Outbox Entry不存在");
      const updated = {
        ...entry,
        status: input.status,
        dispatchAttempts:
          input.incrementDispatchAttempts === true
            ? entry.dispatchAttempts + 1
            : entry.dispatchAttempts,
        ...(input.errorCode !== undefined ? { lastErrorCode: input.errorCode } : {}),
        revision: entry.revision + 1,
        updatedAt: now,
      };
      if (input.errorCode === undefined) delete updated.lastErrorCode;
      draft.outbox[input.outboxId] = updated;
      return { resultRefs: {} };
    },
  });
}

export interface FailOutboxAndRunCommand {
  readonly commandId: CommandId;
  readonly outboxId: string;
  readonly errorCode: string;
  readonly summary: string;
  readonly incrementDispatchAttempts: boolean;
}

/** 不可恢复的派发错误：Outbox与Product Run在同一个产品事务中收敛。 */
export async function failOutboxAndRun(
  deps: ApplicationDeps,
  input: FailOutboxAndRunCommand,
): Promise<void> {
  const now = deps.now();
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const entryBefore = before.outbox[input.outboxId];
  if (
    entryBefore !== undefined &&
    entryBefore.kind !== "workflow_start" &&
    entryBefore.kind !== "workflow_resume"
  ) {
    throw revisionConflict("Memory Import Outbox不能使用Product Run失败收敛用例");
  }
  const priorRun =
    entryBefore === undefined ? undefined : before.entities.runs[entryBefore.productRunId];
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "FailOutboxAndRun",
    requestSha256: hashCanonical("command.fail-outbox-and-run.v1", input),
    ...(entryBefore !== undefined
      ? { traceContext: { productRunId: entryBefore.productRunId } }
      : {}),
    mutate: (draft) => {
      const entry = draft.outbox[input.outboxId];
      if (entry === undefined) throw notFound("Outbox Entry不存在");
      if (entry.kind !== "workflow_start" && entry.kind !== "workflow_resume") {
        throw revisionConflict("Memory Import Outbox不能使用Product Run失败收敛用例");
      }
      draft.outbox[input.outboxId] = {
        ...entry,
        status: "failed_terminal",
        lastErrorCode: input.errorCode,
        dispatchAttempts: entry.dispatchAttempts + (input.incrementDispatchAttempts ? 1 : 0),
        revision: entry.revision + 1,
        updatedAt: now,
      };
      settleRunWithoutSuccess(
        draft,
        entry.productRunId,
        "failed",
        input.errorCode,
        input.summary,
        now,
      );
      return { resultRefs: { productRunId: entry.productRunId } };
    },
  });
  if (!result.replayed && priorRun !== undefined) {
    const { snapshot: after } = await deps.store.read({ kind: "committedSnapshot" });
    const settledRun = after.entities.runs[priorRun.productRunId];
    if (settledRun !== undefined) emitProductRunTransition(deps, priorRun, settledRun, "warn");
  }
}

export interface CommitRunOutcomeUnknownCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly errorCode: string;
  readonly summary: string;
}

export interface SettleIncompatibleWorkflowRunCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly errorCode: string;
  readonly summary: string;
}

/**
 * 本地开发恢复门：旧Bundle已经不可用时，把不可能安全续跑的Product Run与其Workflow Outbox
 * 原子收敛为明确失败。它不删除Message、Plan、Trace、Runtime事件或版本证据；正常同版本恢复
 * 不会调用本用例。生产部署应保留旧Workflow版本，不使用这个本地开发降级路径。
 */
export async function settleIncompatibleWorkflowRun(
  deps: ApplicationDeps,
  input: SettleIncompatibleWorkflowRunCommand,
): Promise<void> {
  const now = deps.now();
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const priorRun = before.entities.runs[input.productRunId];
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "SettleIncompatibleWorkflowRun",
    requestSha256: hashCanonical("command.settle-incompatible-workflow-run.v1", input),
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      if (
        run.status === "succeeded" ||
        run.status === "failed" ||
        run.status === "cancelled" ||
        run.status === "outcome_unknown"
      ) {
        return { resultRefs: { productRunId: input.productRunId } };
      }
      for (const entry of Object.values(draft.outbox)) {
        if (
          (entry.kind !== "workflow_start" && entry.kind !== "workflow_resume") ||
          entry.productRunId !== input.productRunId
        ) {
          continue;
        }
        draft.outbox[entry.outboxId] = {
          ...entry,
          status: "failed_terminal",
          lastErrorCode: input.errorCode,
          revision: entry.revision + 1,
          updatedAt: now,
        };
      }
      settleRunWithoutSuccess(
        draft,
        input.productRunId,
        "failed",
        input.errorCode,
        input.summary,
        now,
      );
      return { resultRefs: { productRunId: input.productRunId } };
    },
  });
  if (priorRun !== undefined) {
    const { snapshot: after } = await deps.store.read({ kind: "committedSnapshot" });
    const settledRun = after.entities.runs[input.productRunId];
    if (settledRun !== undefined) emitProductRunTransition(deps, priorRun, settledRun, "warn");
  }
}

/** 结果长期无法对账时形成用户可见终态，避免永远锁住会话。 */
export async function commitRunOutcomeUnknown(
  deps: ApplicationDeps,
  input: CommitRunOutcomeUnknownCommand,
): Promise<void> {
  const now = deps.now();
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const priorRun = before.entities.runs[input.productRunId];
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CommitRunOutcomeUnknown",
    requestSha256: hashCanonical("command.commit-run-outcome-unknown.v1", input),
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      settleRunWithoutSuccess(
        draft,
        input.productRunId,
        "outcome_unknown",
        input.errorCode,
        input.summary,
        now,
      );
      return { resultRefs: { productRunId: input.productRunId } };
    },
  });
  if (!result.replayed && priorRun !== undefined) {
    const { snapshot: after } = await deps.store.read({ kind: "committedSnapshot" });
    const settledRun = after.entities.runs[input.productRunId];
    if (settledRun !== undefined) emitProductRunTransition(deps, priorRun, settledRun, "warn");
  }
}
