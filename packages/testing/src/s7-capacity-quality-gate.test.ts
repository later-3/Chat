import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  B2_MAX_PLAN_STEPS,
  NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS,
  WORKFLOW_DEFINITION_CONTRACT_LIMITS,
  artifactSchema,
  nodeValueManifestSchema,
  noteDraftSchema,
  planContentSchema,
  workflowNodeDetailDtoSchema,
  workflowRunViewDtoSchema,
} from "@chat/contracts";
import {
  DEFAULT_NODE_CATALOG,
  WorkflowBlueprintRegistry,
  getWorkflowNodeDetail,
  getWorkflowRunView,
  type ApplicationDeps,
  type IdFactory,
  type WorkflowBlueprint,
} from "@chat/application";
import { compileWorkflowRunSpec } from "@chat/application/workflow-run-spec-compiler";
import {
  kernelCompilerInputFixture,
  kernelDefinitionFixture,
} from "@chat/application/workflow-kernel-fixtures";
import { WORKFLOW_KERNEL_LIMITS, hashCanonical } from "@chat/domain";
import { JsonProductStore } from "@chat/product-store-json";
import {
  S7_VERSIONED_FIXTURE_MANIFEST,
  buildS7VersionedFixture,
  migrateS7FixtureToCurrent,
} from "./fixtures/s7-versioned-fixtures.js";

const NOW = "2026-08-10T18:00:00.000Z";

export const S7_CAPACITY_ACCEPTANCE = Object.freeze({
  referenceMachine: {
    os: "macOS Darwin 24.5.0",
    cpu: "Apple M4 Pro",
    memoryBytes: 25_769_803_776,
    node: "24.8.0",
    arch: "arm64",
  },
  performanceMs: {
    compileP95: 250,
    storeOpenP95: 1_000,
    storeTransactP95: 500,
    runViewP95: 100,
    nodeDetailP95: 100,
  },
  responseBytes: {
    runView: 256 * 1024,
    nodeDetail: 128 * 1024,
  },
  storeProbe: { addedSessions: 40 },
} as const);

function percentile(values: readonly number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index] ?? 0;
}

function metrics(values: readonly number[]) {
  return {
    p50: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
  };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function throwingIds(): IdFactory {
  const invalid = () => {
    throw new Error("S7只读Query不应分配产品ID");
  };
  return {
    session: invalid,
    message: invalid,
    run: invalid,
    attempt: invalid,
    plan: invalid,
    planRevision: invalid,
    revisionInput: invalid,
    approval: invalid,
    decision: invalid,
    executionContract: invalid,
    executionCandidate: invalid,
    validationResult: invalid,
    artifact: invalid,
    outbox: invalid,
  } as IdFactory;
}

const CAPACITY_BLUEPRINT: WorkflowBlueprint = {
  blueprintKey: "planning",
  blueprintVersion: 1,
  runnerFamily: "configurable-planning.v1",
  allowedNodeTypes: ["agent.research", "product.commit"],
  optionalNodeTypes: [],
  repeatableNodeTypes: [],
  requiredRoles: [],
  loopRules: [],
  perRunOverrides: [],
  immutableMinimumRisk: { "product.commit": "product_commit" },
  mandatoryManualReviewTypes: [],
  terminalNodeType: "product.commit",
};

const CAPACITY_BLUEPRINTS = new WorkflowBlueprintRegistry(
  [CAPACITY_BLUEPRINT],
  DEFAULT_NODE_CATALOG,
);

function capacityPlanningDefinition(nodeCount: number) {
  const base = kernelDefinitionFixture("mixed");
  const researchNodes = Array.from({ length: nodeCount - 1 }, (_, index) => ({
    kind: "task" as const,
    definitionNodeId: `planning.research-${String(index + 1).padStart(2, "0")}`,
    nodeType: "agent.research" as const,
    schemaVersion: 1,
    config: {},
  }));
  return {
    ...base,
    semanticRoot: {
      ...base.semanticRoot,
      elements: [
        ...researchNodes,
        {
          kind: "task" as const,
          definitionNodeId: "planning.commit",
          nodeType: "product.commit" as const,
          schemaVersion: 1,
          config: {},
        },
      ],
    },
  };
}

function planWithSteps(count: number) {
  return {
    objective: "S7容量边界",
    summary: "固定数量的脱敏步骤",
    assumptions: [],
    openQuestions: [],
    steps: Array.from({ length: count }, (_, index) => ({
      stepId: `step-${String(index + 1)}`,
      title: `步骤${String(index + 1)}`,
      purpose: "验证合同上限",
      dependsOn: index === 0 ? [] : [`step-${String(index)}`],
      inputRefs: [],
      expectedOutput: "脱敏输出",
      successCriteria: ["满足容量合同"],
      requestedCapabilities: [],
      risk: "low" as const,
    })),
    completionCriteria: ["所有边界均有明确结果"],
    warnings: [],
  };
}

describe("S7.2 容量、性能与limit+1自动门", () => {
  it("当前Planning Blueprint与Kernel最大64/limit+1均可证，编译记录p50/p95", () => {
    expect(compileWorkflowRunSpec(kernelCompilerInputFixture("mixed")).success).toBe(true);
    const maximum = capacityPlanningDefinition(
      WORKFLOW_DEFINITION_CONTRACT_LIMITS.structure.maxNodes,
    );
    const limitPlusOne = capacityPlanningDefinition(
      WORKFLOW_DEFINITION_CONTRACT_LIMITS.structure.maxNodes + 1,
    );
    const samples: number[] = [];
    let result: ReturnType<typeof compileWorkflowRunSpec> | undefined;
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const started = performance.now();
      result = compileWorkflowRunSpec(
        kernelCompilerInputFixture("mixed", { definition: maximum }),
        { blueprints: CAPACITY_BLUEPRINTS },
      );
      samples.push(performance.now() - started);
    }
    expect(result?.success, JSON.stringify(result)).toBe(true);
    const overflow = compileWorkflowRunSpec(
      kernelCompilerInputFixture("mixed", { definition: limitPlusOne }),
      { blueprints: CAPACITY_BLUEPRINTS },
    );
    expect(overflow).toMatchObject({ success: false });
    if (overflow.success) throw new Error("65节点不应通过");
    expect(
      overflow.diagnostics.some((item) => item.code === "definition.max_nodes_exceeded"),
      JSON.stringify(overflow.diagnostics),
    ).toBe(true);
    const measured = metrics(samples);
    expect(measured.p95).toBeLessThan(S7_CAPACITY_ACCEPTANCE.performanceMs.compileP95);
    console.info(`[s7-capacity] compile=${JSON.stringify(measured)}`);
  });

  it("正文、Plan步骤、Manifest slot均有limit与limit+1合同", () => {
    expect(
      noteDraftSchema.safeParse({
        title: "S7 Note",
        kind: "general",
        contentMarkdown: "x".repeat(NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS),
        tags: [],
      }).success,
    ).toBe(true);
    expect(
      noteDraftSchema.safeParse({
        title: "S7 Note",
        kind: "general",
        contentMarkdown: "x".repeat(NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS + 1),
        tags: [],
      }).success,
    ).toBe(false);
    expect(planContentSchema.safeParse(planWithSteps(B2_MAX_PLAN_STEPS)).success).toBe(true);
    expect(planContentSchema.safeParse(planWithSteps(B2_MAX_PLAN_STEPS + 1)).success).toBe(false);

    const manifest = (count: number) => ({
      schemaVersion: "node-value-manifest.v1",
      nodeValueManifestId: "wvm_s7capacity1",
      workflowNodeRunId: "wnr_s7capacity1",
      direction: "input",
      slots: Array.from({ length: count }, (_, index) => ({
        name: `slot-${String(index + 1)}`,
        refs: [
          {
            kind: "message",
            id: "msg_s7capacity1",
            revision: 1,
            sha256: "a".repeat(64),
            label: "脱敏引用",
          },
        ],
      })),
      sha256: "b".repeat(64),
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const effectiveManifestLimit = 30;
    expect(nodeValueManifestSchema.safeParse(manifest(effectiveManifestLimit)).success).toBe(true);
    expect(nodeValueManifestSchema.safeParse(manifest(effectiveManifestLimit + 1)).success).toBe(
      false,
    );
    expect(WORKFLOW_DEFINITION_CONTRACT_LIMITS.projection.maxManifestSlots).toBe(
      effectiveManifestLimit,
    );
    expect(WORKFLOW_KERNEL_LIMITS).toEqual(WORKFLOW_DEFINITION_CONTRACT_LIMITS);

    expect(
      artifactSchema.safeParse({
        schemaVersion: "artifact.v1",
        artifactId: "art_s7capacity1",
        productRunId: "run_s7capacity1",
        kind: "markdown",
        title: "S7 Artifact",
        content: "x".repeat(200_000),
        sha256: "c".repeat(64),
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      artifactSchema.safeParse({
        schemaVersion: "artifact.v1",
        artifactId: "art_s7capacity1",
        productRunId: "run_s7capacity1",
        kind: "markdown",
        title: "S7 Artifact",
        content: "x".repeat(200_001),
        sha256: "c".repeat(64),
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it("Store open/transact与Run View/Node Detail在脱敏样本预算内", async () => {
    const terminal = S7_VERSIONED_FIXTURE_MANIFEST.find(
      (entry) => entry.workload === "note_capture" && entry.lifecycle === "terminal",
    );
    if (terminal === undefined) throw new Error("S7 manifest缺少Note终态");
    const snapshot = migrateS7FixtureToCurrent(await buildS7VersionedFixture(terminal));
    const directory = await mkdtemp(join(tmpdir(), "chat-s7-capacity-"));
    const filePath = join(directory, "product.json");
    await writeFile(filePath, JSON.stringify(snapshot));

    const openSamples: number[] = [];
    let store: JsonProductStore | undefined;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const started = performance.now();
      store = await JsonProductStore.open({ filePath, now: () => NOW });
      openSamples.push(performance.now() - started);
    }
    if (store === undefined) throw new Error("Store未打开");

    const transactSamples: number[] = [];
    for (let index = 0; index < S7_CAPACITY_ACCEPTANCE.storeProbe.addedSessions; index += 1) {
      const sessionId = `psn_s7capacity${String(index + 1)}`;
      const commandId = `cmd_s7capacity${String(index + 1)}`;
      const started = performance.now();
      await store.transact({
        commandId: commandId as never,
        commandType: "CreateProductSession",
        requestSha256: hashCanonical("s7-capacity-session.v1", { sessionId }),
        mutate: (draft) => {
          draft.entities.sessions[sessionId] = {
            schemaVersion: "product-session.v1",
            sessionId: sessionId as never,
            ownerPrincipalId: "usr_s7capacity" as never,
            status: "active",
            lastMessageSequence: 0,
            revision: 1,
            createdAt: NOW,
            updatedAt: NOW,
          };
          return { resultRefs: { sessionId } };
        },
      });
      transactSamples.push(performance.now() - started);
    }

    const deps: ApplicationDeps = { store, now: () => NOW, ids: throwingIds() };
    const run = Object.values(snapshot.entities.runs)[0];
    const node = Object.values(snapshot.entities.workflowNodeRuns)[0];
    const session = run === undefined ? undefined : snapshot.entities.sessions[run.sessionId];
    if (run === undefined || node === undefined || session === undefined) {
      throw new Error("S7容量Fixture缺少Run/Node/Session");
    }
    const viewSamples: number[] = [];
    const detailSamples: number[] = [];
    let view: Awaited<ReturnType<typeof getWorkflowRunView>> | undefined;
    let detail: Awaited<ReturnType<typeof getWorkflowNodeDetail>> | undefined;
    for (let iteration = 0; iteration < 30; iteration += 1) {
      let started = performance.now();
      view = await getWorkflowRunView(deps, {
        principalId: session.ownerPrincipalId,
        productRunId: run.productRunId,
      });
      viewSamples.push(performance.now() - started);
      started = performance.now();
      detail = await getWorkflowNodeDetail(deps, {
        principalId: session.ownerPrincipalId,
        productRunId: run.productRunId,
        workflowNodeRunId: node.workflowNodeRunId,
      });
      detailSamples.push(performance.now() - started);
    }
    if (view === undefined || detail === undefined) throw new Error("S7 Query未返回");
    const measured = {
      open: metrics(openSamples),
      transact: metrics(transactSamples),
      runView: metrics(viewSamples),
      nodeDetail: metrics(detailSamples),
      bytes: {
        sourceStore: Buffer.byteLength(await readFile(filePath), "utf8"),
        runView: byteLength(view.value),
        nodeDetail: byteLength(detail.value),
      },
    };
    expect(measured.open.p95).toBeLessThan(S7_CAPACITY_ACCEPTANCE.performanceMs.storeOpenP95);
    expect(measured.transact.p95).toBeLessThan(
      S7_CAPACITY_ACCEPTANCE.performanceMs.storeTransactP95,
    );
    expect(measured.runView.p95).toBeLessThan(S7_CAPACITY_ACCEPTANCE.performanceMs.runViewP95);
    expect(measured.nodeDetail.p95).toBeLessThan(
      S7_CAPACITY_ACCEPTANCE.performanceMs.nodeDetailP95,
    );
    expect(measured.bytes.runView).toBeLessThan(S7_CAPACITY_ACCEPTANCE.responseBytes.runView);
    expect(measured.bytes.nodeDetail).toBeLessThan(S7_CAPACITY_ACCEPTANCE.responseBytes.nodeDetail);

    const runViewLimit = {
      ...view.value,
      nodeRuns: Array.from({ length: 500 }, () => view!.value.nodeRuns[0]!),
    };
    expect(workflowRunViewDtoSchema.safeParse(runViewLimit).success).toBe(true);
    expect(
      workflowRunViewDtoSchema.safeParse({
        ...runViewLimit,
        nodeRuns: [...runViewLimit.nodeRuns, runViewLimit.nodeRuns[0]],
      }).success,
    ).toBe(false);
    const timelineItem = detail.value.timeline?.[0];
    if (timelineItem === undefined) throw new Error("S7 Node Detail缺少Timeline");
    const detailLimit = {
      ...detail.value,
      timeline: Array.from({ length: 500 }, () => timelineItem),
    };
    expect(workflowNodeDetailDtoSchema.safeParse(detailLimit).success).toBe(true);
    expect(
      workflowNodeDetailDtoSchema.safeParse({
        ...detailLimit,
        timeline: [...detailLimit.timeline, timelineItem],
      }).success,
    ).toBe(false);
    console.info(`[s7-capacity] runtime=${JSON.stringify(measured)}`);
  });

  it("Workflow耐久作用域只保留产品ref，不跨Step携带Planning/Note/Execution正文", async () => {
    const workflowSource = [
      await readFile(
        join(process.cwd(), "../workflows/src/configurable-planning-workflow.ts"),
        "utf8",
      ),
      await readFile(join(process.cwd(), "../workflows/src/note-capture-workflow.ts"), "utf8"),
    ].join("\n");
    const forbiddenDurableBodyPaths = [
      "sourceMessageText",
      "prepared.sourceText",
      "contentMarkdown",
      "contextItems",
      "dependency.output",
      "dependency.sections",
      "candidate.output",
      "candidate.sections",
      "finalOutput",
    ];
    expect(
      forbiddenDurableBodyPaths.filter((token) => workflowSource.includes(token)),
      "正文必须在单一Step内load→model→persist；Workflow Checkpoint只能保存产品ref/outcome/identity",
    ).toEqual([]);

    const bundle = [
      await readFile(join(process.cwd(), "../workflows/.workflow-bundle/workflows.mjs"), "utf8"),
      await readFile(join(process.cwd(), "../workflows/.workflow-bundle/steps.mjs"), "utf8"),
    ].join("\n");
    expect(bundle).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/u);
    expect(bundle).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/u);
  });
});
