import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("workflow", async (importOriginal) => {
  const original = await importOriginal<typeof import("workflow")>();
  return { ...original, getStepMetadata: () => ({ attempt: 1 }) };
});

import { freezeMemoryBackendDescriptor, type MemoryBackendPort } from "@chat/application";
import type { MemoryQueryDispatchDto, PlanningInputDto } from "@chat/contracts";
import { computeMemoryBackendDescriptorSha256 } from "@chat/domain";
import { setWorkflowRuntimeContext } from "./runtime-context.js";
import {
  preparePlanningProjectContextStep,
  preparePlanningRulesContextStep,
  generateAndPublishPlanStep,
  preparePlanningLegacyMemoryContextStep,
  preparePlanningMemoryContextStep,
  queryMemoryContextStep,
} from "./workflow-planning-steps.js";

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

function installContext(
  memory: MemoryBackendPort,
  events: unknown[],
  api: Record<string, ReturnType<typeof vi.fn>> = {},
  planner: ReturnType<typeof vi.fn> = vi.fn(),
) {
  setWorkflowRuntimeContext({
    api: api as never,
    bindings: {} as never,
    memoryBackends: { list: () => [memory], get: () => memory },
    trace: (event) => events.push(event),
    now: () => "2026-08-08T00:00:00.000Z",
    bailian: {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      endpointHost: "example.invalid",
    },
    planner: planner as never,
    noteCapture: vi.fn() as never,
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

  it("Configurable兼容链把查询与持久化封入单Step，只返回ContextPackage ref", async () => {
    const query = vi.fn(async () => ({
      externalQueryId: "external-query-slim-1",
      hitCount: 1,
      sections: [
        {
          externalObjectIds: ["memory-private-1"],
          title: "private title",
          kind: "world_model" as const,
          memoryLayer: "L2" as const,
          content: "private memory body",
          tags: ["private-tag"],
        },
      ],
    }));
    const memory = backend(query);
    const frozen = dispatch(memory);
    const persist = vi.fn(async () => ({
      schemaVersion: "chat-internal-runtime.v1",
      status: "ready" as const,
      contextPackageRef: {
        contextPackageId: "ctxp_workflow1",
        revision: 1 as const,
        sha256: SHA,
      },
    }));
    installContext(memory, [], {
      beginPlanningContext: vi.fn(async () => ({
        schemaVersion: "chat-internal-runtime.v1",
        status: "dispatch_required" as const,
        query: frozen,
      })),
      persistPlanningContextResult: persist,
    });

    const result = await preparePlanningLegacyMemoryContextStep({
      productRunId: "run_workflow1",
      attemptId: "att_workflow1",
    });

    expect(result).toEqual({
      status: "ready",
      contextPackageRef: { contextPackageId: "ctxp_workflow1", revision: 1, sha256: SHA },
    });
    expect(JSON.stringify(result)).not.toContain("private memory body");
    expect(query).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          sections: [expect.objectContaining({ content: "private memory body" })],
        }),
      }),
    );
    expect(
      (
        preparePlanningLegacyMemoryContextStep as typeof preparePlanningLegacyMemoryContextStep & {
          maxRetries: number;
        }
      ).maxRetries,
    ).toBe(0);
  });
});

describe("Planning Memory/Project/Rules Context Steps", () => {
  it("只把不可变ref写入checkpoint，并以稳定commandId复用Application事实", async () => {
    const selectedMemory = vi.fn(async () => ({
      schemaVersion: "chat-internal-runtime.v1",
      status: "ready" as const,
      productRunId: "run_workflow1",
      workflowRunSpecId: "wrs_workflow1",
      selectionRef: {
        planningMemorySelectionId: "pmsl_workflow1",
        revision: 1 as const,
        sha256: SHA,
      },
      snapshots: [
        {
          memoryResultSnapshotId: "mrs_private1",
          revision: 1,
          sha256: SHA,
          title: "private memory title",
          kind: "world_model" as const,
          memoryLayer: "L2" as const,
          content: "private memory body",
          tags: ["private"],
          tokenEstimate: 4,
        },
      ],
      totalContentCharacters: 19,
    }));
    const project = vi.fn(async (_input: { readonly commandId: string }) => ({
      schemaVersion: "chat-internal-runtime.v1",
      status: "ready" as const,
      productRunId: "run_workflow1",
      workflowRunSpecId: "wrs_workflow1",
      contextRef: {
        planningProjectContextId: "pcx_workflow1",
        revision: 1 as const,
        sha256: SHA,
      },
    }));
    const rules = vi.fn(async (_input: { readonly commandId: string }) => ({
      schemaVersion: "chat-internal-runtime.v1",
      status: "ready" as const,
      productRunId: "run_workflow1",
      workflowRunSpecId: "wrs_workflow1",
      selectionRef: { ruleSelectionId: "rsl_workflow1", revision: 1 as const, sha256: SHA },
      rules: [
        {
          ruleId: "rul_private1",
          ruleRevisionId: "rrv_private1",
          ruleRevisionSha256: SHA,
          body: "private rule body",
        },
      ],
      totalContentCharacters: 17,
    }));
    const memory = backend(async () => ({ externalQueryId: "unused", hitCount: 0, sections: [] }));
    installContext(memory, [], {
      preparePlanningMemoryContext: selectedMemory,
      preparePlanningProjectContext: project,
      preparePlanningRulesContext: rules,
    });
    const identity = {
      productRunId: "run_workflow1",
      attemptId: "att_workflow1",
      workflowRunSpecId: "wrs_workflow1",
      executionPath: [{ containerNodeId: "planning.resource.loop", iteration: 2 }],
      attemptNumber: 3,
    };

    const memoryResult = await preparePlanningMemoryContextStep({
      ...identity,
      definitionNodeId: "planning.memory",
    });
    const projectResult = await preparePlanningProjectContextStep({
      ...identity,
      definitionNodeId: "planning.project",
    });
    const firstRulesResult = await preparePlanningRulesContextStep({
      ...identity,
      definitionNodeId: "planning.rules",
    });
    const replayedRulesResult = await preparePlanningRulesContextStep({
      ...identity,
      definitionNodeId: "planning.rules",
    });

    expect(memoryResult).toEqual({
      status: "ready",
      selectionRef: { planningMemorySelectionId: "pmsl_workflow1", revision: 1, sha256: SHA },
    });
    expect(JSON.stringify(memoryResult)).not.toContain("private memory body");
    expect(projectResult).toEqual({
      status: "ready",
      contextRef: {
        planningProjectContextId: "pcx_workflow1",
        revision: 1,
        sha256: SHA,
      },
    });
    expect(firstRulesResult).toEqual({
      status: "ready",
      selectionRef: { ruleSelectionId: "rsl_workflow1", revision: 1, sha256: SHA },
    });
    expect(replayedRulesResult).toEqual(firstRulesResult);
    expect(JSON.stringify(firstRulesResult)).not.toContain("private rule");
    expect(rules.mock.calls[0]?.[0].commandId).toBe(rules.mock.calls[1]?.[0].commandId);
    for (const prepare of [selectedMemory, project, rules]) {
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          executionPath: [{ containerNodeId: "planning.resource.loop", iteration: 2 }],
          attemptNumber: 3,
        }),
      );
    }
  });
});

describe("Configurable Planning合并生成Step", () => {
  it("maxSteps在发布前硬限制候选，允许值只checkpoint审核ref", async () => {
    const planningInput: PlanningInputDto = {
      schemaVersion: "chat-internal-runtime.v1",
      productRunId: "run_workflow1" as never,
      attemptId: "att_planning1" as never,
      inputRunRevision: 2,
      inputManifestSha256: SHA,
      sourceMessageRef: { messageId: "msg_workflow1" as never, sha256: SHA },
      sourceMessageText: "不得进入Workflow checkpoint的正文",
      planRevision: 1,
      limits: { maxTurns: 1, timeoutMs: 10_000, tokenBudget: 1_024 },
      promptTemplateVersion: "planner-prompt.v2",
      modelConfigVersion: "bailian.qwen3.7-plus.v1",
    };
    const content = {
      objective: "形成两步计划",
      summary: "先整理再输出",
      assumptions: [],
      openQuestions: [],
      steps: [
        {
          stepId: "step-1",
          title: "整理",
          purpose: "整理输入",
          dependsOn: [],
          inputRefs: [],
          expectedOutput: "要点",
          successCriteria: ["完整"],
          requestedCapabilities: [],
          risk: "low" as const,
        },
        {
          stepId: "step-2",
          title: "输出",
          purpose: "输出结果",
          dependsOn: ["step-1"],
          inputRefs: [],
          expectedOutput: "Markdown",
          successCriteria: ["可读"],
          requestedCapabilities: ["markdown_text_compose"],
          risk: "low" as const,
        },
      ],
      completionCriteria: ["交付完成"],
      warnings: [],
    };
    const planner = vi.fn(async () => ({
      kind: "candidate" as const,
      candidate: content,
      durationMs: 8,
      providerCallCount: 1,
      providerMeta: {
        httpStatus: 200,
        providerRequestId: "provider-plan-1",
        providerStopReason: "toolUse" as const,
        toolCallCount: 1,
      },
      usage: { inputTokens: 20, outputTokens: 10 },
    }));
    const publish = vi.fn(async () => ({
      planId: "pln_workflow1",
      planRevision: 1,
      planSha256: SHA,
      approvalRequestId: "apr_workflow1",
      approvalExpiresAt: "2026-08-11T00:00:00.000Z",
    }));
    const memory = backend(async () => ({ externalQueryId: "unused", hitCount: 0, sections: [] }));
    const compile = vi.fn(async () => planningInput);
    installContext(
      memory,
      [],
      {
        compilePlanningInput: compile,
        publishPlanReview: publish,
      },
      planner,
    );
    const identity = {
      productRunId: "run_workflow1",
      attemptId: "att_workflow1",
      planRevision: 1,
      planningMemorySelectionRef: {
        planningMemorySelectionId: "pmsl_workflow1",
        revision: 1 as const,
        sha256: SHA,
      },
    };

    const allowed = await generateAndPublishPlanStep({ ...identity, maxSteps: 2 });
    const blocked = await generateAndPublishPlanStep({ ...identity, maxSteps: 1 });

    expect(allowed).toEqual({
      status: "published",
      review: {
        planId: "pln_workflow1",
        planRevision: 1,
        planSha256: SHA,
        approvalRequestId: "apr_workflow1",
        approvalExpiresAt: "2026-08-11T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(allowed)).not.toContain("不得进入Workflow checkpoint的正文");
    expect(blocked).toEqual({
      status: "failed",
      errorCode: "model.candidate.capability_violation",
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith(
      expect.objectContaining({
        planningMemorySelectionRef: identity.planningMemorySelectionRef,
      }),
    );
    expect(planner).toHaveBeenCalledTimes(2);
    expect(
      (generateAndPublishPlanStep as typeof generateAndPublishPlanStep & { maxRetries: number })
        .maxRetries,
    ).toBe(0);
  });
});
