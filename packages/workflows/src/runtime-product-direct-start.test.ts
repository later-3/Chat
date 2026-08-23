import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const mocked = vi.hoisted(() => ({
  start: vi.fn(),
  getHookByToken: vi.fn(),
  getRun: vi.fn(),
  resumeHook: vi.fn(),
  captureRunVersionEvidence: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  start: mocked.start,
  getHookByToken: mocked.getHookByToken,
  getRun: mocked.getRun,
  resumeHook: mocked.resumeHook,
}));
vi.mock("./runtime-version-evidence.js", () => ({
  captureRunVersionEvidence: mocked.captureRunVersionEvidence,
}));

import { registerProductWorkflowHttpRoutes } from "./runtime-product-http-routes.js";

describe("Product Workflow Direct Agent start分发", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.captureRunVersionEvidence.mockResolvedValue(undefined);
    mocked.start.mockResolvedValue({ runId: "wrun_private_direct1" });
    mocked.getHookByToken.mockResolvedValue({});
    mocked.resumeHook.mockResolvedValue(undefined);
  });

  it("按冻结runner family启动Direct bundle，输入不含消息或Prompt正文", async () => {
    const app = new Hono();
    const bindings = {
      claimStartIntent: vi.fn().mockResolvedValue("claimed"),
      claimWorkflowBinding: vi.fn().mockResolvedValue({ alreadyExisted: false }),
      markStartOutcomeUnknown: vi.fn(),
    };
    registerProductWorkflowHttpRoutes({
      app,
      workflowDataDir: "/tmp/workflow-direct-start-test",
      credential: "rtk_direct_start",
      bindings,
      world: {
        directAgentWorkflowId: "workflow//direct-agent",
        memoryDirectAgentWorkflowId: "workflow//memory-direct-agent",
        configurablePlanningWorkflowId: "workflow//planning",
        noteCaptureWorkflowId: "workflow//note",
        workflowId: "workflow//legacy",
      },
      buildEvidence: {},
      trace: vi.fn(),
    } as never);

    const response = await app.request("http://runtime/internal/workflow/v1/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "chat-workflow-dispatch.v1",
        productRunId: "run_directstart1",
        attemptId: "att_directstart1",
        workflowRunSpecId: "wrs_directstart1",
        runnerFamily: "direct-agent.v1",
        runnerBundleVersion: "direct-agent.bundle.v1",
        workflowDefinitionVersion: "direct-agent.bundle.v1",
        outboxId: "obx_directstart1",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: "chat-workflow-dispatch.v1",
      status: "started",
    });
    expect(mocked.start).toHaveBeenCalledWith({ workflowId: "workflow//direct-agent" }, [
      {
        schemaVersion: "direct-agent-workflow-input.v1",
        productRunId: "run_directstart1",
        workflowAttemptId: "att_directstart1",
        workflowRunSpecId: "wrs_directstart1",
      },
    ]);
    const serializedInput = JSON.stringify(mocked.start.mock.calls[0]);
    expect(serializedInput).not.toContain("canonicalPayloadJson");
    expect(serializedInput).not.toContain("sourceMessage");
    expect(bindings.claimWorkflowBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        productRunId: "run_directstart1",
        workflowRunId: "wrun_private_direct1",
        runnerFamily: "direct-agent.v1",
        workflowRunSpecId: "wrs_directstart1",
      }),
    );
  });

  it("Memory Direct family只启动新增Workflow ID，checkpoint输入仍只有产品引用", async () => {
    const app = new Hono();
    const bindings = {
      claimStartIntent: vi.fn().mockResolvedValue("claimed"),
      claimWorkflowBinding: vi.fn().mockResolvedValue({ alreadyExisted: false }),
      markStartOutcomeUnknown: vi.fn(),
    };
    registerProductWorkflowHttpRoutes({
      app,
      workflowDataDir: "/tmp/workflow-memory-direct-start-test",
      credential: "rtk_memory_direct_start",
      bindings,
      world: {
        directAgentWorkflowId: "workflow//direct-agent",
        memoryDirectAgentWorkflowId: "workflow//memory-direct-agent",
        configurablePlanningWorkflowId: "workflow//planning",
        noteCaptureWorkflowId: "workflow//note",
        workflowId: "workflow//legacy",
      },
      buildEvidence: {},
      trace: vi.fn(),
    } as never);

    const response = await app.request("http://runtime/internal/workflow/v1/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "chat-workflow-dispatch.v1",
        productRunId: "run_memorydirectstart1",
        attemptId: "att_memorydirectstart1",
        workflowRunSpecId: "wrs_memorydirectstart1",
        runnerFamily: "memory-direct.v1",
        runnerBundleVersion: "memory-direct.bundle.v1",
        workflowDefinitionVersion: "memory-direct.bundle.v1",
        outboxId: "obx_memorydirectstart1",
      }),
    });

    expect(response.status).toBe(201);
    expect(mocked.start).toHaveBeenCalledWith({ workflowId: "workflow//memory-direct-agent" }, [
      {
        schemaVersion: "direct-agent-workflow-input.v1",
        productRunId: "run_memorydirectstart1",
        workflowAttemptId: "att_memorydirectstart1",
        workflowRunSpecId: "wrs_memorydirectstart1",
      },
    ]);
    const serializedInput = JSON.stringify(mocked.start.mock.calls[0]);
    expect(serializedInput).not.toContain("memoryContext");
    expect(serializedInput).not.toContain("sourceMessage");
    expect(bindings.claimWorkflowBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        productRunId: "run_memorydirectstart1",
        runnerFamily: "memory-direct.v1",
        workflowRunSpecId: "wrs_memorydirectstart1",
      }),
    );
  });

  it("Prompt Review Resume先认领派发栅栏，再用精确Decision引用恢复Hook且不唤醒Planning sleep", async () => {
    const app = new Hono();
    const bindings = {
      getPromptReviewHookBinding: vi.fn(() => ({
        hookToken: "prh-prr_directresume1",
        productRunId: "run_directresume1",
        startWorkflowRunId: "wrun_private_directresume1",
        requestRevision: 1,
        reviewSha256: "a".repeat(64),
        hookClaimState: "claimed",
        resumeDispatchState: "none",
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
      })),
      getWorkflowBinding: vi.fn(() => ({
        workflowRunId: "wrun_private_directresume1",
        runnerFamily: "direct-agent.v1",
      })),
      claimPromptReviewResumeDispatch: vi.fn().mockResolvedValue("claimed"),
      markPromptReviewResumeDispatched: vi.fn().mockResolvedValue(undefined),
      markPromptReviewResumeOutcomeUnknown: vi.fn(),
    };
    registerProductWorkflowHttpRoutes({
      app,
      workflowDataDir: "/tmp/workflow-direct-resume-test",
      credential: "rtk_direct_resume",
      bindings,
      world: {},
      buildEvidence: {},
      trace: vi.fn(),
    } as never);

    const request = {
      schemaVersion: "chat-workflow-dispatch.v1",
      productRunId: "run_directresume1",
      attemptId: "att_directresume1",
      outboxId: "obx_directresume1",
      promptReviewRequestId: "prr_directresume1",
      promptReviewDecisionId: "prd_directresume1",
      requestRevision: 1,
      reviewSha256: "a".repeat(64),
      payloadSha256: "b".repeat(64),
    };
    const response = await app.request("http://runtime/internal/workflow/v1/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: "chat-workflow-dispatch.v1",
      status: "resumed",
    });
    expect(bindings.claimPromptReviewResumeDispatch).toHaveBeenCalledWith({
      promptReviewRequestId: "prr_directresume1",
      promptReviewDecisionId: "prd_directresume1",
      requestRevision: 1,
      reviewSha256: "a".repeat(64),
      now: expect.any(String),
    });
    expect(mocked.resumeHook).toHaveBeenCalledWith("prh-prr_directresume1", {
      schemaVersion: "prompt-review-decision-hook-payload.v1",
      productRunId: "run_directresume1",
      promptReviewRequestId: "prr_directresume1",
      promptReviewDecisionId: "prd_directresume1",
      requestRevision: 1,
      reviewSha256: "a".repeat(64),
      payloadSha256: "b".repeat(64),
    });
    expect(bindings.markPromptReviewResumeDispatched).toHaveBeenCalledWith({
      promptReviewRequestId: "prr_directresume1",
      promptReviewDecisionId: "prd_directresume1",
      now: expect.any(String),
    });
    expect(mocked.getRun).not.toHaveBeenCalled();
    const serialized = JSON.stringify(mocked.resumeHook.mock.calls);
    expect(serialized).not.toContain("canonicalPayloadJson");
    expect(serialized).not.toContain("hookToken");
    expect(serialized).not.toContain("operationId");
  });

  it("Prompt Review Resume claim为outcome_unknown时绝不二次调用resumeHook", async () => {
    const app = new Hono();
    const bindings = {
      getPromptReviewHookBinding: vi.fn(() => ({
        hookToken: "prh-prr_directresume2",
        productRunId: "run_directresume2",
        requestRevision: 1,
        reviewSha256: "c".repeat(64),
        resumeDispatchState: "none",
      })),
      getWorkflowBinding: vi.fn(() => ({
        workflowRunId: "wrun_private_directresume2",
        runnerFamily: "direct-agent.v1",
      })),
      claimPromptReviewResumeDispatch: vi.fn().mockResolvedValue("outcome_unknown"),
    };
    registerProductWorkflowHttpRoutes({
      app,
      workflowDataDir: "/tmp/workflow-direct-resume-unknown-test",
      credential: "rtk_direct_resume",
      bindings,
      world: {},
      buildEvidence: {},
      trace: vi.fn(),
    } as never);

    const response = await app.request("http://runtime/internal/workflow/v1/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "chat-workflow-dispatch.v1",
        productRunId: "run_directresume2",
        attemptId: "att_directresume2",
        outboxId: "obx_directresume2",
        promptReviewRequestId: "prr_directresume2",
        promptReviewDecisionId: "prd_directresume2",
        requestRevision: 1,
        reviewSha256: "c".repeat(64),
        payloadSha256: "d".repeat(64),
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: "chat-workflow-dispatch.v1",
      status: "outcome_unknown",
    });
    expect(bindings.claimPromptReviewResumeDispatch).toHaveBeenCalledTimes(1);
    expect(mocked.resumeHook).not.toHaveBeenCalled();
    expect(mocked.getRun).not.toHaveBeenCalled();
  });

  it("Prompt Review对账只公开start与resume状态，不泄露Hook或Workflow身份", async () => {
    const app = new Hono();
    const bindings = {
      getStartState: vi.fn(() => "exists"),
      getPromptReviewHookBinding: vi.fn(() => ({
        hookToken: "prh-secret-runtime-token",
        startWorkflowRunId: "wrun_secret_runtime_id",
        productRunId: "run_directreconcile1",
        resumeDispatchState: "dispatched",
      })),
    };
    registerProductWorkflowHttpRoutes({
      app,
      workflowDataDir: "/tmp/workflow-direct-reconcile-test",
      credential: "rtk_direct_reconcile",
      bindings,
      world: {},
      buildEvidence: {},
      trace: vi.fn(),
    } as never);

    const response = await app.request(
      "http://runtime/internal/workflow/v1/reconcile?productRunId=run_directreconcile1&promptReviewRequestId=prr_directreconcile1",
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      schemaVersion: "chat-workflow-dispatch.v1",
      productRunId: "run_directreconcile1",
      startBinding: "exists",
      hookResumeState: "dispatched",
    });
    expect(JSON.stringify(body)).not.toContain("prh-secret-runtime-token");
    expect(JSON.stringify(body)).not.toContain("wrun_secret_runtime_id");
  });
});
