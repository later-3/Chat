import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("workflow", async (importOriginal) => {
  const original = await importOriginal<typeof import("workflow")>();
  return { ...original, getStepMetadata: () => ({ attempt: 1 }) };
});

import { freezeMemoryBackendDescriptor, type MemoryBackendPort } from "@chat/application";
import type { MemoryQueryDispatchDto } from "@chat/contracts";
import { computeMemoryBackendDescriptorSha256 } from "@chat/domain";
import { setWorkflowRuntimeContext } from "./runtime-context.js";
import { queryMemoryContextStep } from "./workflow-planning-steps.js";

const SHA = "a".repeat(64);

function backend(queryImpl: MemoryBackendPort["query"]): MemoryBackendPort {
  return {
    describe: () => ({
      backendId: "mbk_memmy" as never,
      displayName: "memmy 本地记忆",
      kind: "memmy",
      adapterContractVersion: "memmy-http-query.v1",
      authMode: "none",
      credentialRevision: "none",
      configurationFingerprint: SHA,
      configured: true,
      capabilities: {
        query: true,
        tags: true,
        layers: ["L2"],
        maxLimit: 20,
        maxContextBudget: 8192,
      },
    }),
    health: async () => ({ status: "ready" }),
    query: queryImpl,
  };
}

function dispatch(memory: MemoryBackendPort): MemoryQueryDispatchDto {
  const profile = memory.describe();
  const backendDescriptor: MemoryQueryDispatchDto["backendDescriptor"] =
    freezeMemoryBackendDescriptor(profile);
  return {
    memoryQueryId: "mqy_workflow1" as never,
    contextRequestId: "ctxr_workflow1" as never,
    productRunId: "run_workflow1" as never,
    productSessionId: "psn_workflow1" as never,
    backendId: profile.backendId,
    backendDescriptor,
    backendDescriptorSha256: computeMemoryBackendDescriptorSha256(backendDescriptor),
    requirement: "optional",
    sourceMessageSha256: "b".repeat(64),
    queryText: "private query text",
    tags: ["private-tag"],
    layers: ["L2"],
    limit: 3,
    contextBudget: 512,
  };
}

function installContext(memory: MemoryBackendPort, events: unknown[]) {
  setWorkflowRuntimeContext({
    api: {} as never,
    bindings: {} as never,
    memoryBackends: { list: () => [memory], get: () => memory },
    trace: (event) => events.push(event),
    now: () => "2026-08-08T00:00:00.000Z",
    bailian: {} as never,
    planner: vi.fn() as never,
    executor: vi.fn() as never,
  });
}

afterEach(() => setWorkflowRuntimeContext(undefined));

describe("queryMemoryContextStep", () => {
  it("复核冻结profile后返回strict checkpoint，并只记录ID、计数、Hash和耗时", async () => {
    const query = vi.fn(async () => ({
      externalQueryId: "external-query-1",
      hitCount: 1,
      sections: [
        {
          externalObjectIds: ["memory-1"],
          title: "private title",
          kind: "policy" as const,
          memoryLayer: "L2" as const,
          content: "private memory body",
          tags: ["private-tag"],
        },
      ],
    }));
    const memory = backend(query);
    const events: unknown[] = [];
    installContext(memory, events);

    const result = await queryMemoryContextStep({
      attemptId: "att_workflow1",
      query: dispatch(memory),
    });

    expect(result.outcome).toBe("success");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ operationId: "mqy_workflow1" }));
    expect(
      (queryMemoryContextStep as typeof queryMemoryContextStep & { maxRetries: number }).maxRetries,
    ).toBe(0);
    const serializedTrace = JSON.stringify(events);
    expect(serializedTrace).toContain("memory.query.started");
    expect(serializedTrace).toContain("memory.query.completed");
    expect(serializedTrace).not.toContain("private query text");
    expect(serializedTrace).not.toContain("private memory body");
    expect(serializedTrace).not.toContain("private-tag");
    expect(serializedTrace).not.toContain("private title");
  });

  it("API冻结的认证配置、profile或Hash与Workflow漂移时拒绝且不调用后端", async () => {
    const query = vi.fn(async () => ({ externalQueryId: "unused", hitCount: 0, sections: [] }));
    const original = backend(query);
    const frozen = dispatch(original);
    const changedCredential: MemoryBackendPort = {
      ...original,
      describe: () => ({
        ...original.describe(),
        authMode: "bearer",
        credentialRevision: "workflow-key-2",
      }),
    };
    const events: unknown[] = [];
    installContext(changedCredential, events);

    const credentialResult = await queryMemoryContextStep({
      attemptId: "att_workflow2",
      query: frozen,
    });
    installContext(original, events);
    const hashResult = await queryMemoryContextStep({
      attemptId: "att_workflow3",
      query: { ...frozen, backendDescriptorSha256: "f".repeat(64) },
    });

    expect(credentialResult).toEqual({
      outcome: "failure",
      errorCode: "memory.backend.profile_changed",
    });
    expect(hashResult).toEqual({
      outcome: "failure",
      errorCode: "memory.backend.profile_changed",
    });
    expect(query).not.toHaveBeenCalled();
    expect(JSON.stringify(events).match(/memory\.query\.failed/g)).toHaveLength(2);
  });
});
