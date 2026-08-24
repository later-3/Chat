import type {
  ClaimToolExecutionDecisionRuntimeResponse,
  ResolvedCapabilitySnapshot,
} from "@chat/contracts";
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { computeDirectRuntimeOperationRefSha256 } from "@chat/domain";
import { hashExecutorValue } from "./executor-operation-store.js";

export interface ToolExecutionProductPort {
  publish(input: {
    readonly commandId: string;
    readonly productRunId: string;
    readonly directAgentAttemptId: string;
    readonly runtimeOperationRefSha256: string;
    readonly capability: ResolvedCapabilitySnapshot;
    readonly toolCallId: string;
    readonly inputDisplay: string;
    readonly inputDisplayTruncated: boolean;
    readonly inputSha256: string;
  }): Promise<{ readonly toolExecutionIntentId: string; readonly revision: number }>;
  claim(input: {
    readonly commandId: string;
    readonly productRunId: string;
    readonly directAgentAttemptId: string;
    readonly toolExecutionIntentId: string;
    readonly intentRevision: number;
    readonly capabilityDescriptorSha256: string;
    readonly inputSha256: string;
    readonly scopeRef: ResolvedCapabilitySnapshot["ref"]["scopeRef"];
  }): Promise<ClaimToolExecutionDecisionRuntimeResponse>;
  commitResult(input: {
    readonly commandId: string;
    readonly productRunId: string;
    readonly directAgentAttemptId: string;
    readonly toolExecutionIntentId: string;
    readonly outcome: "completed" | "failed" | "outcome_unknown";
    readonly resultSha256?: string | undefined;
    readonly journalResultSha256?: string | undefined;
    readonly errorCode?: string | undefined;
  }): Promise<void>;
}

interface ActiveToolExecution {
  readonly intentId: string;
  readonly capability: ResolvedCapabilitySnapshot;
  readonly inputSha256: string;
}

export function toolExecutionCommandId(
  kind: string,
  operationId: string,
  toolCallId: string,
): string {
  return `cmd_${hashExecutorValue({ kind, operationId, toolCallId }).slice(0, 40)}`;
}

function isOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "outcomeUnknown" in error &&
    error.outcomeUnknown === true
  );
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("tool_execution.wait_aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/**
 * 高影响Tool在真实handler前等待Product Decision。批准许可只能消费一次；重复取得
 * `already_claimed`意味着上一次响应可能丢失，本进程绝不能猜测性执行。
 */
export class ToolExecutionCoordinator {
  private readonly active = new Map<string, ActiveToolExecution>();

  constructor(
    private readonly product: ToolExecutionProductPort,
    private readonly operation: {
      readonly operationId: string;
      readonly productRunId: string;
      readonly directAgentAttemptId: string;
      readonly inputManifestSha256: string;
    },
  ) {}

  async authorize(input: {
    readonly capability: ResolvedCapabilitySnapshot;
    readonly toolCallId: string;
    readonly inputDisplay: string;
    readonly inputDisplayTruncated: boolean;
    readonly inputSha256: string;
    readonly signal: AbortSignal;
    readonly pauseExecutionTimeout?: (() => void) | undefined;
    readonly resumeExecutionTimeout?: (() => void) | undefined;
  }): Promise<ToolCallEventResult | undefined> {
    if (input.capability.approvalPolicy !== "product_decision_required") return undefined;
    const published = await this.product.publish({
      commandId: toolExecutionCommandId(
        "publish-tool-execution-intent",
        this.operation.operationId,
        input.toolCallId,
      ),
      productRunId: this.operation.productRunId,
      directAgentAttemptId: this.operation.directAgentAttemptId,
      runtimeOperationRefSha256: computeDirectRuntimeOperationRefSha256({
        productRunId: this.operation.productRunId,
        directAgentAttemptId: this.operation.directAgentAttemptId,
        inputManifestSha256: this.operation.inputManifestSha256,
      }),
      capability: input.capability,
      toolCallId: input.toolCallId,
      inputDisplay: input.inputDisplay,
      inputDisplayTruncated: input.inputDisplayTruncated,
      inputSha256: input.inputSha256,
    });
    input.pauseExecutionTimeout?.();
    try {
      for (;;) {
        const claimed = await this.product.claim({
          commandId: toolExecutionCommandId(
            "claim-tool-execution-decision",
            this.operation.operationId,
            input.toolCallId,
          ),
          productRunId: this.operation.productRunId,
          directAgentAttemptId: this.operation.directAgentAttemptId,
          toolExecutionIntentId: published.toolExecutionIntentId,
          intentRevision: published.revision,
          capabilityDescriptorSha256: input.capability.ref.descriptorSha256,
          inputSha256: input.inputSha256,
          scopeRef: input.capability.ref.scopeRef,
        });
        if (claimed.status === "waiting_decision") {
          await wait(500, input.signal);
          continue;
        }
        if (claimed.status === "rejected") {
          return {
            block: true,
            reason: claimed.explanation ?? "用户拒绝了该Tool动作",
          };
        }
        if (claimed.status === "already_claimed") {
          await this.product.commitResult({
            commandId: toolExecutionCommandId(
              "unknown-tool-execution",
              this.operation.operationId,
              input.toolCallId,
            ),
            productRunId: this.operation.productRunId,
            directAgentAttemptId: this.operation.directAgentAttemptId,
            toolExecutionIntentId: published.toolExecutionIntentId,
            outcome: "outcome_unknown",
            errorCode: "tool_execution.permit_response_unknown",
          });
          throw new Error("tool_execution.permit_response_unknown");
        }
        this.active.set(input.toolCallId, {
          intentId: published.toolExecutionIntentId,
          capability: input.capability,
          inputSha256: input.inputSha256,
        });
        return undefined;
      }
    } finally {
      input.resumeExecutionTimeout?.();
    }
  }

  async commit(input: {
    readonly toolCallId: string;
    readonly resultSha256: string;
    readonly journalResultSha256: string;
    readonly failed: boolean;
  }): Promise<void> {
    const active = this.active.get(input.toolCallId);
    if (active === undefined) return;
    const request = {
      commandId: toolExecutionCommandId(
        "commit-tool-execution-result",
        this.operation.operationId,
        input.toolCallId,
      ),
      productRunId: this.operation.productRunId,
      directAgentAttemptId: this.operation.directAgentAttemptId,
      toolExecutionIntentId: active.intentId,
      outcome: input.failed ? ("failed" as const) : ("completed" as const),
      resultSha256: input.resultSha256,
      journalResultSha256: input.journalResultSha256,
    };
    try {
      await this.product.commitResult(request);
    } catch (error) {
      if (!isOutcomeUnknown(error)) throw error;
      // Product提交可安全用同一commandId重放；此重试不会再次执行Tool handler。
      await this.product.commitResult(request);
    }
    this.active.delete(input.toolCallId);
  }

  async markOutcomeUnknown(input: {
    readonly toolCallId: string;
    readonly errorCode: string;
  }): Promise<void> {
    const active = this.active.get(input.toolCallId);
    if (active === undefined) return;
    await this.product.commitResult({
      commandId: toolExecutionCommandId(
        "unknown-tool-execution",
        this.operation.operationId,
        input.toolCallId,
      ),
      productRunId: this.operation.productRunId,
      directAgentAttemptId: this.operation.directAgentAttemptId,
      toolExecutionIntentId: active.intentId,
      outcome: "outcome_unknown",
      errorCode: input.errorCode,
    });
    this.active.delete(input.toolCallId);
  }
}
