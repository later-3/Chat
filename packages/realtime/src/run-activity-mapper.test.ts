import { describe, expect, it } from "vitest";
import type { TraceEventInput } from "@chat/contracts";
import { runActivityFromTrace } from "./run-activity-mapper.js";

const NOW = "2026-08-26T00:00:00.000Z";

describe("治理Reviewer Activity身份", () => {
  it("Provider与Agent Activity都绑定独立Attempt和governance_reviewer节点", () => {
    const common = {
      traceId: "trace_activitygovernance1",
      productRunId: "run_activitygovernance1" as never,
      attemptId: "att_activitygovernance1" as never,
      promptTemplateVersion: "governance-review.v1",
      modelConfigVersion: "bailian.qwen3.7-plus.v1",
      nodeKind: "governance_reviewer" as const,
    };
    const provider = runActivityFromTrace(
      {
        ...common,
        level: "info",
        eventName: "provider.request.started",
        outcome: "unknown",
        spanId: "span_activity-provider",
        provider: "bailian",
        model: "qwen3.7-plus",
        endpointHost: "dashscope.aliyuncs.com",
        operation: "chat_completion",
        inputManifestSha256: "a".repeat(64),
      } as TraceEventInput,
      NOW,
    );
    const agent = runActivityFromTrace(
      {
        ...common,
        level: "info",
        eventName: "pi.node.started",
        outcome: "unknown",
        spanId: "span_activity-agent",
      } as TraceEventInput,
      NOW,
    );
    expect(provider).toMatchObject({
      activityType: "model",
      attemptId: "att_activitygovernance1",
      nodeKind: "governance_reviewer",
    });
    expect(agent).toMatchObject({
      activityType: "agent",
      attemptId: "att_activitygovernance1",
      nodeKind: "governance_reviewer",
    });
    expect(provider?.sourceKey).not.toBe(agent?.sourceKey);
  });
});
