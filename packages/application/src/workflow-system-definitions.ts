import {
  workflowDefinitionRevisionSchema,
  workflowDefinitionSchema,
  workflowViewDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowDefinitionRevision,
  type WorkflowViewDefinition,
} from "@chat/contracts";
import {
  computeWorkflowViewDefinitionSha256,
  type WorkflowSequence,
  type WorkflowViewEdgeShape,
  type WorkflowViewNodeShape,
} from "@chat/domain";
import { DEFAULT_NODE_CATALOG } from "./workflow-node-catalog.js";
import { normalizeWorkflowDefinition } from "./workflow-definition-normalize.js";

export const SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID = "wfd_systemplanningv1" as const;
export const LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID = "wfr_systemplanningv1" as const;
export const LEGACY_SYSTEM_PLANNING_WORKFLOW_VIEW_ID = "wvd_systemplanningv1" as const;
export const SYSTEM_PLANNING_WORKFLOW_REVISION_ID = "wfr_systemplanningv2" as const;
export const SYSTEM_PLANNING_WORKFLOW_VIEW_ID = "wvd_systemplanningv2" as const;
export const SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID = "wfd_systemsimpleplanningv1" as const;
export const SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID = "wfr_systemsimpleplanningv1" as const;
export const SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID = "wvd_systemsimpleplanningv1" as const;
export const SYSTEM_NOTE_WORKFLOW_DEFINITION_ID = "wfd_systemnotev1" as const;
export const SYSTEM_NOTE_WORKFLOW_REVISION_ID = "wfr_systemnotev1" as const;
export const SYSTEM_NOTE_WORKFLOW_VIEW_ID = "wvd_systemnotev1" as const;
export const CONFIGURABLE_PLANNING_RUNNER_FAMILY = "configurable-planning.v1" as const;
export const CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION =
  "configurable-planning.bundle.v1" as const;
export const NOTE_CAPTURE_RUNNER_FAMILY = "note-capture.v1" as const;
export const NOTE_CAPTURE_RUNNER_BUNDLE_VERSION = "note-capture.bundle.v1" as const;
export const LEGACY_PLANNING_RUNNER_FAMILY = "legacy-planning.v1" as const;
export const LEGACY_PLANNING_RUNNER_BUNDLE_VERSION = "legacy-planning.bundle.v1" as const;

export function systemPlanningSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      systemTask("planning.memory", "context.memory"),
      systemTask("planning.project", "context.project"),
      systemTask("planning.rules", "policy.rules"),
      systemTask("planning.skills", "capability.skills"),
      {
        kind: "bounded_loop",
        body: {
          kind: "sequence",
          elements: [
            systemTask("planning.plan", "agent.plan"),
            systemTask("planning.review", "human.plan_review"),
          ],
        },
        outcomeFromDefinitionNodeId: "planning.review",
        continueOutcomes: ["request_revision"],
        exitOutcomes: ["approved", "rejected"],
        maxIterations: 5,
        exceededPolicy: "fail",
      },
      {
        kind: "composite",
        definitionNodeId: "planning.execute",
        nodeType: "execute.plan",
        schemaVersion: 1,
        config: {},
      },
      systemTask("planning.validate", "result.validate"),
      systemTask("planning.commit", "product.commit"),
    ],
  };
}

/** 当前常规对话使用的最小Planning流程；不声明任何Memory或其他可选资源节点。 */
export function systemSimplePlanningSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      {
        kind: "bounded_loop",
        body: {
          kind: "sequence",
          elements: [
            systemTask("planning.plan", "agent.plan"),
            systemTask("planning.review", "human.plan_review"),
          ],
        },
        outcomeFromDefinitionNodeId: "planning.review",
        continueOutcomes: ["request_revision"],
        exitOutcomes: ["approved", "rejected"],
        maxIterations: 5,
        exceededPolicy: "fail",
      },
      {
        kind: "composite",
        definitionNodeId: "planning.execute",
        nodeType: "execute.plan",
        schemaVersion: 1,
        config: {},
      },
      systemTask("planning.validate", "result.validate"),
      systemTask("planning.commit", "product.commit"),
    ],
  };
}

export function systemNoteSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      {
        kind: "bounded_loop",
        body: {
          kind: "sequence",
          elements: [
            systemTask("note.extract", "note.extract"),
            systemTask("note.classify", "note.classify"),
            systemTask("note.review", "human.note_review"),
          ],
        },
        outcomeFromDefinitionNodeId: "note.review",
        continueOutcomes: ["request_revision"],
        exitOutcomes: ["approved", "rejected"],
        maxIterations: 2,
        exceededPolicy: "fail",
      },
      systemTask("note.commit", "note.commit"),
    ],
  };
}

export function createSystemPlanningDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(
    systemPlanningSemanticRoot(),
    DEFAULT_NODE_CATALOG,
  );
  if (!normalized.success) {
    throw new Error(
      `system planning definition invalid:${normalized.diagnostics.map((item) => item.code).join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.planning",
    title: "默认规划工作流",
    description: "读取上下文、生成计划、人工审核、执行、验证并提交结果的系统内置流程。",
    blueprintKey: "planning",
    blueprintVersion: 1,
    status: "active",
    publishedRevisionId: SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
    definitionRevision: 2,
    state: "published",
    blueprintKey: "planning",
    blueprintVersion: 1,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemPlanningWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

export function createSystemSimplePlanningDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(
    systemSimplePlanningSemanticRoot(),
    DEFAULT_NODE_CATALOG,
  );
  if (!normalized.success) {
    throw new Error(
      `system simple planning definition invalid:${normalized.diagnostics
        .map((item) => item.code)
        .join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.simple-planning",
    title: "规划执行工作流",
    description: "生成计划、人工审核、执行、验证并提交结果的系统内置流程。",
    blueprintKey: "planning",
    blueprintVersion: 1,
    status: "active",
    publishedRevisionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
    definitionRevision: 1,
    state: "published",
    blueprintKey: "planning",
    blueprintVersion: 1,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemSimplePlanningWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

export function createSystemNoteDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(systemNoteSemanticRoot(), DEFAULT_NODE_CATALOG);
  if (!normalized.success) {
    throw new Error(
      `system note definition invalid:${normalized.diagnostics.map((item) => item.code).join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.note-capture",
    title: "默认笔记工作流",
    description: "从本次消息或选区抽取笔记、分类、人工审核并保存为正式Note。",
    blueprintKey: "note",
    blueprintVersion: 1,
    status: "active",
    publishedRevisionId: SYSTEM_NOTE_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_NOTE_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
    definitionRevision: 1,
    state: "published",
    blueprintKey: "note",
    blueprintVersion: 1,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemNoteWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

function createSystemPlanningWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("planning.memory", "context.memory", "读取记忆", "task", true),
    viewNode("planning.project", "context.project", "读取项目上下文", "task", true),
    viewNode("planning.rules", "policy.rules", "解析规则", "task", true),
    viewNode("planning.skills", "capability.skills", "解析技能", "task", true),
    viewNode("planning.plan", "agent.plan", "生成计划", "task", false),
    viewNode("planning.review", "human.plan_review", "审核计划", "human_review", false),
    viewNode("planning.execute", "execute.plan", "执行计划", "composite", false),
    viewNode("planning.validate", "result.validate", "验证结果", "task", false),
    viewNode("planning.commit", "product.commit", "提交结果", "product_commit", false),
  ];
  const edges: readonly WorkflowViewEdgeShape[] = [
    edge("planning.memory", "planning.project", "control"),
    edge("planning.project", "planning.rules", "control"),
    edge("planning.rules", "planning.skills", "control"),
    edge("planning.skills", "planning.plan", "control"),
    edge("planning.plan", "planning.review", "control"),
    edge("planning.review", "planning.plan", "loop_back", "request_revision"),
    edge("planning.review", "planning.execute", "outcome", "approved"),
    edge("planning.execute", "planning.validate", "control"),
    edge("planning.validate", "planning.commit", "control"),
  ];
  const content = {
    title: "默认规划工作流",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
      definitionRevision: 2,
      definitionSha256: input.definitionSha256,
      blueprintKey: "planning",
      blueprintVersion: "1",
    },
    nodes,
    edges,
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: SYSTEM_PLANNING_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function createSystemSimplePlanningWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("planning.plan", "agent.plan", "生成计划", "task", false),
    viewNode("planning.review", "human.plan_review", "审核计划", "human_review", false),
    viewNode("planning.execute", "execute.plan", "执行计划", "composite", false),
    viewNode("planning.validate", "result.validate", "验证结果", "task", false),
    viewNode("planning.commit", "product.commit", "提交结果", "product_commit", false),
  ];
  const edges: readonly WorkflowViewEdgeShape[] = [
    edge("planning.plan", "planning.review", "control"),
    edge("planning.review", "planning.plan", "loop_back", "request_revision"),
    edge("planning.review", "planning.execute", "outcome", "approved"),
    edge("planning.execute", "planning.validate", "control"),
    edge("planning.validate", "planning.commit", "control"),
  ];
  const content = {
    title: "规划执行工作流",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
      definitionRevision: 1,
      definitionSha256: input.definitionSha256,
      blueprintKey: "planning",
      blueprintVersion: "1",
    },
    nodes,
    edges,
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function createSystemNoteWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("note.extract", "note.extract", "提取笔记", "task", false),
    viewNode("note.classify", "note.classify", "分类笔记", "task", false),
    viewNode("note.review", "human.note_review", "审核笔记", "human_review", true),
    viewNode("note.commit", "note.commit", "保存笔记", "product_commit", false),
  ];
  const edges: readonly WorkflowViewEdgeShape[] = [
    edge("note.extract", "note.classify", "control"),
    edge("note.classify", "note.review", "control"),
    edge("note.review", "note.extract", "loop_back", "request_revision"),
    edge("note.review", "note.commit", "outcome", "approved"),
  ];
  const content = {
    title: "默认笔记工作流",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
      definitionRevision: 1,
      definitionSha256: input.definitionSha256,
      blueprintKey: "note",
      blueprintVersion: "1",
    },
    nodes,
    edges,
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: SYSTEM_NOTE_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function viewNode(
  definitionNodeId: string,
  nodeType: string,
  title: string,
  kind: WorkflowViewNodeShape["kind"],
  optional: boolean,
): WorkflowViewNodeShape {
  return { definitionNodeId, nodeType, nodeSchemaVersion: "1", title, kind, optional };
}

function edge(
  from: string,
  to: string,
  kind: WorkflowViewEdgeShape["kind"],
  outcomeCode?: string,
): WorkflowViewEdgeShape {
  return outcomeCode === undefined ? { from, to, kind } : { from, to, kind, outcomeCode };
}

function systemTask(
  definitionNodeId: string,
  nodeType:
    | "context.memory"
    | "context.project"
    | "policy.rules"
    | "capability.skills"
    | "agent.research"
    | "agent.plan"
    | "human.plan_review"
    | "result.validate"
    | "product.commit"
    | "note.extract"
    | "note.classify"
    | "human.note_review"
    | "note.commit",
) {
  return { kind: "task" as const, definitionNodeId, nodeType, schemaVersion: 1, config: {} };
}
