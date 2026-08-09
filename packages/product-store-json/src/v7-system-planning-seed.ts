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
  hashCanonical,
  type WorkflowViewEdgeShape,
  type WorkflowViewNodeShape,
} from "@chat/domain";

export const V7_SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID = "wfd_systemplanningv1" as const;
export const V7_SYSTEM_PLANNING_WORKFLOW_REVISION_ID = "wfr_systemplanningv1" as const;
export const V7_SYSTEM_PLANNING_WORKFLOW_VIEW_ID = "wvd_systemplanningv1" as const;
export const V7_LEGACY_PLANNING_RUNNER_FAMILY = "legacy-planning.v1" as const;
export const V7_LEGACY_PLANNING_RUNNER_BUNDLE_VERSION = "legacy-planning.bundle.v1" as const;

/**
 * v7迁移的Definition必须是migration-local常量，不能复用会随产品演进的Catalog或系统Seed。
 * 这里冻结S4发布时的规范化正文（包括当时仍存在的装饰性research节点）。
 */
export function createV7SystemPlanningSeed(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const task = (definitionNodeId: string, nodeType: string, config: Record<string, unknown>) => ({
    kind: "task" as const,
    definitionNodeId,
    nodeType,
    schemaVersion: 1,
    config,
  });
  const semanticRoot = {
    kind: "sequence" as const,
    elements: [
      task("planning.memory", "context.memory", { required: false, maxItems: 8 }),
      task("planning.project", "context.project", { required: false }),
      task("planning.rules", "policy.rules", { required: false }),
      task("planning.skills", "capability.skills", { required: false }),
      task("planning.research", "agent.research", { maxSources: 8 }),
      {
        kind: "bounded_loop" as const,
        body: {
          kind: "sequence" as const,
          elements: [
            task("planning.plan", "agent.plan", { maxSteps: 8 }),
            task("planning.review", "human.plan_review", { reviewMode: "manual" }),
          ],
        },
        outcomeFromDefinitionNodeId: "planning.review",
        continueOutcomes: ["request_revision"],
        exitOutcomes: ["approved", "rejected"],
        maxIterations: 5,
        exceededPolicy: "fail" as const,
      },
      {
        kind: "composite" as const,
        definitionNodeId: "planning.execute",
        nodeType: "execute.plan",
        schemaVersion: 1,
        config: { maxActions: 16 },
      },
      task("planning.validate", "result.validate", { strictEvidence: true }),
      task("planning.commit", "product.commit", { format: "markdown_sections" }),
    ],
  };
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: V7_SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.planning",
    title: "默认规划工作流",
    description: "读取上下文、生成计划、人工审核、执行、验证并提交结果的系统内置流程。",
    blueprintKey: "planning",
    blueprintVersion: 1,
    status: "active",
    publishedRevisionId: V7_SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: V7_SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
    workflowDefinitionId: V7_SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
    definitionRevision: 1,
    state: "published",
    blueprintKey: "planning",
    blueprintVersion: 1,
    title: definition.title,
    semanticRoot,
    definitionSha256: hashCanonical("workflow-definition.v1", semanticRoot),
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  const node = (
    definitionNodeId: string,
    nodeType: string,
    title: string,
    kind: WorkflowViewNodeShape["kind"],
    optional: boolean,
  ): WorkflowViewNodeShape => ({
    definitionNodeId,
    nodeType,
    nodeSchemaVersion: "1",
    title,
    kind,
    optional,
  });
  const nodes: readonly WorkflowViewNodeShape[] = [
    node("planning.memory", "context.memory", "读取记忆", "task", true),
    node("planning.project", "context.project", "读取项目上下文", "task", true),
    node("planning.rules", "policy.rules", "解析规则", "task", true),
    node("planning.skills", "capability.skills", "解析技能", "task", true),
    node("planning.research", "agent.research", "调研", "task", true),
    node("planning.plan", "agent.plan", "生成计划", "task", false),
    node("planning.review", "human.plan_review", "审核计划", "human_review", false),
    node("planning.execute", "execute.plan", "执行计划", "composite", false),
    node("planning.validate", "result.validate", "验证结果", "task", false),
    node("planning.commit", "product.commit", "提交结果", "product_commit", false),
  ];
  const edge = (
    from: string,
    to: string,
    kind: WorkflowViewEdgeShape["kind"],
    outcomeCode?: string,
  ): WorkflowViewEdgeShape =>
    outcomeCode === undefined ? { from, to, kind } : { from, to, kind, outcomeCode };
  const edges: readonly WorkflowViewEdgeShape[] = [
    edge("planning.memory", "planning.project", "control"),
    edge("planning.project", "planning.rules", "control"),
    edge("planning.rules", "planning.skills", "control"),
    edge("planning.skills", "planning.research", "control"),
    edge("planning.research", "planning.plan", "control"),
    edge("planning.plan", "planning.review", "control"),
    edge("planning.review", "planning.plan", "loop_back", "request_revision"),
    edge("planning.review", "planning.execute", "outcome", "approved"),
    edge("planning.execute", "planning.validate", "control"),
    edge("planning.validate", "planning.commit", "control"),
  ];
  const content = {
    title: definition.title,
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: definition.workflowDefinitionId,
      definitionRevision: 1,
      definitionSha256: revision.definitionSha256,
      blueprintKey: "planning",
      blueprintVersion: "1",
    },
    nodes,
    edges,
  };
  const view = workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: V7_SYSTEM_PLANNING_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  return { definition, revision, view };
}
