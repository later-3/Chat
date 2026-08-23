import { z } from "zod";
import {
  workflowExecutorManifestEntrySchema,
  workflowRunBusinessInputSchema,
  workflowRunSpecSchema,
  workflowRunnerEvidenceSchema,
  type WorkflowExecutorManifestEntry,
  type WorkflowNodeResolution,
  type WorkflowResolvedResource,
  type WorkflowReviewResolution,
  type WorkflowRunSpec,
  type WorkflowRunnerEvidence,
} from "@chat/contracts";
export type { WorkflowExecutorManifestEntry, WorkflowRunSpec } from "@chat/contracts";
import {
  WORKFLOW_KERNEL_LIMITS,
  hashCanonical,
  sortWorkflowDiagnostics,
  validateWorkflowStructure,
  type WorkflowDiagnostic,
  type WorkflowNodeTypeKey,
  type WorkflowReviewMode,
  type WorkflowSequence,
} from "@chat/domain";
import {
  DEFAULT_WORKFLOW_BLUEPRINTS,
  type WorkflowBlueprint,
  type WorkflowBlueprintRegistry,
  validateDefinitionAgainstBlueprint,
} from "./workflow-blueprints.js";
import {
  parseWorkflowDefinitionRevision,
  workflowFrozenResourceSchema,
  workflowPrincipalSnapshotSchema,
  workflowRunConfigurationSchema,
  type WorkflowDefinitionRevisionInput,
  type WorkflowFrozenResource,
  type WorkflowPrincipalSnapshot,
  type WorkflowResourceKind,
  type WorkflowRunConfiguration,
  type WorkflowRunOverride,
} from "./workflow-definition-schema.js";
import {
  DEFAULT_NODE_CATALOG,
  nodeExecutorKey,
  type NodeCatalog,
} from "./workflow-node-catalog.js";
import { normalizeWorkflowDefinition } from "./workflow-definition-normalize.js";

const policyEvidenceSchema = z.strictObject({
  resourceId: z.string().min(3).max(128),
  expectedRevision: z.number().int().min(1),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type WorkflowPolicyEvidence = z.infer<typeof policyEvidenceSchema>;

export interface CompileWorkflowRunSpecInput {
  readonly workflowRunSpecId: string;
  readonly productRunId: string;
  readonly createdAt: string;
  readonly definition: unknown;
  readonly runConfiguration: unknown;
  readonly principal: unknown;
  readonly availableResources: readonly unknown[];
  readonly executorManifest: readonly unknown[];
  readonly runner: unknown;
  readonly businessInput?: unknown;
  /** 服务端策略解析结果；浏览器不能自行提交该字段。 */
  readonly autoContinuePolicy?: unknown;
}

export type CompileWorkflowRunSpecResult =
  | { readonly success: true; readonly runSpec: WorkflowRunSpec }
  | { readonly success: false; readonly diagnostics: readonly WorkflowDiagnostic[] };

interface CompilerContext {
  readonly definition: WorkflowDefinitionRevisionInput;
  readonly configuration: WorkflowRunConfiguration;
  readonly principal: WorkflowPrincipalSnapshot;
  readonly resources: readonly WorkflowFrozenResource[];
  readonly executorManifest: readonly WorkflowExecutorManifestEntry[];
  readonly runner: WorkflowRunnerEvidence;
  readonly businessInput?: unknown;
  readonly policyEvidence?: WorkflowPolicyEvidence | undefined;
  readonly blueprint: WorkflowBlueprint;
}

/**
 * 纯Compiler严格按parse→structure→catalog→policy→resource→normalize→hash→schema推进。
 * 失败返回有限诊断，不把用户正文或任意Error.message当作业务结果。
 */
export function compileWorkflowRunSpec(
  input: CompileWorkflowRunSpecInput,
  dependencies: {
    readonly catalog?: NodeCatalog;
    readonly blueprints?: WorkflowBlueprintRegistry;
  } = {},
): CompileWorkflowRunSpecResult {
  const catalog = dependencies.catalog ?? DEFAULT_NODE_CATALOG;
  const blueprints = dependencies.blueprints ?? DEFAULT_WORKFLOW_BLUEPRINTS;
  const parsedDefinition = parseWorkflowDefinitionRevision(input.definition);
  if (!parsedDefinition.success) return parsedDefinition;

  const boundary = parseCompilerBoundaries(input, parsedDefinition.definition, blueprints);
  if (!boundary.success) return boundary;
  const context = boundary.context;

  const structure = validateWorkflowStructure(context.definition.semanticRoot, {
    outcomesFor: (nodeType, schemaVersion) => catalog.get(nodeType, schemaVersion)?.outcomes,
  });
  const blueprintDiagnostics = validateDefinitionAgainstBlueprint(
    context.definition.semanticRoot,
    context.blueprint,
    catalog,
  );
  if (structure.facts.maximumNodeExecutions > WORKFLOW_KERNEL_LIMITS.runtime.maxNodeExecutions) {
    return {
      success: false,
      diagnostics: sortWorkflowDiagnostics([
        ...structure.diagnostics,
        ...blueprintDiagnostics,
        {
          family: "limit_exceeded",
          code: "definition.maximum_execution_budget_exceeded",
          path: "$",
          params: {
            actual: structure.facts.maximumNodeExecutions,
            limit: WORKFLOW_KERNEL_LIMITS.runtime.maxNodeExecutions,
          },
        },
      ]),
    };
  }
  if (structure.diagnostics.length > 0 || blueprintDiagnostics.length > 0) {
    return {
      success: false,
      diagnostics: sortWorkflowDiagnostics([...structure.diagnostics, ...blueprintDiagnostics]),
    };
  }

  const normalized = normalizeWorkflowDefinition(context.definition.semanticRoot, catalog);
  if (!normalized.success) return normalized;
  if (
    context.definition.expectedSha256 !== undefined &&
    context.definition.expectedSha256 !== normalized.normalized.definitionSha256
  ) {
    return {
      success: false,
      diagnostics: [
        {
          family: "resource_stale",
          code: "definition.hash_stale",
          path: "$.definition.expectedSha256",
          params: {},
        },
      ],
    };
  }

  const nodeIndex = indexNodes(normalized.normalized.semanticRoot);
  const policy = resolvePolicyAndNodes(context, nodeIndex, catalog);
  if (policy.diagnostics.length > 0) {
    return { success: false, diagnostics: sortWorkflowDiagnostics(policy.diagnostics) };
  }
  const resources = resolveResources(context, nodeIndex);
  if (resources.diagnostics.length > 0) {
    return { success: false, diagnostics: sortWorkflowDiagnostics(resources.diagnostics) };
  }
  const manifestDiagnostics = validateExecutorManifest(context, nodeIndex);
  if (manifestDiagnostics.length > 0) {
    return { success: false, diagnostics: sortWorkflowDiagnostics(manifestDiagnostics) };
  }

  const definitionRef = {
    workflowDefinitionRevisionId: context.definition.workflowDefinitionRevisionId,
    definitionRevision: context.definition.definitionRevision,
    definitionSha256: normalized.normalized.definitionSha256,
    blueprintKey: context.definition.blueprintKey,
    blueprintVersion: context.definition.blueprintVersion,
  } as const;
  const executionPayload = {
    definitionRef,
    runner: context.runner,
    semanticRoot: normalized.normalized.semanticRoot,
    nodeResolutions: policy.nodeResolutions,
    resourceResolutions: resources.resolutions,
    reviewResolutions: policy.reviewResolutions,
    ...(context.businessInput !== undefined ? { businessInput: context.businessInput } : {}),
    limits: WORKFLOW_KERNEL_LIMITS,
    executorManifest: [...context.executorManifest].sort((left, right) =>
      nodeExecutorKey(left.nodeType, left.schemaVersion).localeCompare(
        nodeExecutorKey(right.nodeType, right.schemaVersion),
      ),
    ),
  };
  const candidate = {
    schemaVersion: "workflow-run-spec.v1" as const,
    workflowRunSpecId: input.workflowRunSpecId,
    productRunId: input.productRunId,
    ...executionPayload,
    sha256: hashCanonical("workflow-run-spec.v1", executionPayload),
    createdAt: input.createdAt,
  };
  const parsedRunSpec = workflowRunSpecSchema.safeParse(candidate);
  if (!parsedRunSpec.success) {
    return {
      success: false,
      diagnostics: parsedRunSpec.error.issues.slice(0, 32).map((issue) => ({
        family: "definition_invalid",
        code: `run_spec.schema.${issue.code}`,
        path: issue.path.length === 0 ? "$" : `$.${issue.path.map(String).join(".")}`,
        params: {},
      })),
    };
  }
  return { success: true, runSpec: parsedRunSpec.data };
}

export function validateWorkflowRunSpecIntegrity(
  input: unknown,
):
  | { readonly success: true; readonly runSpec: WorkflowRunSpec }
  | { readonly success: false; readonly diagnostics: readonly WorkflowDiagnostic[] } {
  const parsed = workflowRunSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      diagnostics: [
        { family: "definition_invalid", code: "run_spec.schema_invalid", path: "$", params: {} },
      ],
    };
  }
  const { sha256 } = parsed.data;
  const payload = {
    definitionRef: parsed.data.definitionRef,
    runner: parsed.data.runner,
    semanticRoot: parsed.data.semanticRoot,
    nodeResolutions: parsed.data.nodeResolutions,
    resourceResolutions: parsed.data.resourceResolutions,
    reviewResolutions: parsed.data.reviewResolutions,
    ...(parsed.data.businessInput !== undefined
      ? { businessInput: parsed.data.businessInput }
      : {}),
    limits: parsed.data.limits,
    executorManifest: parsed.data.executorManifest,
  };
  const expected = hashCanonical("workflow-run-spec.v1", payload);
  if (expected !== sha256) {
    return {
      success: false,
      diagnostics: [
        { family: "resource_stale", code: "run_spec.hash_mismatch", path: "$.sha256", params: {} },
      ],
    };
  }
  return { success: true, runSpec: parsed.data };
}

/** Run创建事务在提交前调用，拒绝Compiler读取后发生的资源revision/hash漂移。 */
export function validateRunSpecResourcesCurrent(
  runSpec: WorkflowRunSpec,
  currentResources: readonly WorkflowFrozenResource[],
): readonly WorkflowDiagnostic[] {
  const current = new Map(
    currentResources.map((resource) => [
      resourceKey(resource.resourceKind, resource.resourceId),
      resource,
    ]),
  );
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const resolution of runSpec.resourceResolutions) {
    if (resolution.resolution !== "included") continue;
    const resource = current.get(resourceKey(resolution.resourceKind, resolution.resourceId));
    if (
      resource === undefined ||
      resource.status !== "active" ||
      resource.revision !== resolution.expectedRevision ||
      resource.sha256 !== resolution.expectedSha256
    ) {
      diagnostics.push({
        family: "resource_stale",
        code: "resource.changed_before_run_create",
        path: `$.resourceResolutions.${resolution.definitionNodeId}`,
        params: { resourceKind: resolution.resourceKind, resourceId: resolution.resourceId },
      });
    }
  }
  return sortWorkflowDiagnostics(diagnostics);
}

function parseCompilerBoundaries(
  input: CompileWorkflowRunSpecInput,
  definition: WorkflowDefinitionRevisionInput,
  blueprints: WorkflowBlueprintRegistry,
):
  | { readonly success: true; readonly context: CompilerContext }
  | {
      readonly success: false;
      readonly diagnostics: readonly WorkflowDiagnostic[];
    } {
  const configuration = workflowRunConfigurationSchema.safeParse(input.runConfiguration);
  const principal = workflowPrincipalSnapshotSchema.safeParse(input.principal);
  const resources = parseContractArray(input.availableResources, 256, workflowFrozenResourceSchema);
  const manifest = parseContractArray(
    input.executorManifest,
    64,
    workflowExecutorManifestEntrySchema,
  );
  const runner = workflowRunnerEvidenceSchema.safeParse(input.runner);
  const businessInput =
    input.businessInput === undefined
      ? { success: true as const, data: undefined }
      : workflowRunBusinessInputSchema.safeParse(input.businessInput);
  const policyEvidence =
    input.autoContinuePolicy === undefined
      ? { success: true as const, data: undefined }
      : policyEvidenceSchema.safeParse(input.autoContinuePolicy);
  const blueprint = blueprints.get(definition.blueprintKey, definition.blueprintVersion);
  const invalid: string[] = [];
  if (!configuration.success) invalid.push("run_configuration");
  if (!principal.success) invalid.push("principal");
  if (!resources.success) invalid.push("resources");
  if (!manifest.success) invalid.push("executor_manifest");
  if (!runner.success) invalid.push("runner");
  if (!businessInput.success) invalid.push("business_input");
  if (!policyEvidence.success) invalid.push("auto_continue_policy");
  if (blueprint === undefined) invalid.push("blueprint");
  if (
    invalid.length > 0 ||
    !configuration.success ||
    !principal.success ||
    !resources.success ||
    !manifest.success ||
    !runner.success ||
    !businessInput.success ||
    !policyEvidence.success ||
    blueprint === undefined
  ) {
    return {
      success: false,
      diagnostics: invalid.sort().map((boundary) => ({
        family: "definition_invalid",
        code: "compiler.boundary_invalid",
        path: `$.${boundary}`,
        params: { boundary },
      })),
    };
  }
  if (businessInput.data !== undefined) {
    const expected =
      definition.blueprintKey === "note"
        ? { inputKind: "note_capture", runnerFamily: "note-capture.v1" }
        : definition.blueprintKey === "direct"
          ? {
              inputKind: "direct_agent_message",
              runnerFamily:
                definition.blueprintVersion === 3
                  ? "memory-agent-direct.v1"
                  : definition.blueprintVersion === 2
                    ? "memory-direct.v1"
                    : "direct-agent.v1",
            }
          : { inputKind: "planning_message", runnerFamily: "configurable-planning.v1" };
    if (
      businessInput.data.kind !== expected.inputKind ||
      runner.data.runnerFamily !== expected.runnerFamily
    ) {
      return {
        success: false,
        diagnostics: [
          {
            family: "definition_invalid",
            code: "compiler.business_input_runner_mismatch",
            path: "$.businessInput",
            params: {
              blueprintKey: definition.blueprintKey,
              runnerFamily: runner.data.runnerFamily,
            },
          },
        ],
      };
    }
  }
  return {
    success: true,
    context: {
      definition,
      configuration: configuration.data,
      principal: principal.data,
      resources: resources.data,
      executorManifest: manifest.data,
      runner: runner.data,
      businessInput: businessInput.data,
      policyEvidence: policyEvidence.data,
      blueprint,
    },
  };
}

function parseContractArray<T>(
  input: readonly unknown[],
  maxItems: number,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
): { success: true; data: T[] } | { success: false } {
  if (!Array.isArray(input) || input.length > maxItems) return { success: false };
  const parsed: T[] = [];
  for (const item of input) {
    const result = schema.safeParse(item);
    if (!result.success) return { success: false };
    parsed.push(result.data);
  }
  return { success: true, data: parsed };
}

interface IndexedNode {
  readonly definitionNodeId: string;
  readonly nodeType: WorkflowNodeTypeKey;
  readonly schemaVersion: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly defaultActivation: "enabled" | "skipped";
  readonly path: string;
}

function indexNodes(root: WorkflowSequence): ReadonlyMap<string, IndexedNode> {
  const result = new Map<string, IndexedNode>();
  const stack: {
    readonly element: WorkflowSequence["elements"][number] | WorkflowSequence;
    readonly path: string;
  }[] = [{ element: root, path: "$" }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const element = frame.element;
    if (element.kind === "task" || element.kind === "composite") {
      result.set(element.definitionNodeId, {
        definitionNodeId: element.definitionNodeId,
        nodeType: element.nodeType,
        schemaVersion: element.schemaVersion,
        config: element.config,
        defaultActivation: element.defaultActivation ?? "enabled",
        path: frame.path,
      });
    } else if (element.kind === "sequence") {
      for (let index = element.elements.length - 1; index >= 0; index -= 1) {
        const child = element.elements[index];
        if (child !== undefined)
          stack.push({ element: child, path: `${frame.path}.elements[${String(index)}]` });
      }
    } else if (element.kind === "choice") {
      for (let index = element.branches.length - 1; index >= 0; index -= 1) {
        const branch = element.branches[index];
        if (branch !== undefined)
          stack.push({
            element: branch.body,
            path: `${frame.path}.branches[${String(index)}].body`,
          });
      }
    } else {
      stack.push({ element: element.body, path: `${frame.path}.body` });
    }
  }
  return result;
}

function resolvePolicyAndNodes(
  context: CompilerContext,
  nodes: ReadonlyMap<string, IndexedNode>,
  catalog: NodeCatalog,
): {
  readonly nodeResolutions: readonly WorkflowNodeResolution[];
  readonly reviewResolutions: readonly WorkflowReviewResolution[];
  readonly diagnostics: readonly WorkflowDiagnostic[];
} {
  const diagnostics: WorkflowDiagnostic[] = [];
  const overrideKeys = new Set<string>();
  const enabled = new Map<string, boolean>();
  const reviewModes = new Map<string, WorkflowReviewMode>();
  const nodeConfigValues = new Map<string, Map<string, boolean | string | number>>();
  const agentConfigurations = new Map<
    string,
    Extract<WorkflowRunOverride, { kind: "agent_configuration" }>
  >();
  for (const override of context.configuration.overrides) {
    const key = overrideIdentity(override);
    if (overrideKeys.has(key)) {
      diagnostics.push(
        policyDiagnostic(
          "run_configuration.duplicate_override",
          `$.overrides.${override.definitionNodeId}`,
          { kind: override.kind },
        ),
      );
      continue;
    }
    overrideKeys.add(key);
    const node = nodes.get(override.definitionNodeId);
    if (node === undefined) {
      diagnostics.push(
        policyDiagnostic(
          "run_configuration.unknown_node",
          `$.overrides.${override.definitionNodeId}`,
          {},
        ),
      );
      continue;
    }
    const overrideRule = context.blueprint.perRunOverrides.find(
      (rule) => rule.nodeType === node.nodeType,
    );
    if (override.kind === "agent_configuration") {
      if (node.nodeType !== "agent.direct") {
        diagnostics.push(
          policyDiagnostic(
            "run_configuration.override_not_allowed",
            `$.overrides.${override.definitionNodeId}`,
            { field: "agentConfiguration" },
          ),
        );
        continue;
      }
      agentConfigurations.set(override.definitionNodeId, override);
      continue;
    }
    if (override.kind === "node_config") {
      if (!(overrideRule?.configFields ?? []).includes(override.field)) {
        diagnostics.push(
          policyDiagnostic(
            "run_configuration.override_not_allowed",
            `$.overrides.${override.definitionNodeId}.${override.field}`,
            { field: override.field },
          ),
        );
        continue;
      }
      const values = nodeConfigValues.get(override.definitionNodeId) ?? new Map();
      values.set(override.field, override.value);
      nodeConfigValues.set(override.definitionNodeId, values);
      continue;
    }
    const allowed = overrideRule?.fields ?? [];
    const field =
      override.kind === "node_enabled"
        ? "enabled"
        : override.kind === "review_mode"
          ? "reviewMode"
          : "selection";
    if (!allowed.includes(field)) {
      diagnostics.push(
        policyDiagnostic(
          "run_configuration.override_not_allowed",
          `$.overrides.${override.definitionNodeId}`,
          { field },
        ),
      );
      continue;
    }
    if (override.kind === "node_enabled") enabled.set(override.definitionNodeId, override.enabled);
    if (override.kind === "review_mode")
      reviewModes.set(override.definitionNodeId, override.reviewMode);
  }

  const nodeResolutions: WorkflowNodeResolution[] = [];
  const reviewResolutions: WorkflowReviewResolution[] = [];
  for (const node of [...nodes.values()].sort((left, right) =>
    left.definitionNodeId.localeCompare(right.definitionNodeId),
  )) {
    const descriptor = catalog.get(node.nodeType, node.schemaVersion);
    if (descriptor === undefined) continue;
    const configCandidate: Record<string, unknown> = { ...node.config };
    for (const [field, value] of nodeConfigValues.get(node.definitionNodeId) ?? []) {
      configCandidate[field] = value;
    }
    const agentConfiguration = agentConfigurations.get(node.definitionNodeId);
    if (agentConfiguration?.configurationMode === "version") {
      configCandidate["agentVersionId"] = agentConfiguration.agentVersionId;
      configCandidate["agentVersionSha256"] = agentConfiguration.agentVersionSha256;
      // 本次会话显式选择完整Agent Version时，历史Workflow的单段Prompt覆盖不能继续
      // 以更高优先级生效，否则UI显示Version而Provider仍收到旧Prompt。
      delete configCandidate["agentPromptOverride"];
      delete configCandidate["agentTemporaryConfiguration"];
    } else if (agentConfiguration?.configurationMode === "temporary") {
      delete configCandidate["agentVersionId"];
      delete configCandidate["agentVersionSha256"];
      delete configCandidate["agentPromptOverride"];
      configCandidate["capabilityMode"] = "custom";
      configCandidate["enabledToolNames"] = agentConfiguration.enabledToolNames;
      configCandidate["resourcePolicy"] = agentConfiguration.resources;
      configCandidate["agentTemporaryConfiguration"] = {
        runtime: agentConfiguration.runtime,
        systemPrompt: agentConfiguration.systemPrompt,
        enabledToolNames: agentConfiguration.enabledToolNames,
        resources: agentConfiguration.resources,
        ...(agentConfiguration.basedOnVersionId === undefined
          ? {}
          : {
              basedOnVersionId: agentConfiguration.basedOnVersionId,
              basedOnVersionSha256: agentConfiguration.basedOnVersionSha256,
            }),
      };
    }
    const parsedConfig = catalog.parseConfig(node.nodeType, node.schemaVersion, configCandidate);
    if (!parsedConfig.success) {
      diagnostics.push(
        ...parsedConfig.issues.map((issue) =>
          policyDiagnostic(
            "run_configuration.node_config_invalid",
            `${node.path}.config${issue.path === "$" ? "" : issue.path.slice(1)}`,
            { nodeType: node.nodeType },
          ),
        ),
      );
    }
    const resolvedConfig = parsedConfig.success ? parsedConfig.data : node.config;
    const requestedEnabled = enabled.get(node.definitionNodeId);
    // agent.research v1没有受治理的调研底座；历史Definition仍可读取，但新Run固定跳过，
    // 不能用装饰性maxSources配置制造“已调研”假象。
    const legacyResearchWithoutExecutor = node.nodeType === "agent.research";
    const activation = legacyResearchWithoutExecutor
      ? "skipped"
      : requestedEnabled === undefined
        ? node.defaultActivation
        : requestedEnabled
          ? "enabled"
          : "skipped";
    let skipOutcome: string | undefined;
    if (activation === "skipped") {
      if (legacyResearchWithoutExecutor) {
        skipOutcome = "no_evidence";
      } else if (
        !context.blueprint.optionalNodeTypes.includes(node.nodeType) ||
        descriptor.skipPolicy.kind === "never"
      ) {
        diagnostics.push(
          policyDiagnostic("policy.skip_denied", node.path, { nodeType: node.nodeType }),
        );
      } else if (descriptor.skipPolicy.kind === "allowed_with_default_outcome") {
        skipOutcome = descriptor.skipPolicy.defaultOutcome;
      } else {
        diagnostics.push(
          policyDiagnostic("policy.explicit_skip_value_not_supported", node.path, {
            nodeType: node.nodeType,
          }),
        );
      }
    }
    nodeResolutions.push({
      definitionNodeId: node.definitionNodeId,
      nodeType: node.nodeType,
      schemaVersion: node.schemaVersion,
      config: resolvedConfig,
      activation,
      ...(skipOutcome !== undefined ? { skipOutcome } : {}),
    });

    if (descriptor.executorKind === "human_review") {
      const configuredMode =
        typeof resolvedConfig.reviewMode === "string"
          ? (resolvedConfig.reviewMode as WorkflowReviewMode)
          : "manual";
      const mode = reviewModes.get(node.definitionNodeId) ?? configuredMode;
      if (mode === "always_auto") {
        diagnostics.push(policyDiagnostic("policy.always_auto_not_supported", node.path, {}));
        continue;
      }
      if (
        mode !== "manual" &&
        context.blueprint.mandatoryManualReviewTypes.includes(node.nodeType)
      ) {
        diagnostics.push(
          policyDiagnostic("policy.mandatory_manual_review", node.path, {
            nodeType: node.nodeType,
          }),
        );
      }
      if (mode === "manual") {
        reviewResolutions.push({ definitionNodeId: node.definitionNodeId, mode, actor: "user" });
      } else {
        const policy = resolveAutoPolicy(context, mode, node.path, diagnostics);
        if (policy !== undefined) {
          reviewResolutions.push({
            definitionNodeId: node.definitionNodeId,
            mode,
            actor: "system_policy",
            policyRef: policy,
          });
        }
      }
    }
  }
  return { nodeResolutions, reviewResolutions, diagnostics };
}

function resolveAutoPolicy(
  context: CompilerContext,
  mode: "auto_continue_if_policy_allows",
  path: string,
  diagnostics: WorkflowDiagnostic[],
): { readonly resourceId: string; readonly revision: number; readonly sha256: string } | undefined {
  const requiredCapability = "workflow.review.auto";
  if (
    !context.principal.capabilities.includes(requiredCapability) ||
    context.policyEvidence === undefined
  ) {
    diagnostics.push(policyDiagnostic("policy.auto_continue_denied", path, { mode }));
    return undefined;
  }
  const resource = context.resources.find(
    (candidate) =>
      candidate.resourceKind === "rule" &&
      candidate.resourceId === context.policyEvidence?.resourceId,
  );
  if (
    resource === undefined ||
    resource.status !== "active" ||
    !resource.allowedPrincipalIds.includes(context.principal.principalId) ||
    resource.revision !== context.policyEvidence.expectedRevision ||
    resource.sha256 !== context.policyEvidence.expectedSha256
  ) {
    diagnostics.push({
      family: "resource_stale",
      code: "policy.auto_continue_evidence_stale",
      path,
      params: {},
    });
    return undefined;
  }
  return { resourceId: resource.resourceId, revision: resource.revision, sha256: resource.sha256 };
}

function resolveResources(
  context: CompilerContext,
  nodes: ReadonlyMap<string, IndexedNode>,
): {
  readonly resolutions: readonly WorkflowResolvedResource[];
  readonly diagnostics: readonly WorkflowDiagnostic[];
} {
  const diagnostics: WorkflowDiagnostic[] = [];
  const resolutions: WorkflowResolvedResource[] = [];
  const selectionOverrides = context.configuration.overrides.filter(
    (override): override is Extract<WorkflowRunOverride, { kind: "resource_selection" }> =>
      override.kind === "resource_selection",
  );
  for (const node of nodes.values()) {
    const expectedKind = resourceKindForNode(node.nodeType);
    if (expectedKind === undefined) continue;
    const override = selectionOverrides.find(
      (candidate) => candidate.definitionNodeId === node.definitionNodeId,
    );
    const configRequired = node.config.required === true;
    const required = configRequired || override?.required === true;
    const selectedIds = new Set<string>();
    if (override === undefined || override.selections.length === 0) {
      if (required) {
        diagnostics.push({
          family: "resource_stale",
          code: "resource.required_selection_missing",
          path: node.path,
          params: { resourceKind: expectedKind },
        });
      } else {
        resolutions.push({
          definitionNodeId: node.definitionNodeId,
          resourceKind: expectedKind,
          resolution: "excluded",
          exclusionReason: "not_selected",
        });
      }
      continue;
    }
    if (expectedKind !== override.resourceKind) {
      diagnostics.push(
        policyDiagnostic("resource.kind_not_allowed_for_node", node.path, {
          resourceKind: override.resourceKind,
        }),
      );
      continue;
    }
    if (node.nodeType === "context.project" && override.selections.length > 1) {
      diagnostics.push(
        policyDiagnostic("resource.project_selection_limit_exceeded", node.path, {
          selectedCount: override.selections.length,
          maxSelections: 1,
        }),
      );
      continue;
    }
    const configuredMaxItems =
      node.nodeType === "context.memory" && typeof node.config.maxItems === "number"
        ? node.config.maxItems
        : undefined;
    if (configuredMaxItems !== undefined && override.selections.length > configuredMaxItems) {
      diagnostics.push(
        policyDiagnostic("resource.memory_selection_limit_exceeded", node.path, {
          selectedCount: override.selections.length,
          maxSelections: configuredMaxItems,
        }),
      );
      continue;
    }
    for (const selected of override.selections) {
      if (selectedIds.has(selected.resourceId)) {
        diagnostics.push(
          policyDiagnostic("resource.duplicate_selection", node.path, {
            resourceId: selected.resourceId,
          }),
        );
        continue;
      }
      selectedIds.add(selected.resourceId);
      if (!selected.resourceId.startsWith(`${resourcePrefix(override.resourceKind)}_`)) {
        diagnostics.push(
          policyDiagnostic("resource.id_prefix_invalid", node.path, {
            resourceKind: override.resourceKind,
          }),
        );
        continue;
      }
      const resource = context.resources.find(
        (candidate) =>
          candidate.resourceKind === override.resourceKind &&
          candidate.resourceId === selected.resourceId,
      );
      const exclusionReason =
        resource === undefined
          ? "not_found"
          : resource.status === "archived"
            ? "archived"
            : !resource.allowedPrincipalIds.includes(context.principal.principalId)
              ? "forbidden"
              : resource.revision !== selected.expectedRevision
                ? "revision_stale"
                : resource.sha256 !== selected.expectedSha256
                  ? "hash_mismatch"
                  : undefined;
      if (exclusionReason !== undefined) {
        // “可选”只表示可以不选；一旦用户明确选择，服务端必须精确冻结该资源，
        // 不能把无权/不存在/过期引用悄悄改写成excluded继续执行。
        diagnostics.push({
          family: "resource_stale",
          code: `resource.${exclusionReason}`,
          path: node.path,
          params: { resourceKind: override.resourceKind, resourceId: selected.resourceId },
        });
      } else {
        resolutions.push({
          definitionNodeId: node.definitionNodeId,
          resourceKind: override.resourceKind,
          resourceId: selected.resourceId,
          expectedRevision: selected.expectedRevision,
          expectedSha256: selected.expectedSha256,
          resolution: "included",
        });
      }
    }
  }
  return {
    resolutions: resolutions.sort((left, right) => {
      const leftId = "resourceId" in left ? left.resourceId : "";
      const rightId = "resourceId" in right ? right.resourceId : "";
      return `${left.definitionNodeId}\0${left.resourceKind}\0${leftId}`.localeCompare(
        `${right.definitionNodeId}\0${right.resourceKind}\0${rightId}`,
      );
    }),
    diagnostics,
  };
}

function validateExecutorManifest(
  context: CompilerContext,
  nodes: ReadonlyMap<string, IndexedNode>,
): readonly WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const manifest = new Map<string, WorkflowExecutorManifestEntry>();
  for (const entry of context.executorManifest) {
    const key = nodeExecutorKey(entry.nodeType, entry.schemaVersion);
    if (manifest.has(key))
      diagnostics.push({
        family: "definition_invalid",
        code: "executor_manifest.duplicate_key",
        path: "$.executorManifest",
        params: { key },
      });
    manifest.set(key, entry);
  }
  for (const node of nodes.values()) {
    const key = nodeExecutorKey(node.nodeType, node.schemaVersion);
    if (!manifest.has(key))
      diagnostics.push({
        family: "definition_invalid",
        code: "executor_manifest.missing_executor",
        path: node.path,
        params: { key },
      });
  }
  return diagnostics;
}

function overrideIdentity(override: WorkflowRunOverride): string {
  // 一个节点每类override只能出现一次；resourceKind是该节点类型的服务端派生属性，
  // 不能被客户端用来制造两个selection并让后一个被find()静默忽略。
  return `${override.kind}\0${override.definitionNodeId}${
    override.kind === "node_config" ? `\0${override.field}` : ""
  }`;
}

function resourceKindForNode(nodeType: WorkflowNodeTypeKey): WorkflowResourceKind | undefined {
  if (nodeType === "context.memory") return "memory";
  if (nodeType === "context.project") return "project";
  if (nodeType === "policy.rules") return "rule";
  if (nodeType === "capability.skills") return "skill";
  return undefined;
}

function resourcePrefix(kind: WorkflowResourceKind): string {
  if (kind === "memory") return "mrs";
  if (kind === "project") return "prj";
  if (kind === "rule") return "rul";
  return "skl";
}

function resourceKey(kind: WorkflowResourceKind, id: string): string {
  return `${kind}\0${id}`;
}

function policyDiagnostic(
  code: string,
  path: string,
  params: Readonly<Record<string, string | number | boolean>>,
): WorkflowDiagnostic {
  return { family: "policy_denied", code, path, params };
}
