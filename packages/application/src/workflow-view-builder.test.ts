import { describe, expect, it } from "vitest";
import { normalizeWorkflowDefinition } from "./workflow-definition-normalize.js";
import { DEFAULT_NODE_CATALOG } from "./workflow-node-catalog.js";
import { createPublishedWorkflowView } from "./workflow-view-builder.js";
import { NOTE_CHOICE_ROOT, PLANNING_MIXED_ROOT } from "./workflow-kernel-fixtures.js";

const NOW = "2026-08-10T00:00:00.000Z";

function revision(root: typeof NOTE_CHOICE_ROOT, blueprintKey: "note" | "planning") {
  const normalized = normalizeWorkflowDefinition(root, DEFAULT_NODE_CATALOG);
  if (!normalized.success) throw new Error("fixture invalid");
  return {
    schemaVersion: "workflow-definition-revision.v3" as const,
    workflowDefinitionRevisionId: "wfr_viewbuilder1" as never,
    workflowDefinitionId: "wfd_viewbuilder1" as never,
    definitionRevision: 1,
    state: "published" as const,
    blueprintKey,
    blueprintVersion: 1,
    title: "测试工作流",
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1 as const,
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
  };
}

describe("published workflow view builder", () => {
  it("Choice投影为outcome边且空分支继续到提交节点", () => {
    const view = createPublishedWorkflowView({
      revision: revision(NOTE_CHOICE_ROOT, "note"),
      createdAt: NOW,
    });
    expect(view.nodes.map((node) => node.definitionNodeId)).toEqual([
      "note.extract",
      "note.classify",
      "note.review",
      "note.commit",
    ]);
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "note.classify",
          to: "note.review",
          kind: "outcome",
          outcomeCode: "needs_review",
        }),
        expect.objectContaining({
          from: "note.classify",
          to: "note.commit",
          kind: "outcome",
          outcomeCode: "classified",
        }),
        expect.objectContaining({ from: "note.review", to: "note.commit", kind: "control" }),
      ]),
    );
  });

  it("BoundedLoop投影回边，只让approved继续执行", () => {
    const view = createPublishedWorkflowView({
      revision: revision(PLANNING_MIXED_ROOT as typeof NOTE_CHOICE_ROOT, "planning"),
      createdAt: NOW,
    });
    expect(view.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "planning.review",
          to: "planning.plan",
          kind: "loop_back",
          outcomeCode: "request_revision",
        }),
        expect.objectContaining({
          from: "planning.review",
          to: "planning.execute",
          kind: "outcome",
          outcomeCode: "approved",
        }),
      ]),
    );
    expect(view.edges).not.toContainEqual(
      expect.objectContaining({
        from: "planning.review",
        to: "planning.execute",
        outcomeCode: "rejected",
      }),
    );
  });

  it("相同Revision生成相同ID与Hash", () => {
    const input = { revision: revision(NOTE_CHOICE_ROOT, "note"), createdAt: NOW };
    expect(createPublishedWorkflowView(input)).toEqual(createPublishedWorkflowView(input));
  });
});
