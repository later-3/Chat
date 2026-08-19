import { describe, expect, it } from "vitest";
import { directAgentCandidateSchema } from "./direct-agent.js";
import { promptReviewDecisionSchema, promptReviewRequestSchema } from "./prompt-review.js";
import { submitPromptReviewDecisionPayloadSchema } from "./prompt-review-api.js";
import { outboxEntrySchema, productRunSchema } from "./product.js";
import { workflowRunBusinessInputSchema } from "./workflow-definition.js";

const NOW = "2026-08-19T12:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PAYLOAD = '{"messages":[{"content":"hello","role":"user"}],"model":"local"}';

describe("Prompt Review与Direct Agent合同", () => {
  it("Request只持久化canonical原文并限制1MiB", () => {
    const request = promptReviewRequestSchema.parse({
      schemaVersion: "prompt-review-request.v1",
      promptReviewRequestId: "prr_1",
      productRunId: "run_1",
      directAgentAttemptId: "att_1",
      requestIndex: 1,
      requestKind: "agent_turn",
      providerId: "local",
      modelId: "local-test",
      endpointHost: "127.0.0.1",
      requestRevision: 1,
      status: "open",
      canonicalPayloadJson: PAYLOAD,
      payloadSha256: HASH_A,
      rendererVersion: "prompt-readable.v1",
      reviewSha256: HASH_B,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(request.canonicalPayloadJson).toBe(PAYLOAD);
    expect("readablePrompt" in request).toBe(false);
    expect(promptReviewRequestSchema.parse({ ...request, status: "cancelled" }).status).toBe(
      "cancelled",
    );
    expect(
      promptReviewRequestSchema.parse({
        ...request,
        status: "cancelled",
        decidedByPromptReviewDecisionId: "prd_1",
      }).decidedByPromptReviewDecisionId,
    ).toBe("prd_1");
    expect(() =>
      promptReviewRequestSchema.parse({
        ...request,
        canonicalPayloadJson: JSON.stringify({ value: "x".repeat(1024 * 1024) }),
      }),
    ).toThrow();
  });

  it("Decision与公开Command严格绑定revision和两类Hash", () => {
    const decision = promptReviewDecisionSchema.parse({
      schemaVersion: "prompt-review-decision.v1",
      promptReviewDecisionId: "prd_1",
      promptReviewRequestId: "prr_1",
      productRunId: "run_1",
      requestRevision: 1,
      reviewSha256: HASH_A,
      payloadSha256: HASH_B,
      kind: "approve",
      principalId: "usr_debug",
      commandId: "cmd_1",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(decision.kind).toBe("approve");
    expect(
      submitPromptReviewDecisionPayloadSchema.parse({
        promptReviewRequestId: "prr_1",
        requestRevision: 1,
        reviewSha256: HASH_A,
        payloadSha256: HASH_B,
        kind: "reject",
        reason: "不发送",
      }).kind,
    ).toBe("reject");
    expect(() =>
      promptReviewDecisionSchema.parse({ ...decision, reason: "approve reason" }),
    ).toThrow();
  });

  it("Direct Run、Attempt业务输入与候选不伪造Plan", () => {
    const run = productRunSchema.parse({
      schemaVersion: "product-run.v3",
      runKind: "direct_agent",
      productRunId: "run_1",
      sessionId: "psn_1",
      sourceMessageId: "msg_1",
      workflowViewDefinitionId: "wvd_direct1",
      workflowRunSpecId: "wrs_direct1",
      runnerFamily: "direct-agent.v1",
      runnerBundleVersion: "direct-agent.bundle.v1",
      status: "waiting_human",
      phase: "prompt_review",
      currentPromptReviewRequestId: "prr_1",
      revision: 2,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(run.runKind).toBe("direct_agent");
    expect(workflowRunBusinessInputSchema.parse({ kind: "direct_agent_message" }).kind).toBe(
      "direct_agent_message",
    );
    const candidate = directAgentCandidateSchema.parse({
      schemaVersion: "direct-agent-candidate.v1",
      directAgentCandidateId: "drc_1",
      productRunId: "run_1",
      directAgentAttemptId: "att_1",
      output: { format: "markdown", text: "done" },
      sha256: HASH_A,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(candidate.output.text).toBe("done");
  });

  it("workflow_resume三种决定引用严格互斥", () => {
    const base = {
      schemaVersion: "outbox-entry.v1" as const,
      outboxId: "obx_1",
      kind: "workflow_resume" as const,
      status: "pending" as const,
      productRunId: "run_1",
      promptReviewRequestId: "prr_1",
      promptReviewDecisionId: "prd_1",
      dispatchAttempts: 0,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(outboxEntrySchema.parse(base).kind).toBe("workflow_resume");
    expect(() =>
      outboxEntrySchema.parse({ ...base, approvalRequestId: "apr_1", decisionId: "dec_1" }),
    ).toThrow();
    expect(() => outboxEntrySchema.parse({ ...base, promptReviewDecisionId: undefined })).toThrow();
  });
});
