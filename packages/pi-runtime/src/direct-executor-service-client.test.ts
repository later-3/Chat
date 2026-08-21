import { describe, expect, it } from "vitest";
import { createPiDirectExecutorServiceClient } from "./direct-executor-service-client.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const TIMESTAMP = "2026-08-21T00:00:00.000Z";
const operationId = "pio_directclientrace1";
const review = {
  promptReviewRequestId: "prr_directclientrace1",
  requestRevision: 1,
  revision: 1,
  requestIndex: 1,
  payloadSha256: SHA_B,
  reviewSha256: SHA_C,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Pi Direct Executor client event drain", () => {
  it("drains events appended between the events GET and waiting snapshot GET", async () => {
    let eventReads = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/operations")) {
        return json(
          {
            schemaVersion: "pi-direct-executor.v1",
            operationId,
            requestSha256: SHA_A,
            status: "queued",
            lastEventSequence: 1,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          202,
        );
      }
      if (url.pathname.endsWith("/events")) {
        eventReads += 1;
        return json({
          schemaVersion: "pi-direct-executor.v1",
          operationId,
          events:
            eventReads === 1
              ? [
                  {
                    sequence: 1,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "operation.accepted",
                    requestSha256: SHA_A,
                  },
                ]
              : [
                  {
                    sequence: 2,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "prompt_review.preparing",
                    requestIndex: 1,
                    payloadSha256: SHA_B,
                    payloadEnvelopeSha256: SHA_C,
                    checkpointSha256: SHA_A,
                  },
                  {
                    sequence: 3,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "prompt_review.waiting",
                    review,
                  },
                ],
          lastEventSequence: eventReads === 1 ? 1 : 3,
        });
      }
      return json({
        schemaVersion: "pi-direct-executor.v1",
        operationId,
        requestSha256: SHA_A,
        status: "waiting_prompt_review",
        activeReview: review,
        lastEventSequence: 3,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      });
    };
    const client = createPiDirectExecutorServiceClient({
      baseUrl: "http://127.0.0.1:43115",
      credential: "rtk_test",
      fetchFn,
      pollIntervalMs: 1,
    });
    const events: string[] = [];
    const result = await client.start({
      productRunId: "run_directclientrace1",
      directAgentAttemptId: "att_directclientrace1",
      workflowRunSpecId: "wrs_directclientrace1",
      workflowRunSpecSha256: SHA_A,
      inputManifestSha256: SHA_B,
      onEvent: (event) => events.push(event.type),
    });
    expect(result.kind).toBe("waiting_prompt_review");
    expect(events).toEqual([
      "operation.accepted",
      "prompt_review.preparing",
      "prompt_review.waiting",
    ]);
  });
});
