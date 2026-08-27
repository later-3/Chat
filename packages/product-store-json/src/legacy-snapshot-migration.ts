import { createEmptySnapshot, productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import {
  createSystemDirectAgentDefinition,
  createSystemMemoryAgentDirectDefinition,
  createSystemMemoryDirectDefinition,
  createSystemMemoryPlanningDefinition,
  createSystemMemoryReadDirectDefinition,
  createSystemMemoryWriteDirectDefinition,
  createSystemNoteDefinition,
  createSystemPlanningDefinition,
  createSystemSimplePlanningDefinition,
} from "@chat/application/workflow-system-definitions";
import type { z } from "zod";

const LEGACY_STORE_VERSION = /^chat-product-store\.v(?:1[0-9]|2[0-6])$/u;
const RETIRED_PRE_V10_STORE_VERSION = /^chat-product-store\.v[1-9]$/u;

type SnapshotSeed = ReturnType<typeof createSystemPlanningDefinition>;
type SnapshotSeedFactory = (createdAt: string) => SnapshotSeed;

/**
 * Project 删除后的唯一历史兼容入口。
 *
 * 旧 Store 仍可能包含 Project 实体、Project Command Receipt 和
 * `project_bootstrap` Prompt Assembly。迁移只保留仍属于当前 Chat 产品的事实，
 * 然后补齐当前系统 Workflow；它不会把旧 Project 对象映射成新的产品对象。
 */
export function migrateLegacyProductSnapshot(input: unknown): ProductSnapshot {
  if (isRecord(input) && RETIRED_PRE_V10_STORE_VERSION.test(String(input["schemaVersion"] ?? ""))) {
    throw new Error("Product Store v1-v9已退役，请先使用备份分支升级到v10或更高版本");
  }
  if (!isRecord(input) || !LEGACY_STORE_VERSION.test(String(input["schemaVersion"] ?? ""))) {
    throw new Error("不是受支持的历史Product Store");
  }
  const storeRevision = input["storeRevision"];
  const committedAt = input["committedAt"];
  const sourceEntities = input["entities"];
  if (
    !Number.isSafeInteger(storeRevision) ||
    Number(storeRevision) < 0 ||
    typeof committedAt !== "string" ||
    !isRecord(sourceEntities)
  ) {
    throw new Error("历史Product Store顶层合同非法");
  }
  const retiredGraph = findRetiredProjectRunGraph(sourceEntities);
  assertNoEmbeddedProjectEvidence(sourceEntities, retiredGraph);
  assertNoRetiredRunMessages(sourceEntities, retiredGraph);

  const migrated = createEmptySnapshot(committedAt);
  const targetEntities = migrated.entities as unknown as Record<string, unknown>;
  const entitySchemas = productSnapshotSchema.shape.entities.shape as unknown as Record<
    string,
    z.ZodType
  >;
  for (const [collection, schema] of Object.entries(entitySchemas)) {
    const source = isRecord(sourceEntities[collection]) ? sourceEntities[collection] : {};
    const candidate = withoutRetiredProjectRunFacts(collection, source, retiredGraph);
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`历史Product Store集合无法迁移:${collection}`);
    }
    targetEntities[collection] = parsed.data;
  }

  const receipts = productSnapshotSchema.shape.commandReceipts.safeParse(
    retireRemovedFeatureReceipts(input["commandReceipts"], retiredGraph),
  );
  const outbox = productSnapshotSchema.shape.outbox.safeParse(
    removeSettledRetiredOutbox(input["outbox"], retiredGraph),
  );
  if (!receipts.success || !outbox.success) {
    throw new Error("历史Product Store命令或Outbox事实无法迁移");
  }

  const candidate = {
    ...migrated,
    storeRevision: Number(storeRevision),
    commandReceipts: receipts.data,
    outbox: outbox.data,
  };
  installCurrentSystemDefinitions(candidate, committedAt);
  return productSnapshotSchema.parse(candidate);
}

function installCurrentSystemDefinitions(snapshot: ProductSnapshot, committedAt: string): void {
  const factories: readonly SnapshotSeedFactory[] = [
    createSystemPlanningDefinition,
    createSystemSimplePlanningDefinition,
    createSystemMemoryPlanningDefinition,
    createSystemNoteDefinition,
    createSystemDirectAgentDefinition,
    createSystemMemoryDirectDefinition,
    createSystemMemoryAgentDirectDefinition,
    createSystemMemoryReadDirectDefinition,
    createSystemMemoryWriteDirectDefinition,
  ];
  for (const create of factories) {
    const probe = create(committedAt);
    const existingDefinition =
      snapshot.entities.workflowDefinitions[probe.definition.workflowDefinitionId];
    const createdAt = existingDefinition?.createdAt ?? committedAt;
    const seed = createdAt === committedAt ? probe : create(createdAt);
    const existingRevision =
      snapshot.entities.workflowDefinitionRevisions[seed.revision.workflowDefinitionRevisionId];
    const existingView =
      snapshot.entities.workflowViewDefinitions[seed.view.workflowViewDefinitionId];
    if (
      existingDefinition?.publishedRevisionId === seed.revision.workflowDefinitionRevisionId &&
      existingRevision !== undefined &&
      existingView !== undefined
    ) {
      continue;
    }
    snapshot.entities.workflowDefinitions[seed.definition.workflowDefinitionId] = seed.definition;
    snapshot.entities.workflowDefinitionRevisions[seed.revision.workflowDefinitionRevisionId] =
      seed.revision;
    snapshot.entities.workflowViewDefinitions[seed.view.workflowViewDefinitionId] = seed.view;
  }
}

interface RetiredRunGraph {
  readonly runIds: ReadonlySet<string>;
  readonly workflowRunSpecIds: ReadonlySet<string>;
  readonly workflowNodeRunIds: ReadonlySet<string>;
}

function findRetiredProjectRunGraph(sourceEntities: Record<string, unknown>): RetiredRunGraph {
  const promptAssemblies = isRecord(sourceEntities["promptAssemblies"])
    ? sourceEntities["promptAssemblies"]
    : {};
  const runIds = new Set<string>();
  for (const value of Object.values(promptAssemblies)) {
    if (!isRecord(value) || !isRecord(value["tools"])) continue;
    if (value["tools"]["capabilityMode"] === "project_bootstrap") {
      addString(runIds, value["productRunId"]);
    }
  }

  const workflowRunSpecIds = new Set<string>();
  const runs = isRecord(sourceEntities["runs"]) ? sourceEntities["runs"] : {};
  for (const [key, value] of Object.entries(runs)) {
    if (!runIds.has(key) && (!isRecord(value) || !runIds.has(String(value["productRunId"])))) {
      continue;
    }
    if (isRecord(value)) addString(workflowRunSpecIds, value["workflowRunSpecId"]);
  }
  const runSpecs = isRecord(sourceEntities["workflowRunSpecs"])
    ? sourceEntities["workflowRunSpecs"]
    : {};
  for (const [key, value] of Object.entries(runSpecs)) {
    if (isRecord(value) && runIds.has(String(value["productRunId"]))) {
      workflowRunSpecIds.add(key);
      addString(workflowRunSpecIds, value["workflowRunSpecId"]);
    }
  }

  const workflowNodeRunIds = new Set<string>();
  const nodeRuns = isRecord(sourceEntities["workflowNodeRuns"])
    ? sourceEntities["workflowNodeRuns"]
    : {};
  for (const [key, value] of Object.entries(nodeRuns)) {
    if (isRecord(value) && runIds.has(String(value["productRunId"]))) {
      workflowNodeRunIds.add(key);
      addString(workflowNodeRunIds, value["workflowNodeRunId"]);
    }
  }
  return { runIds, workflowRunSpecIds, workflowNodeRunIds };
}

function withoutRetiredProjectRunFacts(
  collection: string,
  source: Record<string, unknown>,
  graph: RetiredRunGraph,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => {
      if (collection === "runs" && graph.runIds.has(key)) return false;
      if (collection === "workflowRunSpecs" && graph.workflowRunSpecIds.has(key)) return false;
      if (collection === "workflowNodeRuns" && graph.workflowNodeRunIds.has(key)) return false;
      if (!isRecord(value)) return true;
      if (
        graph.runIds.has(String(value["productRunId"])) ||
        graph.runIds.has(String(value["sourceRunId"])) ||
        graph.workflowRunSpecIds.has(String(value["workflowRunSpecId"])) ||
        graph.workflowNodeRunIds.has(String(value["workflowNodeRunId"]))
      ) {
        return false;
      }
      return true;
    }),
  );
}

function retireRemovedFeatureReceipts(
  input: unknown,
  graph: RetiredRunGraph,
): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const retiredIds = new Set([
    ...graph.runIds,
    ...graph.workflowRunSpecIds,
    ...graph.workflowNodeRunIds,
  ]);
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (!isRecord(value)) return [key, value];
      const commandType = value["commandType"];
      const retired =
        (typeof commandType === "string" && commandType.toLowerCase().includes("project")) ||
        containsIdentity(value, retiredIds);
      return retired
        ? [
            key,
            {
              ...value,
              commandType: "RetiredFeatureCommand",
              resultRefs: {},
            },
          ]
        : [key, value];
    }),
  );
}

function removeSettledRetiredOutbox(
  input: unknown,
  graph: RetiredRunGraph,
): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const retiredIds = new Set([
    ...graph.runIds,
    ...graph.workflowRunSpecIds,
    ...graph.workflowNodeRunIds,
  ]);
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (!isRecord(value)) return true;
      const kind = value["kind"];
      const retired =
        (typeof kind === "string" && kind.toLowerCase().includes("project")) ||
        containsIdentity(value, retiredIds);
      if (!retired) return true;
      if (["acknowledged", "failed_terminal"].includes(String(value["status"]))) return false;
      throw new Error("历史Project Outbox尚未收敛，请先使用备份分支完成取消或对账");
    }),
  );
}

function containsIdentity(value: unknown, identities: ReadonlySet<string>): boolean {
  if (typeof value === "string") return identities.has(value);
  if (Array.isArray(value)) return value.some((item) => containsIdentity(item, identities));
  if (!isRecord(value)) return false;
  return Object.values(value).some((item) => containsIdentity(item, identities));
}

function addString(target: Set<string>, value: unknown): void {
  if (typeof value === "string") target.add(value);
}

function assertNoRetiredRunMessages(
  sourceEntities: Record<string, unknown>,
  graph: RetiredRunGraph,
): void {
  const messages = isRecord(sourceEntities["messages"]) ? sourceEntities["messages"] : {};
  if (
    Object.values(messages).some(
      (value) => isRecord(value) && graph.runIds.has(String(value["sourceRunId"])),
    )
  ) {
    throw new Error("已退役Run仍有正式Message，请先使用备份分支导出或归档这些历史结果");
  }
}

function assertNoEmbeddedProjectEvidence(
  sourceEntities: Record<string, unknown>,
  graph: RetiredRunGraph,
): void {
  const executionContracts = isRecord(sourceEntities["executionContracts"])
    ? sourceEntities["executionContracts"]
    : {};
  for (const value of Object.values(executionContracts)) {
    if (!isRecord(value) || !isRecord(value["workspaceRef"])) continue;
    if (graph.runIds.has(String(value["productRunId"]))) continue;
    const workspaceRef = value["workspaceRef"];
    if (
      ["projectId", "projectResourceId", "revision"].some((key) => workspaceRef[key] !== undefined)
    ) {
      throw new Error("历史执行证据仍绑定已退役Project，请先使用备份分支导出或归档这些历史证据");
    }
  }

  const attempts = isRecord(sourceEntities["attempts"]) ? sourceEntities["attempts"] : {};
  if (
    Object.values(attempts).some(
      (value) =>
        isRecord(value) &&
        !graph.runIds.has(String(value["productRunId"])) &&
        (value["planningProjectContextId"] !== undefined ||
          value["planningProjectContextSha256"] !== undefined),
    )
  ) {
    throw new Error(
      "历史Attempt仍绑定已退役Project Context，请先使用备份分支导出或归档这些历史证据",
    );
  }

  const ruleRevisions = isRecord(sourceEntities["ruleRevisions"])
    ? sourceEntities["ruleRevisions"]
    : {};
  const ruleSelections = isRecord(sourceEntities["ruleSelections"])
    ? sourceEntities["ruleSelections"]
    : {};
  if (
    Object.values(ruleRevisions).some(hasEmbeddedProjectRuleFact) ||
    Object.values(ruleSelections).some(hasEmbeddedProjectRuleFact)
  ) {
    throw new Error("历史Rule仍绑定已退役Project，请先使用备份分支解除作用域后再升级");
  }
}

function hasEmbeddedProjectRuleFact(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value["scenario"] === "string" &&
    value["scenario"].toLowerCase().includes("project")
  ) {
    return true;
  }
  const scope = value["scope"];
  const scopes = value["scopes"];
  const context = value["context"];
  if (
    [scope, context, ...(Array.isArray(scopes) ? scopes : [])].some(
      (candidate) =>
        isRecord(candidate) &&
        ["projectId", "projectMethodProfileId", "projectStageKey"].some(
          (key) => candidate[key] !== undefined,
        ),
    )
  ) {
    return true;
  }
  const sourceCases = value["sourceCases"];
  return (
    Array.isArray(sourceCases) &&
    sourceCases.some((candidate) => isRecord(candidate) && candidate["kind"] === "project_decision")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
