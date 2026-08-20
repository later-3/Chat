import { createHash } from "node:crypto";
import { dshSendReviewSchema, type DshBridgeSendPreview, type DshSendReview } from "./contracts.ts";
import type { AtomicBridgeStateStore } from "./state-store.ts";

interface PendingReview {
  readonly review: DshSendReview;
  readonly promise: Promise<"approve" | "reject">;
  readonly settle: (kind: "approve" | "reject") => void;
}

function reviewId(dshSessionId: string, requestKey: string): string {
  const hash = createHash("sha256")
    .update(["chat-dsh-send-review.v1", dshSessionId, requestKey].join("\u0000"))
    .digest("hex");
  return `dsr_${hash.slice(0, 32)}`;
}

/**
 * DSH发送审核只拥有当前Host进程中的暂停点。完整预览不落Bridge状态文件；Host退出时
 * 原DSH模型调用随进程一起失败，不能在没有原调用栈的情况下伪造“可恢复发送”。
 */
export class DshSendReviewCoordinator {
  private readonly pending = new Map<string, PendingReview>();

  constructor(
    private readonly state: AtomicBridgeStateStore,
    private readonly preview: (dshSessionId: string, text: string) => Promise<DshBridgeSendPreview>,
  ) {}

  current(dshSessionId: string): DshSendReview | null {
    const value = this.pending.get(dshSessionId)?.review;
    return value === undefined ? null : structuredClone(value);
  }

  async waitForDecision(input: {
    readonly dshSessionId: string;
    readonly requestKey: string;
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<"approve" | "reject" | "disabled"> {
    if (!(await this.state.readDshSendReviewEnabled(input.dshSessionId))) return "disabled";
    const id = reviewId(input.dshSessionId, input.requestKey);
    const existing = this.pending.get(input.dshSessionId);
    if (existing !== undefined) {
      if (existing.review.reviewId !== id) {
        throw new Error("当前DSH会话已有另一条发送审核等待处理");
      }
      return await this.withAbort(input.dshSessionId, existing, input.signal);
    }

    const projected = await this.preview(input.dshSessionId, input.text);
    if (!(await this.state.readDshSendReviewEnabled(input.dshSessionId))) return "disabled";
    let settle!: (kind: "approve" | "reject") => void;
    const promise = new Promise<"approve" | "reject">((resolve) => {
      settle = resolve;
    });
    const pending: PendingReview = {
      review: dshSendReviewSchema.parse({
        schemaVersion: "chat-dsh-send-review.v1",
        reviewId: id,
        status: "open",
        preview: projected,
      }),
      promise,
      settle,
    };
    this.pending.set(input.dshSessionId, pending);
    return await this.withAbort(input.dshSessionId, pending, input.signal);
  }

  decide(dshSessionId: string, reviewIdValue: string, kind: "approve" | "reject"): boolean {
    const pending = this.pending.get(dshSessionId);
    if (pending === undefined || pending.review.reviewId !== reviewIdValue) return false;
    this.pending.delete(dshSessionId);
    pending.settle(kind);
    return true;
  }

  /** 关闭开关等价于放行当前等待项，符合“关闭后自动发送”的用户语义。 */
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
