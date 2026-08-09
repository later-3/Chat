import { describe, expect, it } from "vitest";
import type { WorkflowCatalogDto, WorkflowDesignerSlotDto } from "@chat/contracts/public";
import {
  applyWorkflowDesignerOperation,
  type WorkflowDesignerOperationPolicyShape,
} from "@chat/domain";
import {
  applyDesignerOperation,
  quickDesignerDiagnostics,
  reapplyDesignerOperations,
  type DesignerOperation,
  type DesignerOperationContext,
} from "./structure-operations.js";
import {
  applyHistoryOperation,
  createDesignerHistory,
  designerWorkingCopyKey,
  isDesignerHistoryDirty,
  readDesignerWorkingCopy,
  redoDesignerHistory,
  undoDesignerHistory,
  writeDesignerWorkingCopy,
} from "./working-copy.js";
import type { EditableWorkflowDefinitionDetail, WorkflowDefinitionSequence } from "./types.js";

const ROOT: WorkflowDefinitionSequence = {
  kind: "sequence",
  elements: [
    {
      kind: "task",
      definitionNodeId: "planning.memory",
      nodeType: "context.memory",
      schemaVersion: 1,
      config: {},
      defaultActivation: "enabled",
    },
    {
      kind: "bounded_loop",
      body: {
        kind: "sequence",
        elements: [
          {
            kind: "task",
            definitionNodeId: "planning.plan",
            nodeType: "agent.plan",
            schemaVersion: 1,
            config: { maxSteps: 8 },
          },
          {
            kind: "task",
            definitionNodeId: "planning.review",
            nodeType: "human.plan_review",
            schemaVersion: 1,
            config: { reviewMode: "manual" },
          },
        ],
      },
      outcomeFromDefinitionNodeId: "planning.review",
      continueOutcomes: ["request_revision"],
      exitOutcomes: ["approved", "rejected"],
      maxIterations: 5,
      exceededPolicy: "fail",
    },
  ],
};

const CATALOG: WorkflowCatalogDto["nodes"] = [
  {
    nodeType: "context.memory",
    schemaVersion: 1,
    displayName: "读取记忆",
    description: "读取选择的记忆",
    category: "context",
    executorKind: "step",
    riskPolicy: "read_context",
    canDefaultSkip: true,
    supportedBlueprints: ["planning"],
    publicConfigFields: [],
    outcomes: ["success", "optional_unavailable", "required_unavailable"],
  },
  {
    nodeType: "agent.research",
    schemaVersion: 1,
    displayName: "调研",
    description: "整理证据",
    category: "agent",
    executorKind: "step",
    riskPolicy: "generate_candidate",
    canDefaultSkip: true,
    supportedBlueprints: ["planning"],
    publicConfigFields: [
      {
        type: "bounded_integer",
        name: "maxSources",
        label: "最多来源",
        defaultValue: 8,
        minimum: 1,
        maximum: 20,
      },
    ],
    outcomes: ["researched", "no_evidence"],
  },
  {
    nodeType: "agent.plan",
    schemaVersion: 1,
    displayName: "生成计划",
    description: "生成候选计划",
    category: "agent",
    executorKind: "step",
    riskPolicy: "generate_candidate",
    canDefaultSkip: false,
    supportedBlueprints: ["planning"],
    publicConfigFields: [],
    outcomes: ["planned", "needs_input"],
  },
  {
    nodeType: "human.plan_review",
    schemaVersion: 1,
    displayName: "人工审核",
    description: "等待决定",
    category: "human",
    executorKind: "human_review",
    riskPolicy: "human_decision",
    canDefaultSkip: false,
    supportedBlueprints: ["planning"],
    publicConfigFields: [],
    outcomes: ["approved", "request_revision", "rejected"],
  },
];

const rootSlot: WorkflowDesignerSlotDto = {
  slotId: "planning.root.optional",
  address: [],
  label: "规划输入",
  allowedNodeTypes: ["context.memory", "agent.research"],
  minimumIndex: 0,
  maximumIndex: 1,
  maximumElements: 4,
};

const context: DesignerOperationContext = {
  slots: [rootSlot],
  catalog: CATALOG,
  optionalNodeTypes: new Set(["context.memory", "agent.research"]),
  allowedChoiceSourceTypes: ["human.plan_review"],
  loopRules: [
    {
      outcomeNodeType: "human.plan_review",
      continueOutcomes: ["request_revision"],
      exitOutcomes: ["approved", "rejected"],
      maxIterations: 5,
    },
  ],
};

function editableDetail(): EditableWorkflowDefinitionDetail {
  return {
    schemaVersion: "chat-product-api.v1",
    workflowDefinitionId: "wfd_designer1" as never,
    ownerKind: "principal",
    ownerPrincipalId: "usr_debug" as never,
    key: "user.planning",
    title: "我的规划",
    description: "受约束规划",
    blueprintKey: "planning",
    blueprintVersion: 1,
    status: "active",
    revision: 2,
    slots: [rootSlot],
    allowedChoiceSourceTypes: ["human.plan_review"],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    compatibility: "editable",
    semanticRoot: ROOT,
    baseRevisionId: "wfr_designer1" as never,
    baseDefinitionSha256: "a".repeat(64) as never,
    allowedActions: ["copy", "save", "validate", "publish", "archive"],
  };
}

describe("Workflow Designer语义操作", () => {
  it("只允许服务端slot内插入，并拒绝删除Blueprint必需节点", () => {
    const inserted = applyDesignerOperation(
      ROOT,
      {
        kind: "insert_task",
        slotId: rootSlot.slotId,
        index: 1,
        nodeType: "agent.research",
        definitionNodeId: "planning.research.user1",
      },
      context,
    );
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.semanticRoot.elements[1]).toMatchObject({
      kind: "task",
      nodeType: "agent.research",
      defaultActivation: "enabled",
      config: { maxSources: 8 },
    });

    expect(
      applyDesignerOperation(
        ROOT,
        { kind: "remove_optional_task", target: { definitionNodeId: "planning.review" } },
        context,
      ),
    ).toEqual({ ok: false, code: "required_node_change_denied" });
    expect(
      applyDesignerOperation(
        ROOT,
        {
          kind: "insert_task",
          slotId: rootSlot.slotId,
          index: 2,
          nodeType: "agent.research",
          definitionNodeId: "planning.research.user2",
        },
        context,
      ),
    ).toEqual({ ok: false, code: "slot_index_denied" });
  });

  it("BoundedLoop只能在上限内修改，operation log可在新base顺序重放", () => {
    const updated = applyDesignerOperation(
      ROOT,
      {
        kind: "update_loop_policy",
        outcomeFromDefinitionNodeId: "planning.review",
        maxIterations: 2,
        exceededPolicy: "fail",
      },
      context,
    );
    expect(updated.ok).toBe(true);
    expect(
      applyDesignerOperation(
        ROOT,
        {
          kind: "update_loop_policy",
          outcomeFromDefinitionNodeId: "planning.review",
          maxIterations: 6,
          exceededPolicy: "fail",
        },
        context,
      ),
    ).toEqual({ ok: false, code: "operation_contract_invalid" });
    const replay = reapplyDesignerOperations(
      ROOT,
      [
        {
          kind: "set_default_activation",
          target: { definitionNodeId: "planning.memory" },
          activation: "skipped",
        },
      ],
      context,
    );
    expect(replay.ok).toBe(true);
    expect(replay.semanticRoot.elements[0]).toMatchObject({ defaultActivation: "skipped" });
  });

  it("Choice双分支与BoundedLoop包装/展开共用Domain结构语义", () => {
    const flattened = requireSuccess(
      applyDesignerOperation(
        ROOT,
        { kind: "unwrap_loop", outcomeFromDefinitionNodeId: "planning.review" },
        context,
      ),
    );
    const withChoice = requireSuccess(
      applyDesignerOperation(
        flattened,
        { kind: "wrap_in_choice", fromDefinitionNodeId: "planning.review" },
        context,
      ),
    );
    const choice = withChoice.elements[3];
    expect(choice).toMatchObject({
      kind: "choice",
      branches: [{ outcome: "approved" }, { outcome: "rejected" }, { outcome: "request_revision" }],
    });
    const branched = requireSuccess(
      applyDesignerOperation(
        withChoice,
        {
          kind: "move_into_branch",
          target: { definitionNodeId: "planning.memory" },
          fromDefinitionNodeId: "planning.review",
          outcome: "approved",
          index: 0,
        },
        context,
      ),
    );
    const rewrapped = requireSuccess(
      applyDesignerOperation(
        branched,
        {
          kind: "wrap_in_bounded_loop",
          address: [],
          startIndex: 0,
          endIndexExclusive: 3,
          outcomeFromDefinitionNodeId: "planning.review",
          maxIterations: 2,
          exceededPolicy: "request_human",
        },
        context,
      ),
    );
    expect(rewrapped.elements).toHaveLength(1);
    expect(rewrapped.elements[0]).toMatchObject({
      kind: "bounded_loop",
      maxIterations: 2,
      exceededPolicy: "request_human",
    });
  });

  it("浏览器预览与Domain对同一受限operation序列保持逐步conformance", () => {
    const operations: readonly DesignerOperation[] = [
      { kind: "unwrap_loop", outcomeFromDefinitionNodeId: "planning.review" },
      { kind: "wrap_in_choice", fromDefinitionNodeId: "planning.review" },
      {
        kind: "move_into_branch",
        target: { definitionNodeId: "planning.memory" },
        fromDefinitionNodeId: "planning.review",
        outcome: "approved",
        index: 0,
      },
      {
        kind: "wrap_in_bounded_loop",
        address: [],
        startIndex: 0,
        endIndexExclusive: 3,
        outcomeFromDefinitionNodeId: "planning.review",
        maxIterations: 2,
        exceededPolicy: "request_human",
      },
      {
        kind: "update_loop_policy",
        outcomeFromDefinitionNodeId: "planning.review",
        maxIterations: 1,
        exceededPolicy: "fail",
      },
    ];
    let browserRoot = ROOT;
    let domainRoot = ROOT;
    for (const operation of operations) {
      const browser = applyDesignerOperation(browserRoot, operation, context);
      const domain = applyWorkflowDesignerOperation(domainRoot, operation, domainPolicy());
      expect(browser.ok, operation.kind).toBe(domain.ok);
      if (!browser.ok) throw new Error(browser.code);
      if (!domain.ok) throw new Error(domain.code);
      expect(browser.semanticRoot, operation.kind).toEqual(domain.semanticRoot);
      browserRoot = browser.semanticRoot;
      domainRoot = domain.semanticRoot;
    }
  });

  it("浏览器与Domain对受限结构拒绝原因保持conformance", () => {
    const operations: readonly DesignerOperation[] = [
      { kind: "remove_optional_task", target: { definitionNodeId: "planning.review" } },
      {
        kind: "set_default_activation",
        target: { definitionNodeId: "planning.review" },
        activation: "skipped",
      },
      { kind: "wrap_in_choice", fromDefinitionNodeId: "planning.plan" },
      {
        kind: "wrap_in_bounded_loop",
        address: [],
        startIndex: 0,
        endIndexExclusive: 1,
        outcomeFromDefinitionNodeId: "planning.review",
        maxIterations: 2,
        exceededPolicy: "fail",
      },
      {
        kind: "update_loop_policy",
        outcomeFromDefinitionNodeId: "missing.review",
        maxIterations: 1,
        exceededPolicy: "fail",
      },
      {
        kind: "update_node_config",
        target: { definitionNodeId: "planning.plan" },
        fieldName: "unknownField",
        value: true,
      },
      {
        kind: "insert_task",
        slotId: rootSlot.slotId,
        index: 1,
        nodeType: "agent.research",
        definitionNodeId: "planning.memory",
      },
    ];
    for (const operation of operations) {
      const browser = applyDesignerOperation(ROOT, operation, context);
      const domain = applyWorkflowDesignerOperation(ROOT, operation, domainPolicy());
      expect(browser, operation.kind).toEqual(domain);
    }
  });

  it("undo/redo与localStorage按definition+baseHash隔离，坐标不进入草稿", () => {
    const detail = editableDetail();
    const initial = createDesignerHistory(detail);
    const changed = applyHistoryOperation(
      initial,
      {
        kind: "set_default_activation",
        target: { definitionNodeId: "planning.memory" },
        activation: "skipped",
      },
      context,
    );
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(isDesignerHistoryDirty(changed.history)).toBe(true);
    expect(isDesignerHistoryDirty(undoDesignerHistory(changed.history))).toBe(false);
    expect(
      redoDesignerHistory(undoDesignerHistory(changed.history)).present.elements[0],
    ).toMatchObject({ defaultActivation: "skipped" });

    const storage = new Map<string, string>();
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    };
    writeDesignerWorkingCopy(adapter, changed.history);
    const key = designerWorkingCopyKey(detail.workflowDefinitionId, detail.baseDefinitionSha256);
    expect(storage.get(key)).not.toContain("position");
    expect(readDesignerWorkingCopy(adapter, detail)?.operations).toHaveLength(1);
    expect(
      readDesignerWorkingCopy(adapter, {
        ...detail,
        baseDefinitionSha256: "b".repeat(64) as never,
      }),
    ).toBeNull();
  });

  it("重复definitionNodeId产生可定位本地诊断", () => {
    const duplicated = structuredClone(ROOT);
    const loop = duplicated.elements[1];
    if (loop?.kind !== "bounded_loop") throw new Error("fixture缺loop");
    const plan = loop.body.elements[0];
    if (plan?.kind !== "task") throw new Error("fixture缺plan");
    plan.definitionNodeId = "planning.memory";
    expect(quickDesignerDiagnostics(duplicated)).toEqual([
      expect.objectContaining({
        code: "definition.node_id_duplicate",
        path: expect.stringContaining("definitionNodeId"),
        severity: "error",
      }),
    ]);
  });
});

function requireSuccess(
  result: ReturnType<typeof applyDesignerOperation>,
): WorkflowDefinitionSequence {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.semanticRoot;
}

function domainPolicy(): WorkflowDesignerOperationPolicyShape {
  return {
    slots: context.slots,
    nodes: context.catalog.map((descriptor) => ({
      nodeType: descriptor.nodeType,
      schemaVersion: descriptor.schemaVersion,
      executorKind: descriptor.executorKind,
      defaultConfig: Object.fromEntries(
        descriptor.publicConfigFields.flatMap<[string, unknown]>((field) =>
          "defaultValue" in field
            ? [[field.name, field.defaultValue]]
            : field.type === "tag_list"
              ? [[field.name, []]]
              : [],
        ),
      ),
      publicConfigFields: descriptor.publicConfigFields,
      outcomes: descriptor.outcomes,
      skipPolicyKind: descriptor.canDefaultSkip ? "allowed_with_default_outcome" : "never",
    })),
    optionalNodeTypes: [...context.optionalNodeTypes],
    allowedChoiceSourceTypes: context.allowedChoiceSourceTypes,
    loopRules: context.loopRules,
  };
}
