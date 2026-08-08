import type { MemoryImportResult } from "@chat/contracts";
import {
  memoryImportWorkflowInputSchema,
  type MemoryImportWorkflowInput,
} from "./memory-import-workflow-input.js";
import {
  callMemoryImportStep,
  commitMemoryImportAcceptedStep,
  commitMemoryImportFailedStep,
  commitMemoryImportMaterializedStep,
  commitMemoryImportUnknownStep,
  loadMemoryImportStep,
  markMemoryImportDispatchingStep,
  reconcileMemoryImportStep,
  type LoadedMemoryImportStepResult,
} from "./memory-import-workflow-steps.js";

export interface MemoryImportWorkflowResult {
  readonly memoryImportIntentId: string;
  readonly status: MemoryImportResult["status"];
}

/**
 * 把外部只读对账结果提交回Chat产品事实。Workflow只协调步骤，不直接改Product Store；
 * 每个commit都经API进入Application并携带expected revision，所以重放不会覆盖新状态。
 */
async function settleReconcile(
  input: MemoryImportWorkflowInput,
  loaded: LoadedMemoryImportStepResult,
  result: MemoryImportResult,
  externalObjectId?: string,
): Promise<MemoryImportResult> {
  const reconciled = await reconcileMemoryImportStep({
    loaded,
    result,
    ...(externalObjectId !== undefined ? { externalObjectId } : {}),
  });
  if (reconciled.status === "materialized") {
    return commitMemoryImportMaterializedStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result,
      accepted: reconciled.accepted,
      verificationKind: reconciled.verificationKind,
      verificationSha256: reconciled.verificationSha256,
      reconciled: true,
    });
  }
  if (reconciled.status === "accepted") {
    return commitMemoryImportAcceptedStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result,
      accepted: reconciled.accepted,
      durationMs: 0,
      reconciled: true,
    });
  }
  if (reconciled.status === "failed") {
    return commitMemoryImportFailedStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result,
      errorCode: reconciled.errorCode,
      summary: reconciled.summary,
      durationMs: 0,
      reconciled: true,
    });
  }
  if (result.status === "accepted") {
    return commitMemoryImportAcceptedStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result,
      accepted: {
        externalObjectId: result.externalObjectId,
        responseSha256: result.responseSha256,
        ...(result.externalObjectVersion !== undefined
          ? { externalObjectVersion: result.externalObjectVersion }
          : {}),
        ...(result.externalStatus !== undefined ? { externalStatus: result.externalStatus } : {}),
      },
      durationMs: 0,
      reconciled: true,
    });
  }
  return commitMemoryImportUnknownStep({
    loaded,
    intentId: input.memoryImportIntentId,
    result,
    errorCode: reconciled.errorCode,
    durationMs: 0,
    reconciled: true,
  });
}

/**
 * 一次导入或一次人工对账对应一个耐久Workflow Run。
 *
 * 普通导入固定经过 load → dispatching栅栏 → 单次外部call → 产品提交 → 只读对账。
 * 外部call结果未知时也只能进入reconcile，绝不回到call；reconcile模式同样不会执行写入。
 * accepted是Tencent L0已经存在的合法收敛状态，不代表L1已经可用于长期查询。
 */
export async function memoryImportWorkflow(
  rawInput: MemoryImportWorkflowInput,
): Promise<MemoryImportWorkflowResult> {
  "use workflow";
  const input = memoryImportWorkflowInputSchema.parse(rawInput);
  const loaded = await loadMemoryImportStep(input);

  if (input.mode === "reconcile") {
    if (!["dispatching", "accepted", "outcome_unknown"].includes(loaded.result.status)) {
      return {
        memoryImportIntentId: input.memoryImportIntentId,
        status: loaded.result.status,
      };
    }
    const result = await settleReconcile(
      input,
      loaded,
      loaded.result,
      loaded.result.status === "accepted" ? loaded.result.externalObjectId : undefined,
    );
    return { memoryImportIntentId: input.memoryImportIntentId, status: result.status };
  }

  if (loaded.result.status !== "queued") {
    return {
      memoryImportIntentId: input.memoryImportIntentId,
      status: loaded.result.status,
    };
  }
  const dispatching = await markMemoryImportDispatchingStep({
    memoryImportIntentId: input.memoryImportIntentId,
    memoryImportResultId: input.memoryImportResultId,
    requestSha256: loaded.intent.requestSha256,
    expectedRevision: input.expectedResultRevision,
  });
  const call = await callMemoryImportStep({ loaded, dispatching });
  if (call.status === "failed") {
    const result = await commitMemoryImportFailedStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result: dispatching,
      errorCode: call.errorCode,
      summary: call.summary,
      durationMs: call.durationMs,
    });
    return { memoryImportIntentId: input.memoryImportIntentId, status: result.status };
  }
  if (call.status === "outcome_unknown") {
    const unknown = await commitMemoryImportUnknownStep({
      loaded,
      intentId: input.memoryImportIntentId,
      result: dispatching,
      errorCode: call.errorCode,
      durationMs: call.durationMs,
    });
    const result = await settleReconcile(input, loaded, unknown);
    return { memoryImportIntentId: input.memoryImportIntentId, status: result.status };
  }
  const accepted = await commitMemoryImportAcceptedStep({
    loaded,
    intentId: input.memoryImportIntentId,
    result: dispatching,
    accepted: call.accepted,
    durationMs: call.durationMs,
  });
  const result = await settleReconcile(input, loaded, accepted, call.accepted.externalObjectId);
  return { memoryImportIntentId: input.memoryImportIntentId, status: result.status };
}
