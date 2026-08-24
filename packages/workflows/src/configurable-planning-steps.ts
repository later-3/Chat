import { FatalError } from "workflow";
import {
  DEFAULT_NODE_CATALOG,
  DEFAULT_WORKFLOW_BLUEPRINTS,
  validateDefinitionAgainstBlueprint,
} from "@chat/application";
import { workflowRunSpecSchema, type WorkflowRunSpec } from "@chat/contracts";
import {
  WORKFLOW_KERNEL_LIMITS,
  canonicalJsonStringify,
  hashCanonical,
  sha256Hex,
  validateWorkflowStructure,
} from "@chat/domain";
import {
  CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
  CONFIGURABLE_PLANNING_RUNNER_FAMILY,
  DEFINITION_KERNEL_EXECUTORS,
  NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
  NOTE_CAPTURE_RUNNER_FAMILY,
  MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_DIRECT_RUNNER_FAMILY,
  MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
} from "./definition-kernel-executor-registry.js";
import { getWorkflowRuntimeContext } from "./runtime-context.js";
import { wrapApiError } from "./workflow-step-support.js";

export interface ConfigurablePlanningNodeTransition {
  readonly commandId: string;
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly definitionNodeId: string;
  readonly executionPath: readonly {
    readonly containerNodeId: string;
    readonly iteration: number;
  }[];
  readonly attemptNumber: number;
  readonly toStatus:
    | "running"
    | "waiting_human"
    | "skipped"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "outcome_unknown";
  readonly outcomeCode?: string | undefined;
  readonly publicSummary: string;
}

/**
 * RunSpec只经私有Application Query按Product Run身份读取。这里再次做Schema、Hash、
 * Runner bundle、Executor manifest、Blueprint和结构预算校验，篡改在第一个业务节点前关闭。
 */
export async function loadConfigurablePlanningRunSpecStep(input: {
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
}): Promise<WorkflowRunSpec> {
  "use step";
  return loadRestrictedRunSpec(input, {
    runnerFamily: CONFIGURABLE_PLANNING_RUNNER_FAMILY,
    runnerBundleVersion: CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
    blueprintKey: "planning",
  });
}

/** Note与Planning使用同一RunSpec完整性门，仅冻结family/blueprint期望值不同。 */
export async function loadNoteCaptureRunSpecStep(input: {
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
}): Promise<WorkflowRunSpec> {
  "use step";
  const runSpec = await loadRestrictedRunSpec(input, {
    runnerFamily: NOTE_CAPTURE_RUNNER_FAMILY,
    runnerBundleVersion: NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
    blueprintKey: "note",
  });
  if (runSpec.businessInput?.kind !== "note_capture") {
    throw new FatalError("run_spec.business_input_incompatible");
  }
  return runSpec;
}

/** Memory Direct使用独立runner family与direct@2 Blueprint，且首版只解释固定三节点序列。 */
export async function loadMemoryDirectRunSpecStep(input: {
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
}): Promise<WorkflowRunSpec> {
  "use step";
  const runSpec = await loadRestrictedRunSpec(input, {
    runnerFamily: MEMORY_DIRECT_RUNNER_FAMILY,
    runnerBundleVersion: MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
    blueprintKey: "direct",
  });
  if (runSpec.businessInput?.kind !== "direct_agent_message") {
    throw new FatalError("run_spec.business_input_incompatible");
  }
  const elements = runSpec.semanticRoot.elements;
  if (
    elements.length !== 3 ||
    elements[0]?.kind !== "task" ||
    elements[0].nodeType !== "memory.query" ||
    elements[1]?.kind !== "composite" ||
    elements[1].nodeType !== "agent.direct" ||
    elements[2]?.kind !== "task" ||
    elements[2].nodeType !== "memory.write"
  ) {
    throw new FatalError("run_spec.memory_direct_sequence_incompatible");
  }
  return runSpec;
}

/** Memory Agent Direct family承载完整、只读和只整理三种固定节点组合。 */
export async function loadMemoryAgentDirectRunSpecStep(input: {
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
}): Promise<WorkflowRunSpec> {
  "use step";
  const runSpec = await loadRestrictedRunSpec(input, {
    runnerFamily: MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
    runnerBundleVersion: MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
    blueprintKey: "direct",
  });
  if (
    runSpec.businessInput?.kind !== "direct_agent_message" ||
    ![3, 4, 5].includes(runSpec.definitionRef.blueprintVersion)
  ) {
    throw new FatalError("run_spec.business_input_incompatible");
  }
  const elements = runSpec.semanticRoot.elements;
  const nodeTypes = elements.map((element) =>
    "nodeType" in element ? element.nodeType : element.kind,
  );
  const expected =
    runSpec.definitionRef.blueprintVersion === 3
      ? ["agent.memory_retrieve", "agent.direct", "agent.memory_write"]
      : runSpec.definitionRef.blueprintVersion === 4
        ? ["agent.memory_retrieve", "agent.direct"]
        : ["agent.direct", "agent.memory_write"];
  if (
    JSON.stringify(nodeTypes) !== JSON.stringify(expected) ||
    elements.some(
      (element) =>
        !("nodeType" in element) ||
        (element.nodeType === "agent.direct"
          ? element.kind !== "composite"
          : element.kind !== "task"),
    )
  ) {
    throw new FatalError("run_spec.memory_agent_direct_sequence_incompatible");
  }
  return runSpec;
}

async function loadRestrictedRunSpec(
  input: { readonly productRunId: string; readonly workflowRunSpecId: string },
  expected: {
    readonly runnerFamily: string;
    readonly runnerBundleVersion: string;
    readonly blueprintKey: "planning" | "note" | "direct";
  },
): Promise<WorkflowRunSpec> {
  let response: { readonly runSpec: WorkflowRunSpec };
  try {
    response = await getWorkflowRuntimeContext().api.loadWorkflowRunSpec({
      productRunId: input.productRunId as never,
      workflowRunSpecId: input.workflowRunSpecId as never,
    });
  } catch (error) {
    wrapApiError(error);
  }
  const parsed = workflowRunSpecSchema.safeParse(response.runSpec);
  if (!parsed.success) throw new FatalError("run_spec.schema_invalid");
  const runSpec = parsed.data;
  const { sha256 } = runSpec;
  const hashPayload = { ...runSpec } as Record<string, unknown>;
  for (const key of ["schemaVersion", "workflowRunSpecId", "productRunId", "sha256", "createdAt"]) {
    delete hashPayload[key];
  }
  if (hashCanonical("workflow-run-spec.v1", hashPayload) !== sha256) {
    throw new FatalError("run_spec.hash_mismatch");
  }
  if (
    runSpec.productRunId !== input.productRunId ||
    runSpec.workflowRunSpecId !== input.workflowRunSpecId
  ) {
    throw new FatalError("run_spec.identity_mismatch");
  }
  if (
    runSpec.runner.runnerFamily !== expected.runnerFamily ||
    runSpec.runner.runnerBundleVersion !== expected.runnerBundleVersion
  ) {
    throw new FatalError("run_spec.runner_version_incompatible");
  }
  if (runSpec.definitionRef.blueprintKey !== expected.blueprintKey) {
    throw new FatalError("run_spec.blueprint_incompatible");
  }
  if (canonicalJsonStringify(runSpec.limits) !== canonicalJsonStringify(WORKFLOW_KERNEL_LIMITS)) {
    throw new FatalError("run_spec.limits_incompatible");
  }
  const expectedManifest = new Map(
    DEFINITION_KERNEL_EXECUTORS.manifest().map((entry) => [
      `${entry.nodeType}@${String(entry.schemaVersion)}`,
      entry.executorVersion,
    ]),
  );
  const actualManifest = new Map(
    runSpec.executorManifest.map((entry) => [
      `${entry.nodeType}@${String(entry.schemaVersion)}`,
      entry.executorVersion,
    ]),
  );
  if (actualManifest.size !== runSpec.executorManifest.length) {
    throw new FatalError("run_spec.executor_manifest_duplicate");
  }
  const semanticNodes = collectSemanticNodes(runSpec);
  const resolutionById = new Map(
    runSpec.nodeResolutions.map((node) => [node.definitionNodeId, node]),
  );
  if (
    semanticNodes.size !== runSpec.nodeResolutions.length ||
    resolutionById.size !== runSpec.nodeResolutions.length
  ) {
    throw new FatalError("run_spec.node_resolution_set_mismatch");
  }
  for (const [definitionNodeId, semanticNode] of semanticNodes) {
    const node = resolutionById.get(definitionNodeId);
    if (
      node === undefined ||
      node.nodeType !== semanticNode.nodeType ||
      node.schemaVersion !== semanticNode.schemaVersion ||
      canonicalJsonStringify(node.config) !== canonicalJsonStringify(semanticNode.config)
    ) {
      throw new FatalError("run_spec.node_resolution_mismatch");
    }
    const key = `${node.nodeType}@${String(node.schemaVersion)}`;
    if (expectedManifest.get(key) !== actualManifest.get(key)) {
      throw new FatalError("run_spec.executor_manifest_incompatible");
    }
  }
  const structure = validateWorkflowStructure(runSpec.semanticRoot, {
    outcomesFor: (nodeType, schemaVersion) =>
      DEFAULT_NODE_CATALOG.get(nodeType, schemaVersion)?.outcomes,
  });
  const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get(
    runSpec.definitionRef.blueprintKey,
    runSpec.definitionRef.blueprintVersion,
  );
  if (blueprint === undefined) throw new FatalError("run_spec.blueprint_incompatible");
  if (
    structure.diagnostics.length > 0 ||
    validateDefinitionAgainstBlueprint(runSpec.semanticRoot, blueprint, DEFAULT_NODE_CATALOG)
      .length > 0
  ) {
    throw new FatalError("run_spec.semantic_structure_invalid");
  }
  return runSpec;
}

function collectSemanticNodes(runSpec: WorkflowRunSpec): ReadonlyMap<
  string,
  {
    readonly nodeType: WorkflowRunSpec["nodeResolutions"][number]["nodeType"];
    readonly schemaVersion: number;
    readonly config: Readonly<Record<string, unknown>>;
  }
> {
  const nodes = new Map<
    string,
    {
      readonly nodeType: WorkflowRunSpec["nodeResolutions"][number]["nodeType"];
      readonly schemaVersion: number;
      readonly config: Readonly<Record<string, unknown>>;
    }
  >();
  const stack = [...runSpec.semanticRoot.elements];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (element.kind === "sequence") stack.push(...element.elements);
    else if (element.kind === "choice") {
      for (const branch of element.branches) stack.push(...branch.body.elements);
    } else if (element.kind === "bounded_loop") stack.push(...element.body.elements);
    else {
      if (nodes.has(element.definitionNodeId)) {
        throw new FatalError("run_spec.semantic_node_duplicate");
      }
      nodes.set(element.definitionNodeId, {
        nodeType: element.nodeType,
        schemaVersion: element.schemaVersion,
        config: element.config,
      });
    }
  }
  return nodes;
}

/** 每个Step使用稳定commandId提交S1 Node Run投影；Workflow重放只会命中同一Receipt。 */
export async function recordConfigurablePlanningNodeStep(
  input: Omit<ConfigurablePlanningNodeTransition, "commandId">,
): Promise<void> {
  "use step";
  try {
    await getWorkflowRuntimeContext().api.transitionConfigurablePlanningNode({
      commandId: `cmd_${sha256Hex(
        [
          input.workflowRunSpecId,
          input.productRunId,
          input.definitionNodeId,
          canonicalJsonStringify(input.executionPath),
          String(input.attemptNumber),
          input.toStatus,
          input.outcomeCode ?? "",
        ].join("\0"),
      ).slice(0, 32)}`,
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
      definitionNodeId: input.definitionNodeId,
      executionPath: input.executionPath,
      attemptNumber: input.attemptNumber,
      toStatus: input.toStatus,
      ...(input.outcomeCode === undefined ? {} : { outcomeCode: input.outcomeCode }),
      ...(input.publicSummary === undefined ? {} : { publicSummary: input.publicSummary }),
    } as never);
  } catch (error) {
    wrapApiError(error);
  }
}

// 节点状态命令本身虽有稳定commandId，但Store损坏/合同拒绝不应由Workflow盲目重试；
// Runtime整体重放仍会以同一commandId安全命中既有Receipt。
recordConfigurablePlanningNodeStep.maxRetries = 0;
