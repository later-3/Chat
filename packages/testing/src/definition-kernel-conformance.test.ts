import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NODE_CATALOG,
  DEFAULT_WORKFLOW_BLUEPRINTS,
  nodeExecutorKey,
} from "@chat/application";
import { workflowDefinitionRevisionInputSchema } from "@chat/contracts";
import { validateWorkflowStructure, type WorkflowSequence } from "@chat/domain";
import { DEFINITION_KERNEL_EXECUTORS, KernelExecutorRegistry } from "@chat/workflows";
import { compileWorkflowRunSpec } from "@chat/application/workflow-run-spec-compiler";
import { kernelCompilerInputFixture } from "@chat/application/workflow-kernel-fixtures";

describe("Definition Kernel三方Conformance", () => {
  it("Catalog、Blueprint与静态Executor集合完全对齐", () => {
    const catalogKeys = DEFAULT_NODE_CATALOG.list().map((descriptor) =>
      nodeExecutorKey(descriptor.nodeType, descriptor.schemaVersion),
    );
    const executorKeys = DEFINITION_KERNEL_EXECUTORS.list().map((descriptor) =>
      nodeExecutorKey(descriptor.nodeType, descriptor.schemaVersion),
    );
    expect(executorKeys).toEqual(catalogKeys);
    for (const blueprint of DEFAULT_WORKFLOW_BLUEPRINTS.list()) {
      for (const nodeType of blueprint.allowedNodeTypes) {
        const supportedDescriptors = DEFAULT_NODE_CATALOG.list().filter(
          (descriptor) =>
            descriptor.nodeType === nodeType &&
            descriptor.supportedBlueprints.includes(blueprint.blueprintKey),
        );
        expect(supportedDescriptors.length).toBeGreaterThan(0);
        for (const descriptor of supportedDescriptors) {
          expect(DEFINITION_KERNEL_EXECUTORS.get(nodeType, descriptor.schemaVersion)).toBeDefined();
        }
      }
    }
  });

  it("删除任意Executor或添加孤立Executor时Conformance必失败", () => {
    const entries = DEFINITION_KERNEL_EXECUTORS.list();
    expect(conformanceCodes(new KernelExecutorRegistry(entries.slice(1)))).toContain(
      "executor_missing",
    );
    const orphan = {
      ...entries[0]!,
      schemaVersion: 2,
      executorVersion: "context.memory.v2",
    };
    expect(conformanceCodes(new KernelExecutorRegistry([...entries, orphan]))).toContain(
      "executor_orphan",
    );
  });

  it("固定Runner源码没有动态代码、通用HTTP或用户模块逃生口", async () => {
    const root = resolve(import.meta.dirname, "../..");
    const files = [
      "workflows/src/definition-kernel-lab-workflow.ts",
      "workflows/src/definition-kernel-lab-steps.ts",
      "workflows/src/definition-kernel-executor-registry.ts",
    ];
    const source = (
      await Promise.all(files.map((file) => readFile(resolve(root, file), "utf8")))
    ).join("\n");
    expect(source).not.toMatch(
      /\beval\s*\(|new\s+Function\s*\(|execute\s*\(code|node:http|fetch\s*\(/,
    );
    expect(source).not.toContain("ReactFlow");
  });

  it("固定seed合法IR parse→normalize→parse保持Hash，单点破坏有稳定path", () => {
    for (const seed of [7, 17, 29, 43, 71]) {
      const root = generatedNoteSequence(seed);
      const definition = {
        schemaVersion: "workflow-definition-revision-input.v1",
        workflowDefinitionRevisionId: `wfr_seed${String(seed)}`,
        definitionRevision: 1,
        blueprintKey: "note",
        blueprintVersion: 1,
        semanticRoot: root,
      };
      const parsed = workflowDefinitionRevisionInputSchema.safeParse(definition);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const first = compileWorkflowRunSpec(
        kernelCompilerInputFixture("sequence", { definition: parsed.data }),
      );
      expect(first.success).toBe(true);
      if (!first.success) continue;
      const reparsed = workflowDefinitionRevisionInputSchema.safeParse({
        ...parsed.data,
        semanticRoot: first.runSpec.semanticRoot,
      });
      expect(reparsed.success).toBe(true);
      if (!reparsed.success) continue;
      const second = compileWorkflowRunSpec(
        kernelCompilerInputFixture("sequence", { definition: reparsed.data }),
      );
      expect(second.success).toBe(true);
      if (second.success) {
        expect(second.runSpec.definitionRef.definitionSha256).toBe(
          first.runSpec.definitionRef.definitionSha256,
        );
      }
    }

    const broken: WorkflowSequence = {
      kind: "sequence",
      elements: [
        node("duplicate", "note.extract"),
        node("duplicate", "note.classify"),
        node("commit", "note.commit"),
      ],
    };
    const validation = validateWorkflowStructure(broken, {
      outcomesFor: (nodeType, version) => DEFAULT_NODE_CATALOG.get(nodeType, version)?.outcomes,
    });
    expect(validation.diagnostics[0]).toMatchObject({
      code: "definition.duplicate_node_id",
      path: "$.elements[1]",
    });
  });

  it("RunSpec只含精确ref/控制数据，不含secret、endpoint、Hook或Provider正文", () => {
    const compiled = compileWorkflowRunSpec(kernelCompilerInputFixture("mixed"));
    expect(compiled.success).toBe(true);
    if (!compiled.success) return;
    const serialized = JSON.stringify(compiled.runSpec);
    expect(serialized).not.toMatch(
      /api[_-]?key|credential|hookToken|providerPayload|endpoint|https?:\/\//i,
    );
    expect(serialized.length).toBeLessThan(128 * 1024);
  });
});

function conformanceCodes(registry: KernelExecutorRegistry): readonly string[] {
  const catalog = new Set(
    DEFAULT_NODE_CATALOG.list().map((entry) =>
      nodeExecutorKey(entry.nodeType, entry.schemaVersion),
    ),
  );
  const executors = new Set(
    registry.list().map((entry) => nodeExecutorKey(entry.nodeType, entry.schemaVersion)),
  );
  const codes: string[] = [];
  if ([...catalog].some((key) => !executors.has(key))) codes.push("executor_missing");
  if ([...executors].some((key) => !catalog.has(key))) codes.push("executor_orphan");
  return codes;
}

function generatedNoteSequence(seed: number): WorkflowSequence {
  const includeReview = seed % 2 === 1;
  return {
    kind: "sequence",
    elements: [
      node(`extract-${String(seed)}`, "note.extract"),
      {
        kind: "sequence",
        elements: [node(`classify-${String(seed)}`, "note.classify")],
      },
      ...(includeReview ? [node(`review-${String(seed)}`, "human.note_review")] : []),
      node(`commit-${String(seed)}`, "note.commit"),
    ],
  };
}

function node(
  definitionNodeId: string,
  nodeType: "note.extract" | "note.classify" | "human.note_review" | "note.commit",
) {
  return {
    kind: "task" as const,
    definitionNodeId,
    nodeType,
    schemaVersion: 1,
    config: {},
  };
}
