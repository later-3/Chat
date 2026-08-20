import { createHash } from "node:crypto";
import {
  bridgeChatDispatchReviewSchema,
  type BridgeChatDispatchPlan,
  type BridgeChatDispatchReview,
} from "./contracts.ts";
import type { AtomicBridgeStateStore } from "./state-store.ts";

interface PendingReview {
  readonly review: BridgeChatDispatchReview;
  readonly promise: Promise<"approve" | "reject">;
  readonly settle: (kind: "approve" | "reject") => void;
}

function reviewId(dshSessionId: string, planSha256: string): string {
  const hash = createHash("sha256")
    .update(["chat-bridge-dispatch-review.v1", dshSessionId, planSha256].join("\u0000"))
    .digest("hex");
  return `bdr_${hash.slice(0, 32)}`;
}

/**
 * Bridge→Chat调试闸门只暂停当前Host调用栈。完整Command正文不进入Bridge状态；
 * Host退出时原调用失败，不能在缺失调用栈时伪造恢复或重发。
 */
export class BridgeDispatchReviewCoordinator {
  private readonly pending = new Map<string, PendingReview>();

  constructor(private readonly state: AtomicBridgeStateStore) {}

  current(dshSessionId: string): BridgeChatDispatchReview | null {
    const value = this.pending.get(dshSessionId)?.review;
    return value === undefined ? null : structuredClone(value);
  }

  async waitForDecision(input: {
    readonly dshSessionId: string;
    readonly plan: BridgeChatDispatchPlan;
    readonly signal?: AbortSignal;
  }): Promise<"approve" | "reject" | "disabled"> {
    if (!(await this.state.readBridgeDispatchReviewEnabled(input.dshSessionId))) {
      return "disabled";
    }
    const id = reviewId(input.dshSessionId, input.plan.planSha256);
    const existing = this.pending.get(input.dshSessionId);
    if (existing !== undefined) {
      if (existing.review.reviewId !== id) {
        throw new Error("当前DSH会话已有另一条Bridge出口审核等待处理");
      }
      return await this.withAbort(input.dshSessionId, existing, input.signal);
    }
    let settle!: (kind: "approve" | "reject") => void;
    const promise = new Promise<"approve" | "reject">((resolve) => {
      settle = resolve;
    });
    const pending: PendingReview = {
      review: bridgeChatDispatchReviewSchema.parse({
        schemaVersion: "chat-bridge-chat-dispatch-review.v1",
        reviewId: id,
        status: "open",
        plan: input.plan,
      }),
      promise,
      settle,
    };
    this.pending.set(input.dshSessionId, pending);
    return await this.withAbort(input.dshSessionId, pending, input.signal);
  }

  decide(
    dshSessionId: string,
    reviewIdValue: string,
    planSha256: string,
    kind: "approve" | "reject",
  ): boolean {
    const pending = this.pending.get(dshSessionId);
    if (
      pending === undefined ||
      pending.review.reviewId !== reviewIdValue ||
      pending.review.plan.planSha256 !== planSha256
    ) {
      return false;
    }
    this.pending.delete(dshSessionId);
    pending.settle(kind);
    return true;
  }

  approveCurrent(dshSessionId: string): void {
    const pending = this.pending.get(dshSessionId);
    if (pending === undefined) return;
    this.pending.delete(dshSessionId);
    pending.settle("approve");
  }

  close(): void {
    for (const [dshSessionId, pending] of this.pending) {
      this.pending.delete(dshSessionId);
      pending.settle("reject");
    }
  }

  private async withAbort(
    dshSessionId: string,
    pending: PendingReview,
    signal: AbortSignal | undefined,
  ): Promise<"approve" | "reject"> {
    if (signal?.aborted === true) {
      if (this.pending.get(dshSessionId) === pending) {
        this.pending.delete(dshSessionId);
        pending.settle("reject");
      }
      return "reject";
    }
    if (signal === undefined) return await pending.promise;
    return await new Promise<"approve" | "reject">((resolve) => {
      const abort = (): void => {
        if (this.pending.get(dshSessionId) === pending) {
          this.pending.delete(dshSessionId);
          pending.settle("reject");
        }
        resolve("reject");
      };
      signal.addEventListener("abort", abort, { once: true });
      void pending.promise.then((kind) => {
        signal.removeEventListener("abort", abort);
        resolve(kind);
      });
    });
  }
}
