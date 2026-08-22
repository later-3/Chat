import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowRunSpec } from "@chat/contracts";
import { compileWorkflowRunSpec } from "@chat/application/workflow-run-spec-compiler";
import { kernelCompilerInputFixture } from "@chat/application/workflow-kernel-fixtures";
import {
  definitionKernelReviewHookToken,
  getDefinitionKernelLabRun,
  resumeDefinitionKernelLabReview,
  setKernelLabRuntimePort,
  setupWorkflowWorld,
  startDefinitionKernelLabRun,
  type DefinitionKernelLabWorkflowResult,
  type WorkflowWorldHandle,
} from "@chat/workflows";
import { DefinitionKernelFileHarness } from "./definition-kernel-file-harness.js";

const BUNDLE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../workflows/.workflow-bundle",
);

interface LabStack {
  readonly root: string;
  readonly harness: DefinitionKernelFileHarness;
  readonly world: WorkflowWorldHandle;
}

describe("Definition Kernel真实Local World实验室", () => {
  let stack: LabStack;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-definition-kernel-"));
    const harness = await DefinitionKernelFileHarness.open(join(root, "kernel-facts.json"));
    setKernelLabRuntimePort(harness);
    const world = await setupWorkflowWorld({
      dataDir: join(root, "workflow-data"),
      bundleDir: BUNDLE_DIR,
      recoverActiveRuns: false,
      clearBeforeStart: true,
      tag: "definition-kernel-lab",
    });
    stack = { root, harness, world };
  }, 120_000);

  afterAll(async () => {
    setKernelLabRuntimePort(undefined);
    await stack.world.close();
    await rm(stack.root, { recursive: true, force: true });
  });

  it("Sequence、Choice两分支、BoundedLoop第二轮和Human Review在真实Runtime收敛", async () => {
    await expect(runFixture(stack, "sequence")).resolves.toMatchObject({ outcome: "completed" });
    await expect(runFixture(stack, "choice")).resolves.toMatchObject({ outcome: "completed" });

    const reviewedChoice = compileFixture("choice", "reviewedchoice");
    await stack.harness.configureOutcomes("note.classify", ["needs_review"]);
    await expect(runCompiled(stack, reviewedChoice, ["approved"])).resolves.toMatchObject({
      outcome: "completed",
    });

    const loop = compileFixture("bounded_loop", "loopsecond");
    await expect(runCompiled(stack, loop, ["request_revision", "approved"])).resolves.toMatchObject(
      { outcome: "completed" },
    );

    await expect(runFixture(stack, "human_review", ["approved"])).resolves.toMatchObject({
      outcome: "completed",
    });
  }, 240_000); // 5个真实Local World Run串行执行；全仓并行负载下不能沿用单场景60秒门。

  it("Composite有界展开3个Action，失败与结果未知都失败关闭", async () => {
    const success = compileFixture("composite", "compositesuccess");
    await stack.harness.configureComposite(success.workflowRunSpecId, [
      { actionId: "action-1", title: "A" },
      { actionId: "action-2", title: "B" },
      { actionId: "action-3", title: "C" },
    ]);
    await expect(runCompiled(stack, success, ["approved"])).resolves.toMatchObject({
      outcome: "completed",
    });

    const failed = compileFixture("composite", "compositefailed");
    await stack.harness.configureComposite(
      failed.workflowRunSpecId,
      [
        { actionId: "action-1", title: "A" },
        { actionId: "action-2", title: "B" },
        { actionId: "action-3", title: "C" },
      ],
      { "action-2": "failed" },
    );
    await expect(runCompiled(stack, failed, ["approved"])).resolves.toMatchObject({
      outcome: "failed",
      reasonCode: "kernel.node_failed_closed",
    });

    const unknown = compileFixture("composite", "compositeunknown");
    await stack.harness.configureComposite(
      unknown.workflowRunSpecId,
      [{ actionId: "action-1", title: "A" }],
      { "action-1": "outcome_unknown" },
    );
    await expect(runCompiled(stack, unknown, ["approved"])).resolves.toMatchObject({
      outcome: "failed",
      reasonCode: "kernel.node_outcome_unknown",
    });
  }, 240_000); // 3个真实Run串行，慢机器负载下放宽。

  it("循环达到上限时request_human只接受已提交stop决定，重复resume不重复事实", async () => {
    const runSpec = compileFixture("bounded_loop", "looplimit");
    const result = await runCompiled(stack, runSpec, [
      "request_revision",
      "request_revision",
      "request_revision",
      "request_revision",
      "request_revision",
      "stop",
    ]);
    expect(result).toMatchObject({
      outcome: "failed",
      reasonCode: "kernel.loop_limit_stopped_by_human",
    });
    const state = await stack.harness.snapshot();
    expect(Object.values(state.receiptExecutions).every((count) => count === 1)).toBe(true);
    // 6轮人机环回在慢机器上单轮约5秒，测试预算需大于driver deadline
    // （60s + 6×20s = 180s）。
  }, 300_000);

  it("Mixed Fixture执行且同一operation identity重放5次不增加业务Receipt", async () => {
    const runSpec = compileFixture("mixed", "mixedreplay");
    await runCompiled(stack, runSpec, ["approved"]);
    const afterFirst = await stack.harness.snapshot();
    const receiptCount = Object.keys(afterFirst.receipts).length;
    const replayContext = {
      workflowRunSpecId: runSpec.workflowRunSpecId,
      productRunId: runSpec.productRunId,
      definitionNodeId: "planning.research",
      executionPath: "replay-proof",
      attemptNumber: 1,
      commandId: "cmd_replayproof1",
    };
    for (let replay = 0; replay < 5; replay += 1) {
      await stack.harness.research(replayContext);
    }
    const afterReplay = await stack.harness.snapshot();
    expect(Object.keys(afterReplay.receipts)).toHaveLength(receiptCount + 1);
    expect(afterReplay.receiptExecutions[replayContext.commandId]).toBe(1);
    expect(Object.values(afterReplay.receiptExecutions).every((count) => count === 1)).toBe(true);
  }, 180_000); // 5次重放+完整Run，慢机器负载下放宽。

  it("Hash、Executor版本和预算篡改在第一个业务节点前失败关闭", async () => {
    const valid = compileFixture("sequence", "tamperbase");
    for (const [suffix, mutate] of [
      ["hash", (spec: WorkflowRunSpec) => ({ ...spec, sha256: "0".repeat(64) })],
      [
        "executor",
        (spec: WorkflowRunSpec) => ({
          ...spec,
          executorManifest: spec.executorManifest.map((entry, index) =>
            index === 0 ? { ...entry, executorVersion: "future.v99" } : entry,
          ),
        }),
      ],
      [
        "budget",
        (spec: WorkflowRunSpec) => ({
          ...spec,
          limits: {
            ...spec.limits,
            runtime: { ...spec.limits.runtime, maxNodeExecutions: 999 },
          },
        }),
      ],
    ] as const) {
      const tampered = mutate(valid);
      const isolated = {
        ...tampered,
        workflowRunSpecId: `wrs_tamper${suffix}`,
        productRunId: `run_tamper${suffix}`,
      };
      await stack.harness.seedRunSpec(isolated as never);
      await expect(runSeeded(stack, isolated as never)).resolves.toMatchObject({
        outcome: "failed",
      });
    }
  }, 60_000);

  it("waiting_human时关闭并恢复Local World，重读已提交Decision且Receipt不重复", async () => {
    const runSpec = compileFixture("human_review", "hookrecovery");
    await stack.harness.seedRunSpec(runSpec);
    const started = await startDefinitionKernelLabRun(stack.world.definitionKernelLabWorkflowId, {
      schemaVersion: "definition-kernel-lab-workflow-input.v1",
      productRunId: runSpec.productRunId,
      workflowRunSpecId: runSpec.workflowRunSpecId,
      attemptNumber: 1,
      runtimeCredentialRef: "rtc_fixture",
    });
    const review = await waitForReadyReview(stack.harness, runSpec.productRunId);
    await stack.world.close();

    const recoveredHarness = await DefinitionKernelFileHarness.open(
      join(stack.root, "kernel-facts.json"),
    );
    setKernelLabRuntimePort(recoveredHarness);
    const recoveredWorld = await setupWorkflowWorld({
      dataDir: join(stack.root, "workflow-data"),
      bundleDir: BUNDLE_DIR,
      recoverActiveRuns: true,
      tag: "definition-kernel-lab",
    });
    stack = { ...stack, harness: recoveredHarness, world: recoveredWorld };

    const decisionRef = await recoveredHarness.commitDecision(review.reviewRef, "approved");
    await resumeDefinitionKernelLabReview(
      definitionKernelReviewHookToken(runSpec.workflowRunSpecId, review.executionPath),
      decisionRef,
    );
    await expect(getDefinitionKernelLabRun(started.runId).returnValue).resolves.toMatchObject({
      outcome: "completed",
    });
    const evidence = await recoveredHarness.snapshot();
    expect(Object.values(evidence.receiptExecutions).every((count) => count === 1)).toBe(true);
  }, 60_000);
});

function compileFixture(
  key: Parameters<typeof kernelCompilerInputFixture>[0],
  identity: string,
): WorkflowRunSpec {
  const result = compileWorkflowRunSpec(
    kernelCompilerInputFixture(key, {
      workflowRunSpecId: `wrs_${identity}`,
      productRunId: `run_${identity}`,
    }),
  );
  if (!result.success) throw new Error(`Fixture编译失败:${result.diagnostics[0]?.code}`);
  return result.runSpec;
}

async function runFixture(
  stack: LabStack,
  key: Parameters<typeof kernelCompilerInputFixture>[0],
  decisions: readonly string[] = [],
): Promise<DefinitionKernelLabWorkflowResult> {
  return runCompiled(stack, compileFixture(key, `local${key.replace("_", "")}`), decisions);
}

async function runCompiled(
  stack: LabStack,
  runSpec: WorkflowRunSpec,
  decisions: readonly string[],
): Promise<DefinitionKernelLabWorkflowResult> {
  await stack.harness.seedRunSpec(runSpec);
  const result = runSeeded(stack, runSpec);
  await driveCommittedReviews(stack, runSpec, decisions);
  return result;
}

async function runSeeded(
  stack: LabStack,
  runSpec: WorkflowRunSpec,
): Promise<DefinitionKernelLabWorkflowResult> {
  const run = await startDefinitionKernelLabRun(stack.world.definitionKernelLabWorkflowId, {
    schemaVersion: "definition-kernel-lab-workflow-input.v1",
    productRunId: runSpec.productRunId,
    workflowRunSpecId: runSpec.workflowRunSpecId,
    attemptNumber: 1,
    runtimeCredentialRef: "rtc_fixture",
  });
  return run.returnValue;
}

async function driveCommittedReviews(
  stack: LabStack,
  runSpec: WorkflowRunSpec,
  decisions: readonly string[],
): Promise<void> {
  let decisionIndex = 0;
  const resumed = new Set<string>();
  // 预算随决定数伸缩：每轮人机环回在慢机器上约5秒，固定30s会让6轮循环的
  // bounded_loop在慢环境必超时；超时留下的未决review会污染后续测试（见下方过滤）。
  const deadline = Date.now() + 60_000 + decisions.length * 20_000;
  while (Date.now() < deadline) {
    const state = await stack.harness.snapshot();
    if (state.settlements[runSpec.productRunId] !== undefined) return;
    // 只看当前Run的review：harness状态在同文件测试间共享，其他Run遗留的
    // 未决review不属于本次驱动，捡到会消耗错误的决定并resume过期Hook。
    const open = Object.values(state.reviews).find(
      (review) =>
        review.productRunId === runSpec.productRunId &&
        review.hookReady === true &&
        review.decisionRef === undefined &&
        !resumed.has(review.reviewRef),
    );
    if (open !== undefined) {
      const outcome = decisions[decisionIndex];
      if (outcome === undefined) throw new Error(`缺少第${String(decisionIndex + 1)}个人工决定`);
      decisionIndex += 1;
      const decisionRef = await stack.harness.commitDecision(open.reviewRef, outcome);
      resumed.add(open.reviewRef);
      const token = definitionKernelReviewHookToken(runSpec.workflowRunSpecId, open.executionPath);
      await resumeDefinitionKernelLabReview(token, decisionRef);
    }
    // 100ms轮询：harness每次snapshot都整文件读取+结构校验，25ms在慢机器上
    // 自身成为负载源；对每轮约5秒的人机环回延迟可忽略。
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Definition Kernel review驱动超时");
}

async function waitForReadyReview(
  harness: DefinitionKernelFileHarness,
  productRunId: string,
): Promise<{ readonly reviewRef: string; readonly executionPath: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await harness.snapshot();
    const review = Object.values(state.reviews).find(
      (candidate) =>
        candidate.hookReady === true &&
        candidate.productRunId === productRunId &&
        candidate.decisionRef === undefined,
    );
    if (review !== undefined) return review;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待Definition Kernel Hook Ready超时");
}
