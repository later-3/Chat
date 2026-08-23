import {
  CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
  CONFIGURABLE_PLANNING_RUNNER_FAMILY,
  LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
  LEGACY_PLANNING_RUNNER_FAMILY,
  NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
  NOTE_CAPTURE_RUNNER_FAMILY,
  DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
  DIRECT_AGENT_RUNNER_FAMILY,
  MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_DIRECT_RUNNER_FAMILY,
  type PlanningRunnerFamily,
  type ProductWorkflowRunnerFamily,
} from "./definition-kernel-executor-registry.js";

export interface PlanningRunnerDispatchRequest {
  readonly runnerFamily?: string | undefined;
  readonly runnerBundleVersion?: string | undefined;
  readonly workflowRunSpecId?: string | undefined;
}

export type PlanningRunnerDispatch =
  | {
      readonly runnerFamily: typeof LEGACY_PLANNING_RUNNER_FAMILY;
      readonly runnerBundleVersion: typeof LEGACY_PLANNING_RUNNER_BUNDLE_VERSION;
    }
  | {
      readonly runnerFamily: typeof CONFIGURABLE_PLANNING_RUNNER_FAMILY;
      readonly runnerBundleVersion: typeof CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION;
      readonly workflowRunSpecId: string;
    };

export type ProductWorkflowRunnerDispatch =
  | PlanningRunnerDispatch
  | {
      readonly runnerFamily: typeof NOTE_CAPTURE_RUNNER_FAMILY;
      readonly runnerBundleVersion: typeof NOTE_CAPTURE_RUNNER_BUNDLE_VERSION;
      readonly workflowRunSpecId: string;
    }
  | {
      readonly runnerFamily: typeof DIRECT_AGENT_RUNNER_FAMILY;
      readonly runnerBundleVersion: typeof DIRECT_AGENT_RUNNER_BUNDLE_VERSION;
      readonly workflowRunSpecId: string;
    }
  | {
      readonly runnerFamily: typeof MEMORY_DIRECT_RUNNER_FAMILY;
      readonly runnerBundleVersion: typeof MEMORY_DIRECT_RUNNER_BUNDLE_VERSION;
      readonly workflowRunSpecId: string;
    };

export class PlanningRunnerDispatchError extends Error {
  readonly code = "workflow.runner_dispatch_invalid";
  constructor() {
    super("Planning Runner绑定不完整或版本不受支持");
    this.name = "PlanningRunnerDispatchError";
  }
}

/**
 * 正式入口不从缺失字段猜legacy；新旧Runner都必须携带完整冻结身份并逐字段匹配。
 * 旧Store/Outbox迁移在Product读侧补齐legacy证据，该决定随后在SDK start前写入Binding。
 */
export function resolvePlanningRunnerDispatch(
  input: PlanningRunnerDispatchRequest,
): PlanningRunnerDispatch {
  const dispatch = resolveProductWorkflowRunnerDispatch(input);
  if (
    dispatch.runnerFamily === NOTE_CAPTURE_RUNNER_FAMILY ||
    dispatch.runnerFamily === DIRECT_AGENT_RUNNER_FAMILY ||
    dispatch.runnerFamily === MEMORY_DIRECT_RUNNER_FAMILY
  ) {
    throw new PlanningRunnerDispatchError();
  }
  return dispatch;
}

/** 正式Product Workflow入口按已冻结family/bundle/RunSpec静态分派，不读取当前默认开关。 */
export function resolveProductWorkflowRunnerDispatch(
  input: PlanningRunnerDispatchRequest,
): ProductWorkflowRunnerDispatch {
  if (input.runnerFamily === LEGACY_PLANNING_RUNNER_FAMILY) {
    if (
      input.runnerBundleVersion !== LEGACY_PLANNING_RUNNER_BUNDLE_VERSION ||
      input.workflowRunSpecId !== undefined
    ) {
      throw new PlanningRunnerDispatchError();
    }
    return legacyDispatch();
  }
  if (input.runnerFamily === CONFIGURABLE_PLANNING_RUNNER_FAMILY) {
    if (
      input.runnerBundleVersion !== CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION ||
      input.workflowRunSpecId === undefined ||
      !/^wrs_[A-Za-z0-9]+$/.test(input.workflowRunSpecId)
    ) {
      throw new PlanningRunnerDispatchError();
    }
    return {
      runnerFamily: CONFIGURABLE_PLANNING_RUNNER_FAMILY,
      runnerBundleVersion: CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: input.workflowRunSpecId,
    };
  }
  if (input.runnerFamily === NOTE_CAPTURE_RUNNER_FAMILY) {
    if (
      input.runnerBundleVersion !== NOTE_CAPTURE_RUNNER_BUNDLE_VERSION ||
      input.workflowRunSpecId === undefined ||
      !/^wrs_[A-Za-z0-9]+$/.test(input.workflowRunSpecId)
    ) {
      throw new PlanningRunnerDispatchError();
    }
    return {
      runnerFamily: NOTE_CAPTURE_RUNNER_FAMILY,
      runnerBundleVersion: NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: input.workflowRunSpecId,
    };
  }
  if (input.runnerFamily === DIRECT_AGENT_RUNNER_FAMILY) {
    if (
      input.runnerBundleVersion !== DIRECT_AGENT_RUNNER_BUNDLE_VERSION ||
      input.workflowRunSpecId === undefined ||
      !/^wrs_[A-Za-z0-9]+$/.test(input.workflowRunSpecId)
    ) {
      throw new PlanningRunnerDispatchError();
    }
    return {
      runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
      runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: input.workflowRunSpecId,
    };
  }
  if (input.runnerFamily === MEMORY_DIRECT_RUNNER_FAMILY) {
    if (
      input.runnerBundleVersion !== MEMORY_DIRECT_RUNNER_BUNDLE_VERSION ||
      input.workflowRunSpecId === undefined ||
      !/^wrs_[A-Za-z0-9]+$/.test(input.workflowRunSpecId)
    ) {
      throw new PlanningRunnerDispatchError();
    }
    return {
      runnerFamily: MEMORY_DIRECT_RUNNER_FAMILY,
      runnerBundleVersion: MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
      workflowRunSpecId: input.workflowRunSpecId,
    };
  }
  throw new PlanningRunnerDispatchError();
}

export function isSupportedPlanningRunnerFamily(value: string): value is PlanningRunnerFamily {
  return value === LEGACY_PLANNING_RUNNER_FAMILY || value === CONFIGURABLE_PLANNING_RUNNER_FAMILY;
}

export function isSupportedProductWorkflowRunnerFamily(
  value: string,
): value is ProductWorkflowRunnerFamily {
  return (
    isSupportedPlanningRunnerFamily(value) ||
    value === NOTE_CAPTURE_RUNNER_FAMILY ||
    value === DIRECT_AGENT_RUNNER_FAMILY ||
    value === MEMORY_DIRECT_RUNNER_FAMILY
  );
}

function legacyDispatch(): Extract<
  PlanningRunnerDispatch,
  { readonly runnerFamily: typeof LEGACY_PLANNING_RUNNER_FAMILY }
> {
  return {
    runnerFamily: LEGACY_PLANNING_RUNNER_FAMILY,
    runnerBundleVersion: LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
  };
}
