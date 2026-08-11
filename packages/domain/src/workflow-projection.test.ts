import { describe, expect, it } from "vitest";
import {
  LEGACY_PLANNING_VIEW_ID,
  assertWorkflowViewDefinition,
  computeWorkflowViewDefinitionSha256,
  createLegacyPlanningWorkflowView,
} from "./workflow-view.js";
import {
  assertWorkflowNodeRunTimestamps,
  createNodeValueManifest,
  createWorkflowNodeRun,
  transitionWorkflowNodeRun,
  workflowNodeRunIdentityKey,
  type NodeProductRefShape,
  type NodeRunTransitionShape,
  type WorkflowNodeRunShape,
  type WorkflowNodeRunStatusShape,
} from "./workflow-node-run.js";

const CREATED_AT = "2026-08-10T00:00:00.000Z";
const STARTED_AT = "2026-08-10T00:00:01.000Z";
const FINISHED_AT = "2026-08-10T00:00:03.000Z";

const approvalRef: NodeProductRefShape = {
  kind: "approval_request",
  id: "apr_1",
  revision: 1,
  sha256: "a".repeat(64),
  label: "审核",
};
const decisionRef: NodeProductRefShape = {
  kind: "decision",
  id: "dec_1",
  revision: 1,
  sha256: "b".repeat(64),
  label: "决定",
};

describe("Workflow View domain", () => {
  it("legacy Planning Factory由精确六节点golden固定，时间不进入语义Hash", () => {
    const first = createLegacyPlanningWorkflowView(CREATED_AT);
    const later = createLegacyPlanningWorkflowView(FINISHED_AT);

    expect(first.workflowViewDefinitionId).toBe(LEGACY_PLANNING_VIEW_ID);
    expect(
      first.nodes.map(({ definitionNodeId, nodeType, kind, optional }) => ({
        definitionNodeId,
        nodeType,
        kind,
        optional,
      })),
    ).toEqual([
      { definitionNodeId: "context", nodeType: "context.compile", kind: "task", optional: false },
      { definitionNodeId: "plan", nodeType: "agent.plan", kind: "task", optional: false },
      {
        definitionNodeId: "review",
        nodeType: "human.plan_review",
        kind: "human_review",
        optional: false,
      },
      {
        definitionNodeId: "execute",
        nodeType: "execute.plan",
        kind: "composite",
        optional: false,
      },
      { definitionNodeId: "validate", nodeType: "result.validate", kind: "task", optional: false },
      {
        definitionNodeId: "commit",
        nodeType: "product.commit",
        kind: "product_commit",
        optional: false,
      },
    ]);
    expect(first.edges).toEqual([
      { from: "context", to: "plan", kind: "control" },
      { from: "plan", to: "review", kind: "control" },
      { from: "review", to: "plan", kind: "loop_back", outcomeCode: "request_revision" },
      { from: "review", to: "execute", kind: "outcome", outcomeCode: "approve" },
      { from: "execute", to: "validate", kind: "control" },
      { from: "validate", to: "commit", kind: "control" },
    ]);
    expect(first.sha256).toBe("9b99e2b5f36c2294e281e4618ed3244f9316a1ccc66e7a82e0d21a576e13e3a3");
    expect(later.sha256).toBe(first.sha256);
    expect(() => assertWorkflowViewDefinition(first)).not.toThrow();
  });

  it("Canonical Hash忽略对象字段插入顺序，但覆盖每个语义字段", () => {
    const view = createLegacyPlanningWorkflowView(CREATED_AT);
    if (view.source.kind !== "legacy_code") throw new Error("legacy Factory返回了错误source");
    const reordered = {
      edges: view.edges.map((edge) => ({
        ...(edge.outcomeCode === undefined ? {} : { outcomeCode: edge.outcomeCode }),
        kind: edge.kind,
        to: edge.to,
        from: edge.from,
      })),
      nodes: view.nodes.map((node) => ({
        optional: node.optional,
        kind: node.kind,
        title: node.title,
        nodeSchemaVersion: node.nodeSchemaVersion,
        nodeType: node.nodeType,
        definitionNodeId: node.definitionNodeId,
      })),
      source: {
        blueprintVersion: view.source.blueprintVersion,
        blueprintKey: view.source.blueprintKey,
        kind: view.source.kind,
      },
      title: view.title,
    };
    expect(computeWorkflowViewDefinitionSha256(reordered)).toBe(view.sha256);
    expect(computeWorkflowViewDefinitionSha256({ ...view, title: `${view.title}更改` })).not.toBe(
      view.sha256,
    );
    expect(
      computeWorkflowViewDefinitionSha256({
        ...view,
        nodes: view.nodes.map((node) =>
          node.definitionNodeId === "plan" ? { ...node, optional: true } : node,
        ),
      }),
    ).not.toBe(view.sha256);
  });

  it("拒绝重复节点、悬空/重复边、非法父子环和不可达分量", () => {
    const base = createLegacyPlanningWorkflowView(CREATED_AT);
    const withHash = (candidate: typeof base): typeof base => ({
      ...candidate,
      sha256: computeWorkflowViewDefinitionSha256(candidate),
    });

    expect(() =>
      assertWorkflowViewDefinition(
        withHash({ ...base, nodes: [...base.nodes, { ...base.nodes[0]! }] }),
      ),
    ).toThrow(/重复节点/u);
    expect(() =>
      assertWorkflowViewDefinition(
        withHash({
          ...base,
          edges: [...base.edges, { from: "context", to: "missing", kind: "control" }],
        }),
      ),
    ).toThrow(/端点悬空/u);
    expect(() =>
      assertWorkflowViewDefinition(withHash({ ...base, edges: [...base.edges, base.edges[0]!] })),
    ).toThrow(/重复边/u);

    const disconnectedNode = {
      definitionNodeId: "orphan",
      nodeType: "test.orphan",
      nodeSchemaVersion: "1",
      title: "孤立循环",
      kind: "task" as const,
      optional: false,
    };
    expect(() =>
      assertWorkflowViewDefinition(
        withHash({
          ...base,
          nodes: [...base.nodes, disconnectedNode],
          edges: [...base.edges, { from: "orphan", to: "orphan", kind: "control" }],
        }),
      ),
    ).toThrow(/不可达/u);

    const child = { ...disconnectedNode, parentDefinitionNodeId: "plan" };
    expect(() =>
      assertWorkflowViewDefinition(withHash({ ...base, nodes: [...base.nodes, child] })),
    ).toThrow(/父子结构非法/u);
  });

  it("Factory不向调用方泄漏模块级可变引用", () => {
    const first = createLegacyPlanningWorkflowView(CREATED_AT);
    (first.nodes as Array<(typeof first.nodes)[number]>)[0] = {
      ...first.nodes[0]!,
      title: "被调用方篡改",
    };
    const second = createLegacyPlanningWorkflowView(CREATED_AT);
    expect(second.nodes[0]?.title).toBe("整理上下文");
    expect(second.sha256).not.toBe(computeWorkflowViewDefinitionSha256(first));
  });

  it("序列化快照不含Runtime私有身份或执行函数名", () => {
    const serialized = JSON.stringify(createLegacyPlanningWorkflowView(CREATED_AT)).toLowerCase();
    for (const forbidden of [
      "workflowrunid",
      "hooktoken",
      "sessionid",
      "executorkey",
      "handlername",
      "runstep",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

const baseNode = (status: WorkflowNodeRunStatusShape): WorkflowNodeRunShape => ({
  schemaVersion: "workflow-node-run.v1",
  workflowNodeRunId: "wnr_1",
  productRunId: "run_1",
  workflowViewDefinitionId: LEGACY_PLANNING_VIEW_ID,
  definitionNodeId: "execute",
  nodeType: "execute.plan",
  nodeSchemaVersion: "1",
  executionPath: [],
  attemptNumber: 1,
  status,
  projectionSource: "runtime",
  ...(status === "running" || status === "waiting_human" ? { startedAt: STARTED_AT } : {}),
  ...(["succeeded", "failed", "skipped", "cancelled", "outcome_unknown"].includes(status)
    ? { finishedAt: FINISHED_AT }
    : {}),
  revision: 1,
  createdAt: CREATED_AT,
  updatedAt: FINISHED_AT,
});

const expectedTransitions: Record<
  WorkflowNodeRunStatusShape,
  readonly WorkflowNodeRunStatusShape[]
> = {
  queued: ["running", "skipped", "failed", "cancelled"],
  running: ["waiting_human", "succeeded", "failed", "cancelled", "outcome_unknown"],
  waiting_human: ["running", "succeeded", "failed", "cancelled"],
  outcome_unknown: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

const reasonFor = (
  from: WorkflowNodeRunStatusShape,
  to: WorkflowNodeRunStatusShape,
): NodeRunTransitionShape["reasonKind"] => {
  if (to === "running") return from === "waiting_human" ? "resumed" : "started";
  if (to === "waiting_human") return "waiting_human";
  if (to === "succeeded") return "completed";
  if (to === "failed") return "failed";
  if (to === "skipped") return "skipped";
  if (to === "cancelled") return "cancelled";
  return "outcome_unknown";
};

const relatedRefFor = (
  from: WorkflowNodeRunStatusShape,
  to: WorkflowNodeRunStatusShape,
): NodeProductRefShape | undefined => {
  if (to === "waiting_human") return approvalRef;
  if (from === "waiting_human" && (to === "running" || to === "succeeded")) return decisionRef;
  return undefined;
};

describe("Workflow Node Run domain", () => {
  it("状态机表驱动覆盖全部允许/禁止转换，终态不可重开", () => {
    const statuses = Object.keys(expectedTransitions) as WorkflowNodeRunStatusShape[];
    for (const from of statuses) {
      for (const to of statuses) {
        const relatedProductRef = relatedRefFor(from, to);
        const action = () =>
          transitionWorkflowNodeRun(baseNode(from), {
            transitionId: `wnt_${from}_${to}`,
            nodeSequence: 2,
            toStatus: to,
            reasonKind: reasonFor(from, to),
            at: "2026-08-10T00:00:04.000Z",
            ...(relatedProductRef === undefined ? {} : { relatedProductRef }),
          });
        if (expectedTransitions[from].includes(to)) expect(action, `${from}->${to}`).not.toThrow();
        else expect(action, `${from}->${to}`).toThrow(/不允许/u);
      }
    }
  });

  it("人工等待/恢复要求精确产品证据，状态与reason不能错配", () => {
    expect(() =>
      transitionWorkflowNodeRun(baseNode("running"), {
        transitionId: "wnt_wait1",
        nodeSequence: 2,
        toStatus: "waiting_human",
        reasonKind: "waiting_human",
        at: FINISHED_AT,
      }),
    ).toThrow(/Approval Request/u);
    expect(() =>
      transitionWorkflowNodeRun(baseNode("waiting_human"), {
        transitionId: "wnt_resume1",
        nodeSequence: 2,
        toStatus: "running",
        reasonKind: "resumed",
        at: FINISHED_AT,
        relatedProductRef: approvalRef,
      }),
    ).toThrow(/Decision/u);
    expect(() =>
      transitionWorkflowNodeRun(baseNode("running"), {
        transitionId: "wnt_reason1",
        nodeSequence: 2,
        toStatus: "succeeded",
        reasonKind: "failed",
        at: FINISHED_AT,
      }),
    ).toThrow(/reason/u);
  });

  it("outcome_unknown只用于外部执行边界，普通失败不能借此绕过", () => {
    expect(() =>
      transitionWorkflowNodeRun(
        { ...baseNode("running"), definitionNodeId: "plan", nodeType: "agent.plan" },
        {
          transitionId: "wnt_unknown1",
          nodeSequence: 2,
          toStatus: "outcome_unknown",
          reasonKind: "outcome_unknown",
          at: FINISHED_AT,
        },
      ),
    ).toThrow(/外部执行节点/u);
  });

  it("创建、Manifest和身份Hash确定性且不保留可变输入引用", () => {
    const created = createWorkflowNodeRun({
      nodeRun: {
        workflowNodeRunId: "wnr_create1",
        productRunId: "run_1",
        workflowViewDefinitionId: LEGACY_PLANNING_VIEW_ID,
        definitionNodeId: "plan",
        nodeType: "agent.plan",
        nodeSchemaVersion: "1",
        executionPath: [{ containerNodeId: "review_loop", iteration: 2 }],
        attemptNumber: 1,
      },
      transitionId: "wnt_create1",
      at: CREATED_AT,
      projectionSource: "runtime",
    });
    expect(created.nodeRun.status).toBe("queued");
    expect(created.transition).toMatchObject({ nodeSequence: 1, toStatus: "queued" });

    const manifestInput = {
      nodeValueManifestId: "wvm_create1",
      workflowNodeRunId: created.nodeRun.workflowNodeRunId,
      direction: "input" as const,
      slots: [{ name: "source", refs: [decisionRef] }],
      at: CREATED_AT,
    };
    const manifest = createNodeValueManifest(manifestInput);
    manifestInput.slots[0]!.refs[0] = approvalRef;
    expect(manifest.slots[0]?.refs[0]?.kind).toBe("decision");
    expect(createNodeValueManifest({ ...manifestInput, slots: manifest.slots }).sha256).toBe(
      manifest.sha256,
    );

    const identity = workflowNodeRunIdentityKey(created.nodeRun);
    expect(
      workflowNodeRunIdentityKey({
        attemptNumber: 1,
        executionPath: [{ iteration: 2, containerNodeId: "review_loop" }],
        definitionNodeId: "plan",
        productRunId: "run_1",
      }),
    ).toBe(identity);
    expect(workflowNodeRunIdentityKey({ ...created.nodeRun, attemptNumber: 2 })).not.toBe(identity);
    expect(
      workflowNodeRunIdentityKey({
        ...created.nodeRun,
        executionPath: [{ containerNodeId: "review_loop", iteration: 3 }],
      }),
    ).not.toBe(identity);
  });

  it("时间完整性校验终态、倒序和duration精确关系", () => {
    const valid = {
      ...baseNode("succeeded"),
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      durationMs: 2_000,
    };
    expect(() => assertWorkflowNodeRunTimestamps(valid)).not.toThrow();
    expect(() => assertWorkflowNodeRunTimestamps({ ...valid, finishedAt: undefined })).toThrow(
      /终态时间/u,
    );
    expect(() =>
      assertWorkflowNodeRunTimestamps({ ...valid, startedAt: FINISHED_AT, finishedAt: STARTED_AT }),
    ).toThrow(/倒序/u);
    expect(() => assertWorkflowNodeRunTimestamps({ ...valid, durationMs: 1 })).toThrow(/耗时/u);
  });
});
