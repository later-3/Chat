import { describe, expect, it } from "vitest";
import { piDirectExecutorEventSchema } from "@chat/pi-runtime";
import type { ResolvedCapabilitySnapshot } from "@chat/contracts";
import { piDirectExecutorActivities } from "./pi-direct-executor-activity.js";

const SHA = "a".repeat(64);
const scope = {
  productRunId: "run_qualifiedtool1",
  directAgentAttemptId: "att_qualifiedtool1",
};

function capability(localName: string, capabilityId: string): ResolvedCapabilitySnapshot {
  return {
    ref: {
      capabilityId: capabilityId as never,
      descriptorSha256: SHA,
      inputSchemaSha256: "b".repeat(64),
      resolvedImplementationSha256: "c".repeat(64),
      scopeRef: { kind: "workspace", rootId: "root_chat" },
    },
    localName,
    kind: "executable_tool",
    runtimeOwner: "pi_direct",
    sourceRef: {
      sourceKind: "managed_extension",
      package: "@chat/pi-runtime",
      revision: "d".repeat(40),
      artifactSha256: "e".repeat(64),
      resourcePath: "packages/pi-runtime/src/direct-agent-executor.ts",
      contentSha256: "f".repeat(64),
    },
    effect: "external_write",
    scopePolicy: "workspace_required",
    approvalPolicy: "product_decision_required",
    evidencePolicy: "product_intent_result",
  };
}

describe("Pi Direct qualified Capability activity projection", () => {
  it.each([["acme:probe", "pi_direct:tool:workspace_extension:0123456789abcdef0123:acme:probe"]])(
    "%s无损保留localName、qualified ID、source sequence与source hash",
    (localName, id) => {
      const snapshot = capability(localName, id);
      const started = piDirectExecutorActivities(
        scope,
        piDirectExecutorEventSchema.parse({
          operationId: "pio_qualifiedtool1",
          sequence: 7,
          timestamp: "2026-08-23T08:00:00.000Z",
          type: "tool.intent_persisted",
          sessionId: "pis_qualifiedtool1",
          toolCallId: "call_qualifiedtool1",
          toolName: localName,
          inputSha256: SHA,
          capability: snapshot,
        }),
      );
      const completed = piDirectExecutorActivities(
        scope,
        piDirectExecutorEventSchema.parse({
          operationId: "pio_qualifiedtool1",
          sequence: 8,
          timestamp: "2026-08-23T08:00:01.000Z",
          type: "tool.completed",
          sessionId: "pis_qualifiedtool1",
          toolCallId: "call_qualifiedtool1",
          toolName: localName,
          resultSha256: "1".repeat(64),
          capability: snapshot,
        }),
      );
      expect(started).toEqual([
        expect.objectContaining({
          sourceSequence: 7,
          toolName: localName,
          capability: expect.objectContaining({
            ref: expect.objectContaining({ capabilityId: id }),
            sourceRef: expect.objectContaining({ artifactSha256: "e".repeat(64) }),
          }),
        }),
      ]);
      expect(completed).toEqual([
        expect.objectContaining({
          sourceSequence: 8,
          phase: "completed",
          toolName: localName,
          capability: expect.objectContaining({
            ref: expect.objectContaining({ capabilityId: id }),
          }),
        }),
      ]);
    },
  );
});
