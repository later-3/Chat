import {
  PRODUCT_API_SCHEMA_VERSION,
  WORKFLOW_PRODUCT_API_V3_SCHEMA_VERSION,
  workflowBlueprintsV3DtoSchema,
  workflowCatalogV3DtoSchema,
  workflowDefinitionsV3DtoSchema,
  workflowResourcesDtoSchema,
  workflowRunConfigSummaryV3DtoSchema,
  type PrincipalId,
  type ProductRunId,
  type ProductSnapshot,
  type WorkflowDefinitionPublishedV3Dto,
} from "@chat/contracts";
import type { WorkflowElement, WorkflowSequence } from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { forbidden, notFound } from "./errors.js";
import { DEFAULT_WORKFLOW_BLUEPRINTS } from "./workflow-blueprints.js";
import { DEFAULT_NODE_CATALOG, type PublicConfigField } from "./workflow-node-catalog.js";
import {
  RETIRED_SYSTEM_WORKFLOW_DEFINITION_IDS,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
} from "./workflow-system-definitions.js";
import {
  agentNodeBindingDescriptor,
  isPromptBearingNodeType,
} from "./prompt-assembly-use-cases.js";
import {
  listAuthorizedWorkflowResources,
  toWorkflowResourceRefDto,
} from "./workflow-resource-catalog.js";

export async function getWorkflowCatalog(_deps: ApplicationDeps) {
  return {
    catalog: workflowCatalogV3DtoSchema.parse({
      schemaVersion: WORKFLOW_PRODUCT_API_V3_SCHEMA_VERSION,
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
    blueprints: workflowBlueprintsV3DtoSchema.parse({
      schemaVersion: WORKFLOW_PRODUCT_API_V3_SCHEMA_VERSION,
      blueprints: DEFAULT_WORKFLOW_BLUEPRINTS.list().map((blueprint) => ({
        schemaVersion: WORKFLOW_PRODUCT_API_V3_SCHEMA_VERSION,
        blueprintKey: blueprint.blueprintKey,
        blueprintVersion: blueprint.blueprintVersion,
        title: workflowBlueprintCopy(blueprint.blueprintKey, blueprint.blueprintVersion).title,
        description: workflowBlueprintCopy(blueprint.blueprintKey, blueprint.blueprintVersion)
          .description,
        runnerFamily: blueprint.runnerFamily,
        terminalNodeType: blueprint.terminalNodeType,
        optionalNodeTypes: blueprint.optionalNodeTypes,
        loopRules: blueprint.loopRules,
        perRunOverrides: blueprint.perRunOverrides.map((rule) => ({
          ...rule,
          configFields: rule.configFields ?? [],
        })),
        reviewModes:
          blueprint.mandatoryManualReviewTypes.length > 0
            ? ["manual"]
            : ["manual", "auto_continue_if_policy_allows"],
      })),
    }),
  };
}

function workflowBlueprintCopy(
  blueprintKey: "planning" | "note" | "direct",
  blueprintVersion: number,
): {
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
      if (blueprintVersion === 5) {
        return {
          title: "只整理为 Memory 候选",
          description: "执行Agent完成当前回答，写入Agent生成待审核候选；批准后才写入Memory。",
        };
      }
      if (blueprintVersion === 4) {
        return {
          title: "只查询 Memory 后回答",
          description: "检索Agent筛选相关记忆，执行Agent使用冻结上下文回答，不写入Memory。",
        };
      }
      if (blueprintVersion === 3) {
        return {
          title: "Memory Agent 增强执行",
          description: "检索Agent筛选相关记忆，执行Agent完成任务，写入Agent产生待审核候选。",
        };
      }
      if (blueprintVersion === 2) {
        return {
          title: "Memory 增强执行 Agent",
          description: "查询并冻结相关记忆，执行Agent，再按本次配置写回Memory。",
        };
      }
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
    definitions: workflowDefinitionsV3DtoSchema.parse({
      schemaVersion: WORKFLOW_PRODUCT_API_V3_SCHEMA_VERSION,
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
    summary: workflowRunConfigSummaryV3DtoSchema.parse({
      schemaVersion: WORKFLOW_PRODUCT_API_V3_SCHEMA_VERSION,
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
): WorkflowDefinitionPublishedV3Dto {
  const definition = snapshot.entities.workflowDefinitions[revision.workflowDefinitionId];
  if (definition === undefined) throw notFound("Workflow Definition不存在");
  const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get(
    revision.blueprintKey,
    revision.blueprintVersion,
  );
  return {
    schemaVersion: WORKFLOW_PRODUCT_API_V3_SCHEMA_VERSION,
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
      const overrideRule = blueprint?.perRunOverrides.find(
        (rule) => rule.nodeType === node.nodeType,
      );
      const publicConfigFields = descriptor?.publicConfigFields ?? [];
      const agentBinding = isPromptBearingNodeType(node.nodeType)
        ? agentNodeBindingDescriptor(node.nodeType, node.config)
        : undefined;
      return {
        definitionNodeId: node.definitionNodeId,
        nodeType: node.nodeType,
        schemaVersion: node.schemaVersion,
        displayName: descriptor?.displayName ?? node.definitionNodeId,
        optional: blueprint?.optionalNodeTypes.includes(node.nodeType) ?? false,
        defaultActivation: node.defaultActivation ?? "enabled",
        publicConfigFields: publicConfigFields.map((field) =>
          "options" in field ? { ...field, options: [...field.options] } : { ...field },
        ),
        runConfigFields: publicConfigFields
          .filter((field) => (overrideRule?.configFields ?? []).includes(field.name))
          .map((field) =>
            configuredPublicField(
              field,
              field.name === "agentKey" ? agentBinding?.agentKey : node.config[field.name],
            ),
          ),
        ...(agentBinding === undefined ? {} : { agentBinding }),
      };
    }),
    publishedAt: revision.publishedAt ?? revision.createdAt,
    updatedAt: revision.updatedAt,
  };
}

/** Definition节点的真实默认值优先于Catalog模板；类型不一致表示部署代码自身漂移。 */
function configuredPublicField(
  field: PublicConfigField,
  configuredDefault: unknown,
): WorkflowDefinitionPublishedV3Dto["nodes"][number]["runConfigFields"][number] {
  if (field.type === "boolean") {
    if (configuredDefault !== undefined && typeof configuredDefault !== "boolean") {
      throw new Error(`Workflow节点配置默认值类型错误:${field.name}`);
    }
    return { ...field, defaultValue: configuredDefault ?? field.defaultValue };
  }
  if (field.type === "enum_select" || field.type === "review_mode") {
    if (configuredDefault !== undefined && typeof configuredDefault !== "string") {
      throw new Error(`Workflow节点配置默认值类型错误:${field.name}`);
    }
    return {
      ...field,
      options: [...field.options],
      defaultValue: configuredDefault ?? field.defaultValue,
    };
  }
  if (field.type === "bounded_integer") {
    if (configuredDefault !== undefined && typeof configuredDefault !== "number") {
      throw new Error(`Workflow节点配置默认值类型错误:${field.name}`);
    }
    return { ...field, defaultValue: configuredDefault ?? field.defaultValue };
  }
  if (field.type === "short_text" || field.type === "long_text") {
    if (configuredDefault !== undefined && typeof configuredDefault !== "string") {
      throw new Error(`Workflow节点配置默认值类型错误:${field.name}`);
    }
    return { ...field, defaultValue: configuredDefault ?? field.defaultValue };
  }
  return "options" in field ? { ...field, options: [...field.options] } : { ...field };
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
