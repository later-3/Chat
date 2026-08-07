import { hashCanonical } from "@chat/domain";
import type { CommandId, ProductRunId } from "@chat/contracts";
import type { ApplicationDeps } from "./deps.js";
import { notFound } from "./errors.js";
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
    traceContext: { productRunId: existingEntry.productRunId },
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
