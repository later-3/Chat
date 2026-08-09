import {
  workflowViewDefinitionIdSchema,
  workflowViewDefinitionSchema,
  type WorkflowDefinitionRevision,
  type WorkflowViewDefinition,
} from "@chat/contracts";
import {
  assertWorkflowViewDefinition,
  computeWorkflowViewDefinitionSha256,
  hashCanonical,
  type WorkflowElement,
  type WorkflowViewEdgeShape,
  type WorkflowViewNodeShape,
} from "@chat/domain";
import { DEFAULT_WORKFLOW_BLUEPRINTS } from "./workflow-blueprints.js";
import { DEFAULT_NODE_CATALOG } from "./workflow-node-catalog.js";

interface ExitPort {
  readonly from: string;
  readonly kind: "control" | "outcome";
  readonly outcomeCode?: string | undefined;
}

interface Segment {
  readonly entries: readonly string[];
  readonly exits: readonly ExitPort[];
  readonly consumesPrevious?: boolean | undefined;
}

/**
 * Published Revision到历史View的确定性投影。View只保存用户可观察结构；Choice与Loop
 * 被翻译为outcome/loop_back边，绝不暴露Executor key、Hook或Runtime身份。
 */
export function createPublishedWorkflowView(input: {
  readonly revision: WorkflowDefinitionRevision;
  readonly createdAt: string;
}): WorkflowViewDefinition {
  const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get(
    input.revision.blueprintKey,
    input.revision.blueprintVersion,
  );
  if (blueprint === undefined) throw new Error("workflow.view.blueprint_missing");
  const nodes: WorkflowViewNodeShape[] = [];
  const edges: WorkflowViewEdgeShape[] = [];
  const edgeKeys = new Set<string>();

  const addEdge = (edge: WorkflowViewEdgeShape): void => {
    const key = `${edge.from}\0${edge.to}\0${edge.kind}\0${edge.outcomeCode ?? ""}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };
  const connect = (ports: readonly ExitPort[], entries: readonly string[]): void => {
    for (const port of ports) {
      // 当前有限蓝图把rejected定义为终止本轮，不把它错误画成继续执行的边。
      if (port.outcomeCode === "rejected") continue;
      for (const to of entries) {
        addEdge({
          from: port.from,
          to,
          kind: port.kind,
          ...(port.outcomeCode === undefined ? {} : { outcomeCode: port.outcomeCode }),
        });
      }
    }
  };

  const build = (element: WorkflowElement): Segment => {
    if (element.kind === "task" || element.kind === "composite") {
      const descriptor = DEFAULT_NODE_CATALOG.get(element.nodeType, element.schemaVersion);
      if (descriptor === undefined) throw new Error("workflow.view.catalog_entry_missing");
      nodes.push({
        definitionNodeId: element.definitionNodeId,
        nodeType: element.nodeType,
        nodeSchemaVersion: String(element.schemaVersion),
        title: descriptor.displayName,
        kind:
          descriptor.executorKind === "human_review"
            ? "human_review"
            : descriptor.executorKind === "composite"
              ? "composite"
              : descriptor.category === "commit"
                ? "product_commit"
                : "task",
        optional: blueprint.optionalNodeTypes.includes(element.nodeType),
      });
      return {
        entries: [element.definitionNodeId],
        exits: [{ from: element.definitionNodeId, kind: "control" }],
      };
    }
    if (element.kind === "sequence") {
      let entries: readonly string[] = [];
      let exits: readonly ExitPort[] = [];
      for (const child of element.elements) {
        const segment = build(child);
        if (segment.consumesPrevious === true) {
          exits = segment.exits;
          continue;
        }
        if (entries.length === 0 && segment.entries.length > 0) entries = segment.entries;
        if (exits.length > 0 && segment.entries.length > 0) connect(exits, segment.entries);
        if (segment.entries.length > 0 || segment.exits.length > 0) exits = segment.exits;
      }
      return { entries, exits };
    }
    if (element.kind === "choice") {
      const exits: ExitPort[] = [];
      for (const branch of element.branches) {
        const body = build(branch.body);
        if (body.entries.length === 0) {
          exits.push({
            from: element.fromDefinitionNodeId,
            kind: "outcome",
            outcomeCode: branch.outcome,
          });
        } else {
          addEdge({
            from: element.fromDefinitionNodeId,
            to: body.entries[0]!,
            kind: "outcome",
            outcomeCode: branch.outcome,
          });
          exits.push(...body.exits);
        }
      }
      return { entries: [], exits, consumesPrevious: true };
    }

    const body = build(element.body);
    for (const outcome of element.continueOutcomes) {
      for (const entry of body.entries) {
        addEdge({
          from: element.outcomeFromDefinitionNodeId,
          to: entry,
          kind: "loop_back",
          outcomeCode: outcome,
        });
      }
    }
    return {
      entries: body.entries,
      exits: element.exitOutcomes.map((outcomeCode) => ({
        from: element.outcomeFromDefinitionNodeId,
        kind: "outcome" as const,
        outcomeCode,
      })),
    };
  };

  build(input.revision.semanticRoot);
  const workflowViewDefinitionId = workflowViewDefinitionIdSchema.parse(
    `wvd_${hashCanonical("id.published-workflow-view.v1", {
      workflowDefinitionRevisionId: input.revision.workflowDefinitionRevisionId,
      definitionSha256: input.revision.definitionSha256,
    }).slice(0, 32)}`,
  );
  const content = {
    title: input.revision.title,
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: input.revision.workflowDefinitionId,
      definitionRevision: input.revision.definitionRevision,
      definitionSha256: input.revision.definitionSha256,
      blueprintKey: input.revision.blueprintKey,
      blueprintVersion: String(input.revision.blueprintVersion),
    },
    nodes,
    edges,
  };
  const view = workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  assertWorkflowViewDefinition(view);
  return view;
}
