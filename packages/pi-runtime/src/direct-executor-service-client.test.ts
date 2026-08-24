import { describe, expect, it } from "vitest";
import { createPiDirectExecutorServiceClient } from "./direct-executor-service-client.js";
import { PI_DIRECT_EXECUTOR_PROTOCOL_VERSION } from "./direct-executor-service-contract.js";
import { hashExecutorValue } from "./executor-operation-store.js";
import { operationIdForDirectAgentAttempt } from "./direct-executor-identity.js";
import { hashCanonical } from "@chat/domain";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const TIMESTAMP = "2026-08-21T00:00:00.000Z";
const operationId = operationIdForDirectAgentAttempt("att_directclientrace1");
const REQUEST_SHA = hashExecutorValue({
  schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
  operationId,
  productRunId: "run_directclientrace1",
  directAgentAttemptId: "att_directclientrace1",
  workflowRunSpecId: "wrs_directclientrace1",
  workflowRunSpecSha256: SHA_A,
  inputManifestSha256: SHA_B,
});
const review = {
  promptReviewRequestId: "prr_directclientrace1" as never,
  requestRevision: 1,
  revision: 1,
  requestIndex: 1,
  payloadSha256: SHA_B,
  reviewSha256: SHA_C,
};
const ZERO_MANIFEST_INPUT = {
  schemaVersion: "pi-direct-resolved-runtime-manifest.v1" as const,
  systemPromptSha256: SHA_A,
  resourceInventorySha256: SHA_B,
};
const ZERO_MANIFEST = {
  resolvedRuntimeManifest: ZERO_MANIFEST_INPUT,
  resolvedCapabilities: [],
  resolvedRuntimeManifestSha256: hashExecutorValue({
    systemPromptSha256: ZERO_MANIFEST_INPUT.systemPromptSha256,
    capabilities: [],
    resourceInventorySha256: ZERO_MANIFEST_INPUT.resourceInventorySha256,
  }),
};

function clientCapability(localName: "read" | "bash", capabilityId: string) {
  const sourceRef = {
    sourceKind: "builtin" as const,
    package: "@earendil-works/pi-coding-agent",
    repository: "later-3/pi",
    revision: "d".repeat(40),
    resourcePath: `pi/packages/coding-agent/src/core/tools/${localName}.ts`,
  };
  const inputSchemaSha256 = hashExecutorValue({ localName, schema: "client-test" });
  const descriptorInput = {
    schemaVersion: "capability-descriptor.v1" as const,
    capabilityId,
    kind: "executable_tool" as const,
    runtimeOwner: "pi_direct" as const,
    localName,
    sourceRef,
    inputSchemaSha256,
    effect: localName === "read" ? ("read" as const) : ("shell" as const),
    scopePolicy: "workspace_required" as const,
    approvalPolicy:
      localName === "read" ? ("run_policy" as const) : ("product_decision_required" as const),
    evidencePolicy:
      localName === "read" ? ("runtime_journal" as const) : ("product_intent_result" as const),
    readiness: "available" as const,
  };
  const descriptorSha256 = hashCanonical("capability-descriptor.v1", descriptorInput);
  return {
    ref: {
      capabilityId,
      descriptorSha256,
      inputSchemaSha256,
      resolvedImplementationSha256: hashExecutorValue({ sourceRef, descriptorSha256 }),
      scopeRef: { kind: "workspace" as const, rootId: "root_chat" },
    },
    localName,
    kind: descriptorInput.kind,
    runtimeOwner: descriptorInput.runtimeOwner,
    sourceRef,
    effect: descriptorInput.effect,
    scopePolicy: descriptorInput.scopePolicy,
    approvalPolicy: descriptorInput.approvalPolicy,
    evidencePolicy: descriptorInput.evidencePolicy,
  };
}

function manifestForCapabilities(capabilities: readonly ReturnType<typeof clientCapability>[]) {
  return {
    resolvedRuntimeManifest: ZERO_MANIFEST_INPUT,
    resolvedCapabilities: capabilities,
    resolvedRuntimeManifestSha256: hashExecutorValue({
      systemPromptSha256: ZERO_MANIFEST_INPUT.systemPromptSha256,
      capabilities,
      resourceInventorySha256: ZERO_MANIFEST_INPUT.resourceInventorySha256,
    }),
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Pi Direct Executor client event drain", () => {
  it("succeeded v2缺少冻结Manifest时收敛outcome_unknown且不返回Candidate", async () => {
    const resultRef = {
      directAgentCandidateId: "drc_directclientmanifest",
      sha256: SHA_C,
    };
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/operations")) {
        return json(
          {
            schemaVersion: "pi-direct-executor.v2",
            operationId,
            requestSha256: REQUEST_SHA,
            status: "queued",
            lastEventSequence: 1,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          202,
        );
      }
      if (url.pathname.endsWith("/events")) {
        return json({
          schemaVersion: "pi-direct-executor.v2",
          operationId,
          events: [
            {
              sequence: 1,
              timestamp: TIMESTAMP,
              operationId,
              type: "operation.accepted",
              requestSha256: REQUEST_SHA,
            },
            {
              sequence: 2,
              timestamp: TIMESTAMP,
              operationId,
              type: "operation.started",
              requestSha256: REQUEST_SHA,
            },
            {
              sequence: 3,
              timestamp: TIMESTAMP,
              operationId,
              type: "session.started",
              sessionId: "pis_directclientmanifest",
              enabledTools: [],
            },
            {
              sequence: 4,
              timestamp: TIMESTAMP,
              operationId,
              type: "operation.completed",
              result: resultRef,
            },
          ],
          lastEventSequence: 4,
        });
      }
      return json({
        schemaVersion: "pi-direct-executor.v2",
        operationId,
        requestSha256: REQUEST_SHA,
        status: "succeeded",
        sessionId: "pis_directclientmanifest",
        result: resultRef,
        lastEventSequence: 4,
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

    await expect(
      client.start({
        productRunId: "run_directclientrace1",
        directAgentAttemptId: "att_directclientrace1",
        workflowRunSpecId: "wrs_directclientrace1",
        workflowRunSpecSha256: SHA_A,
        inputManifestSha256: SHA_B,
      }),
    ).resolves.toEqual({
      kind: "outcome_unknown",
      operationId,
      requestSha256: REQUEST_SHA,
      errorCode: "direct_executor.journal_integrity_invalid",
    });
  });

  it("accepted到completed但没有Session的succeeded v2收敛outcome_unknown", async () => {
    const resultRef = {
      directAgentCandidateId: "drc_directclientnosession",
      sha256: SHA_C,
    };
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/operations")) {
        return json(
          {
            schemaVersion: "pi-direct-executor.v2",
            operationId,
            requestSha256: REQUEST_SHA,
            status: "queued",
            lastEventSequence: 1,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          202,
        );
      }
      if (url.pathname.endsWith("/events")) {
        return json({
          schemaVersion: "pi-direct-executor.v2",
          operationId,
          events: [
            {
              sequence: 1,
              timestamp: TIMESTAMP,
              operationId,
              type: "operation.accepted",
              requestSha256: REQUEST_SHA,
            },
            {
              sequence: 2,
              timestamp: TIMESTAMP,
              operationId,
              type: "operation.started",
              requestSha256: REQUEST_SHA,
            },
            {
              sequence: 3,
              timestamp: TIMESTAMP,
              operationId,
              type: "operation.completed",
              result: resultRef,
            },
          ],
          lastEventSequence: 3,
        });
      }
      return json({
        schemaVersion: "pi-direct-executor.v2",
        operationId,
        requestSha256: REQUEST_SHA,
        status: "succeeded",
        result: resultRef,
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

    await expect(
      client.start({
        productRunId: "run_directclientrace1",
        directAgentAttemptId: "att_directclientrace1",
        workflowRunSpecId: "wrs_directclientrace1",
        workflowRunSpecSha256: SHA_A,
        inputManifestSha256: SHA_B,
      }),
    ).resolves.toEqual({
      kind: "outcome_unknown",
      operationId,
      requestSha256: REQUEST_SHA,
      errorCode: "direct_executor.journal_integrity_invalid",
    });
  });

  it("succeeded v2的Manifest重复capabilityId时收敛outcome_unknown", async () => {
    const resultRef = {
      directAgentCandidateId: "drc_directclientduplicatecap",
      sha256: SHA_C,
    };
    const capabilities = [
      clientCapability("read", "pi_direct:tool:builtin:shared"),
      clientCapability("bash", "pi_direct:tool:builtin:shared"),
    ];
    const manifest = manifestForCapabilities(capabilities);
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/operations")) {
        return json(
          {
            schemaVersion: "pi-direct-executor.v2",
            operationId,
            requestSha256: REQUEST_SHA,
            status: "queued",
            lastEventSequence: 1,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          202,
        );
      }
      if (url.pathname.endsWith("/events")) {
        return json({
          schemaVersion: "pi-direct-executor.v2",
          operationId,
          events: [
            {
              sequence: 1,
              timestamp: TIMESTAMP,
              operationId,
              type: "operation.accepted",
              requestSha256: REQUEST_SHA,
            },
            {
              sequence: 2,
              timestamp: TIMESTAMP,
              operationId,
              type: "operation.started",
              requestSha256: REQUEST_SHA,
            },
            {
              sequence: 3,
              timestamp: TIMESTAMP,
              operationId,
              type: "session.started",
              sessionId: "pis_directclientduplicatecap",
              enabledTools: ["read", "bash"],
              ...manifest,
            },
            {
              sequence: 4,
              timestamp: TIMESTAMP,
              operationId,
              type: "operation.completed",
              result: resultRef,
            },
          ],
          lastEventSequence: 4,
        });
      }
      return json({
        schemaVersion: "pi-direct-executor.v2",
        operationId,
        requestSha256: REQUEST_SHA,
        status: "succeeded",
        sessionId: "pis_directclientduplicatecap",
        ...manifest,
        result: resultRef,
        lastEventSequence: 4,
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

    await expect(
      client.start({
        productRunId: "run_directclientrace1",
        directAgentAttemptId: "att_directclientrace1",
        workflowRunSpecId: "wrs_directclientrace1",
        workflowRunSpecSha256: SHA_A,
        inputManifestSha256: SHA_B,
      }),
    ).resolves.toEqual({
      kind: "outcome_unknown",
      operationId,
      requestSha256: REQUEST_SHA,
      errorCode: "direct_executor.journal_integrity_invalid",
    });
  });

  it.each([
    {
      label: "另一Operation",
      response: { operationId: "pio_otheroperation", requestSha256: REQUEST_SHA },
    },
    {
      label: "同Operation下另一Request",
      response: { operationId, requestSha256: "d".repeat(64) },
    },
  ])("审核恢复拒绝形状合法的2xx $label", async ({ response }) => {
    const client = createPiDirectExecutorServiceClient({
      baseUrl: "http://127.0.0.1:43115",
      credential: "rtk_test",
      fetchFn: async () =>
        json({
          schemaVersion: "pi-direct-executor.v2",
          ...response,
          status: "waiting_prompt_review",
          sessionId: "pis_directclientrace1",
          activeReview: review,
          lastEventSequence: 5,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        }),
      pollIntervalMs: 1,
    });

    await expect(
      client.submitDecision({
        operationId,
        requestSha256: REQUEST_SHA,
        review,
        promptReviewDecisionId: "prd_directclientrace1",
      }),
    ).rejects.toThrow("direct_executor.response_identity_mismatch");
  });

  it("首次观察v2后任何v1 events或snapshot降级都失败关闭", async () => {
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST") {
        return json(
          {
            schemaVersion: "pi-direct-executor.v2",
            operationId,
            requestSha256: REQUEST_SHA,
            status: "queued",
            lastEventSequence: 1,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          202,
        );
      }
      if (url.pathname.endsWith("/events")) {
        return json({
          schemaVersion: "pi-direct-executor.v1",
          operationId,
          events: [],
          lastEventSequence: 1,
        });
      }
      throw new Error("降级events必须在读取Snapshot前失败");
    };
    const client = createPiDirectExecutorServiceClient({
      baseUrl: "http://127.0.0.1:43115",
      credential: "rtk_test",
      fetchFn,
      pollIntervalMs: 1,
    });
    await expect(
      client.start({
        productRunId: "run_directclientrace1",
        directAgentAttemptId: "att_directclientrace1",
        workflowRunSpecId: "wrs_directclientrace1",
        workflowRunSpecSha256: SHA_A,
        inputManifestSha256: SHA_B,
      }),
    ).rejects.toThrow();
  });

  it("drains events appended between the events GET and waiting snapshot GET", async () => {
    let eventReads = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/operations")) {
        return json(
          {
            schemaVersion: "pi-direct-executor.v2",
            operationId,
            requestSha256: REQUEST_SHA,
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
          schemaVersion: "pi-direct-executor.v2",
          operationId,
          events:
            eventReads === 1
              ? [
                  {
                    sequence: 1,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "operation.accepted",
                    requestSha256: REQUEST_SHA,
                  },
                ]
              : [
                  {
                    sequence: 2,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "operation.started",
                    requestSha256: REQUEST_SHA,
                  },
                  {
                    sequence: 3,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "session.started",
                    sessionId: "pis_directclientrace1",
                    enabledTools: [],
                    ...ZERO_MANIFEST,
                  },
                  {
                    sequence: 4,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "prompt_review.preparing",
                    requestIndex: 1,
                    payloadSha256: SHA_B,
                    payloadEnvelopeSha256: SHA_C,
                    checkpointSha256: SHA_A,
                  },
                  {
                    sequence: 5,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "prompt_review.waiting",
                    review,
                  },
                ],
          lastEventSequence: eventReads === 1 ? 1 : 5,
        });
      }
      return json({
        schemaVersion: "pi-direct-executor.v2",
        operationId,
        requestSha256: REQUEST_SHA,
        status: "waiting_prompt_review",
        sessionId: "pis_directclientrace1",
        activeReview: review,
        ...ZERO_MANIFEST,
        lastEventSequence: 5,
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
      "operation.started",
      "session.started",
      "prompt_review.preparing",
      "prompt_review.waiting",
    ]);
  });

  it("activity projection fails once then replays the same source sequence without affecting execution", async () => {
    let eventReads = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname.endsWith("/operations")) {
        return json(
          {
            schemaVersion: "pi-direct-executor.v2",
            operationId,
            requestSha256: REQUEST_SHA,
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
          schemaVersion: "pi-direct-executor.v2",
          operationId,
          events:
            eventReads === 1
              ? [
                  {
                    sequence: 1,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "operation.accepted",
                    requestSha256: REQUEST_SHA,
                  },
                ]
              : [
                  {
                    sequence: 2,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "operation.started",
                    requestSha256: REQUEST_SHA,
                  },
                  {
                    sequence: 3,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "session.started",
                    sessionId: "pis_directclientrace1",
                    enabledTools: [],
                    ...ZERO_MANIFEST,
                  },
                  {
                    sequence: 4,
                    timestamp: TIMESTAMP,
                    operationId,
                    type: "prompt_review.waiting",
                    review,
                  },
                ],
          lastEventSequence: eventReads === 1 ? 1 : 4,
        });
      }
      return json({
        schemaVersion: "pi-direct-executor.v2",
        operationId,
        requestSha256: REQUEST_SHA,
        status: "waiting_prompt_review",
        sessionId: "pis_directclientrace1",
        activeReview: review,
        ...ZERO_MANIFEST,
        lastEventSequence: 4,
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
    const projected: Array<{ type: string; sequence: number }> = [];
    let failOnce = true;
    const result = await client.start({
      productRunId: "run_directclientrace1",
      directAgentAttemptId: "att_directclientrace1",
      workflowRunSpecId: "wrs_directclientrace1",
      workflowRunSpecSha256: SHA_A,
      inputManifestSha256: SHA_B,
      onEvent: (event) => {
        projected.push({ type: event.type, sequence: event.sequence });
        if (failOnce) {
          failOnce = false;
          return false;
        }
        return true;
      },
    });
    expect(result.kind).toBe("waiting_prompt_review");
    expect(projected).toEqual([
      { type: "operation.accepted", sequence: 1 },
      { type: "operation.accepted", sequence: 1 },
      { type: "operation.started", sequence: 2 },
      { type: "session.started", sequence: 3 },
      { type: "prompt_review.waiting", sequence: 4 },
    ]);
  });
});
