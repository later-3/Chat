import { afterEach, describe, expect, it, vi } from "vitest";

const workflowMetadata = vi.hoisted(() => ({ attempt: 1 }));
vi.mock("workflow", async (importOriginal) => {
  const original = await importOriginal<typeof import("workflow")>();
  return { ...original, getStepMetadata: () => ({ attempt: workflowMetadata.attempt }) };
});

import {
  WorkflowMemoryProviderError,
  type WorkflowMemoryQueryProviderPort,
} from "@chat/application";
import type { MemoryProviderDescriptor, WorkflowMemoryQueryDispatchDto } from "@chat/contracts";
import { computeMemoryProviderDescriptorSha256 } from "@chat/domain";
import {
  callMemoryWriteProviderStep,
  reconcileMemoryWriteProviderStep,
} from "./memory-write-workflow-steps.js";
import { setWorkflowRuntimeContext } from "./runtime-context.js";
import { queryWorkflowMemoryProviderStep } from "./workflow-memory-steps.js";

const SHA = "a".repeat(64);
const DESCRIPTOR: MemoryProviderDescriptor = {
  schemaVersion: "memory-provider-descriptor.v1",
  providerId: "mbk_tencentmemorycore" as never,
  displayName: "Tencent MemoryCore",
  providerKind: "tencent_memorycore",
  transport: "http",
  adapterContractVersion: "tencent-memorycore-http.v2",
  configured: true,
  configurationFingerprint: SHA as never,
  capabilities: {
    query: { maxResults: 20, maxContextCharacters: 32_000 },
    write: {
      maxContentCharacters: 8_192,
      materialization: "asynchronous",
      idempotency: "chat_reconcile",
    },
    reconcile: true,
    management: { list: false, get: false, update: false, delete: false, history: false },
  },
  authMode: "bearer",
  credentialRevision: "memorycore-key-v1",
};

function dispatch(): WorkflowMemoryQueryDispatchDto {
  return {
    workflowMemoryQueryId: "wmq_workflowstep1" as never,
    operationId: "wmq_workflowstep1" as never,
    productRunId: "run_workflowstep1" as never,
    productSessionId: "psn_workflowstep1" as never,
    principalId: "usr_workflowstep1" as never,
    workflowRunSpecId: "wrs_workflowstep1" as never,
    definitionNodeId: "planning.memory-query",
    providerId: DESCRIPTOR.providerId,
    providerDescriptor: DESCRIPTOR,
    providerDescriptorSha256: computeMemoryProviderDescriptorSha256(DESCRIPTOR) as never,
    requirement: "optional",
    sourceMessageId: "msg_workflowstep1" as never,
    sourceMessageSha256: "b".repeat(64) as never,
    querySha256: "c".repeat(64) as never,
    queryText: "发布前需要做什么？",
    maxResults: 8,
    maxContextCharacters: 8_000,
  };
}

function install(provider: WorkflowMemoryQueryProviderPort): void {
  setWorkflowRuntimeContext({
    api: {} as never,
    bindings: {} as never,
    memoryBackends: { list: () => [], get: () => undefined },
    workflowMemoryProviders: {
      list: () => [DESCRIPTOR],
      getQuery: (providerId) => (providerId === DESCRIPTOR.providerId ? provider : undefined),
      getWrite: () => undefined,
    },
    trace: () => undefined,
    now: () => "2026-08-18T12:00:00.000Z",
    bailian: {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      endpointHost: "example.invalid",
    },
    planner: vi.fn() as never,
    noteCapture: vi.fn() as never,
    executor: vi.fn() as never,
  });
}

afterEach(() => {
  workflowMetadata.attempt = 1;
  setWorkflowRuntimeContext(undefined);
});

describe("Workflow Memory Steps", () => {
  it("严格复核冻结Provider描述，并把正文规范化为可持久化checkpoint", async () => {
    const queryMemory = vi.fn(async () => ({
      externalQueryId: "query-real-1",
      hitCount: 1,
      sections: [
        {
          externalObjectIds: ["memory-1"],
          title: "发布门",
          category: "procedure" as const,
          content: "发布前完成真实端到端测试。",
          labels: ["release"],
        },
      ],
    }));
    install({
      describeProvider: () => DESCRIPTOR,
      health: async () => ({ status: "ready" }),
      queryMemory,
    });

    const result = await queryWorkflowMemoryProviderStep({
      query: dispatch(),
      workflowAttemptId: "att_workflowstep1",
    });

    expect(result).toMatchObject({
      outcome: "success",
      sections: [{ category: "procedure", content: "发布前完成真实端到端测试。" }],
    });
    expect(queryMemory).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/L0|L1|team_id|service_id/u);
  });

  it("可重试读错误只在前两次抛出，最后一次返回失败供Application冻结证据", async () => {
    const queryMemory = vi.fn(async () => {
      throw new WorkflowMemoryProviderError({
        code: "memory.provider.unavailable",
        message: "temporarily unavailable",
        retryable: true,
      });
    });
    install({
      describeProvider: () => DESCRIPTOR,
      health: async () => ({ status: "ready" }),
      queryMemory,
    });
    const input = { query: dispatch(), workflowAttemptId: "att_workflowstep2" };

    await expect(queryWorkflowMemoryProviderStep(input)).rejects.toMatchObject({
      code: "memory.provider.unavailable",
    });
    workflowMetadata.attempt = 3;
    await expect(queryWorkflowMemoryProviderStep(input)).resolves.toEqual({
      outcome: "failure",
      errorCode: "memory.provider.unavailable",
    });
    expect(queryMemory).toHaveBeenCalledTimes(2);
  });

  it("外部写与只读对账都禁止Workflow SDK自动重试", () => {
    expect(
      (
        queryWorkflowMemoryProviderStep as typeof queryWorkflowMemoryProviderStep & {
          maxRetries: number;
        }
      ).maxRetries,
    ).toBe(2);
    expect(
      (
        callMemoryWriteProviderStep as typeof callMemoryWriteProviderStep & {
          maxRetries: number;
        }
      ).maxRetries,
    ).toBe(0);
    expect(
      (
        reconcileMemoryWriteProviderStep as typeof reconcileMemoryWriteProviderStep & {
          maxRetries: number;
        }
      ).maxRetries,
    ).toBe(0);
  });
});
