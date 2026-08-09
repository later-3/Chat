import type { WorkflowNodeTypeKey } from "@chat/domain";
import type { WorkflowRunSpec } from "@chat/application";

export interface KernelNodeExecutionScope {
  readonly workflowRunSpecId: string;
  readonly productRunId: string;
  readonly definitionNodeId: string;
  /** 同一循环迭代/Composite子项拥有不同路径；Workflow重放保持不变。 */
  readonly executionPath: string;
  readonly attemptNumber: number;
}

export interface KernelNodeExecutionContext extends KernelNodeExecutionScope {
  readonly commandId: string;
}

export interface KernelNodeControlResult {
  readonly outcomeCode: string;
  readonly outputRefs?:
    | readonly {
        readonly kind: string;
        readonly refId: string;
        readonly revision: number;
        readonly sha256: string;
      }[]
    | undefined;
}

export interface KernelActionManifest {
  readonly actions: readonly {
    readonly actionId: string;
    readonly title: string;
  }[];
}

export interface KernelPreparedComposite extends KernelNodeControlResult {
  readonly actionManifest: KernelActionManifest;
}

export interface KernelReviewWait {
  readonly reviewRef: string;
}

export interface KernelLabSettlement {
  readonly outcome: "completed" | "cancelled" | "failed";
  readonly reasonCode?: string;
}

/**
 * S3实验室Port逐项对应已批准的业务边界，没有open store、request(url)或execute(code)。
 * S4/S5会把这些方法分别适配到真实Application Command；实验Harness使用耐久文件事实。
 */
export interface KernelLabRuntimePort {
  loadRunSpec(input: {
    readonly workflowRunSpecId: string;
    readonly productRunId: string;
  }): Promise<unknown>;
  loadMemoryContext(context: KernelNodeExecutionContext): Promise<KernelNodeControlResult>;
  loadProjectContext(context: KernelNodeExecutionContext): Promise<KernelNodeControlResult>;
  resolveRules(context: KernelNodeExecutionContext): Promise<KernelNodeControlResult>;
  resolveSkills(context: KernelNodeExecutionContext): Promise<KernelNodeControlResult>;
  research(context: KernelNodeExecutionContext): Promise<KernelNodeControlResult>;
  plan(context: KernelNodeExecutionContext): Promise<KernelNodeControlResult>;
  validateResult(context: KernelNodeExecutionContext): Promise<KernelNodeControlResult>;
  commitProduct(context: KernelNodeExecutionContext): Promise<KernelNodeControlResult>;
  extractNote(context: KernelNodeExecutionContext): Promise<KernelNodeControlResult>;
  classifyNote(context: KernelNodeExecutionContext): Promise<KernelNodeControlResult>;
  commitNote(context: KernelNodeExecutionContext): Promise<KernelNodeControlResult>;
  beginPlanReview(context: KernelNodeExecutionContext): Promise<KernelReviewWait>;
  beginNoteReview(context: KernelNodeExecutionContext): Promise<KernelReviewWait>;
  loadCommittedPlanDecision(input: {
    readonly context: KernelNodeExecutionContext;
    readonly reviewRef: string;
    readonly decisionRef: string;
  }): Promise<KernelNodeControlResult>;
  loadCommittedNoteDecision(input: {
    readonly context: KernelNodeExecutionContext;
    readonly reviewRef: string;
    readonly decisionRef: string;
  }): Promise<KernelNodeControlResult>;
  recordPolicyAutoContinue(input: {
    readonly context: KernelNodeExecutionContext;
    readonly nodeType: "human.plan_review" | "human.note_review";
    readonly policyRef: {
      readonly resourceId: string;
      readonly revision: number;
      readonly sha256: string;
    };
  }): Promise<KernelNodeControlResult>;
  prepareExecutePlan(context: KernelNodeExecutionContext): Promise<KernelPreparedComposite>;
  executePlanAction(input: {
    readonly context: KernelNodeExecutionContext;
    readonly actionId: string;
  }): Promise<KernelNodeControlResult>;
  completeExecutePlan(input: {
    readonly context: KernelNodeExecutionContext;
    readonly outcomeCode: "success" | "failed" | "outcome_unknown";
  }): Promise<KernelNodeControlResult>;
  recordSkipped(input: {
    readonly context: KernelNodeExecutionContext;
    readonly nodeType: WorkflowNodeTypeKey;
    readonly outcomeCode: string;
  }): Promise<KernelNodeControlResult>;
  beginLoopLimitReview(input: {
    readonly workflowRunSpecId: string;
    readonly productRunId: string;
    readonly executionPath: string;
    readonly commandId: string;
  }): Promise<KernelReviewWait>;
  markReviewHookReady(input: {
    readonly reviewRef: string;
    readonly commandId: string;
  }): Promise<void>;
  loadCommittedLoopLimitDecision(input: {
    readonly reviewRef: string;
    readonly decisionRef: string;
  }): Promise<{ readonly outcomeCode: "stop" }>;
  settle(input: {
    readonly workflowRunSpecId: string;
    readonly productRunId: string;
    readonly commandId: string;
    readonly settlement: KernelLabSettlement;
  }): Promise<KernelLabSettlement>;
}

const KERNEL_LAB_CONTEXT = Symbol.for("chat.definitionKernelLabRuntimePort");

export function setKernelLabRuntimePort(port: KernelLabRuntimePort | undefined): void {
  (globalThis as Record<PropertyKey, unknown>)[KERNEL_LAB_CONTEXT] = port;
}

export function getKernelLabRuntimePort(): KernelLabRuntimePort {
  const port = (globalThis as Record<PropertyKey, unknown>)[KERNEL_LAB_CONTEXT] as
    KernelLabRuntimePort | undefined;
  if (port === undefined) throw new Error("Definition Kernel Lab Runtime Port未初始化");
  return port;
}

/** 仅用于类型导航，真实加载结果仍必须在Step中做Schema+Hash校验。 */
export type LoadedKernelRunSpec = WorkflowRunSpec;
