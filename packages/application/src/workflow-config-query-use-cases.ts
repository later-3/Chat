import {
  PRODUCT_API_SCHEMA_VERSION,
  workflowBlueprintsDtoSchema,
  workflowCatalogDtoSchema,
  workflowDefinitionsDtoSchema,
  workflowResourcesDtoSchema,
  workflowRunConfigSummaryDtoSchema,
  type PrincipalId,
  type ProductRunId,
  type ProductSnapshot,
  type WorkflowDefinitionPublishedDto,
} from "@chat/contracts";
import type { WorkflowElement, WorkflowSequence } from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { forbidden, notFound } from "./errors.js";
import { DEFAULT_WORKFLOW_BLUEPRINTS } from "./workflow-blueprints.js";
import { DEFAULT_NODE_CATALOG } from "./workflow-node-catalog.js";
import {
  RETIRED_SYSTEM_WORKFLOW_DEFINITION_IDS,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
} from "./workflow-system-definitions.js";
import {
  listAuthorizedWorkflowResources,
  toWorkflowResourceRefDto,
} from "./workflow-resource-catalog.js";

export async function getWorkflowCatalog(_deps: ApplicationDeps) {
  return {
    catalog: workflowCatalogDtoSchema.parse({
      schemaVersion: PRODUCT_API_SCHEMA_VERSION,
      nodes: DEFAULT_NODE_CATALOG.list().map((descriptor) => ({
        nodeType: descriptor.nodeType,
        schemaVersion: descriptor.schemaVersion,
        displayName: descriptor.displayName,
        description: descriptor.description,
        category: descriptor.category,
        executorKind: descriptor.executorKind,
        riskPolicy: descriptor.riskPolicy,
        canDefaultSkip: descriptor.skipPolicy.kind !== "never",
        supportedBlueprints: descriptor.supportedBlueprints,
        publicConfigFields: descriptor.publicConfigFields,
        outcomes: descriptor.outcomes,
      })),
    }),
  };
}

export async function getWorkflowBlueprints(_deps: ApplicationDeps) {
  return {
    blueprints: workflowBlueprintsDtoSchema.parse({
      schemaVersion: PRODUCT_API_SCHEMA_VERSION,
      blueprints: DEFAULT_WORKFLOW_BLUEPRINTS.list().map((blueprint) => ({
        schemaVersion: PRODUCT_API_SCHEMA_VERSION,
        blueprintKey: blueprint.blueprintKey,
        blueprintVersion: blueprint.blueprintVersion,
        title: workflowBlueprintCopy(blueprint.blueprintKey).title,
        description: workflowBlueprintCopy(blueprint.blueprintKey).description,
        runnerFamily: blueprint.runnerFamily,
        terminalNodeType: blueprint.terminalNodeType,
        optionalNodeTypes: blueprint.optionalNodeTypes,
        loopRules: blueprint.loopRules,
        perRunOverrides: blueprint.perRunOverrides,
        reviewModes:
          blueprint.mandatoryManualReviewTypes.length > 0
            ? ["manual"]
            : ["manual", "auto_continue_if_policy_allows"],
      })),
    }),
  };
}

function workflowBlueprintCopy(blueprintKey: "planning" | "note" | "direct"): {
  readonly title: string;
  readonly description: string;
} {
  switch (blueprintKey) {
    case "planning":
      return {
        title: "规划工作流",
        description: "读取上下文、生成计划、审核、执行、验证并提交。",
      };
    case "note":
      return { title: "笔记工作流", description: "抽取、分类并提交笔记。" };
    case "direct":
      return {
        title: "执行 Agent（逐次提示词审核）",
        description: "单节点推进Execution Agent，并在每次Provider请求发送前进入人工审核。",
      };
  }
}

export async function getWorkflowDefinitions(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  return {
    definitions: workflowDefinitionsDtoSchema.parse({
      schemaVersion: PRODUCT_API_SCHEMA_VERSION,
      definitions: Object.values(snapshot.entities.workflowDefinitions)
        .filter(
          (definition) =>
            !RETIRED_SYSTEM_WORKFLOW_DEFINITION_IDS.has(definition.workflowDefinitionId),
        )
        .filter((definition) =>
          definition.ownerKind === "system"
            ? definition.status === "active"
            : definition.ownerPrincipalId === input.principalId && definition.status === "active",
        )
        .flatMap((definition) => {
          const revision =
            definition.publishedRevisionId === undefined
              ? undefined
              : snapshot.entities.workflowDefinitionRevisions[definition.publishedRevisionId];
          return revision === undefined ? [] : [toPublishedDefinitionDto(snapshot, revision)];
        }),
    }),
  };
}

export async function getWorkflowResources(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly resourceKind?: "memory" | "project" | "rule" | "skill" | undefined;
  },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const resources = listAuthorizedWorkflowResources(snapshot, input.principalId)
    .map(toWorkflowResourceRefDto)
    .filter((resource) =>
      input.resourceKind === undefined ? true : resource.resourceKind === input.resourceKind,
    );
  return {
    resources: workflowResourcesDtoSchema.parse({
      schemaVersion: PRODUCT_API_SCHEMA_VERSION,
      resources,
    }),
  };
}

export async function getWorkflowRunConfigSummary(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly productRunId: ProductRunId },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const run = snapshot.entities.runs[input.productRunId];
  const session = run === undefined ? undefined : snapshot.entities.sessions[run.sessionId];
  if (run === undefined || session === undefined) throw notFound("Product Run不存在");
  if (session.ownerPrincipalId !== input.principalId) throw forbidden("无权访问该Run");
  const runSpec =
    run.workflowRunSpecId === undefined
      ? undefined
      : snapshot.entities.workflowRunSpecs[run.workflowRunSpecId];
  const revision =
    runSpec === undefined
      ? undefined
      : snapshot.entities.workflowDefinitionRevisions[
          runSpec.definitionRef.workflowDefinitionRevisionId
        ];
  return {
    summary: workflowRunConfigSummaryDtoSchema.parse({
      schemaVersion: PRODUCT_API_SCHEMA_VERSION,
      productRunId: run.productRunId,
      ...(run.workflowRunSpecId !== undefined ? { workflowRunSpecId: run.workflowRunSpecId } : {}),
      runnerFamily: run.runnerFamily,
      runnerBundleVersion: run.runnerBundleVersion,
      ...(revision !== undefined
        ? { definition: toPublishedDefinitionDto(snapshot, revision) }
        : {}),
      ...(runSpec !== undefined
        ? { definitionSha256: runSpec.definitionRef.definitionSha256 }
        : {}),
      nodeCount: runSpec?.nodeResolutions.length ?? 0,
      resourceSummary:
        runSpec?.resourceResolutions.map((resource) => ({
          definitionNodeId: resource.definitionNodeId,
          resourceKind: resource.resourceKind,
          resolution: resource.resolution === "included" ? "included" : "excluded",
          ...(resource.resolution === "excluded" ? { reason: resource.exclusionReason } : {}),
        })) ?? [],
      reviewSummary:
        runSpec?.reviewResolutions.map((review) => ({
          definitionNodeId: review.definitionNodeId,
          mode: review.mode,
          actor: review.actor,
        })) ?? [],
      createdAt: runSpec?.createdAt ?? run.createdAt,
    }),
  };
}

function toPublishedDefinitionDto(
  snapshot: ProductSnapshot,
  revision: ProductSnapshot["entities"]["workflowDefinitionRevisions"][string],
): WorkflowDefinitionPublishedDto {
  const definition = snapshot.entities.workflowDefinitions[revision.workflowDefinitionId];
  if (definition === undefined) throw notFound("Workflow Definition不存在");
  const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get(
    revision.blueprintKey,
    revision.blueprintVersion,
  );
  return {
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    workflowDefinitionId: revision.workflowDefinitionId,
    workflowDefinitionRevisionId: revision.workflowDefinitionRevisionId,
    definitionRevision: revision.definitionRevision,
    title: revision.title,
    description: definition.description,
    blueprintKey: revision.blueprintKey,
    blueprintVersion: revision.blueprintVersion,
    definitionSha256: revision.definitionSha256,
    ownerKind: definition.ownerKind,
    isDefault:
      revision.workflowDefinitionRevisionId === SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
    nodes: flattenNodes(revision.semanticRoot).map((node) => {
      const descriptor = DEFAULT_NODE_CATALOG.get(node.nodeType, node.schemaVersion);
      return {
        definitionNodeId: node.definitionNodeId,
        nodeType: node.nodeType,
        schemaVersion: node.schemaVersion,
        displayName: descriptor?.displayName ?? node.definitionNodeId,
        optional: blueprint?.optionalNodeTypes.includes(node.nodeType) ?? false,
        defaultActivation: node.defaultActivation ?? "enabled",
        publicConfigFields: (descriptor?.publicConfigFields ?? []).map((field) =>
          "options" in field ? { ...field, options: [...field.options] } : { ...field },
        ),
      };
    }),
    publishedAt: revision.publishedAt ?? revision.createdAt,
    updatedAt: revision.updatedAt,
  };
}

function flattenNodes(root: WorkflowSequence) {
  const nodes: Extract<WorkflowElement, { kind: "task" | "composite" }>[] = [];
  const stack: WorkflowElement[] = [root];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (element.kind === "task" || element.kind === "composite") {
      nodes.push(element);
    } else if (element.kind === "sequence") {
      for (let index = element.elements.length - 1; index >= 0; index -= 1) {
        const child = element.elements[index];
        if (child !== undefined) stack.push(child);
      }
    } else if (element.kind === "choice") {
      for (const branch of [...element.branches].reverse()) stack.push(branch.body);
    } else {
      stack.push(element.body);
    }
  }
  return nodes;
}
