import {
  DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
  DIRECT_AGENT_RUNTIME_PATHS,
} from "@chat/contracts";
import { canonicalJsonStringify } from "@chat/domain";
import { describe, expect, it } from "vitest";
import {
  PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
  type StartPiDirectExecutorOperationRequest,
} from "./direct-executor-service-contract.js";
import { createDirectAgentRuntimeApiCallbacks } from "./direct-runtime-api-callbacks.js";
import { hashFinalProviderPayload } from "./prompt-review-gate.js";

const payload = { messages: [{ role: "user", content: "review me" }], model: "model-test" };

describe("Direct Agent Runtime Fetch callbacks", () => {
  it("按固定私有路径与Schema映射authorize/publish/consume/outcome/candidate", async () => {
    const calls: Array<{ readonly path: string; readonly body: Record<string, unknown> }> = [];
    const payloadSha256 = hashFinalProviderPayload(payload);
    const fetchFn: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname.replace("/internal/runtime/v1", "");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      expect(new Headers(init?.headers).get("x-chat-runtime-key")).toBe("rtk_callbacktest");
      const common = { schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION };
      if (path === DIRECT_AGENT_RUNTIME_PATHS.authorizeOperation) {
        return Response.json({
          ...common,
          productRunId: "run_callbacktest",
          directAgentAttemptId: "att_callbacktest",
          runRevision: 1,
          sourceMessage: {
            messageId: "msg_callbacktest",
            text: "review me",
            sha256: "3".repeat(64),
          },
          promptAssembly: {
            promptAssemblyId: "pma_callbacktest",
            sha256: "7".repeat(64),
            systemPromptAppend: "# Agent 身份",
            userPrompt: "review me",
          },
          capabilityMode: "read_only",
          limits: {
            maxProviderRequests: 16,
            activeTimeoutMs: 1_200_000,
            tokenBudget: 64_000,
          },
        });
      }
      if (path === DIRECT_AGENT_RUNTIME_PATHS.publishPromptReview) {
        return Response.json(
          {
            ...common,
            promptReviewRequestId: "prr_callbacktest",
            productRunId: "run_callbacktest",
            requestRevision: 1,
            requestIndex: 1,
            payloadSha256,
            reviewSha256: "4".repeat(64),
            status: "open",
            revision: 1,
            runRevision: 2,
          },
          { status: 201 },
        );
      }
      if (path === DIRECT_AGENT_RUNTIME_PATHS.consumePromptReviewDecision) {
        return Response.json({
          ...common,
          status: "authorized",
          decision: {
            promptReviewDecisionId: "prd_callbacktest",
            promptReviewRequestId: "prr_callbacktest",
            productRunId: "run_callbacktest",
            requestRevision: 1,
            reviewSha256: "4".repeat(64),
            payloadSha256,
            kind: "approve",
            revision: 1,
            decisionSha256: "5".repeat(64),
          },
          runRevision: 3,
          canonicalPayloadJson: canonicalJsonStringify(payload),
          payloadSha256,
          reviewSha256: "4".repeat(64),
          requestIndex: 1,
          requestKind: "agent_turn",
          providerId: "provider-test",
          modelId: "model-test",
          endpointHost: "provider.example",
        });
      }
      if (path === DIRECT_AGENT_RUNTIME_PATHS.commitPromptReviewDispatchOutcome) {
        return Response.json({
          ...common,
          promptReviewRequestId: "prr_callbacktest",
          productRunId: "run_callbacktest",
          status: "dispatched",
          revision: 4,
        });
      }
      if (path === DIRECT_AGENT_RUNTIME_PATHS.persistCandidate) {
        return Response.json(
          {
            ...common,
            directAgentCandidateId: "drc_callbacktest",
            productRunId: "run_callbacktest",
            sha256: "6".repeat(64),
          },
          { status: 201 },
        );
      }
      return new Response(null, { status: 404 });
    };
    const callbacks = createDirectAgentRuntimeApiCallbacks({
      baseUrl: "http://api.test",
      credential: "rtk_callbacktest",
      fetchFn,
    });
    const request: StartPiDirectExecutorOperationRequest = {
      schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
      operationId: "pio_callbacktest",
      productRunId: "run_callbacktest" as never,
      directAgentAttemptId: "att_callbacktest" as never,
      workflowRunSpecId: "wrs_callbacktest" as never,
      workflowRunSpecSha256: "1".repeat(64),
      inputManifestSha256: "2".repeat(64),
    };
    await expect(callbacks.authorizeOperation(request)).resolves.toMatchObject({
      sourceMessage: { text: "review me" },
      promptAssembly: { userPrompt: "review me" },
      capabilityMode: "read_only",
    });
    const published = await callbacks.promptReviewProduct.publish({
      commandId: "cmd_callbackpublish",
      productRunId: "run_callbacktest",
      directAgentAttemptId: "att_callbacktest",
      expectedRunRevision: 1,
      requestIndex: 1,
      requestKind: "agent_turn",
      providerId: "provider-test",
      modelId: "model-test",
      endpointHost: "provider.example",
      payload,
      canonicalPayloadJson: canonicalJsonStringify(payload),
      payloadSha256,
    });
    const consumed = await callbacks.promptReviewProduct.consumeDecision({
      commandId: "cmd_callbackconsume",
      operationId: request.operationId,
      productRunId: request.productRunId,
      directAgentAttemptId: request.directAgentAttemptId,
      review: published.review,
      providerId: "provider-test",
      modelId: "model-test",
      endpointHost: "provider.example",
      promptReviewDecisionId: "prd_callbacktest",
    });
    expect(consumed).toMatchObject({
      status: "authorized",
      productRunRevision: 3,
      frozenPayload: payload,
    });
    await callbacks.promptReviewProduct.commitDispatchOutcome({
      commandId: "cmd_callbackoutcome",
      productRunId: request.productRunId,
      directAgentAttemptId: request.directAgentAttemptId,
      promptReviewRequestId: published.review.promptReviewRequestId,
      outcome: "dispatched",
    });
    await expect(
      callbacks.publishResult({
        commandId: "cmd_callbackcandidate",
        productRunId: request.productRunId,
        directAgentAttemptId: request.directAgentAttemptId,
        output: { format: "markdown", text: "done" },
      }),
    ).resolves.toEqual({ directAgentCandidateId: "drc_callbacktest", sha256: "6".repeat(64) });

    expect(calls.map((call) => call.path)).toEqual([
      DIRECT_AGENT_RUNTIME_PATHS.authorizeOperation,
      DIRECT_AGENT_RUNTIME_PATHS.publishPromptReview,
      DIRECT_AGENT_RUNTIME_PATHS.consumePromptReviewDecision,
      DIRECT_AGENT_RUNTIME_PATHS.commitPromptReviewDispatchOutcome,
      DIRECT_AGENT_RUNTIME_PATHS.persistCandidate,
    ]);
    expect(JSON.stringify(calls)).not.toContain("rtk_callbacktest");
  });
});
