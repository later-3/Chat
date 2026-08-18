/**
 * Plan候选的纯语义校验。Schema只证明字段形状；执行前还必须证明步骤图与能力请求安全。
 */

export interface PlanSemanticStep {
  readonly stepId: string;
  readonly dependsOn: readonly string[];
  readonly requestedCapabilities: readonly string[];
  readonly risk?: "low" | "medium" | "high";
  readonly inputRefs: readonly {
    readonly refId: string;
    readonly revision: number;
    readonly sha256: string;
  }[];
}

export interface PlanSemanticIssue {
  readonly code:
    | "step_limit_exceeded"
    | "duplicate_step_id"
    | "duplicate_dependency"
    | "dependency_not_previous"
    | "capability_not_allowed"
    | "capability_risk_mismatch"
    | "context_ref_not_allowed";
  readonly detail: string;
}

export function validatePlanSemantics(
  steps: readonly PlanSemanticStep[],
  options: {
    readonly maxSteps: number;
    readonly allowedCapabilities: ReadonlySet<string>;
    readonly allowedContextRefs: ReadonlySet<string>;
  },
): PlanSemanticIssue[] {
  const issues: PlanSemanticIssue[] = [];
  if (steps.length > options.maxSteps) {
    issues.push({
      code: "step_limit_exceeded",
      detail: `计划步骤数${String(steps.length)}超过上限${String(options.maxSteps)}`,
    });
  }

  const previousStepIds = new Set<string>();
  for (const step of steps) {
    if (previousStepIds.has(step.stepId)) {
      issues.push({ code: "duplicate_step_id", detail: `步骤ID重复:${step.stepId}` });
    }

    const dependencies = new Set<string>();
    for (const dependency of step.dependsOn) {
      if (dependencies.has(dependency)) {
        issues.push({
          code: "duplicate_dependency",
          detail: `步骤${step.stepId}重复依赖:${dependency}`,
        });
      }
      dependencies.add(dependency);
      // 只允许引用严格排在当前步骤之前的ID，同时关闭自依赖、向后引用和悬空引用。
      if (!previousStepIds.has(dependency)) {
        issues.push({
          code: "dependency_not_previous",
          detail: `步骤${step.stepId}的依赖不是已定义前置步骤:${dependency}`,
        });
      }
    }

    const capabilities = new Set<string>();
    for (const capability of step.requestedCapabilities) {
      if (capabilities.has(capability) || !options.allowedCapabilities.has(capability)) {
        issues.push({
          code: "capability_not_allowed",
          detail: `步骤${step.stepId}请求了未允许或重复的能力:${capability}`,
        });
      }
      capabilities.add(capability);
    }
    if (capabilities.has("shell_execute") && step.risk !== "high") {
      issues.push({
        code: "capability_risk_mismatch",
        detail: `步骤${step.stepId}请求shell_execute时风险必须标记为high`,
      });
    }
    const contextRefs = new Set<string>();
    for (const ref of step.inputRefs) {
      const key = `${ref.refId}:${String(ref.revision)}:${ref.sha256}`;
      if (contextRefs.has(key) || !options.allowedContextRefs.has(key)) {
        issues.push({
          code: "context_ref_not_allowed",
          detail: `步骤${step.stepId}引用了未允许或重复的上下文:${ref.refId}`,
        });
      }
      contextRefs.add(key);
    }
    previousStepIds.add(step.stepId);
  }
  return issues;
}
