import { describe, expect, it } from "vitest";
import {
  changeWorkflowDefinitionArchiveStatusPayloadSchema,
  createWorkflowDefinitionCopyPayloadSchema,
  saveWorkflowDefinitionDraftPayloadSchema,
  validateWorkflowDefinitionPayloadSchema,
  workflowDefinitionDetailDtoSchema,
  workflowDefinitionValidationDtoSchema,
  workflowDesignerOperationSchema,
  workflowDesignerSlotDtoSchema,
} from "./workflow-designer-api.js";

const HASH = "a".repeat(64);
const NOW = "2026-08-10T00:00:00.000Z";
const ROOT = {
  kind: "sequence" as const,
  elements: [
    {
      kind: "task" as const,
      definitionNodeId: "note.extract",
      nodeType: "note.extract" as const,
      schemaVersion: 1,
      config: { maxCharacters: 4_000 },
    },
    {
      kind: "task" as const,
      definitionNodeId: "note.classify",
      nodeType: "note.classify" as const,
      schemaVersion: 1,
      config: { allowCustomTags: true },
    },
    {
      kind: "task" as const,
      definitionNodeId: "note.commit",
      nodeType: "note.commit" as const,
      schemaVersion: 1,
      config: {},
    },
  ],
};

describe("Workflow Designer公开合同", () => {
  it("editable detail只携带semanticRoot/slot和产品版本，不接受坐标、edge或Executor", () => {
    const detail = workflowDefinitionDetailDtoSchema.parse({
      schemaVersion: "chat-product-api.v1",
      workflowDefinitionId: "wfd_noteuser",
      ownerKind: "principal",
      ownerPrincipalId: "usr_owner",
      key: "user.note",
      title: "我的笔记流程",
      description: "受约束笔记捕获",
      blueprintKey: "note",
      blueprintVersion: 1,
      status: "active",
      revision: 2,
      publishedRevision: revisionSummary("wfr_notepublished", "published"),
      currentDraftRevision: revisionSummary("wfr_notedraft", "draft"),
      slots: [slotFixture()],
      allowedChoiceSourceTypes: ["note.classify"],
      createdAt: NOW,
      updatedAt: NOW,
      compatibility: "editable",
      semanticRoot: ROOT,
      baseRevisionId: "wfr_notedraft",
      baseDefinitionSha256: HASH,
      allowedActions: ["save", "validate", "publish"],
    });
    expect(detail.compatibility).toBe("editable");
    expect(() =>
      workflowDefinitionDetailDtoSchema.parse({ ...detail, positions: {}, edges: [] }),
    ).toThrow();
    expect(() =>
      workflowDefinitionDetailDtoSchema.parse({ ...detail, executorKey: "execute-anything" }),
    ).toThrow();
  });

  it("不兼容Definition只有安全结构摘要，不能偷偷携带semanticRoot", () => {
    const detail = workflowDefinitionDetailDtoSchema.parse({
      schemaVersion: "chat-product-api.v1",
      workflowDefinitionId: "wfd_future",
      ownerKind: "system",
      key: "system.future",
      title: "未来流程",
      description: "当前客户端只读",
      blueprintKey: "planning",
      blueprintVersion: 2,
      status: "active",
      revision: 1,
      publishedRevision: revisionSummary("wfr_future", "published"),
      slots: [],
      allowedChoiceSourceTypes: [],
      createdAt: NOW,
      updatedAt: NOW,
      compatibility: "read_only_incompatible",
      safeStructureSummary: { nodeCount: 4, nodeTypes: ["agent.plan", "product.commit"] },
      incompatibilityCode: "catalog.client_upgrade_required",
      allowedActions: [],
    });
    expect(detail.compatibility).toBe("read_only_incompatible");
    expect(() =>
      workflowDefinitionDetailDtoSchema.parse({ ...detail, semanticRoot: ROOT }),
    ).toThrow();
  });

  it("slot地址strict且拒绝非法范围和自由连接信息", () => {
    expect(workflowDesignerSlotDtoSchema.parse(slotFixture())).toMatchObject({
      slotId: "note.review",
      minimumIndex: 2,
    });
    expect(() =>
      workflowDesignerSlotDtoSchema.parse({ ...slotFixture(), minimumIndex: 3, maximumIndex: 2 }),
    ).toThrow();
    expect(() =>
      workflowDesignerSlotDtoSchema.parse({ ...slotFixture(), edgeHandle: "x" }),
    ).toThrow();
  });

  it("结构operation只接受枚举Choice/BoundedLoop动作，拒绝自由edge、表达式和任意对象配置", () => {
    expect(
      workflowDesignerOperationSchema.parse({
        kind: "wrap_in_choice",
        fromDefinitionNodeId: "note.classify",
      }),
    ).toBeDefined();
    expect(
      workflowDesignerOperationSchema.parse({
        kind: "move_into_branch",
        target: { definitionNodeId: "note.review" },
        fromDefinitionNodeId: "note.classify",
        outcome: "needs_review",
        index: 0,
      }),
    ).toBeDefined();
    expect(
      workflowDesignerOperationSchema.parse({
        kind: "wrap_in_bounded_loop",
        address: [],
        startIndex: 0,
        endIndexExclusive: 2,
        outcomeFromDefinitionNodeId: "note.review",
        maxIterations: 2,
        exceededPolicy: "request_human",
      }),
    ).toBeDefined();
    expect(() =>
      workflowDesignerOperationSchema.parse({
        kind: "wrap_in_choice",
        fromDefinitionNodeId: "note.classify",
        expression: "payload.admin === true",
      }),
    ).toThrow();
    expect(() =>
      workflowDesignerOperationSchema.parse({
        kind: "move_into_branch",
        target: { definitionNodeId: "note.review" },
        fromDefinitionNodeId: "note.classify",
        outcome: "needs_review",
        index: 0,
        edge: { source: "x", target: "y" },
      }),
    ).toThrow();
    expect(() =>
      workflowDesignerOperationSchema.parse({
        kind: "update_node_config",
        target: { definitionNodeId: "note.extract" },
        fieldName: "maxCharacters",
        value: { arbitrary: true },
      }),
    ).toThrow();
  });

  it("copy/save/validate/archive payload绑定精确Revision与Hash并strict拒绝Runtime字段", () => {
    const copy = {
      sourceWorkflowDefinitionRevisionId: "wfr_source",
      sourceDefinitionSha256: HASH,
      title: "副本",
      description: "说明",
    };
    expect(createWorkflowDefinitionCopyPayloadSchema.parse(copy)).toEqual(copy);
    expect(
      saveWorkflowDefinitionDraftPayloadSchema.parse({
        baseRevisionId: "wfr_source",
        baseDefinitionSha256: HASH,
        semanticRoot: ROOT,
      }),
    ).toBeDefined();
    expect(
      validateWorkflowDefinitionPayloadSchema.parse({
        baseRevisionId: "wfr_source",
        baseDefinitionSha256: HASH,
        blueprintKey: "note",
        blueprintVersion: 1,
        semanticRoot: ROOT,
      }),
    ).toBeDefined();
    expect(
      changeWorkflowDefinitionArchiveStatusPayloadSchema.parse({
        targetStatus: "archived",
        publishedRevisionId: "wfr_source",
        publishedDefinitionSha256: HASH,
      }),
    ).toBeDefined();
    expect(() =>
      createWorkflowDefinitionCopyPayloadSchema.parse({ ...copy, workflowRunId: "private" }),
    ).toThrow();
  });

  it("validation valid/normalized/error诊断组合不能自相矛盾", () => {
    const valid = workflowDefinitionValidationDtoSchema.parse({
      schemaVersion: "chat-workflow-designer-api.v2",
      valid: true,
      diagnostics: [],
      normalized: { semanticRoot: ROOT, definitionSha256: HASH, nodeCount: 3 },
    });
    expect(valid.valid).toBe(true);
    expect(() =>
      workflowDefinitionValidationDtoSchema.parse({
        schemaVersion: "chat-product-api.v1",
        valid: true,
        diagnostics: [],
      }),
    ).toThrow();
    expect(() =>
      workflowDefinitionValidationDtoSchema.parse({
        schemaVersion: "chat-product-api.v1",
        valid: true,
        normalized: { semanticRoot: ROOT, definitionSha256: HASH, nodeCount: 3 },
        diagnostics: [
          {
            family: "policy_denied",
            code: "policy.node_cannot_skip",
            path: "$.elements[0]",
            severity: "error",
            params: {},
          },
        ],
      }),
    ).toThrow();
  });
});

function revisionSummary(id: string, state: "draft" | "published" | "superseded") {
  return {
    workflowDefinitionRevisionId: id,
    definitionRevision: state === "draft" ? 2 : 1,
    state,
    definitionSha256: HASH,
    createdAt: NOW,
    ...(state === "published" ? { publishedAt: NOW } : {}),
  };
}

function slotFixture() {
  return {
    slotId: "note.review",
    address: [],
    label: "审核位置",
    allowedNodeTypes: ["human.note_review"],
    minimumIndex: 2,
    maximumIndex: 2,
    maximumElements: 4,
  };
}
