import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeApiClient } from "@chat/contracts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

describe("RuntimeApiClient Direct Agent私有边界", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Workflow只交换Attempt/Decision/Candidate引用与Hash，不携带Provider正文", async () => {
    const responses = [
      {
        schemaVersion: "chat-internal-runtime.v1",
        directAgentAttemptId: "att_directagent1",
        inputManifestSha256: SHA_A,
        runRevision: 2,
      },
      {
        schemaVersion: "chat-internal-runtime.v1",
        decision: {
          promptReviewDecisionId: "prd_directdecision1",
          promptReviewRequestId: "prr_directreview1",
          productRunId: "run_directapi1",
          requestRevision: 1,
          reviewSha256: SHA_B,
          payloadSha256: SHA_C,
          kind: "approve",
          revision: 1,
          decisionSha256: SHA_A,
        },
      },
      {
        schemaVersion: "chat-internal-runtime.v1",
        directAgentCandidateId: "drc_directcandidate1",
        messageId: "msg_directresult1",
        productRunId: "run_directapi1",
      },
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const body = responses.shift();
      if (body === undefined) throw new Error("unexpected request");
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createRuntimeApiClient({
      baseUrl: "http://127.0.0.1:43111",
      credential: "rtk_direct_test",
    });

    await client.beginDirectAgentAttempt({
      commandId: "cmd_begindirectagent1" as never,
      productRunId: "run_directapi1" as never,
      workflowAttemptId: "att_directworkflow1" as never,
    });
    await client.loadPromptReviewDecision({
      productRunId: "run_directapi1" as never,
      promptReviewRequestId: "prr_directreview1" as never,
      promptReviewDecisionId: "prd_directdecision1" as never,
      requestRevision: 1,
      reviewSha256: SHA_B,
      payloadSha256: SHA_C,
    });
    await client.commitDirectAgentResult({
      commandId: "cmd_commitdirectagent1" as never,
      productRunId: "run_directapi1" as never,
      directAgentAttemptId: "att_directagent1" as never,
      directAgentCandidateId: "drc_directcandidate1" as never,
      candidateSha256: SHA_A,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:43111/internal/runtime/v1/begin-direct-agent-attempt",
      "http://127.0.0.1:43111/internal/runtime/v1/load-prompt-review-decision",
      "http://127.0.0.1:43111/internal/runtime/v1/commit-direct-agent-result",
    ]);
    expect(calls[1]?.body).toEqual({
      schemaVersion: "chat-internal-runtime.v1",
      productRunId: "run_directapi1",
      promptReviewRequestId: "prr_directreview1",
      promptReviewDecisionId: "prd_directdecision1",
      requestRevision: 1,
      reviewSha256: SHA_B,
      payloadSha256: SHA_C,
    });
    expect(JSON.stringify(calls)).not.toContain("canonicalPayloadJson");
    expect(JSON.stringify(calls)).not.toContain("readablePrompt");
  });
});
