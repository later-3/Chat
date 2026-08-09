import { describe, expect, it } from "vitest";
import {
  validateWorkflowStructure,
  workflowRiskAtLeast,
  type WorkflowNodeTypeKey,
  type WorkflowSequence,
  type WorkflowStructureLimits,
} from "./workflow-definition-kernel.js";

const outcomes: Readonly<Partial<Record<WorkflowNodeTypeKey, readonly string[]>>> = {
  "note.classify": ["classified", "needs_review"],
  "human.note_review": ["approved", "request_revision", "rejected"],
  "note.extract": ["extracted", "no_note"],
};
const lookup = {
  outcomesFor: (nodeType: WorkflowNodeTypeKey) => outcomes[nodeType],
};

const task = (definitionNodeId: string, nodeType: WorkflowNodeTypeKey = "note.extract") => ({
  kind: "task" as const,
  definitionNodeId,
  nodeType,
  schemaVersion: 1,
  config: {},
});

describe("Workflow Definition纯领域结构", () => {
  it("接受受支配的枚举Choice并计算确定预算", () => {
    const root: WorkflowSequence = {
      kind: "sequence",
      elements: [
        task("classify", "note.classify"),
        {
          kind: "choice",
          fromDefinitionNodeId: "classify",
          branches: [
            { outcome: "classified", body: { kind: "sequence", elements: [] } },
            {
              outcome: "needs_review",
              body: { kind: "sequence", elements: [task("review", "human.note_review")] },
            },
          ],
        },
      ],
    };
    expect(validateWorkflowStructure(root, lookup)).toEqual({
      facts: {
        nodeCount: 2,
        branchCount: 2,
        loopCount: 0,
        maxDepth: 4,
        maxLoopDepth: 0,
        maximumNodeExecutions: 2,
      },
      diagnostics: [],
    });
  });

  it("拒绝未来引用、兄弟分支引用、重复ID和漏outcome", () => {
    const root: WorkflowSequence = {
      kind: "sequence",
      elements: [
        {
          kind: "choice",
          fromDefinitionNodeId: "future",
          branches: [
            {
              outcome: "classified",
              body: { kind: "sequence", elements: [task("duplicate")] },
            },
          ],
        },
        task("future", "note.classify"),
        task("duplicate"),
      ],
    };
    const codes = validateWorkflowStructure(root, lookup).diagnostics.map((entry) => entry.code);
    expect(codes).toContain("definition.control_source_not_dominating");
    expect(codes).toContain("definition.outcome_partition_mismatch");
    expect(codes).toContain("definition.duplicate_node_id");
  });

  it("循环只接受body内最终outcome且检查上限、交集和最坏展开", () => {
    const root: WorkflowSequence = {
      kind: "sequence",
      elements: [
        {
          kind: "bounded_loop",
          body: {
            kind: "sequence",
            elements: [task("review", "human.note_review")],
          },
          outcomeFromDefinitionNodeId: "review",
          continueOutcomes: ["request_revision", "approved"],
          exitOutcomes: ["approved", "rejected"],
          maxIterations: 6,
          exceededPolicy: "fail",
        },
      ],
    };
    const result = validateWorkflowStructure(root, lookup);
    expect(result.facts.maximumNodeExecutions).toBe(6);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "definition.loop_iterations_invalid",
        "definition.loop_outcome_overlap",
      ]),
    );
  });

  it.each([4, 5, 6])("节点预算limit边界=%i", (count) => {
    const limits: WorkflowStructureLimits = {
      maxDepth: 20,
      maxNodes: 5,
      maxBranches: 10,
      maxLoops: 5,
      maxNestedLoops: 2,
      maxLoopIterations: 5,
    };
    const root: WorkflowSequence = {
      kind: "sequence",
      elements: Array.from({ length: count }, (_, index) => task(`node-${String(index)}`)),
    };
    const diagnostics = validateWorkflowStructure(root, lookup, limits).diagnostics;
    expect(diagnostics.some((entry) => entry.code === "definition.max_nodes_exceeded")).toBe(
      count > 5,
    );
  });

  it("风险序严格单调", () => {
    expect(workflowRiskAtLeast("product_commit", "human_decision")).toBe(true);
    expect(workflowRiskAtLeast("read_context", "generate_candidate")).toBe(false);
  });
});
