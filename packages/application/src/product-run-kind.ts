import type { ProductRun } from "@chat/contracts";
import { revisionConflict } from "./errors.js";

export type PlanningProductRun = Extract<ProductRun, { readonly runKind: "planning" }>;
export type NoteCaptureProductRun = Extract<ProductRun, { readonly runKind: "note_capture" }>;
export type DirectAgentProductRun = Extract<ProductRun, { readonly runKind: "direct_agent" }>;
export type WorkflowMemoryProductRun = PlanningProductRun | DirectAgentProductRun;

/**
 * Planning专属Application边界必须先缩窄Run分支。
 * Note Capture不会携带Plan/Approval字段；若误入旧规划用例，必须明确失败而不是读undefined。
 */
export function requirePlanningRun(run: ProductRun): PlanningProductRun {
  if (run.runKind !== "planning") {
    throw revisionConflict("该Product Run不是Planning运行，不能使用Planning命令或查询");
  }
  return run;
}

export function requireNoteCaptureRun(run: ProductRun): NoteCaptureProductRun {
  if (run.runKind !== "note_capture") {
    throw revisionConflict("该Product Run不是Note Capture运行，不能使用Note命令或查询");
  }
  return run;
}

export function requireDirectAgentRun(run: ProductRun): DirectAgentProductRun {
  if (run.runKind !== "direct_agent") {
    throw revisionConflict("该Product Run不是Direct Agent运行，不能使用Prompt Review命令或查询");
  }
  return run;
}

/** Memory节点只属于Planning或显式Memory Direct；普通Direct不能借此隐式启用Memory。 */
export function requireWorkflowMemoryRun(run: ProductRun): WorkflowMemoryProductRun {
  if (
    run.runKind === "planning" ||
    (run.runKind === "direct_agent" &&
      (run.runnerFamily === "memory-direct.v1" || run.runnerFamily === "memory-agent-direct.v1"))
  ) {
    return run;
  }
  throw revisionConflict("该Product Run没有冻结Workflow Memory节点能力");
}
