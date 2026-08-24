import { describe, expect, it, vi } from "vitest";
import type { ResolvedCapabilitySnapshot } from "@chat/contracts";
import { ToolExecutionCoordinator, type ToolExecutionProductPort } from "./tool-execution-gate.js";

function capability(effect: "read" | "local_write" | "shell"): ResolvedCapabilitySnapshot {
  return {
    ref: {
      capabilityId: `pi_direct:tool:builtin:${effect === "shell" ? "bash" : effect === "local_write" ? "write" : "read"}`,
      descriptorSha256: "1".repeat(64),
      inputSchemaSha256: "2".repeat(64),
      resolvedImplementationSha256: "3".repeat(64),
      scopeRef: { kind: "workspace", rootId: "root_test" },
    },
    localName: effect === "shell" ? "bash" : effect === "local_write" ? "write" : "read",
    kind: "executable_tool",
    runtimeOwner: "pi_direct",
    sourceRef: {
      sourceKind: "builtin",
      package: "@earendil-works/pi-coding-agent",
      revision: "4".repeat(40),
    },
    effect,
    scopePolicy: "workspace_required",
    approvalPolicy: effect === "read" ? "run_policy" : "product_decision_required",
    evidencePolicy: effect === "read" ? "runtime_journal" : "product_intent_result",
  };
}

function coordinator(port: ToolExecutionProductPort) {
  return new ToolExecutionCoordinator(port, {
    operationId: "pio_gate1",
    productRunId: "run_gate1",
    directAgentAttemptId: "att_gate1",
    inputManifestSha256: "9".repeat(64),
  });
}

function port(claim: ToolExecutionProductPort["claim"]): ToolExecutionProductPort & {
  publish: ReturnType<typeof vi.fn<ToolExecutionProductPort["publish"]>>;
  commitResult: ReturnType<typeof vi.fn<ToolExecutionProductPort["commitResult"]>>;
} {
  return {
    publish: vi.fn(async () => ({ toolExecutionIntentId: "tei_gate1", revision: 1 })),
    claim,
    commitResult: vi.fn(async () => undefined),
  };
}

const authorizeInput = (resolved: ResolvedCapabilitySnapshot) => ({
  capability: resolved,
  toolCallId: "tool_gate1",
  inputDisplay: '{"path":"README.md"}',
  inputDisplayTruncated: false,
  inputSha256: "5".repeat(64),
  signal: new AbortController().signal,
});

describe("ToolExecutionCoordinator", () => {
  it("只读Tool不创建Product Decision", async () => {
    const product = port(vi.fn());
    await expect(
      coordinator(product).authorize(authorizeInput(capability("read"))),
    ).resolves.toBeUndefined();
    expect(product.publish).not.toHaveBeenCalled();
  });

  it("拒绝在handler前返回block，批准后结果只提交一次", async () => {
    const rejected = port(
      vi.fn(async () => ({
        schemaVersion: "chat-internal-runtime.v1" as const,
        status: "rejected" as const,
        toolExecutionIntentId: "tei_gate1" as never,
        toolExecutionDecisionId: "ted_gate1" as never,
        decisionIntentRevision: 1,
        capabilityDescriptorSha256: "1".repeat(64),
        inputSha256: "5".repeat(64),
        scopeRef: { kind: "workspace" as const, rootId: "root_test" },
        revision: 2,
        explanation: "不允许改写",
      })),
    );
    await expect(
      coordinator(rejected).authorize(authorizeInput(capability("local_write"))),
    ).resolves.toEqual({ block: true, reason: "不允许改写" });
    expect(rejected.commitResult).not.toHaveBeenCalled();

    const approved = port(
      vi.fn(async () => ({
        schemaVersion: "chat-internal-runtime.v1" as const,
        status: "authorized" as const,
        toolExecutionIntentId: "tei_gate1" as never,
        toolExecutionDecisionId: "ted_gate1" as never,
        decisionIntentRevision: 1,
        capabilityDescriptorSha256: "1".repeat(64),
        inputSha256: "5".repeat(64),
        scopeRef: { kind: "workspace" as const, rootId: "root_test" },
        revision: 3,
      })),
    );
    const gate = coordinator(approved);
    await gate.authorize(authorizeInput(capability("shell")));
    await gate.commit({
      toolCallId: "tool_gate1",
      resultSha256: "6".repeat(64),
      journalResultSha256: "7".repeat(64),
      failed: false,
    });
    await gate.commit({
      toolCallId: "tool_gate1",
      resultSha256: "6".repeat(64),
      journalResultSha256: "7".repeat(64),
      failed: false,
    });
    expect(approved.commitResult).toHaveBeenCalledTimes(1);
  });

  it("许可响应可能丢失时不再次执行并提交outcome_unknown", async () => {
    const product = port(
      vi.fn(async () => ({
        schemaVersion: "chat-internal-runtime.v1" as const,
        status: "already_claimed" as const,
        toolExecutionIntentId: "tei_gate1" as never,
        revision: 3,
      })),
    );
    await expect(
      coordinator(product).authorize(authorizeInput(capability("shell"))),
    ).rejects.toThrow("tool_execution.permit_response_unknown");
    expect(product.commitResult).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "outcome_unknown" }),
    );
  });
});
