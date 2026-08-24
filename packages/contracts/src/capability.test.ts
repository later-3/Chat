import { describe, expect, it } from "vitest";
import { capabilityDescriptorSchema, resolvedCapabilityRefSchema } from "./capability.js";

const SHA = "a".repeat(64);

describe("Capability v1 provider seam fixtures", () => {
  it.each([
    ["memory.query", "read", "run_policy", "runtime_journal"],
    ["memory.write", "external_write", "product_decision_required", "product_intent_result"],
  ] as const)(
    "%s可以表达Provider只读或外部写政策而不引入生产依赖",
    (name, effect, approval, evidence) => {
      const descriptor = capabilityDescriptorSchema.parse({
        schemaVersion: "capability-descriptor.v1",
        capabilityId: `provider:memory:operation:${name}`,
        kind: "provider_operation",
        runtimeOwner: "provider",
        localName: name,
        sourceRef: {
          sourceKind: "provider",
          package: "memory-provider-contract-fixture",
          revision: "fixture-v1",
          artifactSha256: SHA,
        },
        inputSchemaSha256: "b".repeat(64),
        effect,
        scopePolicy: "provider_defined",
        approvalPolicy: approval,
        evidencePolicy: evidence,
        readiness: "paused",
        descriptorSha256: "c".repeat(64),
      });
      const resolved = resolvedCapabilityRefSchema.parse({
        capabilityId: descriptor.capabilityId,
        descriptorSha256: descriptor.descriptorSha256,
        inputSchemaSha256: descriptor.inputSchemaSha256,
        resolvedImplementationSha256: "d".repeat(64),
        scopeRef: { kind: "provider", providerRef: "memory:future-fixture" },
      });
      expect(resolved.capabilityId).toBe(`provider:memory:operation:${name}`);
      expect(descriptor.effect).toBe(effect);
    },
  );
});
