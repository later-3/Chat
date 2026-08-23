import { describe, expect, it } from "vitest";
import {
  CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
  CONFIGURABLE_PLANNING_RUNNER_FAMILY,
  DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
  DIRECT_AGENT_RUNNER_FAMILY,
  LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
  LEGACY_PLANNING_RUNNER_FAMILY,
  NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
  NOTE_CAPTURE_RUNNER_FAMILY,
  MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_DIRECT_RUNNER_FAMILY,
  MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
} from "./definition-kernel-executor-registry.js";
import {
  PlanningRunnerDispatchError,
  resolvePlanningRunnerDispatch,
  resolveProductWorkflowRunnerDispatch,
} from "./planning-runner-dispatch.js";

describe("Planning Runner静态分派", () => {
  it("legacy必须携带完整冻结身份且不得带RunSpec", () => {
    expect(
      resolvePlanningRunnerDispatch({
        runnerFamily: LEGACY_PLANNING_RUNNER_FAMILY,
        runnerBundleVersion: LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
      }),
    ).toEqual({
      runnerFamily: LEGACY_PLANNING_RUNNER_FAMILY,
      runnerBundleVersion: LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
    });
  });

  it("configurable family必须同时冻结bundle与RunSpec", () => {
    expect(
      resolvePlanningRunnerDispatch({
        runnerFamily: CONFIGURABLE_PLANNING_RUNNER_FAMILY,
        runnerBundleVersion: CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
        workflowRunSpecId: "wrs_configurable1",
      }),
    ).toEqual({
      runnerFamily: CONFIGURABLE_PLANNING_RUNNER_FAMILY,
      runnerBundleVersion: CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: "wrs_configurable1",
    });
  });

  it("正式通用入口接受冻结Note family，但Planning专用入口拒绝串用", () => {
    const request = {
      runnerFamily: NOTE_CAPTURE_RUNNER_FAMILY,
      runnerBundleVersion: NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: "wrs_notecapture1",
    } as const;
    expect(resolveProductWorkflowRunnerDispatch(request)).toEqual(request);
    expect(() => resolvePlanningRunnerDispatch(request)).toThrow(PlanningRunnerDispatchError);
    expect(() =>
      resolveProductWorkflowRunnerDispatch({
        ...request,
        runnerBundleVersion: "note-capture.bundle.future",
      }),
    ).toThrow(PlanningRunnerDispatchError);
  });

  it("Direct、Memory Direct与Memory Agent Direct使用独立family/bundle并都要求RunSpec", () => {
    const direct = {
      runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
      runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: "wrs_directdispatch1",
    } as const;
    const memoryDirect = {
      runnerFamily: MEMORY_DIRECT_RUNNER_FAMILY,
      runnerBundleVersion: MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: "wrs_memorydirectdispatch1",
    } as const;
    const memoryAgentDirect = {
      runnerFamily: MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
      runnerBundleVersion: MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: "wrs_memoryagentdirectdispatch1",
    } as const;
    expect(resolveProductWorkflowRunnerDispatch(direct)).toEqual(direct);
    expect(resolveProductWorkflowRunnerDispatch(memoryDirect)).toEqual(memoryDirect);
    expect(resolveProductWorkflowRunnerDispatch(memoryAgentDirect)).toEqual(memoryAgentDirect);
    expect(() =>
      resolveProductWorkflowRunnerDispatch({
        ...memoryDirect,
        runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
      }),
    ).toThrow(PlanningRunnerDispatchError);
    expect(() =>
      resolveProductWorkflowRunnerDispatch({
        ...memoryAgentDirect,
        runnerBundleVersion: MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
      }),
    ).toThrow(PlanningRunnerDispatchError);
    expect(() =>
      resolveProductWorkflowRunnerDispatch({
        runnerFamily: MEMORY_DIRECT_RUNNER_FAMILY,
        runnerBundleVersion: MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
      }),
    ).toThrow(PlanningRunnerDispatchError);
  });

  it.each([
    {},
    { runnerFamily: LEGACY_PLANNING_RUNNER_FAMILY },
    {
      runnerFamily: LEGACY_PLANNING_RUNNER_FAMILY,
      runnerBundleVersion: LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: "wrs_tampered1",
    },
    {
      runnerFamily: CONFIGURABLE_PLANNING_RUNNER_FAMILY,
      runnerBundleVersion: "configurable-planning.bundle.future",
      workflowRunSpecId: "wrs_tampered2",
    },
    {
      runnerFamily: CONFIGURABLE_PLANNING_RUNNER_FAMILY,
      runnerBundleVersion: CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
    },
    {
      runnerFamily: "definition-kernel-lab.v1",
      runnerBundleVersion: "definition-kernel-lab.bundle.v1",
      workflowRunSpecId: "wrs_labnotproduction1",
    },
  ])("字段不完整、篡改或实验室family均失败关闭: %#", (request) => {
    expect(() => resolvePlanningRunnerDispatch(request)).toThrow(PlanningRunnerDispatchError);
  });
});
