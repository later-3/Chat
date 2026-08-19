import { describe, expect, it } from "vitest";
import { canonicalJsonStringify } from "./canonical-hash.js";
import { DomainInvariantError } from "./plan-state.js";
import {
  assertPromptReviewDecisionBinding,
  assertPromptReviewRequestIndexes,
  assertSingleOpenPromptReview,
  computePromptReviewPayloadSha256,
  computePromptReviewSha256,
  parseCanonicalPromptReviewPayload,
  renderPromptReviewReadable,
  transitionPromptReviewStatus,
} from "./prompt-review.js";

describe("Prompt Review领域规则", () => {
  const canonicalPayloadJson = canonicalJsonStringify({
    messages: [{ content: "hello", role: "user" }],
    model: "local-test",
  });

  it("只允许open→approved/rejected→Provider派发终态", () => {
    expect(transitionPromptReviewStatus("open", "approved")).toBe("approved");
    expect(transitionPromptReviewStatus("approved", "dispatching")).toBe("dispatching");
    expect(transitionPromptReviewStatus("dispatching", "dispatched")).toBe("dispatched");
    expect(transitionPromptReviewStatus("open", "rejected")).toBe("rejected");
    expect(transitionPromptReviewStatus("open", "cancelled")).toBe("cancelled");
    expect(transitionPromptReviewStatus("approved", "cancelled")).toBe("cancelled");
    expect(() => transitionPromptReviewStatus("open", "dispatching")).toThrow(DomainInvariantError);
    expect(() => transitionPromptReviewStatus("dispatched", "dispatching")).toThrow(
      DomainInvariantError,
    );
  });

  it("Payload必须canonical且顶层不含Credential/Header", () => {
    expect(parseCanonicalPromptReviewPayload(canonicalPayloadJson)).toMatchObject({
      model: "local-test",
    });
    expect(() =>
      parseCanonicalPromptReviewPayload(canonicalJsonStringify({ headers: {}, model: "x" })),
    ).toThrow(/Credential|Header/u);
    expect(() => parseCanonicalPromptReviewPayload('{"z":1,"a":2}')).toThrow(/canonical/u);
    expect(() =>
      parseCanonicalPromptReviewPayload(
        canonicalJsonStringify({ messages: [{ reasoning_content: "hidden", role: "assistant" }] }),
      ),
    ).toThrow(/隐藏推理/u);
    const readable = renderPromptReviewReadable(canonicalPayloadJson, "prompt-readable.v1");
    expect(readable).toContain("1 · USER");
    expect(readable).toContain("hello");
    expect(readable).not.toContain("模型请求提示词");
    expect(readable).toBe(renderPromptReviewReadable(canonicalPayloadJson, "prompt-readable.v1"));
  });

  it("可读版完整保留Tool Call与Tool Result消息字段", () => {
    const toolPayload = canonicalJsonStringify({
      messages: [
        {
          content: "",
          role: "assistant",
          tool_calls: [
            {
              function: { arguments: '{"path":"README.md"}', name: "read" },
              id: "tool_1",
              type: "function",
            },
          ],
        },
        {
          content: "README contents",
          name: "read",
          role: "tool",
          tool_call_id: "tool_1",
        },
      ],
      model: "local-test",
    });

    const readable = renderPromptReviewReadable(toolPayload, "prompt-readable.v1");
    expect(readable).toContain("tool_calls");
    expect(readable).toContain("tool_call_id");
    expect(readable).toContain("tool_1");
    expect(readable).toContain("README contents");
    expect(readable).toContain('"name": "read"');
  });

  it("Decision绑定Request revision、Review Hash与Payload Hash", () => {
    const payloadSha256 = computePromptReviewPayloadSha256(canonicalPayloadJson);
    const reviewSha256 = computePromptReviewSha256({
      promptReviewRequestId: "prr_1",
      productRunId: "run_1",
      directAgentAttemptId: "att_1",
      requestIndex: 1,
      requestKind: "agent_turn",
      providerId: "local",
      modelId: "local-test",
      endpointHost: "127.0.0.1",
      requestRevision: 1,
      payloadSha256,
      rendererVersion: "prompt-readable.v1",
    });
    const request = {
      promptReviewRequestId: "prr_1",
      productRunId: "run_1",
      requestRevision: 1,
      reviewSha256,
      payloadSha256,
      status: "open" as const,
    };
    expect(() => assertPromptReviewDecisionBinding(request, request)).not.toThrow();
    expect(() =>
      assertPromptReviewDecisionBinding(request, { ...request, payloadSha256: "0".repeat(64) }),
    ).toThrow(/Payload Hash/u);
    expect(() =>
      assertPromptReviewDecisionBinding({ ...request, status: "approved" }, request),
    ).toThrow(/已决定/u);
  });

  it("同一Run最多一个open且同一Attempt序号连续", () => {
    expect(() => assertSingleOpenPromptReview([{ status: "open" }, { status: "open" }])).toThrow(
      /多个open/u,
    );
    expect(() =>
      assertPromptReviewRequestIndexes([{ requestIndex: 1 }, { requestIndex: 2 }]),
    ).not.toThrow();
    expect(() =>
      assertPromptReviewRequestIndexes([{ requestIndex: 1 }, { requestIndex: 3 }]),
    ).toThrow(/连续递增/u);
    expect(() =>
      assertPromptReviewRequestIndexes(
        Array.from({ length: 17 }, (_, index) => ({ requestIndex: index + 1 })),
      ),
    ).toThrow(/最多允许16次/u);
  });
});
