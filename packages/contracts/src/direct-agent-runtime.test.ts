import { describe, expect, it } from "vitest";
import {
  DIRECT_AGENT_RUNTIME_PATHS,
  authorizeDirectAgentOperationRuntimeResponseSchema,
  consumePromptReviewDecisionRuntimeResponseSchema,
  loadPromptReviewDecisionRuntimeResponseSchema,
  publishPromptReviewRuntimeRequestSchema,
  publishPromptReviewRuntimeResponseSchema,
} from "./direct-agent-runtime.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const decision = {
  promptReviewDecisionId: "prd_1",
  promptReviewRequestId: "prr_1",
  productRunId: "run_1",
  requestRevision: 1,
  reviewSha256: HASH_B,
  payloadSha256: HASH_A,
  kind: "approve" as const,
  revision: 1 as const,
  decisionSha256: HASH_C,
};

describe("Direct Agent私有Runtime合同", () => {
  it("固定路径与Publish引用覆盖CAS、请求元数据和双Hash", () => {
    expect(DIRECT_AGENT_RUNTIME_PATHS.consumePromptReviewDecision).toBe(
      "/consume-prompt-review-decision",
    );
    const request = publishPromptReviewRuntimeRequestSchema.parse({
      schemaVersion: "chat-internal-runtime.v1",
      commandId: "cmd_1",
      productRunId: "run_1",
      directAgentAttemptId: "att_1",
      expectedRunRevision: 2,
      requestIndex: 1,
      requestKind: "agent_turn",
      providerId: "bailian",
      modelId: "qwen3.7-plus",
      endpointHost: "dashscope.aliyuncs.com",
      canonicalPayloadJson: '{"model":"qwen3.7-plus"}',
      payloadSha256: HASH_A,
    });
    expect(request.expectedRunRevision).toBe(2);
    expect(() =>
      publishPromptReviewRuntimeRequestSchema.parse({
        ...request,
        requestIndex: 17,
      }),
    ).toThrow();
    expect(() =>
      publishPromptReviewRuntimeRequestSchema.parse({
        ...request,
        endpointHost: "https://dashscope.aliyuncs.com/v1",
      }),
    ).toThrow();
    expect(
      publishPromptReviewRuntimeResponseSchema.parse({
        schemaVersion: "chat-internal-runtime.v1",
        promptReviewRequestId: "prr_1",
        productRunId: "run_1",
        requestRevision: 1,
        requestIndex: 1,
        payloadSha256: HASH_A,
        reviewSha256: HASH_B,
        status: "open",
        revision: 1,
        runRevision: 3,
      }).reviewSha256,
    ).toBe(HASH_B);
    expect(
      publishPromptReviewRuntimeResponseSchema.parse({
        schemaVersion: "chat-internal-runtime.v1",
        promptReviewRequestId: "prr_1",
        productRunId: "run_1",
        requestRevision: 1,
        requestIndex: 1,
        payloadSha256: HASH_A,
        reviewSha256: HASH_B,
        status: "approved",
        revision: 2,
        runRevision: 4,
      }).status,
    ).toBe("approved");
  });

  it("一次性permit只有authorized返回正文，重放与拒绝都没有正文", () => {
    const authorized = consumePromptReviewDecisionRuntimeResponseSchema.parse({
      schemaVersion: "chat-internal-runtime.v1",
      status: "authorized",
      decision,
      runRevision: 3,
      canonicalPayloadJson: '{"model":"qwen3.7-plus"}',
      payloadSha256: HASH_A,
      reviewSha256: HASH_B,
      requestIndex: 1,
      requestKind: "agent_turn",
      providerId: "bailian",
      modelId: "qwen3.7-plus",
      endpointHost: "dashscope.aliyuncs.com",
    });
    expect(authorized.status).toBe("authorized");
    expect(
      consumePromptReviewDecisionRuntimeResponseSchema.parse({
        schemaVersion: "chat-internal-runtime.v1",
        status: "already_claimed",
        decision,
        runRevision: 3,
      }).status,
    ).toBe("already_claimed");
    expect(() =>
      consumePromptReviewDecisionRuntimeResponseSchema.parse({
        schemaVersion: "chat-internal-runtime.v1",
        status: "already_claimed",
        decision,
        runRevision: 3,
        canonicalPayloadJson: '{"model":"qwen3.7-plus"}',
      }),
    ).toThrow();
    expect(
      consumePromptReviewDecisionRuntimeResponseSchema.parse({
        schemaVersion: "chat-internal-runtime.v1",
        status: "rejected",
        decision: { ...decision, kind: "reject" },
        runRevision: 3,
      }).status,
    ).toBe("rejected");
  });

  it("Workflow只读Decision路由只返回引用，不返回冻结正文", () => {
    expect(DIRECT_AGENT_RUNTIME_PATHS.loadPromptReviewDecision).toBe(
      "/load-prompt-review-decision",
    );
    expect(
      loadPromptReviewDecisionRuntimeResponseSchema.parse({
        schemaVersion: "chat-internal-runtime.v1",
        decision,
      }).decision.kind,
    ).toBe("approve");
    expect(() =>
      loadPromptReviewDecisionRuntimeResponseSchema.parse({
        schemaVersion: "chat-internal-runtime.v1",
        decision,
        canonicalPayloadJson: '{"model":"qwen3.7-plus"}',
      }),
    ).toThrow();
  });

  it("Authorize只返回冻结消息、read_only与P1固定预算", () => {
    const response = authorizeDirectAgentOperationRuntimeResponseSchema.parse({
      schemaVersion: "chat-internal-runtime.v1",
      productRunId: "run_1",
      directAgentAttemptId: "att_1",
      runRevision: 2,
      sourceMessage: { messageId: "msg_1", text: "检查仓库", sha256: HASH_A },
      capabilityMode: "read_only",
      limits: {
        maxProviderRequests: 16,
        activeTimeoutMs: 1_200_000,
        tokenBudget: 64_000,
      },
    });
    expect(response.capabilityMode).toBe("read_only");
    expect("workspaceRootId" in response).toBe(false);
  });
});
