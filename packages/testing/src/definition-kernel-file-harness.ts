import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { workflowRunSpecSchema, type WorkflowRunSpec } from "@chat/contracts";
import type {
  KernelLabRuntimePort,
  KernelLabSettlement,
  KernelNodeControlResult,
  KernelNodeExecutionContext,
  KernelPreparedComposite,
} from "@chat/workflows";

interface HarnessReview {
  readonly reviewRef: string;
  readonly nodeType: "human.plan_review" | "human.note_review" | "loop_limit";
  readonly commandId: string;
  readonly productRunId: string;
  readonly executionPath: string;
  readonly hookReady?: boolean;
  readonly decisionRef?: string;
  readonly outcomeCode?: string;
}

interface HarnessState {
  readonly schemaVersion: "definition-kernel-file-harness.v1";
  readonly runSpecs: Record<string, WorkflowRunSpec>;
  readonly receipts: Record<string, unknown>;
  readonly receiptExecutions: Record<string, number>;
  readonly outcomeQueues: Record<string, string[]>;
  readonly outcomeOffsets: Record<string, number>;
  readonly actionManifests: Record<string, { readonly actionId: string; readonly title: string }[]>;
  readonly actionOutcomes: Record<string, string>;
  readonly reviews: Record<string, HarnessReview>;
  readonly settlements: Record<string, KernelLabSettlement>;
}

const DEFAULT_OUTCOMES: Readonly<Record<string, string>> = {
  "memory.query": "success",
  "memory.write": "accepted",
  "context.memory": "success",
  "context.project": "success",
  "policy.rules": "resolved",
  "capability.skills": "resolved",
  "agent.research": "researched",
  "agent.plan": "planned",
  "result.validate": "valid",
  "product.commit": "committed",
  "note.extract": "extracted",
  "note.classify": "classified",
  "note.commit": "committed",
  "human.plan_review": "approved",
  "human.note_review": "approved",
};

/**
 * 黑盒Kernel Harness把RunSpec、Command Receipt、Review和Settlement写入原子JSON文件。
 * 关闭/重开Local World后不会依赖进程Map判断节点是否已经执行；相同commandId只消费一次。
 */
export class DefinitionKernelFileHarness implements KernelLabRuntimePort {
  readonly #path: string;
  #queue: Promise<void> = Promise.resolve();

  private constructor(path: string) {
    this.#path = path;
  }

  static async open(path: string): Promise<DefinitionKernelFileHarness> {
    const harness = new DefinitionKernelFileHarness(path);
    await mkdir(dirname(path), { recursive: true });
    try {
      await harness.readState();
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await harness.writeState(emptyState());
    }
    return harness;
  }

  async seedRunSpec(runSpec: WorkflowRunSpec): Promise<void> {
    const parsed = workflowRunSpecSchema.parse(runSpec);
    await this.mutate((state) => {
      state.runSpecs[parsed.workflowRunSpecId] = parsed;
    });
  }

  async configureOutcomes(key: string, outcomes: readonly string[]): Promise<void> {
    await this.mutate((state) => {
      state.outcomeQueues[key] = [...outcomes];
      state.outcomeOffsets[key] = 0;
    });
  }

  async configureComposite(
    workflowRunSpecId: string,
    actions: readonly { readonly actionId: string; readonly title: string }[],
    actionOutcomes: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    await this.mutate((state) => {
      state.actionManifests[workflowRunSpecId] = [...actions];
      for (const [actionId, outcome] of Object.entries(actionOutcomes)) {
        state.actionOutcomes[`${workflowRunSpecId}\0${actionId}`] = outcome;
      }
    });
  }

  async commitDecision(reviewRef: string, outcomeCode: string): Promise<string> {
    const decisionRef = `dec_${reviewRef.replace(/[^A-Za-z0-9]/g, "").slice(-40)}`;
    await this.mutate((state) => {
      const review = state.reviews[reviewRef];
      if (review === undefined) throw new Error("harness.review_not_found");
      if (review.decisionRef !== undefined && review.decisionRef !== decisionRef) {
        throw new Error("harness.review_already_decided");
      }
      state.reviews[reviewRef] = { ...review, decisionRef, outcomeCode };
    });
    return decisionRef;
  }

  async snapshot(): Promise<HarnessState> {
    return this.readState();
  }

  async loadRunSpec(input: {
    readonly workflowRunSpecId: string;
    readonly productRunId: string;
  }): Promise<unknown> {
    const state = await this.readState();
    const runSpec = state.runSpecs[input.workflowRunSpecId];
    if (runSpec === undefined || runSpec.productRunId !== input.productRunId) {
      throw new Error("harness.run_spec_not_found");
    }
    return runSpec;
  }

  queryMemory = (context: KernelNodeExecutionContext) => this.completeNode(context, "memory.query");
  writeMemory = (context: KernelNodeExecutionContext) => this.completeNode(context, "memory.write");
  loadMemoryContext = (context: KernelNodeExecutionContext) =>
    this.completeNode(context, "context.memory");
  loadProjectContext = (context: KernelNodeExecutionContext) =>
    this.completeNode(context, "context.project");
  resolveRules = (context: KernelNodeExecutionContext) =>
    this.completeNode(context, "policy.rules");
  resolveSkills = (context: KernelNodeExecutionContext) =>
    this.completeNode(context, "capability.skills");
  research = (context: KernelNodeExecutionContext) => this.completeNode(context, "agent.research");
  plan = (context: KernelNodeExecutionContext) => this.completeNode(context, "agent.plan");
  validateResult = (context: KernelNodeExecutionContext) =>
    this.completeNode(context, "result.validate");
  commitProduct = (context: KernelNodeExecutionContext) =>
    this.completeNode(context, "product.commit");
  extractNote = (context: KernelNodeExecutionContext) => this.completeNode(context, "note.extract");
  classifyNote = (context: KernelNodeExecutionContext) =>
    this.completeNode(context, "note.classify");
  commitNote = (context: KernelNodeExecutionContext) => this.completeNode(context, "note.commit");

  beginPlanReview(context: KernelNodeExecutionContext) {
    return this.beginReview(context, "human.plan_review");
  }

  beginNoteReview(context: KernelNodeExecutionContext) {
    return this.beginReview(context, "human.note_review");
  }

  loadCommittedPlanDecision(input: {
    readonly context: KernelNodeExecutionContext;
    readonly reviewRef: string;
    readonly decisionRef: string;
  }) {
    return this.loadDecision(input);
  }

  loadCommittedNoteDecision(input: {
    readonly context: KernelNodeExecutionContext;
    readonly reviewRef: string;
    readonly decisionRef: string;
  }) {
    return this.loadDecision(input);
  }

  recordPolicyAutoContinue(input: {
    readonly context: KernelNodeExecutionContext;
    readonly nodeType: "human.plan_review" | "human.note_review";
    readonly policyRef: {
      readonly resourceId: string;
      readonly revision: number;
      readonly sha256: string;
    };
  }) {
    return this.completeNode(input.context, input.nodeType);
  }

  async prepareExecutePlan(context: KernelNodeExecutionContext): Promise<KernelPreparedComposite> {
    return this.receipt(context.commandId, async (state) => ({
      outcomeCode: "success",
      actionManifest: {
        actions: state.actionManifests[context.workflowRunSpecId] ?? [
          { actionId: "action-1", title: "Action 1" },
          { actionId: "action-2", title: "Action 2" },
          { actionId: "action-3", title: "Action 3" },
        ],
      },
    }));
  }

  async executePlanAction(input: {
    readonly context: KernelNodeExecutionContext;
    readonly actionId: string;
  }): Promise<KernelNodeControlResult> {
    return this.receipt(input.context.commandId, async (state) => ({
      outcomeCode:
        state.actionOutcomes[`${input.context.workflowRunSpecId}\0${input.actionId}`] ?? "success",
    }));
  }

  async completeExecutePlan(input: {
    readonly context: KernelNodeExecutionContext;
    readonly outcomeCode: "success" | "failed" | "outcome_unknown";
  }): Promise<KernelNodeControlResult> {
    return this.receipt(input.context.commandId, async () => ({
      outcomeCode: input.outcomeCode,
    }));
  }

  async recordSkipped(input: {
    readonly context: KernelNodeExecutionContext;
    readonly nodeType: Parameters<KernelLabRuntimePort["recordSkipped"]>[0]["nodeType"];
    readonly outcomeCode: string;
  }): Promise<KernelNodeControlResult> {
    return this.receipt(input.context.commandId, async () => ({
      outcomeCode: input.outcomeCode,
    }));
  }

  async beginLoopLimitReview(input: {
    readonly workflowRunSpecId: string;
    readonly productRunId: string;
    readonly executionPath: string;
    readonly commandId: string;
  }): Promise<{ readonly reviewRef: string }> {
    const context: KernelNodeExecutionContext = {
      workflowRunSpecId: input.workflowRunSpecId,
      productRunId: input.productRunId,
      definitionNodeId: "loop-limit",
      executionPath: input.executionPath,
      attemptNumber: 1,
      commandId: input.commandId,
    };
    return this.beginReview(context, "loop_limit");
  }

  async loadCommittedLoopLimitDecision(input: {
    readonly reviewRef: string;
    readonly decisionRef: string;
  }): Promise<{ readonly outcomeCode: "stop" }> {
    const state = await this.readState();
    const review = state.reviews[input.reviewRef];
    if (review?.decisionRef !== input.decisionRef || review.outcomeCode !== "stop") {
      throw new Error("harness.loop_decision_not_committed");
    }
    return { outcomeCode: "stop" };
  }

  async markReviewHookReady(input: {
    readonly reviewRef: string;
    readonly commandId: string;
  }): Promise<void> {
    await this.receipt(input.commandId, async (state) => {
      const review = state.reviews[input.reviewRef];
      if (review === undefined) throw new Error("harness.review_not_found");
      state.reviews[input.reviewRef] = { ...review, hookReady: true };
      return { ready: true };
    });
  }

  async settle(input: {
    readonly workflowRunSpecId: string;
    readonly productRunId: string;
    readonly commandId: string;
    readonly settlement: KernelLabSettlement;
  }): Promise<KernelLabSettlement> {
    return this.receipt(input.commandId, async (state) => {
      state.settlements[input.productRunId] = input.settlement;
      return input.settlement;
    });
  }

  private async completeNode(
    context: KernelNodeExecutionContext,
    key: string,
  ): Promise<KernelNodeControlResult> {
    return this.receipt(context.commandId, async (state) => ({
      outcomeCode: consumeOutcome(state, key),
    }));
  }

  private async beginReview(
    context: KernelNodeExecutionContext,
    nodeType: HarnessReview["nodeType"],
  ): Promise<{ readonly reviewRef: string }> {
    return this.receipt(context.commandId, async (state) => {
      const reviewRef = `rev_${context.commandId.slice(4)}`;
      state.reviews[reviewRef] ??= {
        reviewRef,
        nodeType,
        commandId: context.commandId,
        productRunId: context.productRunId,
        executionPath: context.executionPath,
      };
      return { reviewRef };
    });
  }

  private async loadDecision(input: {
    readonly context: KernelNodeExecutionContext;
    readonly reviewRef: string;
    readonly decisionRef: string;
  }): Promise<KernelNodeControlResult> {
    return this.receipt(input.context.commandId, async (state) => {
      const review = state.reviews[input.reviewRef];
      if (
        review?.decisionRef !== input.decisionRef ||
        review.outcomeCode === undefined ||
        review.nodeType === "loop_limit"
      ) {
        throw new Error("harness.decision_not_committed");
      }
      return { outcomeCode: review.outcomeCode };
    });
  }

  private async receipt<T>(
    commandId: string,
    produce: (state: HarnessState) => Promise<T>,
  ): Promise<T> {
    let output: T | undefined;
    await this.mutate(async (state) => {
      if (Object.hasOwn(state.receipts, commandId)) {
        output = state.receipts[commandId] as T;
        return;
      }
      output = await produce(state);
      state.receipts[commandId] = output;
      state.receiptExecutions[commandId] = (state.receiptExecutions[commandId] ?? 0) + 1;
    });
    if (output === undefined) throw new Error("harness.receipt_output_missing");
    return output;
  }

  private async mutate(mutation: (state: HarnessState) => void | Promise<void>): Promise<void> {
    const operation = this.#queue.then(async () => {
      const state = await this.readState();
      await mutation(state);
      await this.writeState(state);
    });
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  private async readState(): Promise<HarnessState> {
    const raw = JSON.parse(await readFile(this.#path, "utf8")) as unknown;
    if (!isHarnessState(raw)) throw new Error("harness.snapshot_invalid");
    for (const runSpec of Object.values(raw.runSpecs)) workflowRunSpecSchema.parse(runSpec);
    return raw;
  }

  private async writeState(state: HarnessState): Promise<void> {
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, this.#path);
  }
}

function consumeOutcome(state: HarnessState, key: string): string {
  const queue = state.outcomeQueues[key];
  if (queue === undefined || queue.length === 0) return DEFAULT_OUTCOMES[key] ?? "success";
  const offset = state.outcomeOffsets[key] ?? 0;
  state.outcomeOffsets[key] = offset + 1;
  return queue[Math.min(offset, queue.length - 1)] ?? DEFAULT_OUTCOMES[key] ?? "success";
}

function emptyState(): HarnessState {
  return {
    schemaVersion: "definition-kernel-file-harness.v1",
    runSpecs: {},
    receipts: {},
    receiptExecutions: {},
    outcomeQueues: {},
    outcomeOffsets: {},
    actionManifests: {},
    actionOutcomes: {},
    reviews: {},
    settlements: {},
  };
}

function isHarnessState(value: unknown): value is HarnessState {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === "definition-kernel-file-harness.v1" &&
    isRecord(record.runSpecs) &&
    isRecord(record.receipts) &&
    isRecord(record.receiptExecutions) &&
    isRecord(record.outcomeQueues) &&
    isRecord(record.outcomeOffsets) &&
    isRecord(record.actionManifests) &&
    isRecord(record.actionOutcomes) &&
    isRecord(record.reviews) &&
    isRecord(record.settlements)
  );
}

function isRecord(value: unknown): value is Record<string, never> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
