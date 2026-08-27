import type { WorkflowSequence } from "@chat/domain";
import type {
  CompileWorkflowRunSpecInput,
  WorkflowExecutorManifestEntry,
} from "./workflow-run-spec-compiler.js";
import type { WorkflowDefinitionRevisionInput } from "./workflow-definition-schema.js";
import { NODE_CATALOG_DESCRIPTORS } from "./workflow-node-catalog.js";
import { BUILTIN_WORKFLOW_EXECUTOR_MANIFEST } from "./workflow-executor-manifest.js";

const task = (
  definitionNodeId: string,
  nodeType: Exclude<(typeof NODE_CATALOG_DESCRIPTORS)[number]["nodeType"], "execute.plan">,
  config: Readonly<Record<string, unknown>> = {},
) => ({ kind: "task" as const, definitionNodeId, nodeType, schemaVersion: 1, config });

const composite = (definitionNodeId: string, config: Readonly<Record<string, unknown>> = {}) => ({
  kind: "composite" as const,
  definitionNodeId,
  nodeType: "execute.plan" as const,
  schemaVersion: 1,
  config,
});

export const NOTE_SEQUENCE_ROOT: WorkflowSequence = {
  kind: "sequence",
  elements: [
    task("note.extract", "note.extract"),
    task("note.classify", "note.classify"),
    task("note.commit", "note.commit"),
  ],
};

export const NOTE_CHOICE_ROOT: WorkflowSequence = {
  kind: "sequence",
  elements: [
    task("note.extract", "note.extract"),
    task("note.classify", "note.classify"),
    {
      kind: "choice",
      fromDefinitionNodeId: "note.classify",
      branches: [
        { outcome: "classified", body: { kind: "sequence", elements: [] } },
        {
          outcome: "needs_review",
          body: {
            kind: "sequence",
            elements: [task("note.review", "human.note_review")],
          },
        },
      ],
    },
    task("note.commit", "note.commit"),
  ],
};

export const NOTE_HUMAN_REVIEW_ROOT: WorkflowSequence = {
  kind: "sequence",
  elements: [
    task("note.extract", "note.extract"),
    task("note.classify", "note.classify"),
    task("note.review", "human.note_review"),
    task("note.commit", "note.commit"),
  ],
};

export const PLANNING_LOOP_ROOT: WorkflowSequence = {
  kind: "sequence",
  elements: [
    {
      kind: "bounded_loop",
      body: {
        kind: "sequence",
        elements: [
          task("planning.plan", "agent.plan"),
          task("planning.review", "human.plan_review"),
        ],
      },
      outcomeFromDefinitionNodeId: "planning.review",
      continueOutcomes: ["request_revision"],
      exitOutcomes: ["approved", "rejected"],
      maxIterations: 5,
      exceededPolicy: "request_human",
    },
    composite("planning.execute"),
    task("planning.validate", "result.validate"),
    task("planning.commit", "product.commit"),
  ],
};

export const PLANNING_MIXED_ROOT: WorkflowSequence = {
  kind: "sequence",
  elements: [
    task("planning.memory", "context.memory"),
    task("planning.rules", "policy.rules"),
    task("planning.skills", "capability.skills"),
    task("planning.research", "agent.research"),
    ...PLANNING_LOOP_ROOT.elements,
  ],
};

export const KERNEL_EXECUTOR_MANIFEST_FIXTURE: readonly WorkflowExecutorManifestEntry[] =
  BUILTIN_WORKFLOW_EXECUTOR_MANIFEST;

export function kernelDefinitionFixture(
  key: "sequence" | "choice" | "bounded_loop" | "human_review" | "composite" | "mixed",
): WorkflowDefinitionRevisionInput {
  const note = key === "sequence" || key === "choice" || key === "human_review";
  const roots: Readonly<Record<typeof key, WorkflowSequence>> = {
    sequence: NOTE_SEQUENCE_ROOT,
    choice: NOTE_CHOICE_ROOT,
    bounded_loop: PLANNING_LOOP_ROOT,
    human_review: NOTE_HUMAN_REVIEW_ROOT,
    composite: PLANNING_LOOP_ROOT,
    mixed: PLANNING_MIXED_ROOT,
  };
  return {
    schemaVersion: "workflow-definition-revision-input.v3",
    workflowDefinitionRevisionId: `wfr_fixture${key.replace("_", "")}` as never,
    definitionRevision: 1,
    blueprintKey: note ? "note" : "planning",
    blueprintVersion: 1,
    semanticRoot: roots[key],
  };
}

export function kernelCompilerInputFixture(
  key: Parameters<typeof kernelDefinitionFixture>[0],
  overrides: Partial<CompileWorkflowRunSpecInput> = {},
): CompileWorkflowRunSpecInput {
  return {
    workflowRunSpecId: `wrs_fixture${key.replace("_", "")}`,
    productRunId: `run_fixture${key.replace("_", "")}`,
    createdAt: "2026-08-10T00:00:00.000Z",
    definition: kernelDefinitionFixture(key),
    runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    principal: { principalId: "usr_fixture", capabilities: [] },
    availableResources: [],
    executorManifest: KERNEL_EXECUTOR_MANIFEST_FIXTURE,
    runner: {
      runnerFamily: "definition-kernel-lab.v1",
      runnerBundleVersion: "definition-kernel-lab.bundle.v1",
    },
    ...overrides,
  };
}
