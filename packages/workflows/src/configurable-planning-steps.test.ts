import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunSpec } from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import { compileWorkflowRunSpec } from "@chat/application/workflow-run-spec-compiler";
import { kernelCompilerInputFixture } from "@chat/application/workflow-kernel-fixtures";
import {
  CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
  CONFIGURABLE_PLANNING_RUNNER_FAMILY,
  NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
  NOTE_CAPTURE_RUNNER_FAMILY,
} from "./definition-kernel-executor-registry.js";

const mocked = vi.hoisted(() => ({
  loadWorkflowRunSpec: vi.fn(),
  transitionConfigurablePlanningNode: vi.fn(),
}));

vi.mock("./runtime-context.js", () => ({
  getWorkflowRuntimeContext: () => ({ api: mocked }),
}));

import {
  loadConfigurablePlanningRunSpecStep,
  loadNoteCaptureRunSpecStep,
  recordConfigurablePlanningNodeStep,
} from "./configurable-planning-steps.js";

function compiledRunSpec(identity = "steploadvalid"): WorkflowRunSpec {
  const result = compileWorkflowRunSpec(
    kernelCompilerInputFixture("mixed", {
      workflowRunSpecId: `wrs_${identity}`,
      productRunId: `run_${identity}`,
      runner: {
        runnerFamily: CONFIGURABLE_PLANNING_RUNNER_FAMILY,
        runnerBundleVersion: CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
      },
    }),
  );
  if (!result.success) throw new Error(result.diagnostics[0]?.code);
  return result.runSpec;
}

function compiledNoteRunSpec(identity = "stepnotevalid"): WorkflowRunSpec {
  const result = compileWorkflowRunSpec(
    kernelCompilerInputFixture("human_review", {
      workflowRunSpecId: `wrs_${identity}` as never,
      productRunId: `run_${identity}` as never,
      runner: {
        runnerFamily: NOTE_CAPTURE_RUNNER_FAMILY,
        runnerBundleVersion: NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
      },
      businessInput: {
        kind: "note_capture",
        source: {
          kind: "full_message",
          sourceMessageId: "msg_noteinput1",
          sourceMessageSha256: "d".repeat(64),
        },
        defaultKind: "general",
        suggestedTags: [],
      },
    }),
  );
  if (!result.success) throw new Error(result.diagnostics[0]?.code);
  return result.runSpec;
}

function rehash(runSpec: WorkflowRunSpec): WorkflowRunSpec {
  const payload = { ...runSpec } as Record<string, unknown>;
  for (const key of ["schemaVersion", "workflowRunSpecId", "productRunId", "sha256", "createdAt"]) {
    delete payload[key];
  }
  return {
    ...runSpec,
    ...payload,
    sha256: hashCanonical("workflow-run-spec.v1", payload),
  } as WorkflowRunSpec;
}

describe("Configurable Planning RunSpec运行时门", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("读取正式RunSpec后复核identity/hash/bundle/manifest/limits/IR", async () => {
    const runSpec = compiledRunSpec();
    mocked.loadWorkflowRunSpec.mockResolvedValue({ runSpec });
    await expect(
      loadConfigurablePlanningRunSpecStep({
        productRunId: runSpec.productRunId,
        workflowRunSpecId: runSpec.workflowRunSpecId,
      }),
    ).resolves.toEqual(runSpec);
  });

  it("Note复用同一完整性门，并额外要求冻结note_capture业务输入", async () => {
    const runSpec = compiledNoteRunSpec();
    mocked.loadWorkflowRunSpec.mockResolvedValue({ runSpec });
    await expect(
      loadNoteCaptureRunSpecStep({
        productRunId: runSpec.productRunId,
        workflowRunSpecId: runSpec.workflowRunSpecId,
      }),
    ).resolves.toEqual(runSpec);

    const withoutInput = structuredClone(runSpec) as WorkflowRunSpec & {
      businessInput?: WorkflowRunSpec["businessInput"];
    };
    delete withoutInput.businessInput;
    const withoutBusinessInput = rehash(withoutInput);
    mocked.loadWorkflowRunSpec.mockResolvedValue({ runSpec: withoutBusinessInput });
    await expect(
      loadNoteCaptureRunSpecStep({
        productRunId: runSpec.productRunId,
        workflowRunSpecId: runSpec.workflowRunSpecId,
      }),
    ).rejects.toThrow("run_spec.business_input_incompatible");
  });

  it("hash、bundle与executor manifest篡改都在业务节点前失败关闭", async () => {
    const valid = compiledRunSpec("steploadtamper");
    const tampered: readonly WorkflowRunSpec[] = [
      { ...valid, sha256: "0".repeat(64) },
      rehash({
        ...valid,
        runner: { ...valid.runner, runnerBundleVersion: "configurable-planning.bundle.future" },
      }),
      rehash({
        ...valid,
        executorManifest: valid.executorManifest.map((entry) =>
          entry.nodeType === "agent.plan" ? { ...entry, executorVersion: "future.v99" } : entry,
        ),
      }),
      rehash({
        ...valid,
        nodeResolutions: valid.nodeResolutions.map((entry, index) =>
          index === 0 ? { ...entry, config: { ...entry.config, tampered: true } } : entry,
        ),
      }),
    ];
    for (const runSpec of tampered) {
      mocked.loadWorkflowRunSpec.mockResolvedValueOnce({ runSpec });
      await expect(
        loadConfigurablePlanningRunSpecStep({
          productRunId: runSpec.productRunId,
          workflowRunSpecId: runSpec.workflowRunSpecId,
        }),
      ).rejects.toThrow();
    }
  });

  it("相同节点转换派生同一commandId，重放交给Application Receipt收敛", async () => {
    mocked.transitionConfigurablePlanningNode.mockResolvedValue({
      workflowNodeRunId: "wnr_stable1",
      revision: 2,
    });
    const input = {
      productRunId: "run_stable1",
      workflowRunSpecId: "wrs_stable1",
      definitionNodeId: "planning.plan",
      executionPath: [{ containerNodeId: "planning.review.loop", iteration: 2 }],
      attemptNumber: 1,
      toStatus: "succeeded" as const,
      outcomeCode: "planned",
      publicSummary: "节点已完成",
    };
    await recordConfigurablePlanningNodeStep(input);
    await recordConfigurablePlanningNodeStep(input);
    expect(mocked.transitionConfigurablePlanningNode).toHaveBeenCalledTimes(2);
    const first = mocked.transitionConfigurablePlanningNode.mock.calls[0]?.[0];
    const second = mocked.transitionConfigurablePlanningNode.mock.calls[1]?.[0];
    expect(first.commandId).toBe(second.commandId);
    expect(first.commandId).toMatch(/^cmd_[a-f0-9]{32}$/);
  });

  it("人工等待与完成使用不同commandId，同一等待状态重放保持稳定", async () => {
    mocked.transitionConfigurablePlanningNode.mockResolvedValue({
      workflowNodeRunId: "wnr_review1",
      revision: 2,
    });
    const base = {
      productRunId: "run_review1",
      workflowRunSpecId: "wrs_review1",
      definitionNodeId: "planning.review",
      executionPath: [{ containerNodeId: "planning.review.loop", iteration: 1 }],
      attemptNumber: 1,
      publicSummary: "等待你的计划决定",
    } as const;
    await recordConfigurablePlanningNodeStep({ ...base, toStatus: "waiting_human" });
    await recordConfigurablePlanningNodeStep({ ...base, toStatus: "waiting_human" });
    await recordConfigurablePlanningNodeStep({
      ...base,
      toStatus: "succeeded",
      outcomeCode: "approved",
      publicSummary: "计划已批准",
    });
    const [waitingFirst, waitingReplay, succeeded] =
      mocked.transitionConfigurablePlanningNode.mock.calls.map(([call]) => call);
    expect(waitingFirst.commandId).toBe(waitingReplay.commandId);
    expect(succeeded.commandId).not.toBe(waitingFirst.commandId);
  });

  it("节点投影Step关闭SDK自动重试", () => {
    expect(
      (
        recordConfigurablePlanningNodeStep as typeof recordConfigurablePlanningNodeStep & {
          maxRetries: number;
        }
      ).maxRetries,
    ).toBe(0);
  });
});
