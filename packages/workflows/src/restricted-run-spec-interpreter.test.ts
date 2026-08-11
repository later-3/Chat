import { describe, expect, it } from "vitest";
import type { WorkflowRunSpec } from "@chat/contracts";
import { interpretRestrictedRunSpec } from "./restricted-run-spec-interpreter.js";

const task = (definitionNodeId: string, nodeType: string) => ({
  kind: "task",
  definitionNodeId,
  nodeType,
  schemaVersion: 1,
  config: {},
});

function fixture(blueprint: "planning" | "note"): WorkflowRunSpec {
  const reviewType = blueprint === "planning" ? "human.plan_review" : "human.note_review";
  const prefix = blueprint;
  const semanticRoot = {
    kind: "sequence",
    elements: [
      task(`${prefix}.prepare`, blueprint === "planning" ? "agent.plan" : "note.extract"),
      {
        kind: "bounded_loop",
        body: {
          kind: "sequence",
          elements: [task(`${prefix}.review`, reviewType)],
        },
        outcomeFromDefinitionNodeId: `${prefix}.review`,
        continueOutcomes: ["request_revision"],
        exitOutcomes: ["approved", "rejected"],
        maxIterations: 2,
        exceededPolicy: "fail",
      },
      {
        kind: "choice",
        fromDefinitionNodeId: `${prefix}.review`,
        branches: [
          { outcome: "approved", body: { kind: "sequence", elements: [] } },
          { outcome: "rejected", body: { kind: "sequence", elements: [] } },
        ],
      },
      task(`${prefix}.commit`, blueprint === "planning" ? "product.commit" : "note.commit"),
    ],
  } as const;
  const nodes = [
    semanticRoot.elements[0],
    semanticRoot.elements[1].body.elements[0],
    semanticRoot.elements[3],
  ];
  return {
    semanticRoot,
    nodeResolutions: nodes.map((node) => ({
      definitionNodeId: node.definitionNodeId,
      nodeType: node.nodeType,
      schemaVersion: 1,
      config: {},
      activation: "enabled",
    })),
    limits: { runtime: { maxNodeExecutions: 16, maxWaits: 4 } },
  } as unknown as WorkflowRunSpec;
}

describe("受限RunSpec控制解释器", () => {
  for (const blueprint of ["planning", "note"] as const) {
    it(`${blueprint}共用相同Sequence/Loop/Choice执行与稳定iteration路径`, async () => {
      const visits: { node: string; iteration: number | undefined; operation: string }[] = [];
      let reviewCount = 0;
      const result = await interpretRestrictedRunSpec({
        runSpec: fixture(blueprint),
        executeNode: async ({ element, executionPath, registration }) => {
          visits.push({
            node: element.definitionNodeId,
            iteration: executionPath.at(-1)?.iteration,
            operation: registration.operation,
          });
          if (registration.executorKind === "human_review") {
            reviewCount += 1;
            return { outcome: reviewCount === 1 ? "request_revision" : "approved" };
          }
          return { outcome: "committed" };
        },
        onLoopLimitExceeded: async () => "limit" as const,
      });
      expect(result).toEqual({ kind: "completed" });
      expect(visits.map(({ node }) => node)).toEqual([
        `${blueprint}.prepare`,
        `${blueprint}.review`,
        `${blueprint}.review`,
        `${blueprint}.commit`,
      ]);
      expect(
        visits.filter(({ node }) => node.endsWith(".review")).map(({ iteration }) => iteration),
      ).toEqual([1, 2]);
    });
  }

  it("循环上限和Node预算都在下一业务调用前失败关闭", async () => {
    let calls = 0;
    const limitedBase = fixture("note");
    const limited: WorkflowRunSpec = {
      ...limitedBase,
      semanticRoot: {
        ...limitedBase.semanticRoot,
        elements: limitedBase.semanticRoot.elements.map((element, index) =>
          index === 1 && element.kind === "bounded_loop"
            ? { ...element, maxIterations: 1 }
            : element,
        ),
      },
    };
    const result = await interpretRestrictedRunSpec({
      runSpec: limited,
      executeNode: async ({ registration }) => {
        calls += 1;
        return {
          outcome: registration.executorKind === "human_review" ? "request_revision" : "ok",
        };
      },
      onLoopLimitExceeded: async () => "limit" as const,
    });
    expect(result).toEqual({ kind: "terminal", value: "limit" });
    expect(calls).toBe(2);

    const budgetedBase = fixture("planning");
    const budgeted: WorkflowRunSpec = {
      ...budgetedBase,
      limits: {
        ...budgetedBase.limits,
        runtime: { ...budgetedBase.limits.runtime, maxNodeExecutions: 1 },
      },
    };
    await expect(
      interpretRestrictedRunSpec({
        runSpec: budgeted,
        executeNode: async () => ({ outcome: "approved" }),
        onLoopLimitExceeded: async () => "limit",
      }),
    ).rejects.toThrow("workflow_ir.node_execution_budget_exceeded");
  });
});
